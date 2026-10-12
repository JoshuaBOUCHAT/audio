//! HTTP/1.1 sur le même port que le WebSocket (architecture.md § HTTP/1.1) : routage
//! de chaque connexion TLS, upgrade WebSocket, page d'index, et images (stories 27,
//! 45-50) — `POST /media` (envoi) et `GET /media/{id}` (lecture).
//!
//! Volontairement réduit : keep-alive, `Content-Length` obligatoire pour un corps (pas
//! de chunked), pas de compression ni de `Range`. Les requêtes s'accumulent dans un
//! tampon sur plusieurs lectures io_uring (un en-tête peut arriver en morceaux, un
//! corps d'image en plusieurs dizaines de records TLS).
//!
//! Auth des images par `Authorization: Bearer {session_token}` et non par cookie : le
//! client charge l'image en mémoire (comme les avatars), ce qui suivra la future app
//! Tauri, d'une autre origine que le serveur (story 48).

use std::time::{SystemTime, UNIX_EPOCH};

use aws_lc_rs::digest;
use monoio::fs::File;
use monoio::io::{AsyncReadRent, AsyncWriteRentExt};
use prost::Message;
use uuid::Uuid;

use crate::media::{self, StoredMedia};
use crate::registry::TlsStream;
use crate::{AppState, proto};

/// Au-delà, la requête est refusée (en-têtes de navigateur : quelques Ko).
const MAX_HEAD: usize = 16 * 1024;
const CHUNK: usize = 64 * 1024;

struct Head {
    method: String,
    path: String,
    content_length: Option<u64>,
    authorization: Option<String>,
    ws_key: Option<String>,
    keep_alive: bool,
}

/// Une connexion TLS : requêtes HTTP successives (keep-alive), jusqu'à une upgrade
/// WebSocket qui lui donne la main pour le reste de sa vie.
pub async fn serve(mut tls: TlsStream, state: AppState) {
    // Octets lus mais pas encore consommés (début de la requête suivante).
    let mut buf: Vec<u8> = Vec::new();
    loop {
        let Some(head) = read_head(&mut tls, &mut buf).await else {
            return;
        };
        if let Some(key) = &head.ws_key {
            let accept = crate::compute_accept(key);
            let response = format!(
                "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: {accept}\r\n\r\n"
            );
            if tls.write_all(response.into_bytes()).await.0.is_err() {
                return;
            }
            println!("[ws] upgrade OK");
            crate::handle_ws_connection(tls, state, buf).await;
            return;
        }
        let keep_alive = match route(&mut tls, &state, &head, &mut buf).await {
            Ok(keep_alive) => keep_alive && head.keep_alive,
            Err(_) => false,
        };
        if !keep_alive {
            return;
        }
    }
}

async fn read_head(tls: &mut TlsStream, buf: &mut Vec<u8>) -> Option<Head> {
    loop {
        if !buf.is_empty() {
            // 64 : un navigateur envoie bien plus que 16 en-têtes.
            let mut headers = [httparse::EMPTY_HEADER; 64];
            let mut req = httparse::Request::new(&mut headers);
            match req.parse(buf) {
                Ok(httparse::Status::Complete(len)) => {
                    let header = |name: &str| {
                        req.headers
                            .iter()
                            .find(|h| h.name.eq_ignore_ascii_case(name))
                            .map(|h| String::from_utf8_lossy(h.value).into_owned())
                    };
                    let close = header("connection").is_some_and(|v| v.eq_ignore_ascii_case("close"));
                    let head = Head {
                        method: req.method.unwrap_or("").to_string(),
                        path: req.path.unwrap_or("").to_string(),
                        content_length: header("content-length").and_then(|v| v.trim().parse().ok()),
                        authorization: header("authorization"),
                        ws_key: header("sec-websocket-key"),
                        keep_alive: req.version == Some(1) && !close,
                    };
                    buf.drain(..len);
                    return Some(head);
                }
                Ok(httparse::Status::Partial) => {}
                Err(e) => {
                    eprintln!("[http] requête illisible: {e:?}");
                    return None;
                }
            }
        }
        if buf.len() > MAX_HEAD {
            eprintln!("[http] en-têtes trop longs");
            return None;
        }
        let (res, chunk) = tls.read(vec![0u8; 16 * 1024]).await;
        match res {
            Ok(0) | Err(_) => return None,
            Ok(n) => buf.extend_from_slice(&chunk[..n]),
        }
    }
}

/// `Ok(keep_alive)` : faux si la réponse est partie avant la fin du corps (refus
/// d'un envoi), la connexion doit alors être fermée.
async fn route(tls: &mut TlsStream, state: &AppState, head: &Head, buf: &mut Vec<u8>) -> std::io::Result<bool> {
    match (head.method.as_str(), head.path.as_str()) {
        ("GET", "/") => {
            respond(tls, 200, "text/html", &[], crate::INDEX_HTML.as_bytes().to_vec()).await?;
            Ok(true)
        }
        ("POST", "/media") => upload(tls, state, head, buf).await,
        ("GET", path) if path.starts_with("/media/") => {
            get_media(tls, state, head, &path["/media/".len()..]).await?;
            Ok(true)
        }
        _ => {
            let error = proto::Error {
                code: 404,
                message: "introuvable".to_string(),
            };
            respond_error(tls, &error).await?;
            Ok(head.content_length.unwrap_or(0) == 0)
        }
    }
}

/// Utilisateur de la session portée par `Authorization: Bearer {token}`.
fn bearer_user(state: &AppState, head: &Head) -> Result<u64, proto::Error> {
    let unauthorized = || proto::Error {
        code: 401,
        message: "session requise".to_string(),
    };
    let token = head
        .authorization
        .as_deref()
        .and_then(|v| v.strip_prefix("Bearer "))
        .and_then(|t| Uuid::parse_str(t.trim()).ok())
        .ok_or_else(unauthorized)?;
    crate::session_user(&mut state.art.borrow_mut(), token).ok_or_else(unauthorized)
}

/// Stories 27, 47-48 : corps écrit au fil de l'eau dans un fichier temporaire (une
/// image de plusieurs Mo ne reste pas en mémoire), haché en SHA-256 au passage ;
/// format vérifié dès le premier Mio reçu, avant d'accepter le reste.
async fn upload(tls: &mut TlsStream, state: &AppState, head: &Head, buf: &mut Vec<u8>) -> std::io::Result<bool> {
    let config = &state.media;
    let checked = (|| {
        let user_id = bearer_user(state, head)?;
        let len = head.content_length.ok_or(proto::Error {
            code: 411,
            message: "Content-Length requis".to_string(),
        })?;
        if len == 0 {
            return Err(proto::Error {
                code: 400,
                message: "image vide".to_string(),
            });
        }
        let mut art = state.art.borrow_mut();
        crate::require_pseudo(&mut art, user_id)?;
        media::check_quota(&mut art, config, user_id, len)?;
        Ok((user_id, len))
    })();
    let (user_id, len) = match checked {
        Ok(ok) => ok,
        Err(error) => {
            respond_error(tls, &error).await?;
            return Ok(false); // corps non lu
        }
    };

    let temp = config.temp_path();
    let file = File::create(&temp).await?;
    let mut hasher = digest::Context::new(&digest::SHA256);
    let mut probe: Vec<u8> = Vec::new();
    let mut sniffed = None;
    let mut received: u64 = 0;
    while received < len {
        let chunk = if buf.is_empty() {
            let (res, mut chunk) = tls.read(vec![0u8; CHUNK]).await;
            match res {
                Ok(0) | Err(_) => {
                    let _ = monoio::fs::remove_file(&temp).await;
                    return Ok(false); // client parti en cours d'envoi
                }
                Ok(n) => chunk.truncate(n),
            }
            chunk
        } else {
            std::mem::take(buf)
        };
        // Octets au-delà du corps : début de la requête suivante.
        let take = chunk.len().min((len - received) as usize);
        let (body, rest) = chunk.split_at(take);
        buf.extend_from_slice(rest);
        hasher.update(body);
        if sniffed.is_none() {
            probe.extend_from_slice(&body[..body.len().min(media::PROBE_LEN - probe.len())]);
        }
        let body = body.to_vec();
        let (res, _) = file.write_all_at(body, received).await;
        res?;
        received += take as u64;

        if sniffed.is_none() && (probe.len() == media::PROBE_LEN || received == len) {
            match media::sniff(&probe) {
                Ok(found) => sniffed = Some(found),
                Err(error) => {
                    let _ = file.close().await;
                    let _ = monoio::fs::remove_file(&temp).await;
                    respond_error(tls, &error).await?;
                    return Ok(received == len);
                }
            }
        }
    }
    file.close().await?;
    let (mime, width, height) = sniffed.expect("format vérifié une fois le corps reçu");
    let sha256: String = hasher.finish().as_ref().iter().map(|b| format!("{b:02x}")).collect();

    // Quota revérifié : un autre envoi du même utilisateur a pu finir entre-temps.
    let reserved = {
        let mut art = state.art.borrow_mut();
        media::check_quota(&mut art, config, user_id, len).map(|()| media::reserve_file(&mut art, &sha256))
    };
    let first = match reserved {
        Ok(first) => first,
        Err(error) => {
            let _ = monoio::fs::remove_file(&temp).await;
            respond_error(tls, &error).await?;
            return Ok(true);
        }
    };
    if first {
        monoio::fs::rename(&temp, config.file_path(&sha256)).await?;
    } else {
        monoio::fs::remove_file(&temp).await?; // même contenu déjà stocké
    }

    let stored = StoredMedia {
        meta: proto::Media {
            id: Uuid::new_v4().to_string(),
            mime: mime.to_string(),
            size: len,
            width,
            height,
            owner_id: user_id,
            created_at: SystemTime::now().duration_since(UNIX_EPOCH).expect("horloge").as_millis() as u64,
        },
        sha256,
    };
    let uploaded = {
        let mut art = state.art.borrow_mut();
        media::record(&mut art, &stored);
        state.dirty.set(true);
        proto::MediaUploaded {
            quota_used: media::usage(&mut art, user_id),
            quota_total: config.quota,
            media: Some(stored.meta),
        }
    };
    respond(tls, 201, "application/x-protobuf", &[], uploaded.encode_to_vec()).await?;
    Ok(true)
}

/// Stories 27, 46, 48 : réservé aux utilisateurs connectés, fichier lu par morceaux
/// (io_uring) sans le charger entier. Immuable (un id ne change jamais de contenu) :
/// cache navigateur d'un an.
async fn get_media(tls: &mut TlsStream, state: &AppState, head: &Head, id: &str) -> std::io::Result<()> {
    let found = bearer_user(state, head).and_then(|_| {
        if !media::is_media_id(id) {
            return Err(media::not_found());
        }
        media::load(&mut state.art.borrow_mut(), id).ok_or_else(media::not_found)
    });
    let stored = match found {
        Ok(stored) => stored,
        Err(error) => return respond_error(tls, &error).await,
    };
    let file = match File::open(state.media.file_path(&stored.sha256)).await {
        Ok(file) => file,
        Err(e) => {
            eprintln!("[media] fichier {} absent : {e}", stored.sha256);
            return respond_error(tls, &media::not_found()).await;
        }
    };
    let meta = &stored.meta;
    let header = format!(
        "HTTP/1.1 200 OK\r\nContent-Type: {}\r\nContent-Length: {}\r\nCache-Control: private, max-age=31536000, immutable\r\nX-Media-Owner: {}\r\n\r\n",
        meta.mime, meta.size, meta.owner_id
    );
    tls.write_all(header.into_bytes()).await.0?;
    let mut pos = 0;
    let mut chunk = vec![0u8; CHUNK];
    while pos < meta.size {
        let (res, mut c) = file.read_at(chunk, pos).await;
        let n = res?;
        if n == 0 {
            break;
        }
        c.truncate(n);
        let (res, mut c) = tls.write_all(c).await;
        res?;
        pos += n as u64;
        c.resize(CHUNK, 0);
        chunk = c;
    }
    let _ = file.close().await;
    Ok(())
}

async fn respond(
    tls: &mut TlsStream,
    status: u16,
    content_type: &str,
    extra: &[(&str, String)],
    body: Vec<u8>,
) -> std::io::Result<()> {
    let mut response = format!(
        "HTTP/1.1 {status} {}\r\nContent-Type: {content_type}\r\nContent-Length: {}\r\n",
        reason(status),
        body.len()
    );
    for (name, value) in extra {
        response.push_str(&format!("{name}: {value}\r\n"));
    }
    response.push_str("\r\n");
    let mut bytes = response.into_bytes();
    bytes.extend_from_slice(&body);
    tls.write_all(bytes).await.0.map(|_| ())
}

/// Erreur HTTP : le corps est un `Error` protobuf, comme sur le WebSocket.
async fn respond_error(tls: &mut TlsStream, error: &proto::Error) -> std::io::Result<()> {
    respond(tls, error.code as u16, "application/x-protobuf", &[], error.encode_to_vec()).await
}

fn reason(status: u16) -> &'static str {
    match status {
        200 => "OK",
        201 => "Created",
        400 => "Bad Request",
        401 => "Unauthorized",
        403 => "Forbidden",
        404 => "Not Found",
        411 => "Length Required",
        413 => "Payload Too Large",
        _ => "Error",
    }
}
