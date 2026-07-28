mod email;
mod proto;
mod validate;

use std::sync::Arc;

use aws_lc_rs::digest::{digest, SHA1_FOR_LEGACY_USE_ONLY};
use base64::Engine;
use base64::engine::general_purpose::STANDARD as BASE64;
use monoio::io::{AsyncReadRent, AsyncWriteRentExt};
use monoio::net::{TcpListener, TcpStream};
use prost::Message;
use rustls::ServerConfig;
use rustls::pki_types::pem::PemObject;
use rustls::pki_types::{CertificateDer, PrivateKeyDer};
use uuid::Uuid;

const WS_GUID: &str = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

const INDEX_HTML: &str = r#"<!doctype html>
<html>
<body>
<script>
// Protocole binaire (ClientEnvelope/ServerEnvelope protobuf), pas de console de
// test texte ici — voir front/ pour le client protobuf.
const ws = new WebSocket(`wss://${location.host}/`);
ws.onopen = () => console.log('[ws] open');
ws.onclose = () => console.log('[ws] closed');
</script>
</body>
</html>
"#;

#[monoio::main(timer_enabled = true)]
async fn main() {
    let certs: Vec<CertificateDer<'static>> = CertificateDer::pem_file_iter("certs/cert.pem")
        .expect("lecture certs/cert.pem")
        .collect::<Result<_, _>>()
        .expect("parsing certs/cert.pem");
    let key = PrivateKeyDer::from_pem_file("certs/key.pem").expect("lecture certs/key.pem");

    let provider = Arc::new(rustls::crypto::aws_lc_rs::default_provider());
    let mut config = ServerConfig::builder_with_provider(provider)
        .with_safe_default_protocol_versions()
        .expect("protocol versions")
        .with_no_client_auth()
        .with_single_cert(certs, key)
        .expect("config TLS");
    config.alpn_protocols = vec![b"http/1.1".to_vec()];
    let acceptor = monoio_rustls::TlsAcceptor::from(Arc::new(config));

    let listener = TcpListener::bind("127.0.0.1:8443").expect("bind :8443");
    println!("en écoute sur https://127.0.0.1:8443 (cert auto-signé, le navigateur va alerter)");

    loop {
        let (stream, _addr) = match listener.accept().await {
            Ok(pair) => pair,
            Err(e) => {
                eprintln!("accept error: {e:?}");
                continue;
            }
        };
        let acceptor = acceptor.clone();
        monoio::spawn(handle_conn(stream, acceptor));
    }
}

async fn handle_conn(stream: TcpStream, acceptor: monoio_rustls::TlsAcceptor) {
    let mut tls = match acceptor.accept(stream).await {
        Ok(tls) => tls,
        Err(e) => {
            eprintln!("handshake TLS échoué: {e:?}");
            return;
        }
    };

    let Some(ws_key) = read_ws_upgrade_request(&mut tls).await else {
        return;
    };

    let Some(key) = ws_key else {
        let _ = serve_index(&mut tls).await;
        return;
    };

    if handle_ws_upgrade(&mut tls, &key).await.is_err() {
        return;
    }
    println!("[ws] upgrade OK");

    handle_ws_connection(tls).await;
}

// Un seul read : suffisant pour une requête GET tenant dans un segment TCP (pas de
// gestion de requête fragmentée sur plusieurs complétions io_uring ici, cf.
// architecture.md § HTTP/1.1 pour la vraie implémentation).
// Retourne `None` si la lecture/parse échoue, `Some(None)` si la requête n'est pas
// une upgrade WebSocket, `Some(Some(key))` sinon.
async fn read_ws_upgrade_request(
    tls: &mut monoio_rustls::ServerTlsStream<TcpStream>,
) -> Option<Option<String>> {
    let buf = vec![0u8; 4096];
    let (res, buf) = tls.read(buf).await;
    let n = match res {
        Ok(0) | Err(_) => return None,
        Ok(n) => n,
    };

    let mut headers = [httparse::EMPTY_HEADER; 16];
    let mut req = httparse::Request::new(&mut headers);
    if req.parse(&buf[..n]).is_err() {
        return None;
    }
    Some(
        req.headers
            .iter()
            .find(|h| h.name.eq_ignore_ascii_case("sec-websocket-key"))
            .map(|h| String::from_utf8_lossy(h.value).into_owned()),
    )
}

async fn serve_index(tls: &mut monoio_rustls::ServerTlsStream<TcpStream>) -> std::io::Result<()> {
    let body = INDEX_HTML.as_bytes();
    let header = format!(
        "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nContent-Type: text/html\r\nConnection: close\r\n\r\n",
        body.len()
    );
    let mut resp = header.into_bytes();
    resp.extend_from_slice(body);
    tls.write_all(resp).await.0.map(|_| ())
}

async fn handle_ws_upgrade(
    tls: &mut monoio_rustls::ServerTlsStream<TcpStream>,
    key: &str,
) -> std::io::Result<()> {
    let accept = compute_accept(key);
    let response = format!(
        "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: {accept}\r\n\r\n"
    );
    tls.write_all(response.into_bytes()).await.0.map(|_| ())
}

// Boucle requête/réponse : une frame binaire entrante = un ClientEnvelope protobuf,
// traité et immédiatement répondu par un ServerEnvelope sur la même connexion — pas
// de split lecture/écriture nécessaire tant qu'il n'y a pas d'événements poussés côté
// serveur en dehors d'une réponse directe (broadcast à câbler plus tard).
async fn handle_ws_connection(mut tls: monoio_rustls::ServerTlsStream<TcpStream>) {
    let mut buf = vec![0u8; 4096];
    loop {
        let (res, b) = tls.read(buf).await;
        buf = b;
        let n = match res {
            Ok(0) | Err(_) => break,
            Ok(n) => n,
        };
        let Some((opcode, payload)) = decode_ws_frame(&buf[..n]) else {
            break;
        };
        match opcode {
            0x8 => break, // close
            0x2 => {
                let envelope = match proto::ClientEnvelope::decode(payload.as_slice()) {
                    Ok(envelope) => envelope,
                    Err(e) => {
                        eprintln!("[ws] ClientEnvelope illisible: {e:?}");
                        continue;
                    }
                };
                let Some(response) = handle_client_envelope(envelope) else {
                    continue;
                };
                let frame = encode_ws_frame(0x2, &response.encode_to_vec());
                if tls.write_all(frame).await.0.is_err() {
                    break;
                }
            }
            _ => {} // texte/ping/pong non gérés à ce stade
        }
    }
    println!("[ws] connexion terminée");
}

fn handle_client_envelope(envelope: proto::ClientEnvelope) -> Option<proto::ServerEnvelope> {
    use proto::client_envelope::Payload;

    let payload = match envelope.payload {
        Some(Payload::RequestMagicLink(req)) => match validate::validate_request_magic_link(req)
        {
            Ok(valid) => {
                // V1 : le lien est simplement loggé côté serveur, jamais envoyé par
                // email (cf. CLAUDE.md § Authentification). Ack volontairement vide
                // (MagicLinkSent) pour ne pas révéler si l'email correspond à un
                // compte existant.
                let token = Uuid::new_v4();
                println!("[auth] lien magique pour {} : token={token}", valid.email);
                proto::server_envelope::Payload::MagicLinkSent(proto::MagicLinkSent {})
            }
            Err(err) => proto::server_envelope::Payload::Error(err),
        },
        _ => {
            eprintln!("[ws] type de ClientEnvelope non géré");
            return None;
        }
    };

    Some(proto::ServerEnvelope {
        request_id: envelope.request_id,
        payload: Some(payload),
    })
}

fn compute_accept(key: &str) -> String {
    let mut data = String::with_capacity(key.len() + WS_GUID.len());
    data.push_str(key);
    data.push_str(WS_GUID);
    let hash = digest(&SHA1_FOR_LEGACY_USE_ONLY, data.as_bytes());
    BASE64.encode(hash.as_ref())
}

// Encode une frame WebSocket serveur→client (jamais masquée, RFC 6455), FIN=1,
// longueur étendue sur 2 ou 8 octets si besoin — un ServerEnvelope protobuf peut
// dépasser les 125 octets du format court dès qu'un salon a un historique.
fn encode_ws_frame(opcode: u8, payload: &[u8]) -> Vec<u8> {
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

// Décode une frame WebSocket client→serveur (toujours masquée, RFC 6455).
// Retourne (opcode, payload démasqué). Gère la longueur étendue (126/127) mais pas
// les messages fragmentés sur plusieurs frames, ni une requête à cheval sur deux
// complétions de lecture io_uring — cf. commentaire sur `read_ws_upgrade_request`.
fn decode_ws_frame(buf: &[u8]) -> Option<(u8, Vec<u8>)> {
    if buf.len() < 2 {
        return None;
    }
    let opcode = buf[0] & 0x0F;
    let masked = buf[1] & 0x80 != 0;
    if !masked {
        return None;
    }
    let base_len = (buf[1] & 0x7F) as usize;
    let (len, offset) = match base_len {
        126 => {
            if buf.len() < 4 {
                return None;
            }
            (u16::from_be_bytes([buf[2], buf[3]]) as usize, 4)
        }
        127 => {
            if buf.len() < 10 {
                return None;
            }
            (u64::from_be_bytes(buf[2..10].try_into().ok()?) as usize, 10)
        }
        n => (n, 2),
    };
    if buf.len() < offset + 4 {
        return None;
    }
    let mask = [buf[offset], buf[offset + 1], buf[offset + 2], buf[offset + 3]];
    let payload_start = offset + 4;
    if buf.len() < payload_start + len {
        return None;
    }
    let mut payload = buf[payload_start..payload_start + len].to_vec();
    for (i, b) in payload.iter_mut().enumerate() {
        *b ^= mask[i % 4];
    }
    Some((opcode, payload))
}
