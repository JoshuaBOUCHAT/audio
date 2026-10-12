//! Images et fichiers (stories 27, 45-53) : fichiers sur disque, métadonnées dans
//! OxidArt. Une image propre (story 47) s'affiche dans le fil ; tout le reste est un
//! fichier, toujours servi en téléchargement (story 51).
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
use std::time::Duration;

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
                "quota de stockage dépassé ({:.1} Gio par personne)",
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
            message: "seule la personne qui l'a envoyé peut le supprimer pour tout le monde"
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

/// Story 54 : vidéo lisible par le lecteur du navigateur, reconnue à ses octets
/// magiques — MP4/MOV (boîte `ftyp` en tête), WebM/Matroska (en-tête EBML). Un MP4
/// audio seul (marques M4A/M4B/M4P) n'en est pas une.
pub fn sniff_video(probe: &[u8]) -> Option<&'static str> {
    if probe.len() >= 12 && &probe[4..8] == b"ftyp" {
        return match &probe[8..12] {
            b"M4A " | b"M4B " | b"M4P " => None,
            b"qt  " => Some("video/quicktime"),
            _ => Some("video/mp4"),
        };
    }
    if probe.starts_with(b"\x1a\x45\xdf\xa3") {
        let head = &probe[..probe.len().min(64)];
        let webm = head.windows(4).any(|w| w == b"webm");
        return Some(if webm { "video/webm" } else { "video/x-matroska" });
    }
    None
}

/// Story 51 : un fichier qui n'est pas une image propre.
pub const FILE_MIME: &str = "application/octet-stream";
const MAX_NAME_CHARS: usize = 255;

/// Story 51 : nom fourni par le client (`X-Media-Name`, encodé en pourcentage),
/// assaini — ni chemin, ni caractère de contrôle, 255 caractères max. `fallback` si
/// rien d'utilisable.
pub fn sanitize_name(raw: Option<&str>, fallback: &str) -> String {
    let decoded = raw.map(percent_decode).unwrap_or_default();
    let base = decoded.rsplit(['/', '\\']).next().unwrap_or("");
    let name: String = base
        .chars()
        .filter(|c| !c.is_control())
        .take(MAX_NAME_CHARS)
        .collect::<String>()
        .trim()
        .to_string();
    if name.is_empty() || name == "." || name == ".." {
        fallback.to_string()
    } else {
        name
    }
}

fn percent_decode(raw: &str) -> String {
    let bytes = raw.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%'
            && i + 2 < bytes.len()
            && let Some(b) = raw.get(i + 1..i + 3).and_then(|h| u8::from_str_radix(h, 16).ok())
        {
            out.push(b);
            i += 3;
        } else {
            out.push(bytes[i]);
            i += 1;
        }
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// `filename*=UTF-8''…` (RFC 5987) pour `Content-Disposition`.
pub fn percent_encode(name: &str) -> String {
    name.bytes()
        .map(|b| match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'.' | b'_' | b'~' => (b as char).to_string(),
            _ => format!("%{b:02X}"),
        })
        .collect()
}

/// Story 53 : ticket de téléchargement, servi en pièce jointe, 60 s (TTL natif
/// d'OxidArt) — vérifié au début de la requête seulement : un téléchargement plus long
/// n'est pas coupé.
/// Story 54 : ticket de lecture, servi en ligne (lecteur vidéo, requêtes Range), 1 h
/// prolongée à chaque requête — une vidéo en pause ne coupe pas.
#[derive(Clone, Copy, PartialEq, Debug)]
pub enum Ticket {
    Download,
    Stream,
}

impl Ticket {
    fn prefix(self) -> &'static str {
        match self {
            Ticket::Download => "download_ticket:",
            Ticket::Stream => "stream_ticket:",
        }
    }

    fn ttl(self) -> Duration {
        match self {
            Ticket::Download => Duration::from_secs(60),
            Ticket::Stream => Duration::from_secs(3600),
        }
    }
}

pub fn create_ticket(art: &mut OxidArt, media_id: &str, kind: Ticket) -> String {
    let ticket = uuid::Uuid::new_v4().to_string();
    art.set_ttl(
        SharedByte::from_str(&format!("{}{ticket}", kind.prefix())),
        kind.ttl(),
        Value::String(SharedByte::from_str(media_id)),
    );
    ticket
}

/// Sorte du ticket s'il est valide pour ce média (réutilisable pendant sa durée de vie :
/// le navigateur rejoue des requêtes) ; un ticket de lecture est prolongé.
pub fn check_ticket(art: &mut OxidArt, ticket: &str, media_id: &str) -> Option<Ticket> {
    if !is_media_id(ticket) {
        return None;
    }
    for kind in [Ticket::Download, Ticket::Stream] {
        let key = format!("{}{ticket}", kind.prefix());
        let valid = art
            .get(key.as_bytes())
            .is_some_and(|v| v.as_bytes().is_some_and(|b| b.as_slice() == media_id.as_bytes()));
        if valid {
            if kind == Ticket::Stream {
                art.set_ttl(SharedByte::from_str(&key), kind.ttl(), Value::String(SharedByte::from_str(media_id)));
            }
            return Some(kind);
        }
    }
    None
}

pub fn not_found() -> proto::Error {
    proto::Error {
        code: 404,
        message: "fichier inconnu ou supprimé".to_string(),
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
    fn videos() {
        assert_eq!(sniff_video(b"\0\0\0\x20ftypisom\0\0\x02\0"), Some("video/mp4"));
        assert_eq!(sniff_video(b"\0\0\0\x14ftypqt  \0\0\0\0"), Some("video/quicktime"));
        assert_eq!(sniff_video(b"\0\0\0\x20ftypM4A \0\0\0\0"), None);
        assert_eq!(sniff_video(b"\x1a\x45\xdf\xa3\x9f\x42\x86\x81\x01\x42\x82\x84webm"), Some("video/webm"));
        assert_eq!(sniff_video(b"\x1a\x45\xdf\xa3\x42\x82\x88matroska"), Some("video/x-matroska"));
        assert_eq!(sniff_video(b"PK\x03\x04"), None);
    }

    #[test]
    fn noms_assainis() {
        assert_eq!(sanitize_name(Some("vacances%20%C3%A9t%C3%A9.zip"), "f"), "vacances été.zip");
        assert_eq!(sanitize_name(Some("..%2F..%2Fetc%2Fpasswd"), "f"), "passwd");
        assert_eq!(sanitize_name(Some("a%0Ab"), "f"), "ab");
        assert_eq!(sanitize_name(Some(".."), "f"), "f");
        assert_eq!(sanitize_name(None, "fichier"), "fichier");
        assert_eq!(sanitize_name(Some(&"é".repeat(300)), "f").chars().count(), 255);
        assert_eq!(percent_encode("été 1.zip"), "%C3%A9t%C3%A9%201.zip");
    }

    #[test]
    fn ids_valides() {
        assert!(is_media_id("6f9619ff-8b86-4011-b42d-00c04fc964ff"));
        assert!(!is_media_id("../../etc/passwd"));
        assert!(!is_media_id("6F9619FF-8B86-4011-B42D-00C04FC964FF"));
    }
}
