//! Salons et DM (stories 7-8, 28-32).

use oxidart::krange::RangeVal;
use oxidart::{OxidArt, Value};
use radixox_lib::shared_byte::SharedByte;

use crate::dispatch::require_auth;
use crate::users::require_pseudo;
use crate::{AppState, codec, keys, proto, validate};

/// Story 8 : tous les salons sont visibles par tout le monde. Les DM vivent sous
/// `dm:` (stories 28-32), jamais parcourus ici. Triés par id (`keys::channel_key`).
pub fn list_channels(art: &OxidArt) -> Vec<proto::Channel> {
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
pub fn list_dms(art: &mut OxidArt, user_id: u64) -> Vec<proto::Conversation> {
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

pub fn parse_id(bytes: &[u8]) -> u64 {
    std::str::from_utf8(bytes)
        .ok()
        .and_then(|s| s.parse().ok())
        .expect("id stocké en décimal")
}

/// DM référencé par un index écrit dans le même emprunt que lui : absence = invariant
/// violé.
pub fn load_dm(art: &mut OxidArt, id: u64) -> proto::Channel {
    let val = art.get(keys::dm_key(id).as_bytes()).expect("user_dms → dm:{id} inexistant");
    codec::decode(val.as_bytes().expect("dm:{id} toujours Value::String").as_slice(), "dm:{id}")
}

pub fn conversation(art: &OxidArt, channel: proto::Channel) -> proto::Conversation {
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
pub fn open_dm(
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
pub fn range_bytes<'a>(val: RangeVal<'a>, what: &str) -> &'a [u8] {
    match val {
        RangeVal::Bytes(b) => b.as_slice(),
        RangeVal::Int(_) => panic!("{what} toujours Value::String"),
    }
}

/// Story 7 : création de salon texte, admin uniquement (seule distinction de
/// privilège du système, cf. CLAUDE.md), nom unique parmi les salons texte. Le statut admin est relu dans `user:{id}`
/// plutôt que mis en cache sur la connexion.
pub fn create_channel(
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
