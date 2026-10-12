//! Étape parse-don't-validate (cf. architecture.md § Validation) : chaque `RawX`
//! prost transite par une fonction `validate_*` qui produit un `ValidX` — la
//! non-violation des invariants structurels devient une propriété du type, pas une
//! convention que le code métier doit revérifier.

use uuid::Uuid;

use crate::email::Email;
use crate::proto;

/// `RequestMagicLink.email` vide ou invalide n'a aucune interprétation métier valide
/// (contrairement à un champ optionnel qui ferait partie du flow normal), donc
/// rejeté ici plutôt que remonté au handler. La validation/normalisation elle-même
/// vit dans `Email::parse` — cette fonction ne fait que l'appliquer au bon champ.
pub struct ValidRequestMagicLink {
    pub email: Email,
}

pub fn validate_request_magic_link(
    raw: proto::RequestMagicLink,
) -> Result<ValidRequestMagicLink, proto::Error> {
    let email = Email::parse(&raw.email)?;
    Ok(ValidRequestMagicLink { email })
}

/// `AuthRequest.token` accepte indifféremment un token de lien magique ou un token
/// de session (story 33) — les deux sont des UUID v4 bruts, aucun invariant métier
/// au-delà du format UUID, donc pas de newtype dédié (contrairement à `Email`) :
/// un `Uuid::parse_str` suffit à porter toute la garantie structurelle nécessaire.
pub struct ValidAuthRequest {
    pub token: Uuid,
}

pub fn validate_auth_request(raw: proto::AuthRequest) -> Result<ValidAuthRequest, proto::Error> {
    let token = Uuid::parse_str(&raw.token).map_err(|_| proto::Error {
        code: 400,
        message: "token invalide".to_string(),
    })?;
    Ok(ValidAuthRequest { token })
}

/// Story 7 : un salon sans nom n'a aucune interprétation métier (le client n'aurait
/// rien à afficher), donc rejeté ici. Le nom est trimé ; pas de longueur max en v1.
/// L'unicité, qui dépend de l'état, est vérifiée par `create_channel`.
pub struct ValidCreateChannel {
    pub name: String,
}

pub fn validate_create_channel(
    raw: proto::CreateChannel,
) -> Result<ValidCreateChannel, proto::Error> {
    let name = raw.name.trim();
    if name.is_empty() {
        return Err(proto::Error {
            code: 400,
            message: "nom de salon vide".to_string(),
        });
    }
    Ok(ValidCreateChannel {
        name: name.to_string(),
    })
}

/// Story 10 : un message vide (ou fait uniquement d'espaces) n'a rien à afficher.
/// Le contenu n'est pas trimé (les espaces peuvent compter dans un message) et n'a pas
/// de taille max en v1 (CLAUDE.md § garde-fous hors scope).
pub struct ValidSendMessage {
    pub channel_id: u64,
    pub content: String,
    /// Story 39 : `SendMessage.reply_to_id` non nul. Son existence dans le salon dépend
    /// de l'état, vérifiée par `send_message`.
    pub reply_to_id: Option<u64>,
}

pub fn validate_send_message(raw: proto::SendMessage) -> Result<ValidSendMessage, proto::Error> {
    Ok(ValidSendMessage {
        channel_id: raw.channel_id,
        content: validate_content(raw.content)?,
        reply_to_id: (raw.reply_to_id != 0).then_some(raw.reply_to_id),
    })
}

/// Story 40 : mêmes règles de contenu qu'à l'envoi.
pub struct ValidEditMessage {
    pub channel_id: u64,
    pub message_id: u64,
    pub content: String,
}

pub fn validate_edit_message(raw: proto::EditMessage) -> Result<ValidEditMessage, proto::Error> {
    Ok(ValidEditMessage {
        channel_id: raw.channel_id,
        message_id: raw.message_id,
        content: validate_content(raw.content)?,
    })
}

fn validate_content(content: String) -> Result<String, proto::Error> {
    if content.trim().is_empty() {
        return Err(proto::Error {
            code: 400,
            message: "message vide".to_string(),
        });
    }
    Ok(content)
}

pub const MAX_PSEUDO_CHARS: usize = 32;

/// Stories 34-35 : pseudo trimé, 1 à 32 caractères, sans caractère de contrôle
/// (retours à la ligne, etc. casseraient l'affichage). L'unicité, qui dépend de
/// l'état, est vérifiée par `set_pseudo`.
pub struct ValidSetPseudo {
    pub pseudo: String,
}

pub fn validate_set_pseudo(raw: proto::SetPseudo) -> Result<ValidSetPseudo, proto::Error> {
    let pseudo = raw.pseudo.trim();
    let invalid = |message: &str| proto::Error {
        code: 400,
        message: message.to_string(),
    };
    if pseudo.is_empty() {
        return Err(invalid("pseudo vide"));
    }
    if pseudo.chars().count() > MAX_PSEUDO_CHARS {
        return Err(invalid("pseudo trop long (32 caractères max)"));
    }
    if pseudo.chars().any(char::is_control) {
        return Err(invalid("pseudo avec caractère de contrôle"));
    }
    Ok(ValidSetPseudo {
        pseudo: pseudo.to_string(),
    })
}

pub const MAX_BIO_CHARS: usize = 190;

/// Story 43 : description trimée, ≤ 190 caractères, retours à la ligne permis mais
/// pas les autres caractères de contrôle. Vide = retirer la description.
pub struct ValidSetBio {
    pub bio: String,
}

pub fn validate_set_bio(raw: proto::SetBio) -> Result<ValidSetBio, proto::Error> {
    let bio = raw.bio.trim();
    let invalid = |message: &str| proto::Error {
        code: 400,
        message: message.to_string(),
    };
    if bio.chars().count() > MAX_BIO_CHARS {
        return Err(invalid("description trop longue (190 caractères max)"));
    }
    if bio.chars().any(|c| c.is_control() && c != '\n') {
        return Err(invalid("description avec caractère de contrôle"));
    }
    Ok(ValidSetBio { bio: bio.to_string() })
}

/// Story 37 : seule limite de taille métier du système, la photo étant stockée dans
/// OxidArt et persistée par le snapshot.
pub const MAX_AVATAR_BYTES: usize = 256 * 1024;

/// `image: None` = retirer la photo (`SetAvatar.image` vide).
pub struct ValidSetAvatar {
    pub image: Option<Vec<u8>>,
}

/// Story 37 : PNG, JPEG ou WebP reconnus à leurs octets magiques. Le client recadre et
/// réduit avant l'envoi ; le serveur ne décode pas l'image, il refuse seulement ce qui
/// n'en a pas la signature.
pub fn validate_set_avatar(raw: proto::SetAvatar) -> Result<ValidSetAvatar, proto::Error> {
    let image = raw.image;
    if image.is_empty() {
        return Ok(ValidSetAvatar { image: None });
    }
    if image.len() > MAX_AVATAR_BYTES {
        return Err(proto::Error {
            code: 400,
            message: "photo trop lourde (256 Kio max)".to_string(),
        });
    }
    let png = image.starts_with(b"\x89PNG\r\n\x1a\n");
    let jpeg = image.starts_with(b"\xff\xd8\xff");
    let webp = image.len() >= 12 && image.starts_with(b"RIFF") && &image[8..12] == b"WEBP";
    if !(png || jpeg || webp) {
        return Err(proto::Error {
            code: 400,
            message: "photo : PNG, JPEG ou WebP attendu".to_string(),
        });
    }
    Ok(ValidSetAvatar { image: Some(image) })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn pseudo(raw: &str) -> Result<String, u32> {
        validate_set_pseudo(proto::SetPseudo { pseudo: raw.to_string() })
            .map(|v| v.pseudo)
            .map_err(|e| e.code)
    }

    fn bio(raw: &str) -> Result<String, u32> {
        validate_set_bio(proto::SetBio { bio: raw.to_string() })
            .map(|v| v.bio)
            .map_err(|e| e.code)
    }

    #[test]
    fn bio_trimee_bornee_multiligne() {
        assert_eq!(bio("  salut\nça va  "), Ok("salut\nça va".to_string()));
        assert_eq!(bio("   "), Ok(String::new()));
        assert_eq!(bio(&"é".repeat(190)), Ok("é".repeat(190)));
        assert_eq!(bio(&"é".repeat(191)), Err(400));
        assert_eq!(bio("a\tb"), Err(400));
    }

    #[test]
    fn pseudo_trime_et_borne() {
        assert_eq!(pseudo("  Léa  "), Ok("Léa".to_string()));
        assert_eq!(pseudo("   "), Err(400));
        assert_eq!(pseudo(&"é".repeat(32)), Ok("é".repeat(32)));
        assert_eq!(pseudo(&"é".repeat(33)), Err(400));
        assert_eq!(pseudo("a\nb"), Err(400));
    }

    fn avatar(image: &[u8]) -> Result<bool, u32> {
        validate_set_avatar(proto::SetAvatar { image: image.to_vec() })
            .map(|v| v.image.is_some())
            .map_err(|e| e.code)
    }

    #[test]
    fn avatar_par_octets_magiques() {
        assert_eq!(avatar(b""), Ok(false));
        assert_eq!(avatar(b"\x89PNG\r\n\x1a\n...."), Ok(true));
        assert_eq!(avatar(b"\xff\xd8\xff\xe0"), Ok(true));
        assert_eq!(avatar(b"RIFF\0\0\0\0WEBPVP8 "), Ok(true));
        assert_eq!(avatar(b"<svg onload=alert(1)>"), Err(400));
        assert_eq!(avatar(b"RIFF\0\0\0\0WAVE"), Err(400));
        let mut big = b"\xff\xd8\xff".to_vec();
        big.resize(MAX_AVATAR_BYTES + 1, 0);
        assert_eq!(avatar(&big), Err(400));
    }
}
