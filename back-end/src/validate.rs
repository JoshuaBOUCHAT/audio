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
