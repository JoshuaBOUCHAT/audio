//! Framing WebSocket (RFC 6455) côté serveur. Les frames client arrivent en flux : une
//! lecture io_uring peut contenir une demi-frame ou plusieurs frames, d'où
//! `parse_client_frame` sur un tampon d'accumulation (cf. `read_loop`).

/// Taille max d'une frame client. Garde-fou de transport, pas une limite métier : sans
/// borne, un client pourrait annoncer 2⁶³ octets et faire grossir le tampon
/// d'accumulation sans fin. Large devant la plus grosse requête légitime (photo de
/// profil ≤ 256 Kio, story 37).
pub const MAX_FRAME_LEN: usize = 1 << 20;

#[derive(Debug, PartialEq)]
pub enum FrameError {
    /// RFC 6455 § 5.1 : toute frame client doit être masquée.
    Unmasked,
    TooLarge,
    /// Message découpé en plusieurs frames (FIN=0 / continuation) : les navigateurs
    /// n'en envoient pas pour un `send()`, pas géré.
    Fragmented,
}

#[derive(Debug, PartialEq)]
pub struct Frame {
    pub opcode: u8,
    pub payload: Vec<u8>,
    /// Octets de `buf` occupés par la frame, à retirer du tampon.
    pub consumed: usize,
}

/// `Ok(None)` : frame incomplète, lire davantage.
pub fn parse_client_frame(buf: &[u8]) -> Result<Option<Frame>, FrameError> {
    if buf.len() < 2 {
        return Ok(None);
    }
    let fin = buf[0] & 0x80 != 0;
    let opcode = buf[0] & 0x0F;
    if !fin || opcode == 0x0 {
        return Err(FrameError::Fragmented);
    }
    if buf[1] & 0x80 == 0 {
        return Err(FrameError::Unmasked);
    }
    let (len, offset) = match buf[1] & 0x7F {
        126 => {
            if buf.len() < 4 {
                return Ok(None);
            }
            (u16::from_be_bytes([buf[2], buf[3]]) as u64, 4)
        }
        127 => {
            if buf.len() < 10 {
                return Ok(None);
            }
            (u64::from_be_bytes(buf[2..10].try_into().expect("8 octets")), 10)
        }
        n => (n as u64, 2),
    };
    if len > MAX_FRAME_LEN as u64 {
        return Err(FrameError::TooLarge);
    }
    let len = len as usize;
    let payload_start = offset + 4;
    if buf.len() < payload_start + len {
        return Ok(None);
    }
    let mask = [buf[offset], buf[offset + 1], buf[offset + 2], buf[offset + 3]];
    let mut payload = buf[payload_start..payload_start + len].to_vec();
    for (i, b) in payload.iter_mut().enumerate() {
        *b ^= mask[i % 4];
    }
    Ok(Some(Frame {
        opcode,
        payload,
        consumed: payload_start + len,
    }))
}

/// Frame serveur→client (jamais masquée), FIN=1, longueur étendue sur 2 ou 8 octets si
/// besoin.
pub fn encode_frame(opcode: u8, payload: &[u8]) -> Vec<u8> {
    let mut frame = Vec::with_capacity(10 + payload.len());
    frame.push(0x80 | opcode); // FIN=1
    let len = payload.len();
    if len < 126 {
        frame.push(len as u8);
    } else if len <= u16::MAX as usize {
        frame.push(126);
        frame.extend_from_slice(&(len as u16).to_be_bytes());
    } else {
        frame.push(127);
        frame.extend_from_slice(&(len as u64).to_be_bytes());
    }
    frame.extend_from_slice(payload);
    frame
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Frame client masquée, comme l'enverrait un navigateur.
    fn client_frame(opcode: u8, payload: &[u8]) -> Vec<u8> {
        let mask = [0x12, 0x34, 0x56, 0x78];
        let mut frame = encode_frame(opcode, payload);
        let header_len = frame.len() - payload.len();
        frame[1] |= 0x80;
        for (i, b) in frame[header_len..].iter_mut().enumerate() {
            *b ^= mask[i % 4];
        }
        frame.splice(header_len..header_len, mask);
        frame
    }

    #[test]
    fn les_trois_formats_de_longueur() {
        for len in [0, 125, 126, 65_535, 65_536, 300_000] {
            let payload: Vec<u8> = (0..len).map(|i| i as u8).collect();
            let buf = client_frame(0x2, &payload);
            let frame = parse_client_frame(&buf).unwrap().unwrap();
            assert_eq!(frame.payload, payload, "len={len}");
            assert_eq!(frame.consumed, buf.len());
        }
    }

    #[test]
    fn frame_incomplete_a_chaque_coupure() {
        let buf = client_frame(0x2, &[7; 70_000]);
        for cut in [0, 1, 2, 3, 9, 13, 14, 1000, buf.len() - 1] {
            assert_eq!(parse_client_frame(&buf[..cut]), Ok(None), "cut={cut}");
        }
    }

    #[test]
    fn plusieurs_frames_dans_un_tampon() {
        let mut buf = client_frame(0x2, b"un");
        buf.extend(client_frame(0x2, b"deux"));
        let first = parse_client_frame(&buf).unwrap().unwrap();
        assert_eq!(first.payload, b"un");
        let second = parse_client_frame(&buf[first.consumed..]).unwrap().unwrap();
        assert_eq!(second.payload, b"deux");
    }

    #[test]
    fn refus() {
        let mut too_large = vec![0x82, 0x80 | 127];
        too_large.extend(((MAX_FRAME_LEN + 1) as u64).to_be_bytes());
        assert_eq!(parse_client_frame(&too_large), Err(FrameError::TooLarge));

        let mut unmasked = encode_frame(0x2, b"x");
        assert_eq!(parse_client_frame(&unmasked), Err(FrameError::Unmasked));
        unmasked[0] &= 0x7F; // FIN=0
        assert_eq!(parse_client_frame(&unmasked), Err(FrameError::Fragmented));
    }
}
