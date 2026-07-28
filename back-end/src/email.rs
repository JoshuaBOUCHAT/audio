use std::fmt;
use std::ops::Deref;

/// Email validé et normalisé (trim + lowercase) — jamais construit autrement que via
/// `Email::parse`. Pas de `DerefMut`/accès à la `String` interne en écriture : une
/// fois construit, un `Email` ne peut plus redevenir invalide.
///
/// Convention dans tout le crate : un champ/variable `String`/`&str` qui représente
/// un email pas encore validé s'appelle `unchecked_email_str`, jamais `email` — le
/// nom porte l'état de validation, `email: String`/`email: &str` ne doit jamais
/// apparaître ailleurs qu'ici.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct Email(String);

impl Email {
    /// Lowercase systématique : `Foo@Bar.com` et `foo@bar.com` doivent résoudre au
    /// même `email_index:{email}` (cf. architecture.md), sinon la même personne peut
    /// se retrouver avec deux comptes selon la casse tapée dans le formulaire.
    ///
    /// Pas de transtypage `&mut String -> &mut Email` : trim/lowercase peuvent
    /// changer la longueur en octets (repliement Unicode), donc une nouvelle
    /// allocation est de toute façon inévitable ici — un `transmute` n'économiserait
    /// rien et introduirait de l'unsafe sans bénéfice sur un chemin (auth) qui n'est
    /// pas chaud.
    pub fn parse(unchecked_email_str: &str) -> Result<Self, crate::proto::Error> {
        let trimmed = unchecked_email_str.trim();
        if trimmed.is_empty() {
            return Err(crate::proto::Error {
                code: 400,
                message: "email vide".to_string(),
            });
        }
        Ok(Self(trimmed.to_lowercase()))
    }
}

impl Deref for Email {
    type Target = str;

    fn deref(&self) -> &str {
        &self.0
    }
}

impl fmt::Display for Email {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}

impl AsRef<str> for Email {
    fn as_ref(&self) -> &str {
        &self.0
    }
}
