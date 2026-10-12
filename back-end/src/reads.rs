//! Non-lus et réglages de notification (stories 56-60), propres à chaque utilisateur.
//!
//! - `read:{user}:{conversation}` : id du dernier message lu (ne fait qu'avancer).
//!   Le compte des non-lus parcourt par `krange` les seuls messages qui suivent ce
//!   marqueur, par pages, et s'arrête à `MAX_UNREAD` : jamais tout le salon.
//! - `settings:{user}` : `Settings` (bincode, cf. `codec`).

use oxidart::krange::RangeVal;
use oxidart::{OxidArt, Value};
use radixox_lib::shared_byte::SharedByte;

use crate::{codec, keys, proto};

/// Au-delà, le client affiche « 99+ » : inutile de compter plus loin.
pub const MAX_UNREAD: u32 = 100;
const PAGE: usize = 128;
const MAX_SOUND_LEN: usize = 32;
const MAX_RULES: usize = 2000;

fn read_key(user_id: u64, channel_id: u64) -> String {
    format!("read:{}:{}", keys::sortable_id(user_id), keys::sortable_id(channel_id))
}

fn settings_key(user_id: u64) -> String {
    format!("settings:{}", keys::sortable_id(user_id))
}

pub fn last_read(art: &mut OxidArt, user_id: u64, channel_id: u64) -> u64 {
    art.get(read_key(user_id, channel_id).as_bytes())
        .map(|v| v.to_int().expect("read:… toujours un entier") as u64)
        .unwrap_or(0)
}

/// Story 56 : messages des autres, non supprimés, après le dernier lu — plafonné.
/// Story 62 : parmi eux, ceux qui me mentionnent (`<@{moi}>`).
pub fn unread(art: &mut OxidArt, user_id: u64, channel_id: u64) -> proto::Unread {
    let last_read_id = last_read(art, user_id, channel_id);
    let mention = format!("<@{user_id}>");
    let mut mentions = 0;
    let prefix = keys::message_prefix(channel_id);
    let mut from = if last_read_id == 0 {
        Vec::new()
    } else {
        keys::message_key(channel_id, last_read_id).into_bytes()
    };
    let mut count = 0;
    'pages: loop {
        let page = art.krange(prefix.as_bytes(), &from, PAGE, false);
        if page.is_empty() {
            break;
        }
        for (key, val) in page.iter() {
            let RangeVal::Bytes(bytes) = val else {
                panic!("message toujours Value::String");
            };
            let message: proto::Message = codec::decode(bytes.as_slice(), "message");
            if message.user_id != user_id && !message.deleted {
                count += 1;
                if message.content.contains(&mention) {
                    mentions += 1;
                }
                if count == MAX_UNREAD {
                    break 'pages;
                }
            }
            from = key.to_vec();
        }
        if page.len() < PAGE {
            break;
        }
    }
    proto::Unread {
        channel_id,
        last_read_id,
        count,
        mentions,
    }
}

/// Story 56 : le marqueur avance jusqu'à `message_id`, jamais en arrière (un appareil
/// en retard ne « dé-lit » pas ce qu'un autre a lu). Rend le marqueur effectif.
pub fn mark_read(art: &mut OxidArt, user_id: u64, channel_id: u64, message_id: u64) -> u64 {
    let current = last_read(art, user_id, channel_id);
    if message_id <= current {
        return current;
    }
    art.set(
        SharedByte::from_str(&read_key(user_id, channel_id)),
        Value::Int(message_id as i64),
    );
    message_id
}

pub fn settings(art: &mut OxidArt, user_id: u64) -> proto::Settings {
    art.get(settings_key(user_id).as_bytes())
        .map(|v| codec::decode(v.as_bytes().expect("settings toujours Value::String").as_slice(), "settings"))
        .unwrap_or_else(|| proto::Settings {
            sound: "pop".to_string(),
            ..Default::default()
        })
}

/// Stories 57-63 : remplace les réglages. Une règle par salon et par personne (la
/// dernière l'emporte) ; les règles égales au défaut sont retirées ; l'ancien `rules`
/// (story 58) est vidé.
pub fn set_settings(art: &mut OxidArt, user_id: u64, mut settings: proto::Settings) -> Result<proto::Settings, proto::Error> {
    let invalid = |message: &str| proto::Error {
        code: 400,
        message: message.to_string(),
    };
    if settings.sound.len() > MAX_SOUND_LEN || settings.sound.chars().any(|c| !c.is_ascii_alphanumeric() && c != '-') {
        return Err(invalid("son inconnu"));
    }
    if settings.channel_rules.len() + settings.person_rules.len() > MAX_RULES {
        return Err(invalid("trop de règles de notification"));
    }
    if settings.channel_rules.iter().any(|r| proto::ChannelLevel::try_from(r.level).is_err()) {
        return Err(invalid("niveau de notification inconnu"));
    }
    settings.rules.clear();
    let mut channels: Vec<proto::ChannelRule> = Vec::new();
    for rule in settings.channel_rules.drain(..) {
        channels.retain(|r| r.channel_id != rule.channel_id);
        if rule.level() != proto::ChannelLevel::Mentions || rule.silent {
            channels.push(rule);
        }
    }
    settings.channel_rules = channels;
    let mut persons: Vec<proto::PersonRule> = Vec::new();
    for rule in settings.person_rules.drain(..) {
        persons.retain(|r| r.user_id != rule.user_id);
        if rule.dm_muted || rule.dm_silent || rule.mentions_muted || rule.mentions_silent {
            persons.push(rule);
        }
    }
    settings.person_rules = persons;
    art.set(
        SharedByte::from_str(&settings_key(user_id)),
        Value::String(SharedByte::from_slice(codec::encode(&settings))),
    );
    Ok(settings)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn message(art: &mut OxidArt, channel_id: u64, id: u64, user_id: u64, deleted: bool) {
        let m = proto::Message {
            id,
            channel_id,
            user_id,
            content: "x".into(),
            timestamp: 0,
            deleted,
            reply_to_id: 0,
            edited_at: 0,
        };
        art.set(
            SharedByte::from_str(&keys::message_key(channel_id, id)),
            Value::String(SharedByte::from_slice(codec::encode(&m))),
        );
    }

    #[test]
    fn non_lus_apres_le_marqueur_des_autres_seulement() {
        let mut art = OxidArt::new();
        for id in 10..20 {
            message(&mut art, 2, id, if id % 2 == 0 { 1 } else { 7 }, id == 19);
        }
        message(&mut art, 3, 30, 7, false); // autre salon
        assert_eq!(unread(&mut art, 1, 2).count, 4); // 11, 13, 15, 17 (19 supprimé)
        assert_eq!(mark_read(&mut art, 1, 2, 13), 13);
        assert_eq!(unread(&mut art, 1, 2).count, 2);
        assert_eq!(mark_read(&mut art, 1, 2, 11), 13, "le marqueur ne recule pas");
        assert_eq!(unread(&mut art, 1, 2).last_read_id, 13);
    }

    #[test]
    fn mentions_non_lues() {
        let mut art = OxidArt::new();
        for (id, content) in [(1, "salut <@1>"), (2, "<@12> pas moi"), (3, "<@1> et <@1>"), (4, "rien")] {
            let m = proto::Message {
                id,
                channel_id: 2,
                user_id: 7,
                content: content.into(),
                timestamp: 0,
                deleted: false,
                reply_to_id: 0,
                edited_at: 0,
            };
            art.set(
                SharedByte::from_str(&keys::message_key(2, id)),
                Value::String(SharedByte::from_slice(codec::encode(&m))),
            );
        }
        let u = unread(&mut art, 1, 2);
        assert_eq!((u.count, u.mentions), (4, 2), "<@12> n'est pas une mention de <@1>");
        mark_read(&mut art, 1, 2, 1);
        assert_eq!(unread(&mut art, 1, 2).mentions, 1);
    }

    #[test]
    fn compte_plafonne_sur_plusieurs_pages() {
        let mut art = OxidArt::new();
        for id in 1..=400 {
            message(&mut art, 2, id, 7, false);
        }
        assert_eq!(unread(&mut art, 1, 2).count, MAX_UNREAD);
        mark_read(&mut art, 1, 2, 350);
        assert_eq!(unread(&mut art, 1, 2).count, 50);
    }

    #[test]
    fn reglages_dedupliques_et_valides() {
        let mut art = OxidArt::new();
        assert_eq!(settings(&mut art, 1).sound, "pop");
        let channel = |channel_id, level: proto::ChannelLevel, silent| proto::ChannelRule {
            channel_id,
            level: level as i32,
            silent,
        };
        let person = |user_id, dm_muted| proto::PersonRule {
            user_id,
            dm_muted,
            ..Default::default()
        };
        let saved = set_settings(
            &mut art,
            1,
            proto::Settings {
                sound: "ding".into(),
                desktop_notifications: true,
                rules: vec![proto::NotificationRule { channel_id: 9, muted: true, silent: false }],
                channel_rules: vec![
                    channel(2, proto::ChannelLevel::Nothing, false),
                    channel(3, proto::ChannelLevel::Mentions, false),
                    channel(2, proto::ChannelLevel::All, true),
                ],
                person_rules: vec![person(5, true), person(6, false)],
            },
        )
        .unwrap();
        assert_eq!(saved.channel_rules, vec![channel(2, proto::ChannelLevel::All, true)]);
        assert_eq!(saved.person_rules, vec![person(5, true)]);
        assert!(saved.rules.is_empty(), "ancien format vidé");
        assert_eq!(settings(&mut art, 1), saved);
        let bad = proto::Settings { sound: "../x".into(), ..saved.clone() };
        assert!(set_settings(&mut art, 1, bad).is_err());
        let bad_level = proto::Settings {
            channel_rules: vec![proto::ChannelRule { channel_id: 2, level: 42, silent: false }],
            ..saved
        };
        assert!(set_settings(&mut art, 1, bad_level).is_err());
    }
}
