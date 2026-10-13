//! Vie d'une connexion WebSocket après l'upgrade : lecture des trames, réponse
//! directe, et diffusion des événements aux autres connexions (`notify`). Le flux TLS
//! est découpé : la tâche de lecture garde une moitié, l'autre vit dans le registre.

use aws_lc_rs::digest::{digest, SHA1_FOR_LEGACY_USE_ONLY};
use base64::Engine;
use base64::engine::general_purpose::STANDARD as BASE64;
use monoio::io::{AsyncReadRent, OwnedReadHalf, Splitable};
use prost::Message;

use crate::dispatch::handle_client_envelope;
use crate::registry::{self, ConnId, TlsStream};
use crate::{AppState, ping_every, presence, proto, ws};

pub const WS_GUID: &str = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
// Boucle de lecture : une frame binaire entrante = un ClientEnvelope protobuf. Le flux
// TLS est découpé : cette tâche garde la moitié lecture, la moitié écriture vit dans le
// registre, par lequel passent la réponse directe comme les broadcasts poussés par
// d'autres connexions (cf. registry.rs).
// Story 33 : l'auth se fait une fois par connexion WebSocket (AuthRequest), puis
// l'identité est portée par `user_id` en mémoire pour toute la durée de vie de cette
// connexion — aucune requête suivante n'a besoin de reporter un token.
/// `pending` : octets déjà lus après la requête d'upgrade (début de frame éventuel).
pub async fn handle_ws_connection(tls: TlsStream, state: AppState, pending: Vec<u8>) {
    let (read, write) = tls.into_split();
    let conn = state.registry.borrow_mut().insert(write);
    read_loop(read, conn, &state, pending).await;
    // Story 21 : une coupure WebSocket vaut LeaveVoice.
    state.voice.borrow_mut().leave(conn);
    state.registry.borrow_mut().remove(conn);
    presence::disconnected(&state.presence, &state.registry, conn);
    println!("[ws] connexion terminée");
}

/// Les octets lus s'accumulent dans `pending` jusqu'à former des frames complètes :
/// une lecture peut porter une demi-frame (photo de profil de plusieurs records TLS)
/// comme plusieurs frames. Une frame invalide ferme la connexion.
pub async fn read_loop(
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
                0x2 => handle_binary_frame(&frame.payload, state, conn, &mut user_id).await,
                _ => {} // texte/ping/pong non gérés à ce stade
            }
        }
        // Story 69 : aucune trame (pas même un pong) depuis trois pings : connexion morte.
        let dead_after = ping_every() * 3;
        let Ok((res, c)) = monoio::time::timeout(dead_after, read.read(chunk)).await else {
            println!("[ws] connexion silencieuse depuis {dead_after:?} : fermée");
            return;
        };
        chunk = c;
        match res {
            Ok(0) | Err(_) => return,
            Ok(n) => pending.extend_from_slice(&chunk[..n]),
        }
    }
}

pub async fn handle_binary_frame(payload: &[u8], state: &AppState, conn: ConnId, user_id: &mut Option<u64>) {
    let envelope = match proto::ClientEnvelope::decode(payload) {
        Ok(envelope) => envelope,
        Err(e) => {
            eprintln!("[ws] ClientEnvelope illisible: {e:?}");
            return;
        }
    };
    if let Some(response) = handle_client_envelope(envelope, state, conn, user_id).await {
        registry::send(&state.registry, conn, &server_frame(&response));
    }
}

pub fn server_frame(envelope: &proto::ServerEnvelope) -> Vec<u8> {
    ws::encode_frame(0x2, &envelope.encode_to_vec())
}

/// Événement poussé (request_id vide), déjà encodé en frame.
pub fn event(payload: proto::server_envelope::Payload) -> Vec<u8> {
    server_frame(&proto::ServerEnvelope {
        request_id: String::new(),
        payload: Some(payload),
    })
}

/// Destinataires d'un événement sur les messages d'une conversation.
pub enum Audience {
    /// Salon : tout le monde voit tout (story 11).
    Everyone,
    /// DM : les deux participants seulement (story 29).
    Participants([u64; 2]),
}

/// Pousse l'événement aux destinataires sauf l'émetteur, qui l'a en réponse.
pub fn notify(state: &AppState, conn: ConnId, audience: &Audience, payload: &proto::server_envelope::Payload) {
    let frame = event(payload.clone());
    match audience {
        Audience::Everyone => registry::broadcast(&state.registry, conn, &frame),
        Audience::Participants(users) => {
            registry::send_to_users(&state.registry, users, Some(conn), &frame)
        }
    }
}

pub fn compute_accept(key: &str) -> String {
    let mut data = String::with_capacity(key.len() + WS_GUID.len());
    data.push_str(key);
    data.push_str(WS_GUID);
    let hash = digest(&SHA1_FOR_LEGACY_USE_ONLY, data.as_bytes());
    BASE64.encode(hash.as_ref())
}
