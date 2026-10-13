//! Messages (stories 9-15, 39-40, 64) : envoi, modification, suppression
//! (tombstone), synchronisation et pages d'historique.

use std::time::{SystemTime, UNIX_EPOCH};

use oxidart::{OxidArt, Value};
use radixox_lib::shared_byte::SharedByte;

use crate::channels::{conversation, load_dm, range_bytes};
use crate::connection::Audience;
use crate::dispatch::require_auth;
use crate::users::require_pseudo;
use crate::{AppState, codec, keys, proto, validate};

/// Conversation où `user_id` peut lire et écrire : un salon texte (tout le monde) ou
/// un DM dont il est participant. Story 32 : un DM dont on n'est pas participant
/// répond 404 comme s'il n'existait pas — admin compris.
pub fn load_conversation(
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
    if let Some(val) = art.get(keys::channel_key(channel_id).as_bytes()) {
        let channel: proto::Channel = codec::decode(
            val.as_bytes().expect("channel:{id} toujours Value::String").as_slice(),
            "channel:{id}",
        );
        // Story 70 : un salon vocal n'a pas de fil de messages.
        if channel.r#type() == proto::channel::Type::Voice {
            return Err(unknown());
        }
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

pub fn decode_message(val: &Value) -> proto::Message {
    codec::decode(val.as_bytes().expect("message toujours Value::String").as_slice(), "message")
}

pub struct Sent {
    pub message: proto::Message,
    pub audience: Audience,
    /// Story 28 : premier message d'un DM — l'autre participant et la conversation à
    /// lui révéler.
    pub dm_revealed: Option<(u64, proto::Conversation)>,
}

/// Story 10 : envoi dans un salon texte existant, par n'importe quel utilisateur
/// authentifié (pas de « rejoindre », story 9), ou dans un DM dont on est
/// participant (story 31).
pub fn send_message(
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

pub fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("horloge avant 1970")
        .as_millis() as u64
}

pub fn save_message(art: &mut OxidArt, message: &proto::Message) {
    let encoded = codec::encode(message);
    art.set(
        SharedByte::from_str(&keys::message_key(message.channel_id, message.id)),
        Value::String(SharedByte::from_slice(encoded)),
    );
}

/// Message `message_id` du salon, 404 s'il n'existe pas (id client hors borne compris).
pub fn load_message(
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
pub fn edit_message(
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
pub fn sync_messages(
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
pub const MAX_PAGE: u32 = 200;

/// Story 64 : les `limit` messages qui précèdent `before_id` (0 = les plus récents),
/// par un `krange` inversé d'une entrée de plus — qui dit seulement s'il en reste.
pub fn sync_page(art: &OxidArt, channel_id: u64, before_id: u64, limit: u32) -> proto::SyncResponse {
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
pub fn delete_message(
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


#[cfg(test)]
mod tests {
    use super::*;

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
