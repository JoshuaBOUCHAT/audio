mod email;
mod keys;
mod persist;
mod presence;
mod proto;
mod registry;
mod validate;
mod ws;

use std::cell::{Cell, RefCell};
use std::env;
use std::rc::Rc;
use std::sync::Arc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use aws_lc_rs::digest::{digest, SHA1_FOR_LEGACY_USE_ONLY};
use base64::Engine;
use base64::engine::general_purpose::STANDARD as BASE64;
use monoio::io::{AsyncReadRent, AsyncWriteRentExt, OwnedReadHalf, Splitable};
use monoio::net::{TcpListener, TcpStream};
use oxidart::krange::RangeVal;
use oxidart::monoio::SharedArt;
use oxidart::{OxidArt, Value};
use prost::Message;
use radixox_lib::shared_byte::SharedByte;
use rustls::ServerConfig;
use rustls::pki_types::pem::PemObject;
use rustls::pki_types::{CertificateDer, PrivateKeyDer};
use uuid::Uuid;

use email::Email;
use presence::{Presence, SharedPresence};
use registry::{ConnId, SharedRegistry, TlsStream};

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
    registry: SharedRegistry,
    /// Levé par chaque mutation métier, remis à zéro par la save périodique
    /// (oxidart ne compte pas les modifications).
    dirty: Rc<Cell<bool>>,
    presence: SharedPresence,
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
    persist::load_at_startup(&art).expect("reload du dump");
    persist::install_shutdown(art.clone());
    let dirty = Rc::new(Cell::new(false));
    persist::install_periodic_save(art.clone(), dirty.clone());
    let state = AppState {
        art,
        bootstrap_admin_email,
        registry: SharedRegistry::default(),
        dirty,
        presence: Rc::new(RefCell::new(Presence::from_env())),
    };

    if cfg!(debug_assertions) {
        println!(
            "[dev] build debug : tokens de connexion permanents 00000000-0000-0000-0000-00000000000N \
             (N = 1..{DEV_LOGIN_TOKENS}, 1 = admin) — absents en release"
        );
    }

    // `AUDIO_LISTEN` : autre adresse que celle de dev, ex. un second serveur de test.
    let listen = env::var("AUDIO_LISTEN").unwrap_or_else(|_| "127.0.0.1:8443".into());
    let listener = TcpListener::bind(&listen).unwrap_or_else(|e| panic!("bind {listen}: {e}"));
    println!("en écoute sur https://{listen} (cert auto-signé, le navigateur va alerter)");

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

    // 64 : un navigateur envoie bien plus que 16 en-têtes (Origin, Sec-Fetch-*,
    // Accept-Language, Cookie…) — au-delà, httparse renvoie TooManyHeaders.
    let mut headers = [httparse::EMPTY_HEADER; 64];
    let mut req = httparse::Request::new(&mut headers);
    if let Err(e) = req.parse(&buf[..n]) {
        eprintln!("[http] requête illisible: {e:?}");
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

// Boucle de lecture : une frame binaire entrante = un ClientEnvelope protobuf. Le flux
// TLS est découpé : cette tâche garde la moitié lecture, la moitié écriture vit dans le
// registre, par lequel passent la réponse directe comme les broadcasts poussés par
// d'autres connexions (cf. registry.rs).
// Story 33 : l'auth se fait une fois par connexion WebSocket (AuthRequest), puis
// l'identité est portée par `user_id` en mémoire pour toute la durée de vie de cette
// connexion — aucune requête suivante n'a besoin de reporter un token.
async fn handle_ws_connection(tls: TlsStream, state: AppState) {
    let (read, write) = tls.into_split();
    let conn = state.registry.borrow_mut().insert(write);
    read_loop(read, conn, &state).await;
    state.registry.borrow_mut().remove(conn);
    presence::disconnected(&state.presence, &state.registry, conn);
    println!("[ws] connexion terminée");
}

/// Les octets lus s'accumulent dans `pending` jusqu'à former des frames complètes :
/// une lecture peut porter une demi-frame (photo de profil de plusieurs records TLS)
/// comme plusieurs frames. Une frame invalide ferme la connexion.
async fn read_loop(mut read: OwnedReadHalf<TlsStream>, conn: ConnId, state: &AppState) {
    let mut chunk = vec![0u8; 16 * 1024];
    let mut pending: Vec<u8> = Vec::new();
    let mut user_id: Option<u64> = None;
    loop {
        loop {
            let frame = match ws::parse_client_frame(&pending) {
                Ok(Some(frame)) => frame,
                Ok(None) => break,
                Err(e) => {
                    eprintln!("[ws] frame refusée: {e:?}");
                    return;
                }
            };
            pending.drain(..frame.consumed);
            match frame.opcode {
                0x8 => return, // close
                0x2 => handle_binary_frame(&frame.payload, state, conn, &mut user_id),
                _ => {} // texte/ping/pong non gérés à ce stade
            }
        }
        let (res, c) = read.read(chunk).await;
        chunk = c;
        match res {
            Ok(0) | Err(_) => return,
            Ok(n) => pending.extend_from_slice(&chunk[..n]),
        }
    }
}

fn handle_binary_frame(payload: &[u8], state: &AppState, conn: ConnId, user_id: &mut Option<u64>) {
    let envelope = match proto::ClientEnvelope::decode(payload) {
        Ok(envelope) => envelope,
        Err(e) => {
            eprintln!("[ws] ClientEnvelope illisible: {e:?}");
            return;
        }
    };
    if let Some(response) = handle_client_envelope(envelope, state, conn, user_id) {
        registry::send(&state.registry, conn, &server_frame(&response));
    }
}

fn server_frame(envelope: &proto::ServerEnvelope) -> Vec<u8> {
    ws::encode_frame(0x2, &envelope.encode_to_vec())
}

fn handle_client_envelope(
    envelope: proto::ClientEnvelope,
    state: &AppState,
    conn: ConnId,
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
                Ok(mut response) => {
                    state.registry.borrow_mut().mark_authenticated(conn);
                    let me = response.me.as_ref().expect("AuthResponse.me toujours rempli");
                    presence::connected(
                        &state.presence,
                        &state.registry,
                        conn,
                        me.id,
                        me.status() == proto::Status::Invisible,
                    );
                    response.online_user_ids = state.presence.borrow().online_ids();
                    proto::server_envelope::Payload::AuthResponse(response)
                }
                Err(err) => proto::server_envelope::Payload::Error(err),
            },
            Err(err) => proto::server_envelope::Payload::Error(err),
        },
        Some(Payload::CreateChannel(req)) => match create_channel(req, state, *user_id) {
            Ok(channel) => {
                let created = proto::server_envelope::Payload::ChannelCreated(
                    proto::ChannelCreated {
                        channel: Some(channel),
                    },
                );
                // Les autres clients authentifiés l'apprennent par broadcast
                // (request_id vide) ; l'émetteur, par sa réponse ci-dessous.
                let event = proto::ServerEnvelope {
                    request_id: String::new(),
                    payload: Some(created.clone()),
                };
                registry::broadcast(&state.registry, conn, &server_frame(&event));
                created
            }
            Err(err) => proto::server_envelope::Payload::Error(err),
        },
        Some(Payload::SendMessage(req)) => match send_message(req, state, *user_id) {
            Ok(message) => {
                let new_message = proto::server_envelope::Payload::NewMessage(
                    proto::NewMessage {
                        message: Some(message),
                    },
                );
                // Story 11 : broadcast global à tous les clients authentifiés (pas
                // d'abonnement par salon) ; l'émetteur le reçoit en réponse.
                let event = proto::ServerEnvelope {
                    request_id: String::new(),
                    payload: Some(new_message.clone()),
                };
                registry::broadcast(&state.registry, conn, &server_frame(&event));
                new_message
            }
            Err(err) => proto::server_envelope::Payload::Error(err),
        },
        Some(Payload::Sync(req)) => match sync_messages(req, state, *user_id) {
            Ok(response) => proto::server_envelope::Payload::SyncResponse(response),
            Err(err) => proto::server_envelope::Payload::Error(err),
        },
        Some(Payload::DeleteMessage(req)) => match delete_message(req, state, *user_id) {
            Ok(deleted) => {
                let deleted = proto::server_envelope::Payload::MessageDeleted(deleted);
                let event = proto::ServerEnvelope {
                    request_id: String::new(),
                    payload: Some(deleted.clone()),
                };
                registry::broadcast(&state.registry, conn, &server_frame(&event));
                deleted
            }
            Err(err) => proto::server_envelope::Payload::Error(err),
        },
        Some(Payload::EditMessage(req)) => match edit_message(req, state, *user_id) {
            Ok(message) => {
                let edited = proto::server_envelope::Payload::MessageEdited(
                    proto::MessageEdited {
                        message: Some(message),
                    },
                );
                let event = proto::ServerEnvelope {
                    request_id: String::new(),
                    payload: Some(edited.clone()),
                };
                registry::broadcast(&state.registry, conn, &server_frame(&event));
                edited
            }
            Err(err) => proto::server_envelope::Payload::Error(err),
        },
        Some(Payload::SetStatus(req)) => match set_status(req, state, *user_id) {
            Ok(status) => {
                presence::status_changed(
                    &state.presence,
                    &state.registry,
                    user_id.expect("set_status exige l'auth"),
                    status == proto::Status::Invisible,
                );
                proto::server_envelope::Payload::StatusSet(proto::StatusSet {
                    status: status as i32,
                })
            }
            Err(err) => proto::server_envelope::Payload::Error(err),
        },
        Some(Payload::SetPseudo(req)) => match set_pseudo(req, state, *user_id) {
            Ok(profile) => user_updated(state, conn, profile),
            Err(err) => proto::server_envelope::Payload::Error(err),
        },
        Some(Payload::SetAvatar(req)) => match set_avatar(req, state, *user_id) {
            Ok(profile) => user_updated(state, conn, profile),
            Err(err) => proto::server_envelope::Payload::Error(err),
        },
        Some(Payload::GetAvatar(req)) => match get_avatar(req, state, *user_id) {
            Ok(avatar) => proto::server_envelope::Payload::Avatar(avatar),
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

/// Nombre de tokens de connexion de dev (`dev_login_email`).
const DEV_LOGIN_TOKENS: u128 = 9;

/// **Build debug uniquement** (absent d'un `cargo build --release`) : tokens fixes
/// `00000000-0000-0000-0000-00000000000N`, N de 1 à 9, qui se comportent comme un lien
/// magique jamais consommé ni expiré — se connecter en dev sans aller chercher un lien
/// dans les logs. Le token 1 est le compte admin du bootstrap (s'il est fourni), les
/// autres `devN@dev.local`. En release le flow d'auth reste strict (CLAUDE.md
/// § Authentification).
#[cfg(debug_assertions)]
fn dev_login_email(token: Uuid, state: &AppState) -> Option<Email> {
    let n = token.as_u128();
    if !(1..=DEV_LOGIN_TOKENS).contains(&n) {
        return None;
    }
    if n == 1
        && let Some(admin) = &state.bootstrap_admin_email
    {
        return Some(admin.clone());
    }
    Some(Email::parse(&format!("dev{n}@dev.local")).expect("email de dev valide"))
}

#[cfg(not(debug_assertions))]
fn dev_login_email(_token: Uuid, _state: &AppState) -> Option<Email> {
    None
}

/// Stories 35-37 : le changement de profil est diffusé aux autres clients
/// authentifiés ; l'auteur le reçoit en réponse.
fn user_updated(
    state: &AppState,
    conn: ConnId,
    profile: proto::UserProfile,
) -> proto::server_envelope::Payload {
    let updated = proto::server_envelope::Payload::UserUpdated(proto::UserUpdated {
        profile: Some(profile),
    });
    let event = proto::ServerEnvelope {
        request_id: String::new(),
        payload: Some(updated.clone()),
    };
    registry::broadcast(&state.registry, conn, &server_frame(&event));
    updated
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
    let login_email = match art.get(magic_link_key.as_bytes()) {
        Some(email_val) => {
            art.del(magic_link_key.as_bytes());
            let email_bytes = email_val
                .as_bytes()
                .expect("magic_link:{token} toujours stocké en Value::String");
            let email_str = email_bytes
                .as_str()
                .expect("email toujours UTF-8 (garanti par Email::parse à l'écriture)");
            Some(Email::parse(email_str).expect("email re-normalisé toujours valide"))
        }
        None => dev_login_email(token, state),
    };
    let (user, session_token) = if let Some(email) = login_email {
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
                load_user(&mut art, id)
            }
            None => {
                let id = art
                    .incr(SharedByte::from_str("id_counter"))
                    .expect("id_counter jamais utilisé pour autre chose qu'un entier")
                    as u64;
                let is_admin = state.bootstrap_admin_email.as_ref() == Some(&email);
                // Pseudo vide : choisi ensuite par SetPseudo (story 34).
                let user = proto::User {
                    id,
                    email: email.to_string(),
                    is_admin,
                    pseudo: String::new(),
                    avatar_version: 0,
                    status: proto::Status::Online as i32,
                };
                save_user(&mut art, &user);
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
        state.dirty.set(true);
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
        (load_user(&mut art, id), token) // token de session déjà valide : pas de rotation, renvoyé tel quel
    };

    user_id_slot.replace(user.id);
    let channels = list_channels(&art, user.id);
    let users = list_profiles(&art);
    Ok(proto::AuthResponse {
        me: Some(user),
        channels,
        session_token: session_token.to_string(),
        users,
        online_user_ids: Vec::new(), // rempli par l'appelant, après `presence::connected`
    })
}

fn save_user(art: &mut OxidArt, user: &proto::User) {
    let encoded = bincode::serialize(user).expect("sérialisation User");
    art.set(
        SharedByte::from_str(&format!("user:{}", user.id)),
        Value::String(SharedByte::from_slice(encoded)),
    );
}

fn profile(user: &proto::User) -> proto::UserProfile {
    proto::UserProfile {
        id: user.id,
        pseudo: user.pseudo.clone(),
        avatar_version: user.avatar_version,
    }
}

/// Story 36 : profils de tous les comptes qui ont choisi un pseudo (un compte sans
/// pseudo n'a rien pu écrire, cf. `require_pseudo`, donc personne n'a à l'afficher).
fn list_profiles(art: &OxidArt) -> Vec<proto::UserProfile> {
    art.krange(b"user:", b"", usize::MAX, false)
        .iter()
        .map(|(_, val)| {
            bincode::deserialize::<proto::User>(range_bytes(val, "user:{id}"))
                .expect("user:{id} corrompu")
        })
        .filter(|u| !u.pseudo.is_empty())
        .map(|u| profile(&u))
        .collect()
}

/// Story 34 : aucune écriture (message, salon, suppression, photo) tant que le pseudo
/// n'est pas choisi — tout auteur visible par les autres a un pseudo.
fn require_pseudo(art: &mut OxidArt, user_id: u64) -> Result<proto::User, proto::Error> {
    let user = load_user(art, user_id);
    if user.pseudo.is_empty() {
        return Err(proto::Error {
            code: 403,
            message: "choisis d'abord un pseudo".to_string(),
        });
    }
    Ok(user)
}

fn pseudo_index_key(pseudo: &str) -> String {
    format!("pseudo_index:{}", pseudo.to_lowercase())
}

/// Stories 34-35 : choix ou changement de pseudo, unique casse ignorée via
/// `pseudo_index:{minuscules}`. Changer seulement la casse de son propre pseudo est
/// permis. Ancien index supprimé et nouveau posé dans le même emprunt.
fn set_pseudo(
    req: proto::SetPseudo,
    state: &AppState,
    user_id: Option<u64>,
) -> Result<proto::UserProfile, proto::Error> {
    let user_id = require_auth(user_id)?;
    let valid = validate::validate_set_pseudo(req)?;

    let mut art = state.art.borrow_mut();
    let mut user = load_user(&mut art, user_id);
    let new_index = pseudo_index_key(&valid.pseudo);
    if let Some(owner) = art.get(new_index.as_bytes()) {
        let owner = owner.as_bytes().expect("pseudo_index toujours Value::String");
        if owner.as_slice() != user_id.to_string().as_bytes() {
            return Err(proto::Error {
                code: 409,
                message: "pseudo déjà pris".to_string(),
            });
        }
    }
    if !user.pseudo.is_empty() {
        art.del(pseudo_index_key(&user.pseudo).as_bytes());
    }
    art.set(
        SharedByte::from_str(&new_index),
        Value::String(SharedByte::from_str(&user_id.to_string())),
    );
    user.pseudo = valid.pseudo;
    save_user(&mut art, &user);
    state.dirty.set(true);
    Ok(profile(&user))
}

/// Story 41 : statut choisi, mémorisé avec le compte. Un numéro de statut inconnu
/// (client plus récent) est refusé plutôt que ramené à En ligne.
fn set_status(
    req: proto::SetStatus,
    state: &AppState,
    user_id: Option<u64>,
) -> Result<proto::Status, proto::Error> {
    let user_id = require_auth(user_id)?;
    let status = proto::Status::try_from(req.status).map_err(|_| proto::Error {
        code: 400,
        message: "statut inconnu".to_string(),
    })?;
    let mut art = state.art.borrow_mut();
    let mut user = load_user(&mut art, user_id);
    user.set_status(status);
    save_user(&mut art, &user);
    state.dirty.set(true);
    Ok(status)
}

/// Story 37 : nouvelle photo (version = id tiré du compteur global, change à chaque
/// envoi) ou retrait (version 0, image supprimée).
fn set_avatar(
    req: proto::SetAvatar,
    state: &AppState,
    user_id: Option<u64>,
) -> Result<proto::UserProfile, proto::Error> {
    let user_id = require_auth(user_id)?;
    let valid = validate::validate_set_avatar(req)?;

    let mut art = state.art.borrow_mut();
    let mut user = require_pseudo(&mut art, user_id)?;
    let key = format!("avatar:{user_id}");
    match valid.image {
        Some(image) => {
            art.set(
                SharedByte::from_str(&key),
                Value::String(SharedByte::from_slice(image)),
            );
            user.avatar_version = art
                .incr(SharedByte::from_str("id_counter"))
                .expect("id_counter jamais utilisé pour autre chose qu'un entier")
                as u64;
        }
        None => {
            art.del(key.as_bytes());
            user.avatar_version = 0;
        }
    }
    save_user(&mut art, &user);
    state.dirty.set(true);
    Ok(profile(&user))
}

/// Story 36 : photo d'un utilisateur, lue par WebSocket faute de chemin HTTP pour les
/// images (story 37). 404 si l'utilisateur n'existe pas ou n'a pas de photo.
fn get_avatar(
    req: proto::GetAvatar,
    state: &AppState,
    user_id: Option<u64>,
) -> Result<proto::Avatar, proto::Error> {
    require_auth(user_id)?;
    let not_found = || proto::Error {
        code: 404,
        message: "pas de photo".to_string(),
    };
    let mut art = state.art.borrow_mut();
    let user_bytes = art
        .get(format!("user:{}", req.user_id).as_bytes())
        .ok_or_else(not_found)?;
    let user: proto::User = bincode::deserialize(
        user_bytes.as_bytes().expect("user:{id} toujours Value::String").as_slice(),
    )
    .expect("user:{id} corrompu");
    if user.avatar_version == 0 {
        return Err(not_found());
    }
    let image = art
        .get(format!("avatar:{}", user.id).as_bytes())
        .expect("avatar_version ≠ 0 sans avatar:{id} — invariant violé");
    Ok(proto::Avatar {
        user_id: user.id,
        avatar_version: user.avatar_version,
        image: image
            .as_bytes()
            .expect("avatar:{id} toujours Value::String")
            .as_slice()
            .to_vec(),
    })
}

/// Toute référence `user:{id}` vient d'un index ou d'une session écrits par
/// `handle_auth` dans le même emprunt que `user:{id}` lui-même : une absence est une
/// violation d'invariant, pas une erreur métier.
fn load_user(art: &mut OxidArt, id: u64) -> proto::User {
    let user_bytes = art
        .get(format!("user:{id}").as_bytes())
        .expect("référence vers user:{id} inexistant — invariant violé");
    bincode::deserialize(
        user_bytes.as_bytes().expect("user:{id} toujours Value::String").as_slice(),
    )
    .expect("user:{id} corrompu")
}

/// Story 8 : tous les salons sont visibles par tout le monde, sauf les DM (stories
/// 28-32), réservés à leurs deux participants. Triés par id (clés `keys::channel_key`).
fn list_channels(art: &OxidArt, user_id: u64) -> Vec<proto::Channel> {
    art.krange(keys::CHANNEL_PREFIX.as_bytes(), b"", usize::MAX, false)
        .iter()
        .map(|(_, val)| {
            bincode::deserialize::<proto::Channel>(range_bytes(val, "channel:{id}"))
                .expect("channel:{id} corrompu")
        })
        .filter(|c| {
            c.r#type() != proto::channel::Type::Dm || c.participant_ids.contains(&user_id)
        })
        .collect()
}

/// Valeur d'une entrée de `krange` : audio ne stocke que des `Value::String`.
fn range_bytes<'a>(val: RangeVal<'a>, what: &str) -> &'a [u8] {
    match val {
        RangeVal::Bytes(b) => b.as_slice(),
        RangeVal::Int(_) => panic!("{what} toujours Value::String"),
    }
}

/// Story 7 : création de salon texte, admin uniquement (seule distinction de
/// privilège du système, cf. CLAUDE.md), nom unique parmi les salons texte. Le statut admin est relu dans `user:{id}`
/// plutôt que mis en cache sur la connexion.
fn create_channel(
    req: proto::CreateChannel,
    state: &AppState,
    user_id: Option<u64>,
) -> Result<proto::Channel, proto::Error> {
    let user_id = require_auth(user_id)?;
    let valid = validate::validate_create_channel(req)?;

    let mut art = state.art.borrow_mut();
    if !require_pseudo(&mut art, user_id)?.is_admin {
        return Err(proto::Error {
            code: 403,
            message: "création de salon réservée à l'admin".to_string(),
        });
    }

    // Nom unique par type de salon (un salon texte et un salon vocal peuvent partager
    // un nom), sans tenir compte de la casse. Scan de `channel:` plutôt qu'un index
    // dédié : quelques salons, chemin non chaud.
    let lowered = valid.name.to_lowercase();
    if list_channels(&art, user_id)
        .iter()
        .any(|c| c.r#type() == proto::channel::Type::Text && c.name.to_lowercase() == lowered)
    {
        return Err(proto::Error {
            code: 409,
            message: "un salon texte porte déjà ce nom".to_string(),
        });
    }

    let id = art
        .incr(SharedByte::from_str("id_counter"))
        .expect("id_counter jamais utilisé pour autre chose qu'un entier") as u64;
    let channel = proto::Channel {
        id,
        name: valid.name,
        r#type: proto::channel::Type::Text as i32,
        participant_ids: vec![],
    };
    let encoded = bincode::serialize(&channel).expect("sérialisation Channel");
    art.set(
        SharedByte::from_str(&keys::channel_key(id)),
        Value::String(SharedByte::from_slice(encoded)),
    );
    state.dirty.set(true);
    Ok(channel)
}

fn require_auth(user_id: Option<u64>) -> Result<u64, proto::Error> {
    user_id.ok_or_else(|| proto::Error {
        code: 401,
        message: "non authentifié".to_string(),
    })
}

/// Salon texte existant. Les DM sont refusés par toutes les opérations sur les
/// messages tant que leur livraison ciblée n'existe pas : le broadcast global les
/// montrerait à tout le monde.
fn check_text_channel(art: &mut OxidArt, channel_id: u64) -> Result<(), proto::Error> {
    let unknown = || proto::Error {
        code: 404,
        message: "salon inconnu".to_string(),
    };
    if !keys::is_sortable(channel_id) {
        return Err(unknown());
    }
    let channel_bytes = art
        .get(keys::channel_key(channel_id).as_bytes())
        .ok_or_else(unknown)?;
    let channel: proto::Channel = bincode::deserialize(
        channel_bytes.as_bytes().expect("channel:{id} toujours Value::String").as_slice(),
    )
    .expect("channel:{id} corrompu");
    if channel.r#type() != proto::channel::Type::Text {
        return Err(proto::Error {
            code: 400,
            message: "opération possible uniquement dans un salon texte".to_string(),
        });
    }
    Ok(())
}

fn decode_message(val: &Value) -> proto::Message {
    bincode::deserialize(
        val.as_bytes().expect("message toujours Value::String").as_slice(),
    )
    .expect("message corrompu")
}

/// Story 10 : envoi dans un salon texte existant, par n'importe quel utilisateur
/// authentifié (pas de « rejoindre », story 9).
fn send_message(
    req: proto::SendMessage,
    state: &AppState,
    user_id: Option<u64>,
) -> Result<proto::Message, proto::Error> {
    let user_id = require_auth(user_id)?;
    let valid = validate::validate_send_message(req)?;

    let mut art = state.art.borrow_mut();
    require_pseudo(&mut art, user_id)?;
    check_text_channel(&mut art, valid.channel_id)?;
    // Story 39 : le message cité doit exister dans ce salon (supprimé compris : on
    // peut répondre à un message supprimé entre-temps, la citation l'affichera).
    if let Some(reply_to_id) = valid.reply_to_id {
        load_message(&mut art, valid.channel_id, reply_to_id).map_err(|_| proto::Error {
            code: 404,
            message: "message cité inconnu".to_string(),
        })?;
    }

    let id = art
        .incr(SharedByte::from_str("id_counter"))
        .expect("id_counter jamais utilisé pour autre chose qu'un entier") as u64;
    let message = proto::Message {
        id,
        channel_id: valid.channel_id,
        user_id,
        content: valid.content,
        timestamp: now_ms(),
        deleted: false,
        reply_to_id: valid.reply_to_id.unwrap_or(0),
        edited_at: 0,
    };
    save_message(&mut art, &message);
    state.dirty.set(true);
    Ok(message)
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("horloge avant 1970")
        .as_millis() as u64
}

fn save_message(art: &mut OxidArt, message: &proto::Message) {
    let encoded = bincode::serialize(message).expect("sérialisation Message");
    art.set(
        SharedByte::from_str(&keys::message_key(message.channel_id, message.id)),
        Value::String(SharedByte::from_slice(encoded)),
    );
}

/// Message `message_id` du salon, 404 s'il n'existe pas (id client hors borne compris).
fn load_message(
    art: &mut OxidArt,
    channel_id: u64,
    message_id: u64,
) -> Result<proto::Message, proto::Error> {
    let unknown = || proto::Error {
        code: 404,
        message: "message inconnu".to_string(),
    };
    if !keys::is_sortable(message_id) {
        return Err(unknown());
    }
    art.get(keys::message_key(channel_id, message_id).as_bytes())
        .map(|val| decode_message(&val))
        .ok_or_else(unknown)
}

/// Story 40 : modification par l'auteur seul (l'admin peut supprimer mais pas faire
/// dire quelque chose à quelqu'un), pas sur un tombstone. Pas d'historique : seul le
/// dernier contenu et `edited_at` sont gardés.
fn edit_message(
    req: proto::EditMessage,
    state: &AppState,
    user_id: Option<u64>,
) -> Result<proto::Message, proto::Error> {
    let user_id = require_auth(user_id)?;
    let valid = validate::validate_edit_message(req)?;

    let mut art = state.art.borrow_mut();
    require_pseudo(&mut art, user_id)?;
    check_text_channel(&mut art, valid.channel_id)?;
    let mut message = load_message(&mut art, valid.channel_id, valid.message_id)?;
    if message.user_id != user_id {
        return Err(proto::Error {
            code: 403,
            message: "seul l'auteur peut modifier ce message".to_string(),
        });
    }
    if message.deleted {
        return Err(proto::Error {
            code: 400,
            message: "message supprimé".to_string(),
        });
    }
    message.content = valid.content;
    message.edited_at = now_ms();
    save_message(&mut art, &message);
    state.dirty.set(true);
    Ok(message)
}

/// Stories 12 et 15 : messages d'id > `last_seen_id`, tombstones compris, triés par
/// id (`krange` strictement après la clé de `last_seen_id`). En v1 le client envoie 0
/// à la reconnexion et reçoit tout le salon (cf. user-stories.md, story 15).
fn sync_messages(
    req: proto::SyncRequest,
    state: &AppState,
    user_id: Option<u64>,
) -> Result<proto::SyncResponse, proto::Error> {
    require_auth(user_id)?;
    let mut art = state.art.borrow_mut();
    check_text_channel(&mut art, req.channel_id)?;
    // Au-delà de la borne des clés, aucun message ne peut suivre `last_seen_id`.
    let messages = if keys::is_sortable(req.last_seen_id) {
        let prefix = keys::message_prefix(req.channel_id);
        let from = keys::message_key(req.channel_id, req.last_seen_id);
        art.krange(prefix.as_bytes(), from.as_bytes(), usize::MAX, false)
            .iter()
            .map(|(_, val)| {
                bincode::deserialize(range_bytes(val, "message")).expect("message corrompu")
            })
            .collect()
    } else {
        Vec::new()
    };
    Ok(proto::SyncResponse {
        channel_id: req.channel_id,
        messages,
    })
}

/// Stories 13-14 : tombstone, pas de suppression physique — le contenu est effacé,
/// le message reste avec `deleted = true` pour que la resync le reflète. Droit :
/// l'auteur, ou l'admin sur n'importe quel message. Supprimer un message déjà
/// supprimé est accepté (idempotent) et rediffusé.
fn delete_message(
    req: proto::DeleteMessage,
    state: &AppState,
    user_id: Option<u64>,
) -> Result<proto::MessageDeleted, proto::Error> {
    let user_id = require_auth(user_id)?;
    let mut art = state.art.borrow_mut();
    let user = require_pseudo(&mut art, user_id)?;
    check_text_channel(&mut art, req.channel_id)?;

    let mut message = load_message(&mut art, req.channel_id, req.message_id)?;
    if message.user_id != user_id && !user.is_admin {
        return Err(proto::Error {
            code: 403,
            message: "seuls l'auteur et l'admin peuvent supprimer ce message".to_string(),
        });
    }

    message.deleted = true;
    message.content.clear();
    save_message(&mut art, &message);
    state.dirty.set(true);
    Ok(proto::MessageDeleted {
        channel_id: req.channel_id,
        message_id: req.message_id,
    })
}

fn compute_accept(key: &str) -> String {
    let mut data = String::with_capacity(key.len() + WS_GUID.len());
    data.push_str(key);
    data.push_str(WS_GUID);
    let hash = digest(&SHA1_FOR_LEGACY_USE_ONLY, data.as_bytes());
    BASE64.encode(hash.as_ref())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Pseudo accentué en clé brute : oxidart accepte les clés binaires (radixox
    /// 9a3fd6c), plus besoin d'encoder l'index.
    #[test]
    fn pseudo_index_accentue() {
        let mut art = OxidArt::new();
        let key = pseudo_index_key("LÉA");
        assert_eq!(key, "pseudo_index:léa");
        art.set(SharedByte::from_str(&key), Value::String(SharedByte::from_str("7")));
        assert!(art.get(pseudo_index_key("Léa").as_bytes()).is_some());
        assert!(art.get(pseudo_index_key("Lea").as_bytes()).is_none());
    }
}
