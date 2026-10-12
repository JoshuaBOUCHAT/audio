//! Comptes à mot de passe et entrée sur invitation (stories 65-68).
//!
//! - `password:{user}` : hash bcrypt (coût 12, calculé par tranches de 16 tours qui
//!   rendent la main à monoio : la boucle single-thread ne se fige jamais plus de
//!   ~1 ms, audio et vidéo compris) d'un HMAC-SHA256 du mot de passe par le
//!   **pepper**, secret serveur de 32 octets hors de la base (`data/pepper`, ou
//!   `AUDIO_PEPPER`) : un dump seul ne permet pas de tester des mots de passe.
//!   Jamais dans `User`, qui part au client.
//! - `login_fail:{email}` : échecs récents (TTL 15 min, prolongé à chaque échec) ;
//!   10 bloquent l'email. Le flow d'auth reste strict (CLAUDE.md).
//! - `invite:{token}` : invitation à usage unique, TTL choisi par l'admin.
//! - `magic_link:{token}` : lien de connexion de dépannage, créé par l'admin seul.

use std::path::Path;
use std::task::Poll;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use aws_lc_rs::{constant_time, hmac, rand};
use base64::Engine;
use base64::engine::general_purpose::STANDARD as BASE64;
use blowfish::Blowfish;
use oxidart::krange::RangeVal;
use oxidart::{OxidArt, Value};
use radixox_lib::shared_byte::SharedByte;

use crate::{codec, keys, proto};

const BCRYPT_COST: u32 = 12;
/// Tours de bcrypt entre deux `yield` (~45 µs chacun en release).
const ROUNDS_PER_SLICE: u32 = 16;
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
        Self::from_secret(&secret)
    }

    fn from_secret(secret: &[u8]) -> Self {
        let pepper = hmac::Key::new(hmac::HMAC_SHA256, secret);
        // Au démarrage, rien d'autre ne tourne encore : la version d'un bloc suffit.
        let dummy = bcrypt::hash(peppered(&pepper, "mot de passe factice"), BCRYPT_COST).expect("bcrypt");
        Self { pepper, dummy }
    }

    pub async fn hash(&self, password: &str) -> String {
        let mut salt = [0u8; 16];
        rand::fill(&mut salt).expect("aléa système");
        let output = bcrypt_yielding(BCRYPT_COST, salt, peppered(&self.pepper, password).as_bytes()).await;
        format!(
            "$2b${BCRYPT_COST:02}${}{}",
            bcrypt::BASE_64.encode(salt),
            bcrypt::BASE_64.encode(&output[..23])
        )
    }

    pub async fn verify(&self, password: &str, hash: Option<&str>) -> bool {
        let Some((cost, salt, expected)) = split_hash(hash.unwrap_or(&self.dummy)) else {
            return false;
        };
        let output = bcrypt_yielding(cost, salt, peppered(&self.pepper, password).as_bytes()).await;
        let ok = constant_time::verify_slices_are_equal(&output[..23], &expected).is_ok();
        ok && hash.is_some()
    }
}

/// Hash d'un coût inférieur à l'actuel (créé avant le passage au coût 12) : à refaire
/// à la prochaine connexion réussie, seul moment où le mot de passe est connu.
pub fn needs_rehash(hash: &str) -> bool {
    split_hash(hash).is_some_and(|(cost, ..)| cost < BCRYPT_COST)
}

/// `$2b$12$` + sel (22 caractères) + hash (31), alphabet base64 de bcrypt.
fn split_hash(hash: &str) -> Option<(u32, [u8; 16], Vec<u8>)> {
    let rest = ["$2a$", "$2b$", "$2y$"].iter().find_map(|prefix| hash.strip_prefix(prefix))?;
    let (cost, rest) = rest.split_once('$')?;
    let cost = cost.parse().ok().filter(|cost| (4..=31).contains(cost))?;
    if rest.len() != 53 || !rest.is_ascii() {
        return None;
    }
    let salt = bcrypt::BASE_64.decode(&rest[..22]).ok()?.try_into().ok()?;
    let expected = bcrypt::BASE_64.decode(&rest[22..]).ok()?;
    Some((cost, salt, expected))
}

/// bcrypt de la crate `bcrypt` (même sortie, bit pour bit), mais les `2^cost` tours
/// du key schedule — tout le coût — rendent la main tous les `ROUNDS_PER_SLICE`.
async fn bcrypt_yielding(cost: u32, salt: [u8; 16], password: &[u8]) -> [u8; 24] {
    // Mot de passe terminé par un zéro, 72 octets au plus (le nôtre en fait 45).
    let mut key = Vec::with_capacity(password.len() + 1);
    key.extend_from_slice(password);
    key.push(0);
    key.truncate(72);

    let mut state = Blowfish::bc_init_state();
    state.salted_expand_key(&salt, &key);
    for round in 1..=1u32 << cost {
        state.bc_expand_key(&key);
        state.bc_expand_key(&salt);
        if round % ROUNDS_PER_SLICE == 0 {
            yield_now().await;
        }
    }

    // « OrpheanBeholderScryDoubt » chiffré 64 fois.
    let mut ctext = [0x4f727068, 0x65616e42, 0x65686f6c, 0x64657253, 0x63727944, 0x6f756274];
    let mut output = [0; 24];
    for i in (0..6).step_by(2) {
        for _ in 0..64 {
            [ctext[i], ctext[i + 1]] = state.bc_encrypt([ctext[i], ctext[i + 1]]);
        }
        output[i * 4..][..4].copy_from_slice(&ctext[i].to_be_bytes());
        output[(i + 1) * 4..][..4].copy_from_slice(&ctext[i + 1].to_be_bytes());
    }
    output
}

/// Rend la main une fois : la tâche repasse en fin de file, les autres tâches et les
/// complétions io_uring passent avant (monoio n'expose pas de `yield_now`).
async fn yield_now() {
    let mut yielded = false;
    std::future::poll_fn(|cx| {
        if yielded {
            return Poll::Ready(());
        }
        yielded = true;
        cx.waker().wake_by_ref();
        Poll::Pending
    })
    .await
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
    use futures::executor::block_on;
    use std::future::Future;

    fn passwords() -> Passwords {
        let dir = std::env::temp_dir().join(format!("audio-pepper-{}", uuid::Uuid::new_v4()));
        Passwords::load(&dir)
    }

    #[test]
    fn hachage_avec_pepper() {
        block_on(async {
            let p = passwords();
            let hash = p.hash("correct horse").await;
            assert!(hash.starts_with("$2b$12$"));
            assert!(p.verify("correct horse", Some(&hash)).await);
            assert!(!p.verify("mauvais", Some(&hash)).await);
            assert!(!p.verify("correct horse", None).await, "compte sans mot de passe");
            let other = passwords(); // autre pepper : le hash ne vaut plus rien
            assert!(!other.verify("correct horse", Some(&hash)).await);
            assert!(!p.verify("correct horse", Some("pas un hash")).await);
        });
    }

    /// Même sortie que la crate `bcrypt`, dans les deux sens, y compris au-delà de 72
    /// octets (troncature) et pour les hash coût 6 d'avant le coût 12.
    #[test]
    fn bcrypt_decoupe_identique_a_la_crate() {
        block_on(async {
            let salt = *b"0123456789abcdef";
            for password in ["a", "correct horse battery staple", &"x".repeat(100)] {
                for cost in [4, 5, 6] {
                    let mut terminated = password.as_bytes().to_vec();
                    terminated.push(0);
                    terminated.truncate(72);
                    assert_eq!(
                        bcrypt_yielding(cost, salt, password.as_bytes()).await,
                        bcrypt::bcrypt(cost, salt, &terminated),
                        "coût {cost}, {} octets",
                        password.len()
                    );
                }
            }
            let p = passwords();
            let legacy = bcrypt::hash(peppered(&p.pepper, "ancien mdp"), 6).unwrap();
            assert!(p.verify("ancien mdp", Some(&legacy)).await, "hash coût 6 encore valide");
            assert!(needs_rehash(&legacy));
            let fresh = p.hash("ancien mdp").await;
            assert!(!needs_rehash(&fresh));
            assert!(bcrypt::verify(peppered(&p.pepper, "ancien mdp"), &fresh).unwrap(), "lisible par la crate");
        });
    }

    /// Coût 6 = 64 tours = 4 tranches de 16 : la tâche rend la main 4 fois.
    #[test]
    fn bcrypt_rend_la_main_tous_les_16_tours() {
        let waker = futures::task::noop_waker();
        let mut cx = std::task::Context::from_waker(&waker);
        let mut fut = std::pin::pin!(bcrypt_yielding(6, [0; 16], b"x"));
        let mut pending = 0;
        while fut.as_mut().poll(&mut cx).is_pending() {
            pending += 1;
        }
        assert_eq!(pending, 64 / ROUNDS_PER_SLICE);
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
