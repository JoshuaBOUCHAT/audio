mod email;
mod proto;
mod validate;

use std::env;
use std::sync::Arc;
use std::time::Duration;

use aws_lc_rs::digest::{digest, SHA1_FOR_LEGACY_USE_ONLY};
use base64::Engine;
use base64::engine::general_purpose::STANDARD as BASE64;
use monoio::io::{AsyncReadRent, AsyncWriteRentExt};
use monoio::net::{TcpListener, TcpStream};
use oxidart::monoio::SharedArt;
use oxidart::{OxidArt, Value};
use prost::Message;
use radixox_lib::shared_byte::SharedByte;
use rustls::ServerConfig;
use rustls::pki_types::pem::PemObject;
use rustls::pki_types::{CertificateDer, PrivateKeyDer};
use uuid::Uuid;

use email::Email;

const WS_GUID: &str = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
// Story 4 : pas de valeur imposée par CLAUDE.md, 15 minutes retenu (assez court pour
// limiter le risque si les logs fuitent, assez long pour qu'un ami aille chercher le
// lien transmis à la main en v1).
const MAGIC_LINK_TTL: Duration = Duration::from_secs(15 * 60);

/// État partagé entre toutes les connexions (single-thread monoio, cf. CLAUDE.md
/// § OxidArt) : cloner (`Rc::clone` implicite pour `art`) dans chaque tâche spawnée,
/// jamais reconstruire.
#[derive(Clone)]
struct AppState {
    art: SharedArt,
    bootstrap_admin_email: Option<Email>,
}

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

    // Story 3 (bootstrap admin) : email fourni en argument CLI ou variable d'env,
    // pas de compte spécial pré-créé — juste retenu ici pour marquer admin le
    // premier compte qui se connecte avec cet email (cf. handle_auth).
    let bootstrap_admin_email = env::args()
        .nth(1)
        .or_else(|| env::var("ADMIN_EMAIL").ok())
        .map(|raw| Email::parse(&raw).expect("email admin (arg CLI / ADMIN_EMAIL) invalide"));
    if let Some(email) = &bootstrap_admin_email {
        println!("[boot] {email} sera admin à sa première connexion");
    }

    let art = OxidArt::shared_with_evictor(Duration::from_millis(100), Duration::from_secs(1));
    let state = AppState {
        art,
        bootstrap_admin_email,
    };

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
        monoio::spawn(handle_conn(stream, acceptor, state.clone()));
    }
}

async fn handle_conn(stream: TcpStream, acceptor: monoio_rustls::TlsAcceptor, state: AppState) {
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

    handle_ws_connection(tls, state).await;
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
// Story 33 : l'auth se fait une fois par connexion WebSocket (AuthRequest), puis
// l'identité est portée par `user_id` en mémoire pour toute la durée de vie de cette
// connexion — aucune requête suivante n'a besoin de reporter un token.
async fn handle_ws_connection(mut tls: monoio_rustls::ServerTlsStream<TcpStream>, state: AppState) {
    let mut buf = vec![0u8; 4096];
    let mut user_id: Option<u64> = None;
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
                let Some(response) = handle_client_envelope(envelope, &state, &mut user_id) else {
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

fn handle_client_envelope(
    envelope: proto::ClientEnvelope,
    state: &AppState,
    user_id: &mut Option<u64>,
) -> Option<proto::ServerEnvelope> {
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
                state.art.borrow_mut().set_ttl(
                    SharedByte::from_str(&format!("magic_link:{token}")),
                    MAGIC_LINK_TTL,
                    Value::String(valid.email.as_shared_byte()),
                );
                println!("[auth] lien magique pour {} : token={token}", valid.email);
                proto::server_envelope::Payload::MagicLinkSent(proto::MagicLinkSent {})
            }
            Err(err) => proto::server_envelope::Payload::Error(err),
        },
        Some(Payload::Auth(req)) => match validate::validate_auth_request(req) {
            Ok(valid) => match handle_auth(valid.token, state, user_id) {
                Ok(response) => proto::server_envelope::Payload::AuthResponse(response),
                Err(err) => proto::server_envelope::Payload::Error(err),
            },
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

/// `token` = token de lien magique OU token de session (story 33), le serveur ne
/// distingue pas les deux formats a priori : il regarde d'abord `magic_link:{token}`
/// (et le consomme, usage unique), sinon retente sur `session:{token}` (jamais
/// consommé, story 6 — session valide indéfiniment).
///
/// Toute la suite de mutations OxidArt ci-dessous représente un état métier valide
/// une fois terminée (consommation du lien + résolution/création de l'utilisateur +
/// émission de session) — appliquée en un seul emprunt `borrow_mut()`, donc atomique
/// vis-à-vis des autres tâches monoio (cf. CLAUDE.md § OxidArt).
fn handle_auth(
    token: Uuid,
    state: &AppState,
    user_id_slot: &mut Option<u64>,
) -> Result<proto::AuthResponse, proto::Error> {
    let mut art = state.art.borrow_mut();

    let invalid_token = || proto::Error {
        code: 401,
        message: "token invalide ou expiré".to_string(),
    };

    let magic_link_key = format!("magic_link:{token}");
    let (user, session_token) = if let Some(email_val) = art.get(magic_link_key.as_bytes()) {
        art.del(magic_link_key.as_bytes());
        let email_bytes = email_val
            .as_bytes()
            .expect("magic_link:{token} toujours stocké en Value::String");
        let email_str = email_bytes
            .as_str()
            .expect("email toujours UTF-8 (garanti par Email::parse à l'écriture)");
        let email = Email::parse(email_str).expect("email re-normalisé toujours valide");

        let email_index_key = format!("email_index:{email}");
        let user = match art.get(email_index_key.as_bytes()) {
            Some(id_val) => {
                let id: u64 = id_val
                    .as_bytes()
                    .expect("email_index:{email} toujours Value::String")
                    .as_str()
                    .expect("id toujours ASCII")
                    .parse()
                    .expect("id_counter toujours numérique");
                let user_bytes = art
                    .get(format!("user:{id}").as_bytes())
                    .expect("email_index sans user:{id} correspondant — invariant violé");
                bincode::deserialize::<proto::User>(
                    user_bytes.as_bytes().expect("user:{id} toujours Value::String").as_slice(),
                )
                .expect("user:{id} corrompu")
            }
            None => {
                let id = art
                    .incr(SharedByte::from_str("id_counter"))
                    .expect("id_counter jamais utilisé pour autre chose qu'un entier")
                    as u64;
                let is_admin = state.bootstrap_admin_email.as_ref() == Some(&email);
                let user = proto::User {
                    id,
                    email: email.to_string(),
                    is_admin,
                };
                let encoded = bincode::serialize(&user).expect("sérialisation User");
                art.set(
                    SharedByte::from_str(&format!("user:{id}")),
                    Value::String(SharedByte::from_slice(encoded)),
                );
                art.set(
                    SharedByte::from_str(&email_index_key),
                    Value::String(SharedByte::from_str(&id.to_string())),
                );
                user
            }
        };

        let session_token = Uuid::new_v4();
        art.set(
            SharedByte::from_str(&format!("session:{session_token}")),
            Value::String(SharedByte::from_str(&user.id.to_string())),
        );
        (user, session_token)
    } else {
        let session_key = format!("session:{token}");
        let id_val = art.get(session_key.as_bytes()).ok_or_else(invalid_token)?;
        let id: u64 = id_val
            .as_bytes()
            .expect("session:{token} toujours Value::String")
            .as_str()
            .expect("id toujours ASCII")
            .parse()
            .expect("session id toujours numérique");
        let user_bytes = art
            .get(format!("user:{id}").as_bytes())
            .expect("session sans user:{id} correspondant — invariant violé");
        let user: proto::User = bincode::deserialize(
            user_bytes.as_bytes().expect("user:{id} toujours Value::String").as_slice(),
        )
        .expect("user:{id} corrompu");
        (user, token) // token de session déjà valide : pas de rotation, renvoyé tel quel
    };

    user_id_slot.replace(user.id);
    Ok(proto::AuthResponse {
        me: Some(user),
        channels: vec![], // vide tant que CreateChannel/le stockage de salons n'existe pas
        session_token: session_token.to_string(),
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
