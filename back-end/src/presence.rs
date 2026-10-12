//! Présence (stories 23, 41-42) : qui les autres voient en ligne. État de connexion en
//! mémoire, pas une donnée OxidArt — après un redémarrage tout le monde se reconnecte
//! et l'état se reconstruit. Seul le statut choisi (En ligne / Invisible) est
//! persisté, dans `User.status`.
//!
//! Un utilisateur est **annoncé** en ligne quand il a au moins une connexion
//! authentifiée et le statut En ligne, avec deux délais (story 42) :
//! - à la première connexion, l'annonce attend `delay` (on peut passer invisible
//!   avant que quiconque nous ait vu arriver) ;
//! - à la dernière déconnexion, l'annonce « hors ligne » attend aussi `delay` (un
//!   refresh ou une coupure courte ne fait pas clignoter le statut, et la reconnexion
//!   pendant ce délai ne refait pas l'attente).
//!
//! Les délais sont des tâches monoio endormies ; `generation` invalide celles qui
//! sont devenues caduques (reconnexion, déconnexion, changement de statut entre-temps).

use std::cell::RefCell;
use std::collections::HashMap;
use std::rc::Rc;
use std::time::Duration;

use crate::registry::{self, ConnId, SharedRegistry};

pub type SharedPresence = Rc<RefCell<Presence>>;

const DEFAULT_DELAY: Duration = Duration::from_secs(15);

#[derive(Default)]
struct UserPresence {
    /// Connexions authentifiées de cet utilisateur (onglets/appareils, story 5).
    conns: Vec<ConnId>,
    /// Les autres le voient en ligne.
    announced: bool,
    generation: u64,
}

pub struct Presence {
    users: HashMap<u64, UserPresence>,
    conn_user: HashMap<ConnId, u64>,
    delay: Duration,
}

impl Presence {
    /// `AUDIO_PRESENCE_DELAY_MS` raccourcit les délais (tests de bout en bout).
    pub fn from_env() -> Self {
        let delay = std::env::var("AUDIO_PRESENCE_DELAY_MS")
            .ok()
            .and_then(|ms| ms.parse().ok())
            .map(Duration::from_millis)
            .unwrap_or(DEFAULT_DELAY);
        Self {
            users: HashMap::new(),
            conn_user: HashMap::new(),
            delay,
        }
    }

    /// Utilisateurs actuellement annoncés en ligne (`AuthResponse.online_user_ids`).
    pub fn online_ids(&self) -> Vec<u64> {
        self.users
            .iter()
            .filter(|(_, p)| p.announced)
            .map(|(&id, _)| id)
            .collect()
    }
}

enum Pending {
    Online,
    Offline,
}

/// Connexion authentifiée pour `user_id`. Une seconde auth sur la même connexion
/// (autre compte) la détache d'abord de l'ancien.
pub fn connected(
    presence: &SharedPresence,
    registry: &SharedRegistry,
    conn: ConnId,
    user_id: u64,
    invisible: bool,
) {
    if presence.borrow().conn_user.get(&conn) == Some(&user_id) {
        return;
    }
    disconnected(presence, registry, conn);
    let schedule = {
        let mut p = presence.borrow_mut();
        p.conn_user.insert(conn, user_id);
        let user = p.users.entry(user_id).or_default();
        user.conns.push(conn);
        if user.conns.len() > 1 {
            None
        } else {
            // Première connexion : annule une annonce « hors ligne » en attente ; si
            // déjà annoncé (reconnexion rapide), rien d'autre à faire.
            user.generation += 1;
            (!user.announced && !invisible).then_some(user.generation)
        }
    };
    if let Some(generation) = schedule {
        spawn_pending(presence, registry, user_id, generation, Pending::Online);
    }
}

pub fn disconnected(presence: &SharedPresence, registry: &SharedRegistry, conn: ConnId) {
    let schedule = {
        let mut p = presence.borrow_mut();
        let Some(user_id) = p.conn_user.remove(&conn) else {
            return;
        };
        let user = p.users.get_mut(&user_id).expect("conn_user → users");
        user.conns.retain(|&c| c != conn);
        if !user.conns.is_empty() {
            return;
        }
        // Dernière connexion : annule une annonce « en ligne » en attente.
        user.generation += 1;
        if !user.announced {
            p.users.remove(&user_id);
            return;
        }
        Some((user_id, user.generation))
    };
    if let Some((user_id, generation)) = schedule {
        spawn_pending(presence, registry, user_id, generation, Pending::Offline);
    }
}

/// Story 41 : le changement de statut s'applique tout de suite, sans délai.
pub fn status_changed(
    presence: &SharedPresence,
    registry: &SharedRegistry,
    user_id: u64,
    invisible: bool,
) {
    let announce = {
        let mut p = presence.borrow_mut();
        let Some(user) = p.users.get_mut(&user_id) else {
            return;
        };
        user.generation += 1;
        let online = !invisible && !user.conns.is_empty();
        if online == user.announced {
            return;
        }
        user.announced = online;
        online
    };
    broadcast(registry, user_id, announce);
}

fn spawn_pending(
    presence: &SharedPresence,
    registry: &SharedRegistry,
    user_id: u64,
    generation: u64,
    pending: Pending,
) {
    let presence = presence.clone();
    let registry = registry.clone();
    let delay = presence.borrow().delay;
    monoio::spawn(async move {
        monoio::time::sleep(delay).await;
        let announce = {
            let mut p = presence.borrow_mut();
            let Some(user) = p.users.get_mut(&user_id) else {
                return;
            };
            if user.generation != generation {
                return; // caduque : reconnexion, déconnexion ou changement de statut
            }
            match pending {
                Pending::Online => user.announced = true,
                Pending::Offline => {
                    p.users.remove(&user_id);
                }
            }
            matches!(pending, Pending::Online)
        };
        broadcast(&registry, user_id, announce);
    });
}

fn broadcast(registry: &SharedRegistry, user_id: u64, online: bool) {
    use prost::Message;
    let event = crate::proto::ServerEnvelope {
        request_id: String::new(),
        payload: Some(crate::proto::server_envelope::Payload::PresenceChanged(
            crate::proto::PresenceChanged { user_id, online },
        )),
    };
    registry::broadcast_all(registry, &crate::ws::encode_frame(0x2, &event.encode_to_vec()));
}
