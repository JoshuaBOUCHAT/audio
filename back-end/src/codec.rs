//! Encodage des valeurs OxidArt (`User`, `Channel`, `Message`, `StoredMedia`) en
//! bincode : compact, et strict — un enregistrement qui ne correspond plus au schéma
//! fait planter le chargement plutôt que d'être relu avec des valeurs par défaut qui
//! masqueraient une incohérence (décision 2026-10-12, HANDOFF.md).
//!
//! **Build debug uniquement** : un champ ajouté **en fin** de type rend les anciens
//! enregistrements trop courts (`UnexpectedEof`). Le bincode lisant des octets nuls
//! comme les valeurs par défaut de tous nos types (0, "", false, liste vide, premier
//! variant d'enum), on complète par des zéros et on relit ; `upgrade_dev` réécrit le
//! dump au nouveau format au démarrage. Un champ retiré, déplacé ou retypé plante
//! toujours. D'où la règle : **un nouveau champ va toujours à la fin**.

use serde::Serialize;
use serde::de::DeserializeOwned;

pub fn encode<T: Serialize>(value: &T) -> Vec<u8> {
    bincode::serialize(value).expect("sérialisation bincode")
}

/// `what` : clé ou nature de l'enregistrement, pour le message d'erreur.
pub fn decode<T: DeserializeOwned>(bytes: &[u8], what: &str) -> T {
    match bincode::deserialize(bytes) {
        Ok(value) => value,
        Err(e) => {
            #[cfg(debug_assertions)]
            if let Some(value) = decode_padded(bytes, &e) {
                eprintln!("[dev] {what} : ancien schéma, relu avec des valeurs par défaut");
                return value;
            }
            panic!(
                "{what} corrompu ({e}) — en dev, après un changement de schéma : supprimer data/dump.rxd"
            )
        }
    }
}

/// Champs manquants en fin d'enregistrement : complétés par des zéros. Le bincode
/// « legacy » ignore les octets en trop après la valeur.
#[cfg(debug_assertions)]
fn decode_padded<T: DeserializeOwned>(bytes: &[u8], error: &bincode::Error) -> Option<T> {
    let bincode::ErrorKind::Io(io) = error.as_ref() else {
        return None;
    };
    if io.kind() != std::io::ErrorKind::UnexpectedEof {
        return None;
    }
    let mut padded = bytes.to_vec();
    padded.resize(bytes.len() + 4096, 0);
    bincode::deserialize(&padded).ok()
}

/// Debug : réécrit au schéma courant tout enregistrement d'un ancien schéma, une fois
/// au démarrage (l'avertissement ne revient pas à chaque lecture).
#[cfg(debug_assertions)]
pub fn upgrade_dev(art: &mut oxidart::OxidArt) {
    use crate::{media::StoredMedia, proto};
    let upgraded = upgrade::<proto::User>(art, b"user:")
        + upgrade::<proto::Channel>(art, b"channel:")
        + upgrade::<proto::Channel>(art, b"dm:")
        + upgrade::<proto::Message>(art, b"message:")
        + upgrade::<StoredMedia>(art, b"media:");
    if upgraded > 0 {
        println!("[dev] {upgraded} enregistrement(s) mis au schéma courant");
    }
}

#[cfg(debug_assertions)]
fn upgrade<T: Serialize + DeserializeOwned>(art: &mut oxidart::OxidArt, prefix: &[u8]) -> usize {
    use oxidart::Value;
    use oxidart::krange::RangeVal;
    use radixox_lib::shared_byte::SharedByte;

    // Clés d'abord (emprunt de l'arbre), réécriture ensuite.
    let stale: Vec<(Vec<u8>, Vec<u8>)> = art
        .krange(prefix, b"", usize::MAX, false)
        .iter()
        .filter_map(|(key, val)| match val {
            RangeVal::Bytes(b) if bincode::deserialize::<T>(b.as_slice()).is_err() => {
                Some((key.to_vec(), b.as_slice().to_vec()))
            }
            _ => None,
        })
        .collect();
    for (key, bytes) in &stale {
        let what = String::from_utf8_lossy(key);
        let value: T = decode(bytes, &what);
        art.set(
            SharedByte::from_slice(key),
            Value::String(SharedByte::from_slice(encode(&value))),
        );
    }
    stale.len()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde::Deserialize;

    #[derive(Serialize, Deserialize, Debug, PartialEq)]
    struct V1 {
        id: u64,
        name: String,
    }

    #[derive(Serialize, Deserialize, Debug, PartialEq)]
    struct V2 {
        id: u64,
        name: String,
        bio: String,
        theme: i32,
        flag: bool,
        ids: Vec<u64>,
    }

    #[test]
    fn champs_ajoutes_en_fin_relus_par_defaut_en_debug() {
        let old = encode(&V1 {
            id: 7,
            name: "Léa".into(),
        });
        let new: V2 = decode(&old, "test");
        assert_eq!(
            new,
            V2 {
                id: 7,
                name: "Léa".into(),
                bio: String::new(),
                theme: 0,
                flag: false,
                ids: vec![]
            }
        );
    }

    /// Longueur de chaîne impossible (type changé, données abîmées) : même complété de
    /// zéros, l'enregistrement reste illisible — échec franc, en debug aussi.
    #[test]
    #[should_panic(expected = "corrompu")]
    fn donnee_incoherente_plante_toujours() {
        let mut bytes = 7u64.to_le_bytes().to_vec();
        bytes.extend(u64::MAX.to_le_bytes());
        let _: V2 = decode(&bytes, "test");
    }

    /// Un `User` d'avant le thème (story 55) : son encodage sans le dernier champ.
    #[test]
    fn dump_ancien_schema_mis_a_niveau_au_demarrage() {
        use crate::proto;
        use oxidart::{OxidArt, Value};
        use radixox_lib::shared_byte::SharedByte;

        let user = proto::User {
            id: 3,
            email: "lea@x.fr".into(),
            is_admin: true,
            pseudo: "Léa".into(),
            avatar_version: 0,
            status: proto::Status::Invisible as i32,
            bio: "salut".into(),
            theme: proto::Theme::Dark as i32,
        };
        let mut old = encode(&user);
        old.truncate(old.len() - 4); // `theme` (i32) pas encore là
        let mut art = OxidArt::new();
        art.set(SharedByte::from_str("user:3"), Value::String(SharedByte::from_slice(old)));

        upgrade_dev(&mut art);

        let stored = art.get(b"user:3").unwrap();
        let read: proto::User = bincode::deserialize(stored.as_bytes().unwrap().as_slice()).expect("relu strictement");
        assert_eq!(read.pseudo, "Léa");
        assert_eq!(read.bio, "salut");
        assert_eq!(read.status(), proto::Status::Invisible);
        assert_eq!(read.theme(), proto::Theme::System);
    }
}
