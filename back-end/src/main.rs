mod accounts;
mod auth;
mod channels;
mod codec;
mod connection;
mod dispatch;
mod email;
mod http;
mod keys;
mod media;
mod messages;
mod persist;
mod presence;
mod reads;
mod proto;
mod registry;
mod users;
mod validate;
mod ws;

use std::cell::{Cell, RefCell};
use std::env;
use std::rc::Rc;
use std::sync::Arc;
use std::time::Duration;

use monoio::net::{TcpListener, TcpStream};
use oxidart::monoio::SharedArt;
use oxidart::OxidArt;
use rustls::ServerConfig;
use rustls::pki_types::pem::PemObject;
use rustls::pki_types::{CertificateDer, PrivateKeyDer};

use auth::{DEV_LOGIN_TOKENS, find_user_by_email};
use email::Email;
use presence::{Presence, SharedPresence};
use registry::SharedRegistry;

/// Story 69 : intervalle du ping serveur ; une connexion silencieuse pendant trois
/// intervalles (aucune trame, pas même un pong) est morte. `AUDIO_HEARTBEAT_MS` le
/// raccourcit (tests).
pub fn ping_every() -> Duration {
    env::var("AUDIO_HEARTBEAT_MS")
        .ok()
        .and_then(|ms| ms.parse().ok())
        .map(Duration::from_millis)
        .unwrap_or(Duration::from_secs(15))
}

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
    passwords: Rc<accounts::Passwords>,
}

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
        passwords: Rc::new(accounts::Passwords::load(&persist::data_dir())),
    };

    if cfg!(debug_assertions) {
        println!(
            "[dev] build debug : tokens de connexion permanents 00000000-0000-0000-0000-00000000000N \
             (N = 1..{DEV_LOGIN_TOKENS}, 1 = admin) — absents en release"
        );
    }

    // `AUDIO_LISTEN` : autre adresse que celle de dev, ex. un second serveur de test.
    let listen = env::var("AUDIO_LISTEN").unwrap_or_else(|_| "127.0.0.1:8443".into());
    // Story 65 : tant que le compte du bootstrap admin n'existe pas, une invitation
    // pour lui à chaque démarrage (la console reste la porte d'entrée initiale).
    if let Some(email) = &state.bootstrap_admin_email {
        let mut art = state.art.borrow_mut();
        if find_user_by_email(&mut art, email).is_none() {
            let invite = accounts::create_invite(&mut art, Duration::from_secs(7 * 24 * 3600));
            println!(
                "[boot] compte admin {email} à créer : ouvrir /?invite={} (7 jours, avec cet email)",
                invite.token
            );
        }
    }

    // Story 69 : un seul minuteur pour tout le serveur, pas un par connexion.
    let registry = state.registry.clone();
    monoio::spawn(async move {
        let ping = ws::encode_frame(0x9, &[]);
        loop {
            monoio::time::sleep(ping_every()).await;
            registry::ping_all(&registry, &ping);
        }
    });

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
