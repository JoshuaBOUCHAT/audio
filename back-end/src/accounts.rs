//! Comptes à mot de passe et entrée sur invitation (stories 65-68).
//!
//! - `password:{user}` : hash bcrypt (coût 6, ~3 ms : la boucle single-thread ne se
//!   fige pas, audio et vidéo compris) d'un HMAC-SHA256 du mot de passe par le
//!   **pepper**, secret serveur de 32 octets hors de la base (`data/pepper`, ou
//!   `AUDIO_PEPPER`) : un dump seul ne permet pas de tester des mots de passe.
//!   Jamais dans `User`, qui part au client.
//! - `login_fail:{email}` : échecs récents (TTL 15 min, prolongé à chaque échec) ;
//!   10 bloquent l'email. Le flow d'auth reste strict (CLAUDE.md).
//! - `invite:{token}` : invitation à usage unique, TTL choisi par l'admin.
//! - `magic_link:{token}` : lien de connexion de dépannage, créé par l'admin seul.

use std::path::Path;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use aws_lc_rs::{hmac, rand};
use base64::Engine;
use base64::engine::general_purpose::STANDARD as BASE64;
use oxidart::krange::RangeVal;
use oxidart::{OxidArt, Value};
use radixox_lib::shared_byte::SharedByte;

use crate::{codec, keys, proto};

const BCRYPT_COST: u32 = 6;
pub const MIN_PASSWORD_CHARS: usize = 8;
const MAX_PASSWORD_CHARS: usize = 128;
const MAX_FAILURES: i64 = 10;
const LOCKOUT: Duration = Duration::from_secs(15 * 60);
const MAX_LINK_TTL: Duration = Duration::from_secs(30 * 24 * 3600);
const MIN_LINK_TTL: Duration = Duration::from_secs(60);

pub struct Passwords {
    pepper: hmac::Key,
    /// Hash d'un mot de passe quelconque, vérifié pour un email inconnu : même durée
    /// de réponse que pour un vrai compte.
    dummy: String,
}

impl Passwords {
    /// Pepper : `AUDIO_PEPPER`, sinon `data/pepper` (créé au premier lancement, droits
    /// 0600). Le perdre rend tous les mots de passe invalides (les liens de connexion
    /// de l'admin restent la sortie de secours).
    pub fn load(data_dir: &Path) -> Self {
        let secret = match std::env::var("AUDIO_PEPPER") {
            Ok(secret) => secret.into_bytes(),
            Err(_) => {
                let path = data_dir.join("pepper");
                match std::fs::read(&path) {
                    Ok(secret) => secret,
                    Err(_) => {
                        let mut secret = [0u8; 32];
                        rand::fill(&mut secret).expect("aléa système");
                        let hex: String = secret.iter().map(|b| format!("{b:02x}")).collect();
                        std::fs::create_dir_all(data_dir).expect("création du dossier de données");
                        write_private(&path, hex.as_bytes());
                        println!("[boot] pepper créé : {}", path.display());
                        hex.into_bytes()
                    }
                }
            }
        };
        let pepper = hmac::Key::new(hmac::HMAC_SHA256, &secret);
        let dummy = bcrypt::hash(peppered(&pepper, "mot de passe factice"), BCRYPT_COST).expect("bcrypt");
        Self { pepper, dummy }
    }

    pub fn hash(&self, password: &str) -> String {
        bcrypt::hash(peppered(&self.pepper, password), BCRYPT_COST).expect("bcrypt")
    }

    pub fn verify(&self, password: &str, hash: Option<&str>) -> bool {
        let ok = bcrypt::verify(peppered(&self.pepper, password), hash.unwrap_or(&self.dummy)).unwrap_or(false);
        ok && hash.is_some()
    }
}

#[cfg(unix)]
fn write_private(path: &Path, bytes: &[u8]) {
    use std::io::Write;
    use std::os::unix::fs::OpenOptionsExt;
    let mut file = std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(path)
        .expect("création du pepper");
    file.write_all(bytes).expect("écriture du pepper");
}

/// HMAC du mot de passe par le pepper, en base64 (44 caractères, sous la limite de 72
/// octets de bcrypt).
fn peppered(pepper: &hmac::Key, password: &str) -> String {
    BASE64.encode(hmac::sign(pepper, password.as_bytes()).as_ref())
}

fn password_key(user_id: u64) -> String {
    format!("password:{}", keys::sortable_id(user_id))
}

pub fn password_hash(art: &mut OxidArt, user_id: u64) -> Option<String> {
    art.get(password_key(user_id).as_bytes())
        .map(|v| v.as_bytes().expect("password toujours Value::String").as_str().expect("hash ASCII").to_string())
}

pub fn store_password(art: &mut OxidArt, user_id: u64, hash: &str) {
    art.set(SharedByte::from_str(&password_key(user_id)), Value::String(SharedByte::from_str(hash)));
}

pub fn validate_password(password: &str) -> Result<(), proto::Error> {
    let chars = password.chars().count();
    if chars < MIN_PASSWORD_CHARS {
        return Err(proto::Error {
            code: 400,
            message: format!("mot de passe trop court ({MIN_PASSWORD_CHARS} caractères min)"),
        });
    }
    if chars > MAX_PASSWORD_CHARS {
        return Err(proto::Error {
            code: 400,
            message: "mot de passe trop long".to_string(),
        });
    }
    Ok(())
}

fn fail_key(email: &str) -> String {
    format!("login_fail:{email}")
}

/// Story 67 : 429 si l'email a déjà trop d'échecs récents.
pub fn check_lockout(art: &mut OxidArt, email: &str) -> Result<(), proto::Error> {
    let failures = art.get(fail_key(email).as_bytes()).map(|v| v.to_int().unwrap_or(0)).unwrap_or(0);
    if failures >= MAX_FAILURES {
        return Err(proto::Error {
            code: 429,
            message: "trop d'essais : réessaie dans 15 minutes".to_string(),
        });
    }
    Ok(())
}

/// Un échec de plus ; la fenêtre de 15 min repart à chaque échec.
pub fn record_failure(art: &mut OxidArt, email: &str) {
    let key = fail_key(email);
    let failures = art.get(key.as_bytes()).map(|v| v.to_int().unwrap_or(0)).unwrap_or(0) + 1;
    art.set_ttl(SharedByte::from_str(&key), LOCKOUT, Value::Int(failures));
}

pub fn clear_failures(art: &mut OxidArt, email: &str) {
    art.del(fail_key(email).as_bytes());
}

fn now_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).expect("horloge").as_millis() as u64
}

/// Durée d'un lien choisie par l'admin, bornée à [1 min, 30 jours].
pub fn link_ttl(seconds: u32) -> Result<Duration, proto::Error> {
    let ttl = Duration::from_secs(seconds as u64);
    if !(MIN_LINK_TTL..=MAX_LINK_TTL).contains(&ttl) {
        return Err(proto::Error {
            code: 400,
            message: "durée de validité : entre 1 minute et 30 jours".to_string(),
        });
    }
    Ok(ttl)
}

fn invite_key(token: &str) -> String {
    format!("invite:{token}")
}

/// Story 65 : invitation à usage unique, expirée par le TTL natif d'OxidArt.
pub fn create_invite(art: &mut OxidArt, ttl: Duration) -> proto::Invite {
    let created_at = now_ms();
    let invite = proto::Invite {
        token: uuid::Uuid::new_v4().to_string(),
        created_at,
        expires_at: created_at + ttl.as_millis() as u64,
    };
    art.set_ttl(
        SharedByte::from_str(&invite_key(&invite.token)),
        ttl,
        Value::String(SharedByte::from_slice(codec::encode(&invite))),
    );
    invite
}

/// Invitations en cours, la plus récente d'abord (les expirées ont disparu d'elles-mêmes).
pub fn list_invites(art: &OxidArt) -> Vec<proto::Invite> {
    let mut invites: Vec<proto::Invite> = art
        .krange(b"invite:", b"", usize::MAX, false)
        .iter()
        .filter_map(|(_, val)| match val {
            RangeVal::Bytes(b) => Some(codec::decode(b.as_slice(), "invite")),
            RangeVal::Int(_) => None,
        })
        .collect();
    invites.sort_by_key(|i: &proto::Invite| std::cmp::Reverse(i.created_at));
    invites
}

pub fn invite_exists(art: &mut OxidArt, token: &str) -> bool {
    uuid::Uuid::parse_str(token).is_ok() && art.get(invite_key(token).as_bytes()).is_some()
}

/// Consomme (ou révoque) une invitation ; `false` si elle n'existait plus.
pub fn take_invite(art: &mut OxidArt, token: &str) -> bool {
    invite_exists(art, token) && art.del(invite_key(token).as_bytes())
}

/// Story 68 : lien magique de dépannage pour un membre (usage unique, TTL choisi).
pub fn create_login_link(art: &mut OxidArt, email: &str, ttl: Duration) -> proto::LoginLinkCreated {
    let token = uuid::Uuid::new_v4().to_string();
    art.set_ttl(
        SharedByte::from_str(&format!("magic_link:{token}")),
        ttl,
        Value::String(SharedByte::from_str(email)),
    );
    proto::LoginLinkCreated {
        token,
        expires_at: now_ms() + ttl.as_millis() as u64,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn passwords() -> Passwords {
        let dir = std::env::temp_dir().join(format!("audio-pepper-{}", uuid::Uuid::new_v4()));
        Passwords::load(&dir)
    }

    #[test]
    fn hachage_avec_pepper() {
        let p = passwords();
        let hash = p.hash("correct horse");
        assert!(p.verify("correct horse", Some(&hash)));
        assert!(!p.verify("mauvais", Some(&hash)));
        assert!(!p.verify("correct horse", None), "compte sans mot de passe");
        let other = passwords(); // autre pepper : le hash ne vaut plus rien
        assert!(!other.verify("correct horse", Some(&hash)));
    }

    #[test]
    fn verrouillage_apres_dix_echecs() {
        let mut art = OxidArt::new();
        for _ in 0..9 {
            record_failure(&mut art, "a@x.fr");
        }
        assert!(check_lockout(&mut art, "a@x.fr").is_ok());
        record_failure(&mut art, "a@x.fr");
        assert_eq!(check_lockout(&mut art, "a@x.fr").unwrap_err().code, 429);
        assert!(check_lockout(&mut art, "b@x.fr").is_ok(), "par email");
        clear_failures(&mut art, "a@x.fr");
        assert!(check_lockout(&mut art, "a@x.fr").is_ok());
    }

    #[test]
    fn invitations_usage_unique() {
        let mut art = OxidArt::new();
        let invite = create_invite(&mut art, Duration::from_secs(3600));
        assert_eq!(list_invites(&art).len(), 1);
        assert!(take_invite(&mut art, &invite.token));
        assert!(!take_invite(&mut art, &invite.token), "usage unique");
        assert!(list_invites(&art).is_empty());
        assert!(link_ttl(30).is_err() && link_ttl(31 * 24 * 3600).is_err() && link_ttl(3600).is_ok());
    }
}
