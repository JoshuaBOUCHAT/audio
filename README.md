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

**Spike à faire avant d'investir dans le serveur HTTP/1.1 maison** : valider que
`monoio-rustls` + `rustls-acme` obtiennent un certificat Let's Encrypt et servent du TLS
correctement sous monoio (cet écosystème TLS/ACME est surtout testé avec Tokio, pas
encore éprouvé avec le modèle *completion* de monoio). Voir la section "TLS & ACME" dans
`architecture.md` pour le détail du risque et le plan si le spike échoue.

## Commandes

```bash
cd back-end
cargo build
cargo run
cargo test
cargo clippy
```

Pas encore de build front documenté ni de génération protobuf câblée en CI.
