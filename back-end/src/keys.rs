//! Encodage des ids dans les clés `message:{ch}:{id}` : base64 (clés OxidArt ASCII),
//! alphabet rangé dans l'ordre ASCII (`-`, `0-9`, `A-Z`, `_`, `a-z`) sur une
//! longueur fixe, donc ordre des octets = ordre numérique.
//!
//! Attention : oxidart ne trie pas les enfants d'un nœud, `getn` renvoie les clés
//! dans l'ordre d'insertion (modifié par un reload du dump). L'ordre des clés n'est
//! donc PAS exploité — les appelants trient par id. Longueur fixe de 6 caractères, soit
//! 2³⁶ ≈ 69 milliards d'ids : le compteur reste un u64, mais un serveur entre amis
//! n'approchera jamais cette borne (18 000 ans à 10 000 messages/jour).

const ALPHABET: &[u8; 64] = b"-0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ_abcdefghijklmnopqrstuvwxyz";
pub const SORTABLE_ID_LEN: usize = 6;
const MAX_SORTABLE_ID: u64 = (1 << (6 * SORTABLE_ID_LEN)) - 1;

/// Panique au-delà de 2³⁶ − 1 plutôt que de produire une clé tronquée, mal triée.
pub fn sortable_id(mut id: u64) -> [u8; SORTABLE_ID_LEN] {
    assert!(id <= MAX_SORTABLE_ID, "id {id} au-delà de 2^36 : élargir SORTABLE_ID_LEN");
    let mut out = [ALPHABET[0]; SORTABLE_ID_LEN];
    for slot in out.iter_mut().rev() {
        *slot = ALPHABET[(id & 63) as usize];
        id >>= 6;
    }
    out
}

/// Préfixe commun à tous les messages d'un salon, pour `getn`.
pub fn message_prefix(channel_id: u64) -> String {
    format!("message:{channel_id}:")
}

pub fn message_key(channel_id: u64, id: u64) -> String {
    let encoded = sortable_id(id);
    let mut key = message_prefix(channel_id);
    // ALPHABET n'a que de l'ASCII.
    key.push_str(std::str::from_utf8(&encoded).expect("alphabet ASCII"));
    key
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn alphabet_trie_et_sans_doublon() {
        assert!(ALPHABET.windows(2).all(|w| w[0] < w[1]));
    }

    #[test]
    fn ordre_des_octets_egal_ordre_numerique() {
        let ids = [0, 1, 5, 6, 63, 64, 65, 4095, 4096, 1 << 30, MAX_SORTABLE_ID - 1, MAX_SORTABLE_ID];
        for w in ids.windows(2) {
            assert!(sortable_id(w[0]) < sortable_id(w[1]), "{} vs {}", w[0], w[1]);
        }
    }

    #[test]
    #[should_panic(expected = "au-delà de 2^36")]
    fn refuse_un_id_trop_grand() {
        sortable_id(MAX_SORTABLE_ID + 1);
    }
}
