# TODO

Points identifiés mais volontairement repoussés — à ne pas oublier. Le travail en
cours vit dans `HANDOFF.md`.

## Lointain

- **File d'envoi par connexion non bornée** (`back-end/src/registry.rs`, `pending`) :
  un client qui ne lit plus fait grossir la mémoire du serveur jusqu'à ce que le TCP
  casse. Piste : borner à N octets, au-delà fermer la connexion — le client resync
  via `SyncRequest` en se reconnectant. Accepté en v1 (groupe d'amis, cf. CLAUDE.md
  § garde-fous hors scope).

## Quand oxidart aura un `getn` ordonné

- Parcours des enfants dans l'ordre des radix (recherche linéaire du plus petit à
  chaque nœud, au plus 16 enfants grâce aux clés hex de `keys.rs`). Côté audio :
  retirer le tri par id de `sync_messages` / `list_channels`, et ouvrir la
  pagination (« les N derniers messages ») sans collecter tout le salon.
