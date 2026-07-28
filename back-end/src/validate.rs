//! Étape parse-don't-validate (cf. architecture.md § Validation) : chaque `RawX`
//! prost transite par une fonction `validate_*` qui produit un `ValidX` — la
//! non-violation des invariants structurels devient une propriété du type, pas une
//! convention que le code métier doit revérifier.

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
