mod codec;
mod email;
mod http;
mod keys;
mod media;
mod persist;
mod presence;
mod reads;
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
use monoio::io::{AsyncReadRent, OwnedReadHalf, Splitable};
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
    media: Rc<media::MediaConfig>,
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
        media: Rc::new(media::MediaConfig::from_env(&persist::data_dir())),
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
    let tls = match acceptor.accept(stream).await {
        Ok(tls) => tls,
        Err(e) => {
            eprintln!("handshake TLS échoué: {e:?}");
            return;
        }
    };
    http::serve(tls, state).await;
}

// Boucle de lecture : une frame binaire entrante = un ClientEnvelope protobuf. Le flux
// TLS est découpé : cette tâche garde la moitié lecture, la moitié écriture vit dans le
// registre, par lequel passent la réponse directe comme les broadcasts poussés par
// d'autres connexions (cf. registry.rs).
// Story 33 : l'auth se fait une fois par connexion WebSocket (AuthRequest), puis
// l'identité est portée par `user_id` en mémoire pour toute la durée de vie de cette
// connexion — aucune requête suivante n'a besoin de reporter un token.
/// `pending` : octets déjà lus après la requête d'upgrade (début de frame éventuel).
async fn handle_ws_connection(tls: TlsStream, state: AppState, pending: Vec<u8>) {
    let (read, write) = tls.into_split();
    let conn = state.registry.borrow_mut().insert(write);
    read_loop(read, conn, &state, pending).await;
    state.registry.borrow_mut().remove(conn);
    presence::disconnected(&state.presence, &state.registry, conn);
    println!("[ws] connexion terminée");
}

/// Les octets lus s'accumulent dans `pending` jusqu'à former des frames complètes :
/// une lecture peut porter une demi-frame (photo de profil de plusieurs records TLS)
/// comme plusieurs frames. Une frame invalide ferme la connexion.
async fn read_loop(
    mut read: OwnedReadHalf<TlsStream>,
    conn: ConnId,
    state: &AppState,
    mut pending: Vec<u8>,
) {
    let mut chunk = vec![0u8; 16 * 1024];
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
                    let me = response.me.as_ref().expect("AuthResponse.me toujours rempli");
                    state.registry.borrow_mut().mark_authenticated(conn, me.id);
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
            Ok(sent) => {
                // Story 28 : premier message d'un DM, l'autre découvre la conversation
                // juste avant le message (même file d'envoi, donc dans cet ordre).
                if let Some((other, conversation)) = sent.dm_revealed {
                    let opened = event(proto::server_envelope::Payload::DmOpened(
                        proto::DmOpened {
                            conversation: Some(conversation),
                        },
                    ));
                    registry::send_to_users(&state.registry, &[other], None, &opened);
                }
                let new_message = proto::server_envelope::Payload::NewMessage(
                    proto::NewMessage {
                        message: Some(sent.message),
                    },
                );
                // Story 11 : broadcast global pour un salon (pas d'abonnement), story 29 :
                // aux seuls participants pour un DM ; l'émetteur le reçoit en réponse.
                notify(state, conn, &sent.audience, &new_message);
                new_message
            }
            Err(err) => proto::server_envelope::Payload::Error(err),
        },
        Some(Payload::Sync(req)) => match sync_messages(req, state, *user_id) {
            Ok(response) => proto::server_envelope::Payload::SyncResponse(response),
            Err(err) => proto::server_envelope::Payload::Error(err),
        },
        Some(Payload::DeleteMessage(req)) => match delete_message(req, state, *user_id) {
            Ok((deleted, audience)) => {
                let deleted = proto::server_envelope::Payload::MessageDeleted(deleted);
                notify(state, conn, &audience, &deleted);
                deleted
            }
            Err(err) => proto::server_envelope::Payload::Error(err),
        },
        Some(Payload::EditMessage(req)) => match edit_message(req, state, *user_id) {
            Ok((message, audience)) => {
                let edited = proto::server_envelope::Payload::MessageEdited(
                    proto::MessageEdited {
                        message: Some(message),
                    },
                );
                notify(state, conn, &audience, &edited);
                edited
            }
            Err(err) => proto::server_envelope::Payload::Error(err),
        },
        Some(Payload::OpenDm(req)) => match open_dm(req, state, *user_id) {
            Ok(conversation) => {
                let opened = proto::server_envelope::Payload::DmOpened(proto::DmOpened {
                    conversation: Some(conversation),
                });
                // Mes autres onglets/appareils l'ont aussi ; l'autre participant
                // seulement au premier message (story 28).
                let me = user_id.expect("open_dm exige l'auth");
                registry::send_to_users(&state.registry, &[me], Some(conn), &event(opened.clone()));
                opened
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
        Some(Payload::SetTheme(req)) => match set_theme(req, state, *user_id) {
            Ok(theme) => {
                let set = proto::server_envelope::Payload::ThemeSet(proto::ThemeSet { theme: theme as i32 });
                // Story 55 : mes autres onglets/appareils basculent aussi, personne d'autre.
                let me = user_id.expect("set_theme exige l'auth");
                registry::send_to_users(&state.registry, &[me], Some(conn), &event(set.clone()));
                set
            }
            Err(err) => proto::server_envelope::Payload::Error(err),
        },
        Some(Payload::MarkRead(req)) => {
            let marked = require_auth(*user_id).and_then(|me| {
                let mut art = state.art.borrow_mut();
                load_conversation(&mut art, req.channel_id, me)?;
                let last = reads::mark_read(&mut art, me, req.channel_id, req.message_id.min(keys::MAX_ID));
                state.dirty.set(true);
                Ok((me, last))
            });
            match marked {
                Ok((me, last_read_id)) => {
                    let marked = proto::server_envelope::Payload::ReadMarked(proto::ReadMarked {
                        channel_id: req.channel_id,
                        last_read_id,
                    });
                    // Story 56 : mes autres appareils effacent aussi le badge.
                    registry::send_to_users(&state.registry, &[me], Some(conn), &event(marked.clone()));
                    marked
                }
                Err(err) => proto::server_envelope::Payload::Error(err),
            }
        }
        Some(Payload::SetSettings(req)) => {
            let saved = require_auth(*user_id).and_then(|me| {
                let settings = req.settings.unwrap_or_default();
                let saved = reads::set_settings(&mut state.art.borrow_mut(), me, settings)?;
                state.dirty.set(true);
                Ok((me, saved))
            });
            match saved {
                Ok((me, settings)) => {
                    let set = proto::server_envelope::Payload::SettingsSet(proto::SettingsSet {
                        settings: Some(settings),
                    });
                    registry::send_to_users(&state.registry, &[me], Some(conn), &event(set.clone()));
                    set
                }
                Err(err) => proto::server_envelope::Payload::Error(err),
            }
        }
        Some(Payload::SetPseudo(req)) => match set_pseudo(req, state, *user_id) {
            Ok(profile) => user_updated(state, conn, profile),
            Err(err) => proto::server_envelope::Payload::Error(err),
        },
        Some(Payload::DeleteMedia(req)) => {
            let deleted = require_auth(*user_id).and_then(|me| {
                media::delete(&mut state.art.borrow_mut(), &state.media, &req.media_id, me)
            });
            match deleted {
                Ok(()) => {
                    state.dirty.set(true);
                    let deleted = proto::server_envelope::Payload::MediaDeleted(proto::MediaDeleted {
                        media_id: req.media_id,
                    });
                    // Story 50 : partout où le lien apparaît, « image supprimée ».
                    registry::broadcast(&state.registry, conn, &event(deleted.clone()));
                    deleted
                }
                Err(err) => proto::server_envelope::Payload::Error(err),
            }
        }
        Some(Payload::GetMedia(req)) => match get_media_info(req, state, *user_id) {
            Ok(info) => proto::server_envelope::Payload::MediaInfo(info),
            Err(err) => proto::server_envelope::Payload::Error(err),
        },
        Some(Payload::RequestDownload(req)) => {
            let ticket = require_auth(*user_id).and_then(|_| {
                let mut art = state.art.borrow_mut();
                if !media::is_media_id(&req.media_id) || media::load(&mut art, &req.media_id).is_none() {
                    return Err(media::not_found());
                }
                let kind = if req.inline { media::Ticket::Stream } else { media::Ticket::Download };
                Ok(media::create_ticket(&mut art, &req.media_id, kind))
            });
            match ticket {
                Ok(ticket) => proto::server_envelope::Payload::DownloadTicket(proto::DownloadTicket {
                    media_id: req.media_id,
                    ticket,
                }),
                Err(err) => proto::server_envelope::Payload::Error(err),
            }
        }
        Some(Payload::SetBio(req)) => match set_bio(req, state, *user_id) {
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

/// Événement poussé (request_id vide), déjà encodé en frame.
fn event(payload: proto::server_envelope::Payload) -> Vec<u8> {
    server_frame(&proto::ServerEnvelope {
        request_id: String::new(),
        payload: Some(payload),
    })
}

/// Destinataires d'un événement sur les messages d'une conversation.
enum Audience {
    /// Salon : tout le monde voit tout (story 11).
    Everyone,
    /// DM : les deux participants seulement (story 29).
    Participants([u64; 2]),
}

/// Pousse l'événement aux destinataires sauf l'émetteur, qui l'a en réponse.
fn notify(state: &AppState, conn: ConnId, audience: &Audience, payload: &proto::server_envelope::Payload) {
    let frame = event(payload.clone());
    match audience {
        Audience::Everyone => registry::broadcast(&state.registry, conn, &frame),
        Audience::Participants(users) => {
            registry::send_to_users(&state.registry, users, Some(conn), &frame)
        }
    }
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
                    bio: String::new(),
                    theme: proto::Theme::System as i32,
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
        let id = session_user(&mut art, token).ok_or_else(invalid_token)?;
        (load_user(&mut art, id), token) // token de session déjà valide : pas de rotation, renvoyé tel quel
    };

    user_id_slot.replace(user.id);
    let channels = list_channels(&art);
    let users = list_profiles(&art);
    let dms = list_dms(&mut art, user.id);
    // Story 56 : non-lus de chaque conversation visible.
    let unread = channels
        .iter()
        .map(|c| c.id)
        .chain(dms.iter().filter_map(|d| d.channel.as_ref().map(|c| c.id)))
        .map(|id| reads::unread(&mut art, user.id, id))
        .collect();
    let settings = Some(reads::settings(&mut art, user.id));
    Ok(proto::AuthResponse {
        me: Some(user),
        channels,
        session_token: session_token.to_string(),
        users,
        online_user_ids: Vec::new(), // rempli par l'appelant, après `presence::connected`
        dms,
        unread,
        settings,
    })
}

/// Utilisateur d'un token de session (story 33) : WebSocket (`AuthRequest`) et HTTP
/// (`Authorization: Bearer`, images).
fn session_user(art: &mut OxidArt, token: Uuid) -> Option<u64> {
    let id_val = art.get(format!("session:{token}").as_bytes())?;
    Some(
        id_val
            .as_bytes()
            .expect("session:{token} toujours Value::String")
            .as_str()
            .expect("id toujours ASCII")
            .parse()
            .expect("session id toujours numérique"),
    )
}

fn save_user(art: &mut OxidArt, user: &proto::User) {
    let encoded = codec::encode(user);
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
        bio: user.bio.clone(),
    }
}

/// Story 36 : profils de tous les comptes qui ont choisi un pseudo (un compte sans
/// pseudo n'a rien pu écrire, cf. `require_pseudo`, donc personne n'a à l'afficher).
fn list_profiles(art: &OxidArt) -> Vec<proto::UserProfile> {
    art.krange(b"user:", b"", usize::MAX, false)
        .iter()
        .map(|(_, val)| {
            codec::decode::<proto::User>(range_bytes(val, "user:{id}"), "user:{id}")
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

/// Story 55 : thème mémorisé avec le compte ; un numéro inconnu est refusé.
fn set_theme(
    req: proto::SetTheme,
    state: &AppState,
    user_id: Option<u64>,
) -> Result<proto::Theme, proto::Error> {
    let user_id = require_auth(user_id)?;
    let theme = proto::Theme::try_from(req.theme).map_err(|_| proto::Error {
        code: 400,
        message: "thème inconnu".to_string(),
    })?;
    let mut art = state.art.borrow_mut();
    let mut user = load_user(&mut art, user_id);
    user.set_theme(theme);
    save_user(&mut art, &user);
    state.dirty.set(true);
    Ok(theme)
}

/// Au plus autant d'ids par `GetMedia` : un salon affiche rarement plus de médias
/// d'un coup, et la réponse reste petite.
const MAX_MEDIA_PER_REQUEST: usize = 500;

/// Story 51 : métadonnées (nom, taille, type, propriétaire) sans le contenu ; les ids
/// inconnus, mal formés ou supprimés sont simplement absents de la réponse.
fn get_media_info(
    req: proto::GetMedia,
    state: &AppState,
    user_id: Option<u64>,
) -> Result<proto::MediaInfo, proto::Error> {
    require_auth(user_id)?;
    if req.media_ids.len() > MAX_MEDIA_PER_REQUEST {
        return Err(proto::Error {
            code: 400,
            message: format!("{MAX_MEDIA_PER_REQUEST} médias max par requête"),
        });
    }
    let mut art = state.art.borrow_mut();
    let media = req
        .media_ids
        .iter()
        .filter(|id| media::is_media_id(id))
        .filter_map(|id| media::load(&mut art, id))
        .map(|stored| stored.meta)
        .collect();
    Ok(proto::MediaInfo { media })
}

/// Story 43 : description de profil, diffusée comme un changement de pseudo.
fn set_bio(
    req: proto::SetBio,
    state: &AppState,
    user_id: Option<u64>,
) -> Result<proto::UserProfile, proto::Error> {
    let user_id = require_auth(user_id)?;
    let valid = validate::validate_set_bio(req)?;
    let mut art = state.art.borrow_mut();
    let mut user = require_pseudo(&mut art, user_id)?;
    user.bio = valid.bio;
    save_user(&mut art, &user);
    state.dirty.set(true);
    Ok(profile(&user))
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
    let user: proto::User = codec::decode(user_bytes.as_bytes().expect("user:{id} toujours Value::String").as_slice(), "user:{id}");
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
    codec::decode(user_bytes.as_bytes().expect("user:{id} toujours Value::String").as_slice(), "user:{id}")
}

/// Story 8 : tous les salons sont visibles par tout le monde. Les DM vivent sous
/// `dm:` (stories 28-32), jamais parcourus ici. Triés par id (`keys::channel_key`).
fn list_channels(art: &OxidArt) -> Vec<proto::Channel> {
    art.krange(keys::CHANNEL_PREFIX.as_bytes(), b"", usize::MAX, false)
        .iter()
        .map(|(_, val)| {
            codec::decode::<proto::Channel>(range_bytes(val, "channel:{id}"), "channel:{id}")
        })
        .collect()
}

/// Story 30 : mes DM, via `user_dms:{moi}:` — ne lit que mes entrées, pas celles des
/// autres. Dernière activité = dernier message, lu par un `krange` inversé à une
/// entrée (aucun champ à tenir à jour à chaque envoi).
fn list_dms(art: &mut OxidArt, user_id: u64) -> Vec<proto::Conversation> {
    let dm_ids: Vec<u64> = art
        .krange(keys::user_dms_prefix(user_id).as_bytes(), b"", usize::MAX, false)
        .iter()
        .map(|(_, val)| parse_id(range_bytes(val, "user_dms")))
        .collect();
    dm_ids
        .into_iter()
        .map(|id| {
            let channel = load_dm(art, id);
            conversation(art, channel)
        })
        .collect()
}

fn parse_id(bytes: &[u8]) -> u64 {
    std::str::from_utf8(bytes)
        .ok()
        .and_then(|s| s.parse().ok())
        .expect("id stocké en décimal")
}

/// DM référencé par un index écrit dans le même emprunt que lui : absence = invariant
/// violé.
fn load_dm(art: &mut OxidArt, id: u64) -> proto::Channel {
    let val = art.get(keys::dm_key(id).as_bytes()).expect("user_dms → dm:{id} inexistant");
    codec::decode(val.as_bytes().expect("dm:{id} toujours Value::String").as_slice(), "dm:{id}")
}

fn conversation(art: &OxidArt, channel: proto::Channel) -> proto::Conversation {
    let prefix = keys::message_prefix(channel.id);
    let last_message_id = art
        .krange(prefix.as_bytes(), b"", 1, true)
        .iter()
        .next()
        .map(|(key, _)| {
            keys::parse_sortable_id(&key[prefix.len()..]).expect("clé message:{ch}:{id} valide")
        })
        .unwrap_or(0);
    proto::Conversation {
        channel: Some(channel),
        last_message_id,
    }
}

/// Story 28 : DM avec `req.user_id`, l'existant s'il y en a un (créé par moi ou par
/// l'autre), sinon un nouveau. Seule mon entrée `user_dms` est posée ici : l'autre
/// n'apprend l'existence du DM qu'au premier message (`send_message`).
fn open_dm(
    req: proto::OpenDm,
    state: &AppState,
    user_id: Option<u64>,
) -> Result<proto::Conversation, proto::Error> {
    let user_id = require_auth(user_id)?;
    let mut art = state.art.borrow_mut();
    require_pseudo(&mut art, user_id)?;
    let other = req.user_id;
    if other == user_id {
        return Err(proto::Error {
            code: 400,
            message: "pas de conversation privée avec soi-même".to_string(),
        });
    }
    let unknown = || proto::Error {
        code: 404,
        message: "utilisateur inconnu".to_string(),
    };
    if !keys::is_sortable(other) {
        return Err(unknown());
    }
    let other_user = art
        .get(format!("user:{other}").as_bytes())
        .map(|val| {
            codec::decode::<proto::User>(val.as_bytes().expect("user:{id} toujours Value::String").as_slice(), "user:{id}")
        })
        .ok_or_else(unknown)?;
    if other_user.pseudo.is_empty() {
        return Err(unknown());
    }

    let mine = keys::user_dm_key(user_id, other);
    if let Some(val) = art.get(mine.as_bytes()) {
        let id = parse_id(val.as_bytes().expect("user_dms toujours Value::String").as_slice());
        let channel = load_dm(&mut art, id);
        return Ok(conversation(&art, channel));
    }
    let channel = match art.get(keys::user_dm_key(other, user_id).as_bytes()) {
        Some(val) => {
            load_dm(&mut art, parse_id(val.as_bytes().expect("user_dms toujours Value::String").as_slice()))
        }
        None => {
            let id = art
                .incr(SharedByte::from_str("id_counter"))
                .expect("id_counter jamais utilisé pour autre chose qu'un entier")
                as u64;
            let channel = proto::Channel {
                id,
                name: String::new(),
                r#type: proto::channel::Type::Dm as i32,
                participant_ids: vec![user_id, other],
            };
            let encoded = codec::encode(&channel);
            art.set(
                SharedByte::from_str(&keys::dm_key(id)),
                Value::String(SharedByte::from_slice(encoded)),
            );
            channel
        }
    };
    art.set(
        SharedByte::from_str(&mine),
        Value::String(SharedByte::from_str(&channel.id.to_string())),
    );
    state.dirty.set(true);
    Ok(conversation(&art, channel))
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
    if list_channels(&art)
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
    let encoded = codec::encode(&channel);
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

/// Conversation où `user_id` peut lire et écrire : un salon texte (tout le monde) ou
/// un DM dont il est participant. Story 32 : un DM dont on n'est pas participant
/// répond 404 comme s'il n'existait pas — admin compris.
fn load_conversation(
    art: &mut OxidArt,
    channel_id: u64,
    user_id: u64,
) -> Result<Audience, proto::Error> {
    let unknown = || proto::Error {
        code: 404,
        message: "conversation inconnue".to_string(),
    };
    if !keys::is_sortable(channel_id) {
        return Err(unknown());
    }
    if art.get(keys::channel_key(channel_id).as_bytes()).is_some() {
        return Ok(Audience::Everyone);
    }
    let Some(val) = art.get(keys::dm_key(channel_id).as_bytes()) else {
        return Err(unknown());
    };
    let dm: proto::Channel =
        codec::decode(val.as_bytes().expect("dm:{id} toujours Value::String").as_slice(), "dm:{id}");
    match dm.participant_ids[..] {
        [a, b] if a == user_id || b == user_id => Ok(Audience::Participants([a, b])),
        _ => Err(unknown()),
    }
}

fn decode_message(val: &Value) -> proto::Message {
    codec::decode(val.as_bytes().expect("message toujours Value::String").as_slice(), "message")
}

struct Sent {
    message: proto::Message,
    audience: Audience,
    /// Story 28 : premier message d'un DM — l'autre participant et la conversation à
    /// lui révéler.
    dm_revealed: Option<(u64, proto::Conversation)>,
}

/// Story 10 : envoi dans un salon texte existant, par n'importe quel utilisateur
/// authentifié (pas de « rejoindre », story 9), ou dans un DM dont on est
/// participant (story 31).
fn send_message(
    req: proto::SendMessage,
    state: &AppState,
    user_id: Option<u64>,
) -> Result<Sent, proto::Error> {
    let user_id = require_auth(user_id)?;
    let valid = validate::validate_send_message(req)?;

    let mut art = state.art.borrow_mut();
    require_pseudo(&mut art, user_id)?;
    let audience = load_conversation(&mut art, valid.channel_id, user_id)?;
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

    // Story 28 : l'entrée `user_dms` de l'autre n'est posée qu'au premier message.
    let mut dm_revealed = None;
    if let Audience::Participants([a, b]) = audience {
        let other = if a == user_id { b } else { a };
        let theirs = keys::user_dm_key(other, user_id);
        if art.get(theirs.as_bytes()).is_none() {
            art.set(
                SharedByte::from_str(&theirs),
                Value::String(SharedByte::from_str(&valid.channel_id.to_string())),
            );
            let channel = load_dm(&mut art, valid.channel_id);
            dm_revealed = Some((other, conversation(&art, channel)));
        }
    }
    state.dirty.set(true);
    Ok(Sent {
        message,
        audience,
        dm_revealed,
    })
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("horloge avant 1970")
        .as_millis() as u64
}

fn save_message(art: &mut OxidArt, message: &proto::Message) {
    let encoded = codec::encode(message);
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
) -> Result<(proto::Message, Audience), proto::Error> {
    let user_id = require_auth(user_id)?;
    let valid = validate::validate_edit_message(req)?;

    let mut art = state.art.borrow_mut();
    require_pseudo(&mut art, user_id)?;
    let audience = load_conversation(&mut art, valid.channel_id, user_id)?;
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
    Ok((message, audience))
}

/// Stories 12 et 15 : messages d'id > `last_seen_id`, tombstones compris, triés par
/// id (`krange` strictement après la clé de `last_seen_id`). En v1 le client envoie 0
/// à la reconnexion et reçoit tout le salon (cf. user-stories.md, story 15).
fn sync_messages(
    req: proto::SyncRequest,
    state: &AppState,
    user_id: Option<u64>,
) -> Result<proto::SyncResponse, proto::Error> {
    let user_id = require_auth(user_id)?;
    let mut art = state.art.borrow_mut();
    load_conversation(&mut art, req.channel_id, user_id)?;
    if req.limit > 0 {
        return Ok(sync_page(&art, req.channel_id, req.before_id, req.limit));
    }
    // Au-delà de la borne des clés, aucun message ne peut suivre `last_seen_id`.
    let messages = if keys::is_sortable(req.last_seen_id) {
        let prefix = keys::message_prefix(req.channel_id);
        let from = keys::message_key(req.channel_id, req.last_seen_id);
        art.krange(prefix.as_bytes(), from.as_bytes(), usize::MAX, false)
            .iter()
            .map(|(_, val)| {
                codec::decode(range_bytes(val, "message"), "message")
            })
            .collect()
    } else {
        Vec::new()
    };
    Ok(proto::SyncResponse {
        channel_id: req.channel_id,
        messages,
        has_more: false,
    })
}

/// Au plus autant de messages par page (story 64).
const MAX_PAGE: u32 = 200;

/// Story 64 : les `limit` messages qui précèdent `before_id` (0 = les plus récents),
/// par un `krange` inversé d'une entrée de plus — qui dit seulement s'il en reste.
fn sync_page(art: &OxidArt, channel_id: u64, before_id: u64, limit: u32) -> proto::SyncResponse {
    let limit = limit.min(MAX_PAGE) as usize;
    let prefix = keys::message_prefix(channel_id);
    let from = if before_id == 0 || !keys::is_sortable(before_id) {
        Vec::new()
    } else {
        keys::message_key(channel_id, before_id).into_bytes()
    };
    let mut messages: Vec<proto::Message> = art
        .krange(prefix.as_bytes(), &from, limit + 1, true)
        .iter()
        .map(|(_, val)| codec::decode(range_bytes(val, "message"), "message"))
        .collect();
    let has_more = messages.len() > limit;
    messages.truncate(limit);
    messages.reverse(); // du plus ancien au plus récent
    proto::SyncResponse {
        channel_id,
        messages,
        has_more,
    }
}

/// Stories 13-14 : tombstone, pas de suppression physique — le contenu est effacé,
/// le message reste avec `deleted = true` pour que la resync le reflète. Droit :
/// l'auteur, ou l'admin sur n'importe quel message d'un salon — dans un DM, l'auteur
/// seul (story 32). Supprimer un message déjà supprimé est accepté (idempotent) et
/// rediffusé.
fn delete_message(
    req: proto::DeleteMessage,
    state: &AppState,
    user_id: Option<u64>,
) -> Result<(proto::MessageDeleted, Audience), proto::Error> {
    let user_id = require_auth(user_id)?;
    let mut art = state.art.borrow_mut();
    let user = require_pseudo(&mut art, user_id)?;
    let audience = load_conversation(&mut art, req.channel_id, user_id)?;

    let mut message = load_message(&mut art, req.channel_id, req.message_id)?;
    let admin_override = user.is_admin && matches!(audience, Audience::Everyone);
    if message.user_id != user_id && !admin_override {
        return Err(proto::Error {
            code: 403,
            message: match audience {
                Audience::Everyone => "seuls l'auteur et l'admin peuvent supprimer ce message",
                Audience::Participants(_) => "seul l'auteur peut supprimer ce message privé",
            }
            .to_string(),
        });
    }

    message.deleted = true;
    message.content.clear();
    save_message(&mut art, &message);
    state.dirty.set(true);
    Ok((
        proto::MessageDeleted {
            channel_id: req.channel_id,
            message_id: req.message_id,
        },
        audience,
    ))
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

    #[test]
    fn pages_d_historique() {
        let mut art = OxidArt::new();
        for id in 1..=150u64 {
            let m = proto::Message {
                id,
                channel_id: 2,
                content: format!("m{id}"),
                ..Default::default()
            };
            save_message(&mut art, &m);
        }
        let ids = |r: &proto::SyncResponse| r.messages.iter().map(|m| m.id).collect::<Vec<_>>();
        let last = sync_page(&art, 2, 0, 64);
        assert_eq!(ids(&last), (87..=150).collect::<Vec<_>>());
        assert!(last.has_more);
        let before = sync_page(&art, 2, 87, 64);
        assert_eq!(ids(&before), (23..=86).collect::<Vec<_>>());
        let first = sync_page(&art, 2, 23, 64);
        assert_eq!(ids(&first), (1..=22).collect::<Vec<_>>());
        assert!(!first.has_more);
        let all = sync_page(&art, 2, 0, 10_000); // plafonné à MAX_PAGE, ici 150 < 200
        assert_eq!(all.messages.len(), 150);
        assert!(!all.has_more);
        assert!(sync_page(&art, 3, 0, 64).messages.is_empty(), "autre salon");
    }
}
