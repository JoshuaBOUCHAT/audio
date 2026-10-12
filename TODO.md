# TODO

Points identifiés mais volontairement repoussés — à ne pas oublier. Le travail en
cours vit dans `HANDOFF.md`.

## Lointain

- **File d'envoi par connexion non bornée** (`back-end/src/registry.rs`, `pending`) :
  un client qui ne lit plus fait grossir la mémoire du serveur jusqu'à ce que le TCP
  casse. Piste : borner à N octets, au-delà fermer la connexion — le client resync
  via `SyncRequest` en se reconnectant. Accepté en v1 (groupe d'amis, cf. CLAUDE.md
  § garde-fous hors scope).

## Pagination des messages

- `krange` d'oxidart permet déjà « les N derniers messages » (`rev = true`, curseur =
  clé du plus ancien reçu) sans collecter tout le salon ; `sync_messages` rend encore
  tout ce qui suit `last_seen_id`. Touche au protocole : passer d'abord par une user
  story (`proto/user-stories.md`) avant d'ajouter un `count`/curseur à `SyncRequest`.
