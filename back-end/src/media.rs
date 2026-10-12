//! Images (stories 27, 45-50) : fichiers sur disque, métadonnées dans OxidArt.
//!
//! - `data/media/{sha256}` : contenu, nommé par son empreinte — un même fichier
//!   envoyé deux fois n'est stocké qu'une fois. `media_file:{sha256}` (counter) compte
//!   les images qui le désignent ; à 0 le fichier est effacé.
//! - `media:{id}` : `StoredMedia` (bincode). `id` = UUID v4 aléatoire, non devinable :
//!   connaître le lien est nécessaire pour voir une image (DM, story 32 / 48).
//! - `media_usage:{user}` (counter) : octets envoyés par l'utilisateur, pour le quota
//!   (story 48).
//!
//! Les images ne vont pas dans OxidArt : elles y seraient toutes en RAM et réécrites
//! à chaque snapshot. Le contenu transite par HTTP (`http.rs`), jamais par le WS.

use std::path::{Path, PathBuf};

use oxidart::{OxidArt, Value};
use radixox_lib::shared_byte::SharedByte;
use serde::{Deserialize, Serialize};

use crate::{keys, proto};

/// Story 47 : au-delà, une « bombe » de pixels ferait planter le navigateur des autres.
pub const MAX_SIDE: u32 = 16_384;
/// Assez d'octets pour lire les dimensions de tous les formats acceptés (un JPEG peut
/// porter de longues métadonnées EXIF avant ses dimensions).
pub const PROBE_LEN: usize = 1 << 20;

#[derive(Serialize, Deserialize)]
pub struct StoredMedia {
    pub meta: proto::Media,
    pub sha256: String,
}

/// Dossier des images et quota par personne (story 48), fixés au lancement.
pub struct MediaConfig {
    pub dir: PathBuf,
    /// Octets par personne ; 0 = illimité.
    pub quota: u64,
}

impl MediaConfig {
    /// `AUDIO_MEDIA_QUOTA_GIB` : quota par personne en Gio (décimales permises), 25 par
    /// défaut, 0 = illimité.
    pub fn from_env(data_dir: &Path) -> Self {
        let gib: f64 = std::env::var("AUDIO_MEDIA_QUOTA_GIB")
            .ok()
            .map(|v| v.parse().expect("AUDIO_MEDIA_QUOTA_GIB : nombre de Gio, 0 = illimité"))
            .unwrap_or(25.0);
        let dir = data_dir.join("media");
        std::fs::create_dir_all(dir.join("tmp")).expect("création de data/media/tmp");
        Self {
            dir,
            quota: (gib * (1u64 << 30) as f64) as u64,
        }
    }

    pub fn file_path(&self, sha256: &str) -> PathBuf {
        self.dir.join(sha256)
    }

    pub fn temp_path(&self) -> PathBuf {
        self.dir.join("tmp").join(uuid::Uuid::new_v4().to_string())
    }
}

pub fn media_key(id: &str) -> String {
    format!("media:{id}")
}

fn usage_key(user_id: u64) -> String {
    format!("media_usage:{}", keys::sortable_id(user_id))
}

fn file_key(sha256: &str) -> String {
    format!("media_file:{sha256}")
}

pub fn usage(art: &mut OxidArt, user_id: u64) -> u64 {
    art.get(usage_key(user_id).as_bytes())
        .map(|v| v.to_int().expect("media_usage toujours un entier") as u64)
        .unwrap_or(0)
}

/// Story 48 : refus avant d'écrire quoi que ce soit sur le disque.
pub fn check_quota(art: &mut OxidArt, config: &MediaConfig, user_id: u64, size: u64) -> Result<(), proto::Error> {
    if config.quota != 0 && usage(art, user_id) + size > config.quota {
        return Err(proto::Error {
            code: 413,
            message: format!(
                "quota d'images dépassé ({:.1} Gio par personne)",
                config.quota as f64 / (1u64 << 30) as f64
            ),
        });
    }
    Ok(())
}

/// Story 47 : format reconnu à ses octets magiques, dimensions lues dans l'en-tête,
/// sans décoder l'image (le serveur single-thread serait bloqué) ni la réencoder (les
/// GIF gardent leur animation).
pub fn sniff(probe: &[u8]) -> Result<(&'static str, u32, u32), proto::Error> {
    let invalid = |message: &str| proto::Error {
        code: 400,
        message: message.to_string(),
    };
    let mime = if probe.starts_with(b"\x89PNG\r\n\x1a\n") {
        "image/png"
    } else if probe.starts_with(b"\xff\xd8\xff") {
        "image/jpeg"
    } else if probe.len() >= 12 && probe.starts_with(b"RIFF") && &probe[8..12] == b"WEBP" {
        "image/webp"
    } else if probe.starts_with(b"GIF87a") || probe.starts_with(b"GIF89a") {
        "image/gif"
    } else {
        return Err(invalid("image attendue : PNG, JPEG, WebP ou GIF"));
    };
    let size = imagesize::blob_size(probe).map_err(|_| invalid("en-tête d'image illisible"))?;
    let (width, height) = (size.width as u64, size.height as u64);
    if width == 0 || height == 0 {
        return Err(invalid("image vide"));
    }
    if width > MAX_SIDE as u64 || height > MAX_SIDE as u64 {
        return Err(invalid("image trop grande (16 384 px de côté max)"));
    }
    Ok((mime, width as u32, height as u32))
}

/// Réserve le fichier `sha256` pour une nouvelle image : `true` si c'est le premier
/// (le fichier temporaire doit devenir `data/media/{sha256}`), `false` s'il existe
/// déjà (doublon : le temporaire est jeté). Réservé avant le renommage pour qu'une
/// suppression concurrente ne puisse pas effacer le fichier qu'on s'apprête à poser.
pub fn reserve_file(art: &mut OxidArt, sha256: &str) -> bool {
    art.incr(SharedByte::from_str(&file_key(sha256)))
        .expect("media_file toujours un entier")
        == 1
}

pub fn record(art: &mut OxidArt, stored: &StoredMedia) {
    let encoded = bincode::serialize(stored).expect("sérialisation StoredMedia");
    art.set(
        SharedByte::from_str(&media_key(&stored.meta.id)),
        Value::String(SharedByte::from_slice(encoded)),
    );
    art.incrby(
        SharedByte::from_str(&usage_key(stored.meta.owner_id)),
        stored.meta.size as i64,
    )
    .expect("media_usage toujours un entier");
}

pub fn load(art: &mut OxidArt, id: &str) -> Option<StoredMedia> {
    let val = art.get(media_key(id).as_bytes())?;
    Some(
        bincode::deserialize(val.as_bytes().expect("media:{id} toujours Value::String").as_slice())
            .expect("media:{id} corrompu"),
    )
}

/// Story 50 : « supprimer pour tout le monde », par celle ou celui qui l'a envoyée.
/// Rend son poids au quota ; efface le fichier si plus aucune image ne le désigne.
/// L'effacement est un `unlink` synchrone (rare, instantané) : il a lieu dans le même
/// emprunt que le décompte, donc aucun envoi concurrent ne peut s'intercaler entre les
/// deux (cf. `reserve_file`).
pub fn delete(art: &mut OxidArt, config: &MediaConfig, id: &str, user_id: u64) -> Result<(), proto::Error> {
    if !is_media_id(id) {
        return Err(not_found());
    }
    let stored = load(art, id).ok_or_else(not_found)?;
    if stored.meta.owner_id != user_id {
        return Err(proto::Error {
            code: 403,
            message: "seule la personne qui a envoyé l'image peut la supprimer pour tout le monde"
                .to_string(),
        });
    }
    art.del(media_key(id).as_bytes());
    art.decrby(SharedByte::from_str(&usage_key(user_id)), stored.meta.size as i64)
        .expect("media_usage toujours un entier");
    let remaining = art
        .decr(SharedByte::from_str(&file_key(&stored.sha256)))
        .expect("media_file toujours un entier");
    if remaining <= 0 {
        art.del(file_key(&stored.sha256).as_bytes());
        if let Err(e) = std::fs::remove_file(config.file_path(&stored.sha256)) {
            eprintln!("[media] effacement de {} : {e}", stored.sha256);
        }
    }
    Ok(())
}

pub fn not_found() -> proto::Error {
    proto::Error {
        code: 404,
        message: "image inconnue ou supprimée".to_string(),
    }
}

/// Id d'image valide (UUID) : refuse toute autre forme avant d'en faire une clé ou un
/// chemin.
pub fn is_media_id(id: &str) -> bool {
    uuid::Uuid::parse_str(id).is_ok_and(|u| u.hyphenated().to_string() == id)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn png(width: u32, height: u32) -> Vec<u8> {
        let mut b = b"\x89PNG\r\n\x1a\n\0\0\0\x0dIHDR".to_vec();
        b.extend(width.to_be_bytes());
        b.extend(height.to_be_bytes());
        b.extend([8, 6, 0, 0, 0]);
        b
    }

    #[test]
    fn formats_et_dimensions() {
        assert_eq!(sniff(&png(640, 480)).unwrap(), ("image/png", 640, 480));
        let gif = b"GIF89a\x40\x01\xf0\x00\x00\x00\x00;";
        assert_eq!(sniff(gif).unwrap(), ("image/gif", 320, 240));
        assert_eq!(sniff(b"<svg onload=alert(1)>").unwrap_err().code, 400);
        assert_eq!(sniff(&png(MAX_SIDE + 1, 10)).unwrap_err().code, 400);
        assert_eq!(sniff(&png(0, 10)).unwrap_err().code, 400);
    }

    #[test]
    fn ids_valides() {
        assert!(is_media_id("6f9619ff-8b86-4011-b42d-00c04fc964ff"));
        assert!(!is_media_id("../../etc/passwd"));
        assert!(!is_media_id("6F9619FF-8B86-4011-B42D-00C04FC964FF"));
    }
}
