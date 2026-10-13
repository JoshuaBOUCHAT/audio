//! Profils (stories 34-37, 41, 43, 55) : pseudo, statut, thème, description, photo ;
//! volume de chaque personne pour moi (story 76).

use oxidart::krange::RangeVal;
use oxidart::{OxidArt, Value};
use radixox_lib::shared_byte::SharedByte;

use crate::channels::range_bytes;
use crate::connection::server_frame;
use crate::dispatch::require_auth;
use crate::registry::{self, ConnId};
use crate::{AppState, codec, keys, proto, validate};

/// Stories 35-37 : le changement de profil est diffusé aux autres clients
/// authentifiés ; l'auteur le reçoit en réponse.
pub fn user_updated(
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

pub fn save_user(art: &mut OxidArt, user: &proto::User) {
    let encoded = codec::encode(user);
    art.set(
        SharedByte::from_str(&format!("user:{}", user.id)),
        Value::String(SharedByte::from_slice(encoded)),
    );
}

pub fn profile(user: &proto::User) -> proto::UserProfile {
    proto::UserProfile {
        id: user.id,
        pseudo: user.pseudo.clone(),
        avatar_version: user.avatar_version,
        bio: user.bio.clone(),
    }
}

/// Story 36 : profils de tous les comptes qui ont choisi un pseudo (un compte sans
/// pseudo n'a rien pu écrire, cf. `require_pseudo`, donc personne n'a à l'afficher).
pub fn list_profiles(art: &OxidArt) -> Vec<proto::UserProfile> {
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
pub fn require_pseudo(art: &mut OxidArt, user_id: u64) -> Result<proto::User, proto::Error> {
    let user = load_user(art, user_id);
    if user.pseudo.is_empty() {
        return Err(proto::Error {
            code: 403,
            message: "choisis d'abord un pseudo".to_string(),
        });
    }
    Ok(user)
}

pub fn pseudo_index_key(pseudo: &str) -> String {
    format!("pseudo_index:{}", pseudo.to_lowercase())
}

/// Stories 34-35 : choix ou changement de pseudo, unique casse ignorée via
/// `pseudo_index:{minuscules}`. Changer seulement la casse de son propre pseudo est
/// permis. Ancien index supprimé et nouveau posé dans le même emprunt.
pub fn set_pseudo(
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
pub fn set_status(
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
pub fn set_theme(
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

/// Story 43 : description de profil, diffusée comme un changement de pseudo.
pub fn set_bio(
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
pub fn set_avatar(
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
pub fn get_avatar(
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
pub fn load_user(art: &mut OxidArt, id: u64) -> proto::User {
    let user_bytes = art
        .get(format!("user:{id}").as_bytes())
        .expect("référence vers user:{id} inexistant — invariant violé");
    codec::decode(user_bytes.as_bytes().expect("user:{id} toujours Value::String").as_slice(), "user:{id}")
}



/// Story 76 : au-delà, refusé (la page propose 0-200 %).
const MAX_VOICE_VOLUME: u32 = 200;

/// Story 76 : `voice_volume:{moi}:{autre}` → volume en %, clé absente = 100 %. Une clé
/// par personne réglée, hors de `Settings` (bincode strict, cf. user-stories.md).
fn voice_volume_prefix(user_id: u64) -> String {
    format!("voice_volume:{}:", keys::sortable_id(user_id))
}

pub fn voice_volumes(art: &OxidArt, user_id: u64) -> Vec<proto::VoiceVolumeSet> {
    let prefix = voice_volume_prefix(user_id);
    art.krange(prefix.as_bytes(), b"", usize::MAX, false)
        .iter()
        .filter_map(|(key, val)| {
            let other = keys::parse_sortable_id(&key[prefix.len()..])?;
            let RangeVal::Int(volume) = val else { return None };
            Some(proto::VoiceVolumeSet {
                user_id: other,
                volume: volume as u32,
            })
        })
        .collect()
}

pub fn set_voice_volume(
    req: proto::SetVoiceVolume,
    state: &AppState,
    user_id: Option<u64>,
) -> Result<proto::VoiceVolumeSet, proto::Error> {
    let me = require_auth(user_id)?;
    if req.volume > MAX_VOICE_VOLUME || !keys::is_sortable(req.user_id) || req.user_id == me {
        return Err(proto::Error {
            code: 400,
            message: format!("volume entre 0 et {MAX_VOICE_VOLUME} %, pour une autre personne"),
        });
    }
    let key = format!("{}{}", voice_volume_prefix(me), keys::sortable_id(req.user_id));
    let mut art = state.art.borrow_mut();
    if req.volume == 100 {
        art.del(key.as_bytes());
    } else {
        art.set(SharedByte::from_str(&key), Value::Int(req.volume as i64));
    }
    state.dirty.set(true);
    Ok(proto::VoiceVolumeSet {
        user_id: req.user_id,
        volume: req.volume,
    })
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
}
