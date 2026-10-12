//! Encodage des ids dans les clés `channel:{id}`, `dm:{id}`, `user_dms:{user}:{autre}`
//! et `message:{ch}:{id}` : hexadécimal
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
/// Plus grand id qui tienne dans une clé (borne d'un id venu du client).
pub const MAX_ID: u64 = MAX_SORTABLE_ID;

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

/// Inverse de `sortable_id`, pour un id lu dans une clé.
pub fn parse_sortable_id(hex: &[u8]) -> Option<u64> {
    if hex.len() != SORTABLE_ID_LEN {
        return None;
    }
    u64::from_str_radix(std::str::from_utf8(hex).ok()?, 16).ok()
}

/// DM (stories 28-32), sous un préfixe distinct de `channel:` : la liste des salons
/// ne parcourt jamais les DM.
pub fn dm_key(id: u64) -> String {
    format!("dm:{}", sortable_id(id))
}

/// Mes DM : `krange` sur ce préfixe ne lit que les entrées de cet utilisateur.
pub fn user_dms_prefix(user_id: u64) -> String {
    format!("user_dms:{}:", sortable_id(user_id))
}

/// Entrée de `user_id` pour son DM avec `other` (valeur : id du DM) : « ai-je déjà un
/// DM avec X ? » est un seul `get`.
pub fn user_dm_key(user_id: u64, other: u64) -> String {
    let mut key = user_dms_prefix(user_id);
    key.push_str(&sortable_id(other));
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
    fn aller_retour_id_de_cle() {
        for id in [0, 1, 255, MAX_SORTABLE_ID] {
            assert_eq!(parse_sortable_id(sortable_id(id).as_bytes()), Some(id));
        }
        assert_eq!(parse_sortable_id(b"12"), None);
        assert_eq!(parse_sortable_id(b"zzzzzzzzz"), None);
    }

    #[test]
    fn borne_des_ids_client() {
        assert!(is_sortable(MAX_SORTABLE_ID));
        assert!(!is_sortable(MAX_SORTABLE_ID + 1));
        assert!(!is_sortable(u64::MAX));
    }
}
