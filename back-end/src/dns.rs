//! Résolution DNS minimale (story 18) : l'IP publique annoncée pour le vocal est celle
//! du domaine par lequel les navigateurs joignent le serveur. Une requête A en UDP sur
//! monoio, vers le premier serveur de `/etc/resolv.conf` — pas de `getaddrinfo`, qui
//! bloquerait la seule boucle du serveur.

use std::net::{IpAddr, Ipv4Addr, SocketAddr};
use std::time::Duration;

use monoio::net::udp::UdpSocket;

const TIMEOUT: Duration = Duration::from_secs(2);

/// Première IPv4 de `name`, ou `None` (pas de réponse, pas d'enregistrement A).
pub async fn resolve_a(name: &str) -> Option<Ipv4Addr> {
    let server = nameserver()?;
    let bind: SocketAddr = if server.is_ipv4() { "0.0.0.0:0" } else { "[::]:0" }.parse().ok()?;
    let socket = UdpSocket::bind(bind).ok()?;
    let id = (std::process::id() as u16) ^ (name.len() as u16).rotate_left(7);
    let (res, _) = socket.send_to(query(id, name)?, SocketAddr::new(server, 53)).await;
    res.ok()?;
    let (res, buf) = monoio::time::timeout(TIMEOUT, socket.recv_from(vec![0u8; 1500])).await.ok()?;
    let (n, _) = res.ok()?;
    parse_a(id, &buf[..n])
}

/// Premier `nameserver` utilisable de `/etc/resolv.conf` (une IPv6 de lien avec
/// `%interface` est ignorée).
fn nameserver() -> Option<IpAddr> {
    std::fs::read_to_string("/etc/resolv.conf")
        .ok()?
        .lines()
        .filter_map(|l| l.trim().strip_prefix("nameserver"))
        .find_map(|v| v.trim().parse().ok())
}

/// Requête A récursive pour `name`.
fn query(id: u16, name: &str) -> Option<Vec<u8>> {
    let mut q = Vec::with_capacity(32 + name.len());
    q.extend_from_slice(&id.to_be_bytes());
    q.extend_from_slice(&[0x01, 0x00, 0, 1, 0, 0, 0, 0, 0, 0]); // RD ; 1 question
    for label in name.trim_end_matches('.').split('.') {
        if label.is_empty() || label.len() > 63 {
            return None;
        }
        q.push(label.len() as u8);
        q.extend_from_slice(label.as_bytes());
    }
    q.extend_from_slice(&[0, 0, 1, 0, 1]); // fin du nom ; type A ; classe IN
    Some(q)
}

/// Avance après un nom (étiquettes, ou pointeur de compression).
fn skip_name(msg: &[u8], mut at: usize) -> Option<usize> {
    loop {
        let len = *msg.get(at)? as usize;
        if len == 0 {
            return Some(at + 1);
        }
        if len & 0xC0 == 0xC0 {
            return Some(at + 2);
        }
        at += 1 + len;
    }
}

fn parse_a(id: u16, msg: &[u8]) -> Option<Ipv4Addr> {
    let u16_at = |at: usize| Some(u16::from_be_bytes([*msg.get(at)?, *msg.get(at + 1)?]));
    if u16_at(0)? != id || msg[3] & 0x0F != 0 {
        return None; // autre requête, ou erreur (RCODE)
    }
    let questions = u16_at(4)?;
    let answers = u16_at(6)?;
    let mut at = 12;
    for _ in 0..questions {
        at = skip_name(msg, at)? + 4;
    }
    for _ in 0..answers {
        at = skip_name(msg, at)?;
        let (kind, len) = (u16_at(at)?, u16_at(at + 8)? as usize);
        let data = msg.get(at + 10..at + 10 + len)?;
        if kind == 1 && len == 4 {
            return Some(Ipv4Addr::new(data[0], data[1], data[2], data[3]));
        }
        at += 10 + len; // CNAME & co : on passe
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Réponse réelle : CNAME puis A, noms compressés.
    #[test]
    fn reponse_avec_cname() {
        let mut msg = vec![0x12, 0x34, 0x81, 0x80, 0, 1, 0, 2, 0, 0, 0, 0];
        msg.extend_from_slice(&query(0x1234, "audio.example.fr").unwrap()[12..]);
        // CNAME : nom = pointeur vers la question (offset 12), donnée = « b.example.fr »
        msg.extend_from_slice(&[0xC0, 12, 0, 5, 0, 1, 0, 0, 0, 60, 0, 4, 1, b'b', 0xC0, 18]);
        // A : nom = pointeur, 90.21.196.219
        msg.extend_from_slice(&[0xC0, 12, 0, 1, 0, 1, 0, 0, 0, 60, 0, 4, 90, 21, 196, 219]);
        assert_eq!(parse_a(0x1234, &msg), Some(Ipv4Addr::new(90, 21, 196, 219)));
        assert_eq!(parse_a(0x9999, &msg), None, "autre identifiant");
        msg[3] = 0x83; // NXDOMAIN
        assert_eq!(parse_a(0x1234, &msg), None);
    }

    /// Vrai réseau : `cargo test -- --ignored resolution_reelle`.
    #[test]
    #[ignore]
    fn resolution_reelle() {
        let ip = monoio::RuntimeBuilder::<monoio::FusionDriver>::new()
            .enable_timer()
            .build()
            .unwrap()
            .block_on(resolve_a("audio.joshua-bouchat.fr"));
        println!("audio.joshua-bouchat.fr → {ip:?}");
        assert!(ip.is_some());
    }

    #[test]
    fn nom_invalide() {
        assert!(query(1, "a..b").is_none());
        assert!(query(1, &"x".repeat(64)).is_none());
    }
}
