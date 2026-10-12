//! Encodage des ids dans les clés `channel:{id}` et `message:{ch}:{id}` : hexadécimal
//! minuscule (clés OxidArt ASCII) sur une longueur fixe, donc ordre des octets = ordre
//! numérique, et `krange` d'oxidart rend directement les entrées triées par id.
//!
//! Base 16 plutôt que base64 : au plus 16 enfants par nœud de l'ART, la taille que la
//! recherche d'enfants SWAR d'oxidart traite le plus vite.
//!
//! 9 caractères = 16⁹ = 2³⁶ ≈ 69 milliards d'ids : le compteur reste un u64, mais un
//! serveur entre amis n'approchera jamais cette borne (18 000 ans à 10 000
//! messages/jour).

pub const SORTABLE_ID_LEN: usize = 9;
const MAX_SORTABLE_ID: u64 = (1 << (4 * SORTABLE_ID_LEN)) - 1;

/// Vrai si `id` tient dans une clé. Les ids venus du client doivent passer par ici
/// avant `channel_key` / `message_key` : un id hors borne ne peut désigner aucune
/// entrée existante (le compteur n'y arrive jamais), et paniquer arrêterait le serveur.
pub fn is_sortable(id: u64) -> bool {
    id <= MAX_SORTABLE_ID
}

/// Panique au-delà de 2³⁶ − 1 plutôt que de produire une clé tronquée, mal triée.
pub fn sortable_id(id: u64) -> String {
    assert!(is_sortable(id), "id {id} au-delà de 2^36 : élargir SORTABLE_ID_LEN");
    format!("{id:0SORTABLE_ID_LEN$x}")
}

/// Préfixe commun à tous les salons, pour `krange`.
pub const CHANNEL_PREFIX: &str = "channel:";

pub fn channel_key(id: u64) -> String {
    let mut key = CHANNEL_PREFIX.to_string();
    key.push_str(&sortable_id(id));
    key
}

/// Préfixe commun à tous les messages d'un salon, pour `krange`.
pub fn message_prefix(channel_id: u64) -> String {
    format!("message:{channel_id}:")
}

pub fn message_key(channel_id: u64, id: u64) -> String {
    let mut key = message_prefix(channel_id);
    key.push_str(&sortable_id(id));
    key
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn longueur_fixe() {
        assert_eq!(sortable_id(0), "000000000");
        assert_eq!(sortable_id(MAX_SORTABLE_ID), "fffffffff");
    }

    #[test]
    fn ordre_des_octets_egal_ordre_numerique() {
        let ids = [0, 1, 9, 10, 15, 16, 255, 256, 4095, 4096, 1 << 30, MAX_SORTABLE_ID - 1, MAX_SORTABLE_ID];
        for w in ids.windows(2) {
            assert!(sortable_id(w[0]) < sortable_id(w[1]), "{} vs {}", w[0], w[1]);
        }
    }

    #[test]
    #[should_panic(expected = "au-delà de 2^36")]
    fn refuse_un_id_trop_grand() {
        sortable_id(MAX_SORTABLE_ID + 1);
    }

    #[test]
    fn borne_des_ids_client() {
        assert!(is_sortable(MAX_SORTABLE_ID));
        assert!(!is_sortable(MAX_SORTABLE_ID + 1));
        assert!(!is_sortable(u64::MAX));
    }
}
