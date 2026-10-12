//! Registre des connexions WebSocket : tout ce qui part vers un client (réponse
//! directe comme broadcast) passe par ici, pour garder l'ordre sur la connexion.
//!
//! Modèle proactif repris de radixox (`utils/mod.rs`, `SubRegistry`) : pas de tâche
//! d'écriture permanente par connexion. Pousser des octets les ajoute à `pending` ; si
//! aucune écriture n'est en vol (la moitié écriture est rendue au registre), on lance
//! une tâche `write_task` qui échange `pending` contre son buffer vide, écrit, et
//! recommence tant que `pending` s'est rempli entre-temps. La dernière tâche active
//! rend la moitié écriture et son buffer à la connexion.
//!
//! TODO lointain : `pending` n'est pas borné — un client qui ne lit plus fait grossir
//! la mémoire jusqu'à ce que le TCP casse (cf. TODO.md).

use std::cell::RefCell;
use std::rc::Rc;

use monoio::io::{AsyncWriteRentExt, OwnedWriteHalf};
use monoio::net::TcpStream;
use radixox_lib::gen_arena::{GenArena, Key};

pub type TlsStream = monoio_rustls::ServerTlsStream<TcpStream>;
pub type SharedRegistry = Rc<RefCell<Registry>>;

/// Clé générationnelle : une `ConnId` d'une connexion fermée ne désigne jamais la
/// connexion qui réutilise son emplacement.
#[derive(Clone, Copy, PartialEq, Eq, Hash)]
pub struct ConnId(Key);

struct Conn {
    /// `None` pendant qu'une `write_task` la possède.
    write: Option<OwnedWriteHalf<TlsStream>>,
    /// Frames WebSocket en attente d'écriture.
    pending: Vec<u8>,
    /// Buffer vide rendu par la dernière écriture ; `None` en même temps que `write`.
    spare: Option<Vec<u8>>,
}

#[derive(Default)]
pub struct Registry {
    conns: GenArena<Conn>,
    /// Connexions dont l'`AuthRequest` a été acceptée, avec leur utilisateur : seules
    /// destinataires des broadcasts, et de la livraison ciblée des DM (story 29).
    /// GenArena n'est pas itérable, et c'est le seul parcours utile.
    authenticated: Vec<(ConnId, u64)>,
}

impl Registry {
    pub fn insert(&mut self, write: OwnedWriteHalf<TlsStream>) -> ConnId {
        ConnId(self.conns.insert(Conn {
            write: Some(write),
            pending: Vec::new(),
            spare: Some(Vec::new()),
        }))
    }

    /// Fermeture : la moitié écriture est lâchée ici, ou par la `write_task` en vol
    /// quand elle constate que la connexion n'existe plus.
    pub fn remove(&mut self, id: ConnId) {
        self.conns.remove(id.0);
        self.authenticated.retain(|&(a, _)| a != id);
    }

    /// Idempotent : une reprise de session sur une connexion déjà authentifiée ne
    /// la double pas dans les broadcasts (et une auth avec un autre compte remplace
    /// l'utilisateur de la connexion).
    pub fn mark_authenticated(&mut self, id: ConnId, user_id: u64) {
        if !self.conns.contains(id.0) {
            return;
        }
        match self.authenticated.iter_mut().find(|(a, _)| *a == id) {
            Some(entry) => entry.1 = user_id,
            None => self.authenticated.push((id, user_id)),
        }
    }
}

/// Envoie une frame déjà encodée à une seule connexion.
pub fn send(registry: &SharedRegistry, id: ConnId, frame: &[u8]) {
    {
        let mut reg = registry.borrow_mut();
        let Some(conn) = reg.conns.get_mut(id.0) else {
            return;
        };
        conn.pending.extend_from_slice(frame);
    }
    trigger_write(registry, id);
}

/// Envoie une frame déjà encodée (une seule fois pour tous) à toutes les connexions
/// authentifiées sauf `except` — l'émetteur reçoit déjà sa réponse directe, avec son
/// `request_id`.
pub fn broadcast(registry: &SharedRegistry, except: ConnId, frame: &[u8]) {
    push_to(registry, |id, _| id != except, frame);
}

/// Événement sans émetteur (ex. présence annoncée après un délai) : à toutes les
/// connexions authentifiées.
pub fn broadcast_all(registry: &SharedRegistry, frame: &[u8]) {
    push_to(registry, |_, _| true, frame);
}

/// Story 29 : seulement aux connexions de `users` (participants d'un DM), toutes
/// sauf `except`.
pub fn send_to_users(registry: &SharedRegistry, users: &[u64], except: Option<ConnId>, frame: &[u8]) {
    push_to(registry, |id, user| Some(id) != except && users.contains(&user), frame);
}

fn push_to(registry: &SharedRegistry, target: impl Fn(ConnId, u64) -> bool, frame: &[u8]) {
    let targets: Vec<ConnId> = {
        let mut reg = registry.borrow_mut();
        let Registry { conns, authenticated } = &mut *reg;
        authenticated
            .iter()
            .filter(|&&(id, user)| target(id, user))
            .map(|&(id, _)| id)
            .inspect(|id| {
                if let Some(conn) = conns.get_mut(id.0) {
                    conn.pending.extend_from_slice(frame);
                }
            })
            .collect()
    };
    for id in targets {
        trigger_write(registry, id);
    }
}

/// Lance une `write_task` si aucune n'est en vol pour cette connexion ; sinon celle
/// en vol verra les nouveaux octets de `pending` avant de rendre la main.
fn trigger_write(registry: &SharedRegistry, id: ConnId) {
    let taken = registry.borrow_mut().conns.get_mut(id.0).and_then(|conn| {
        let write = conn.write.take()?;
        let spare = conn.spare.take().expect("spare présent avec write");
        Some((write, spare))
    });
    if let Some((write, buf)) = taken {
        monoio::spawn(write_task(registry.clone(), id, write, buf));
    }
}

async fn write_task(
    registry: SharedRegistry,
    id: ConnId,
    mut write: OwnedWriteHalf<TlsStream>,
    mut buf: Vec<u8>,
) {
    loop {
        {
            let mut reg = registry.borrow_mut();
            let Some(conn) = reg.conns.get_mut(id.0) else {
                return; // connexion fermée pendant l'écriture
            };
            if conn.pending.is_empty() {
                conn.write = Some(write);
                conn.spare = Some(buf);
                return;
            }
            std::mem::swap(&mut buf, &mut conn.pending);
        }
        let (res, b) = write.write_all(buf).await;
        buf = b;
        buf.clear();
        if res.is_err() {
            // Socket cassée : la lecture échouera aussi et la tâche de lecture
            // fera le ménage ; on retire déjà la connexion des broadcasts.
            registry.borrow_mut().remove(id);
            return;
        }
    }
}
