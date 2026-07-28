// Spike : valide que monoio-rustls + rustls-acme (Let's Encrypt staging) fonctionnent
// ensemble sous monoio (io_uring), sans dépendance à Tokio.
//
// Usage sur le VPS (port 443 doit être libre, DNS du domaine déjà pointé dessus) :
//   sudo setcap 'cap_net_bind_service=+ep' target/release/examples/acme_spike
//   ./target/release/examples/acme_spike <domaine> <email>
//
// Ou directement en root :
//   cargo run --release --example acme_spike -- spike.joshua-bouchat.fr contact@joshua-bouchat.fr

use std::sync::Arc;

use futures::StreamExt;
use monoio::io::AsyncWriteRentExt;
use monoio::net::TcpListener;
use rustls::ServerConfig;
use rustls_acme::{caches::DirCache, AcmeConfig};

#[monoio::main(timer_enabled = true)]
async fn main() {
    let mut args = std::env::args().skip(1);
    let domain = args
        .next()
        .expect("usage: acme_spike <domaine> <email>");
    let email = args
        .next()
        .expect("usage: acme_spike <domaine> <email>");

    println!("[spike] domaine={domain} email={email} (Let's Encrypt STAGING)");

    let mut state = AcmeConfig::new([domain.as_str()])
        .contact_push(format!("mailto:{email}"))
        .cache(DirCache::new("./acme_spike_cache"))
        .directory_lets_encrypt(false) // staging — pas de rate limit prod
        .state();

    let resolver = state.resolver();
    let provider = Arc::new(rustls::crypto::aws_lc_rs::default_provider());
    let mut config = ServerConfig::builder_with_provider(provider)
        .with_safe_default_protocol_versions()
        .expect("protocol versions")
        .with_no_client_auth()
        .with_cert_resolver(resolver);
    // TLS-ALPN-01 exige que le serveur négocie explicitement "acme-tls/1" pendant le
    // challenge — sans ça Let's Encrypt rejette même si le bon cert est présenté.
    // "http/1.1" reste nécessaire pour que les connexions normales (navigateur) négocient
    // toujours quelque chose une fois qu'on annonce une liste ALPN non vide.
    config.alpn_protocols = vec![b"acme-tls/1".to_vec(), b"http/1.1".to_vec()];
    let acceptor = monoio_rustls::TlsAcceptor::from(Arc::new(config));

    // rustls-acme ne spawn rien tout seul ("no persistent tasks spawned under the hood") —
    // c'est nous qui devons driver l'état ACME en pollant ce stream, cohérent avec le
    // modèle single-thread/single-runtime de monoio.
    monoio::spawn(async move {
        loop {
            match state.next().await {
                Some(Ok(event)) => println!("[spike][acme] event: {event:?}"),
                Some(Err(err)) => eprintln!("[spike][acme] error: {err:?}"),
                None => break,
            }
        }
    });

    let listener = TcpListener::bind("0.0.0.0:443").expect("bind :443");
    println!("[spike] en écoute sur :443 — https://{domain}/ (cert staging, navigateur va alerter, c'est normal)");

    loop {
        let (stream, addr) = match listener.accept().await {
            Ok(pair) => pair,
            Err(e) => {
                eprintln!("[spike] accept error: {e:?}");
                continue;
            }
        };
        let acceptor = acceptor.clone();
        monoio::spawn(async move {
            match acceptor.accept(stream).await {
                Ok(mut tls) => {
                    println!("[spike] handshake TLS OK depuis {addr}");
                    let body = b"Hello Tls! (monoio + rustls-acme spike)\n".to_vec();
                    let header = format!(
                        "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nContent-Type: text/plain\r\nConnection: close\r\n\r\n",
                        body.len()
                    );
                    let mut resp = header.into_bytes();
                    resp.extend_from_slice(&body);
                    if let (Err(e), _) = tls.write_all(resp).await {
                        eprintln!("[spike] write error depuis {addr}: {e:?}");
                    }
                }
                Err(e) => eprintln!("[spike] handshake TLS échoué depuis {addr}: {e:?}"),
            }
        });
    }
}
