use std::fmt;
use std::ops::Deref;

use radixox_lib::shared_byte::SharedByte;

/// Email validé et normalisé (trim + lowercase) — jamais construit autrement que via
/// `Email::parse`. Pas de `DerefMut`/accès à la donnée interne en écriture : une
/// fois construit, un `Email` ne peut plus redevenir invalide.
///
/// Stocké en `SharedByte` (pas `String`) : zéro conversion à la frontière OxidArt
/// (`set`/`get` prennent déjà `SharedByte`/`&[u8]`), clone bon marché (refcompté).
/// `SharedByte` ne garantit pas l'UTF-8 par construction — mais `Email::parse` ne
/// construit jamais le `SharedByte` interne à partir d'autre chose que d'un `&str`
/// déjà validé UTF-8, donc l'invariant "contenu UTF-8 valide" est maintenu ici une
/// fois pour toutes : `as_ref::<str>` peut donc être `unsafe` sans jamais paniquer.
///
/// Convention dans tout le crate : un champ/variable `String`/`&str` qui représente
/// un email pas encore validé s'appelle `unchecked_email_str`, jamais `email` — le
/// nom porte l'état de validation, `email: String`/`email: &str` ne doit jamais
/// apparaître ailleurs qu'ici.
#[derive(Debug, Clone)]
pub struct Email(SharedByte);

impl Email {
    /// Lowercase systématique : `Foo@Bar.com` et `foo@bar.com` doivent résoudre au
    /// même `email_index:{email}` (cf. architecture.md), sinon la même personne peut
    /// se retrouver avec deux comptes selon la casse tapée dans le formulaire.
    pub fn parse(unchecked_email_str: &str) -> Result<Self, crate::proto::Error> {
        let trimmed = unchecked_email_str.trim();
        if trimmed.is_empty() {
            return Err(crate::proto::Error {
                code: 400,
                message: "email vide".to_string(),
            });
        }
        Ok(Self(SharedByte::from_str(&trimmed.to_lowercase())))
    }
}

impl PartialEq for Email {
    fn eq(&self, other: &Self) -> bool {
        self.0 == other.0
    }
}
impl Eq for Email {}

impl std::hash::Hash for Email {
    fn hash<H: std::hash::Hasher>(&self, state: &mut H) {
        self.0.hash(state);
    }
}

impl Deref for Email {
    type Target = str;

    fn deref(&self) -> &str {
        // SAFETY: le seul constructeur (`parse`) écrit un `SharedByte` issu d'un
        // `&str` déjà valide UTF-8 (trim + lowercase préservent l'UTF-8) — l'invariant
        // est garanti par construction, jamais revérifié ailleurs dans le crate.
        unsafe { std::str::from_utf8_unchecked(self.0.as_slice()) }
    }
}

impl fmt::Display for Email {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self)
    }
}

impl AsRef<str> for Email {
    fn as_ref(&self) -> &str {
        self
    }
}
