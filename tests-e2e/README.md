# Tests de bout en bout (scripts de session)

Scripts écrits pendant le développement (2026-10-12) pour vérifier chaque story
contre le **vrai serveur**, faute de navigateur. Pas une suite automatisée : chacun
se lance à la main, affiche `ok …` par vérification et s'arrête au premier `ÉCHEC`.
Le futur remplaçant est Playwright (cf. HANDOFF.md § Prochaines étapes).

Ils supposent le dépôt dans `/home/joshua/rust/audio` (imports en chemin absolu) et
un back-end **de test** sur le port 8444 — jamais celui de dev (8443), et jamais sur
`back-end/data` :

```bash
D=$(mktemp -d)
cd back-end && cargo build
AUDIO_LISTEN=127.0.0.1:8444 AUDIO_DATA_DIR=$D ./target/debug/back-end admin@x.fr > $D/log 2>&1 &
```

Variables utiles côté serveur : `AUDIO_PRESENCE_DELAY_MS=500` (présence), `AUDIO_HEARTBEAT_MS=200`
(heartbeat), `AUDIO_MEDIA_QUOTA_GIB=0.004` (quota de `media.mts`).

- `protocol/*.mts` : requêtes protobuf directes (`ProtocolClient`), lancés depuis `front/` :
  `NODE_TLS_REJECT_UNAUTHORIZED=0 node ../tests-e2e/protocol/dm.mts`
  (`accounts.mts` prend le log du serveur en argument, `media.mts` le dossier `$D/media`).
- `store/*.mjs` : le `ChatStore` du front chargé par Vite sous Node, navigateur simulé :
  `VITE_BACK_END_URL=wss://127.0.0.1:8444 VITE_MEDIA_BASE=https://127.0.0.1:8444 NODE_TLS_REJECT_UNAUTHORIZED=0 node ../tests-e2e/store/notify-store.mjs`
  (`acc-store.mjs` prend le log du serveur, `hb-store.mjs` le PID du serveur — il le gèle
  par `SIGSTOP`, `cache-test.mjs` le relance sur une base vide).

Chaque script part d'une base vide (comptes de dev `00000000-…-00000000000N`, build debug).
