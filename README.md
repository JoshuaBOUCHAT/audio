# audio

Clone de Discord self-hosted, minimaliste, pour un usage privé entre amis — single-thread,
single-binaire Rust (monoio/io_uring), zéro SaaS.

Voir [`architecture.md`](./architecture.md) pour le design complet (stack, protocole,
modèle de threads, bande passante, décisions d'auth) et [`CLAUDE.md`](./CLAUDE.md) pour
les règles/philosophie du projet.

## Structure

```
audio/
├── architecture.md   # doc de référence technique
├── back-end/         # serveur Rust (monoio, io_uring)
├── front/            # client web — React + Vite + Tailwind + shadcn/ui
└── proto/            # messages.proto — source de vérité du protocole
```

## État actuel

Squelette d'outillage qui compile/build des deux côtés (back-end + front), rien
d'implémenté côté métier. Le protocole (`proto/messages.proto`) est défini et tracé aux
user stories dans `proto/user-stories.md`.

## Prochaine étape

**Spike TLS/ACME validé** (`back-end/examples/acme_spike.rs`, testé en conditions
réelles sur VPS avec Let's Encrypt staging) : `monoio-rustls` + `rustls-acme`
fonctionnent sous monoio, deux ajustements requis (feature `sync` de monoio,
`alpn_protocols` explicite) — détails dans la section "TLS & ACME" de
`architecture.md`. Prochaine étape : serveur HTTP/1.1 maison (parsing `httparse` +
boucle keep-alive) et upgrade WebSocket, cf. section "HTTP/1.1 — Assets & Pièces
Jointes" de `architecture.md`.

## Commandes

```bash
cd back-end
cargo build
cargo run
cargo test
cargo clippy
```

Pas encore de build front documenté ni de génération protobuf câblée en CI.
