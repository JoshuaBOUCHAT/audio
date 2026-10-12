# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Vue d'ensemble

Clone de Discord self-hosted, minimaliste, pour un usage privé entre amis. Zéro SaaS,
zéro dépendance externe lourde, un seul binaire serveur Linux.

**Philosophie non négociable** — toute proposition qui viole un de ces points doit être
justifiée explicitement avant d'être acceptée :
- Single-thread, single-process, single-binaire serveur (monoio / io_uring)
- Zéro Tokio, zéro nginx/reverse-proxy, zéro Docker Compose
- Zéro SQL — persistence via OxidArt (ART in-memory) + snapshot (`BGSAVE` oxidart)
- Un seul port TLS exposé (443), y compris pour le renouvellement ACME
- Le protocole (Protobuf) est LA source de vérité — types Rust et JS générés, jamais dupliqués à la main

Document de référence détaillé (stack, diagrammes, snippets) : `architecture.md` à la
racine. **Le schéma Protobuf qu'il contient est un brouillon non validé** — voir
section Protocole ci-dessous avant de s'y fier.

## Structure du monorepo

```
audio/
├── architecture.md   # doc de référence technique (stack, bande passante, snippets)
├── back-end/         # serveur Rust (monoio, io_uring) — crate "back-end"
├── front/            # client web — React + Vite + Tailwind + shadcn/ui
└── proto/            # messages.proto partagé — source de vérité du protocole
```

`back-end/`, `front/` et une future app Tauri consomment tous `proto/`. Ne jamais
définir de types de message ailleurs que dans `proto/messages.proto`.

État actuel (2026-10-11) : le serveur texte v1 est implémenté (auth, salons, messages,
broadcast, persistance) ; le front n'a qu'une page de debug (`/debug`). Point de
reprise détaillé : `HANDOFF.md` ; points repoussés : `TODO.md`.

## Commandes

```bash
cd back-end
cargo build
cargo run
cargo test
cargo clippy
```

```bash
cd front
npm run proto:gen   # régénère src/proto/messages.{js,d.ts} (non versionnés) après toute modif du .proto
npm run dev         # http://localhost:5173/debug
npx tsc -b && npm run lint
```

## Dépendance OxidArt

OxidArt (Adaptive Radix Tree, O(k) sur toutes les ops) vient du projet frère
`~/rust/radixox/oxidart` (voir son propre `CLAUDE.md` pour l'implémentation). Câblage
choisi : **path dependency relative** dans `back-end/Cargo.toml` — suppose que
`radixox/` et `audio/` restent côte à côte sur le disque. Si les deux repos doivent un
jour se découpler (CI, autre machine), revisiter ce choix (git dep figée sur un tag,
ou extraction en crate publié).

OxidArt est synchrone (`get`/`set`/`del` ne sont jamais `async fn`). Règle de
cohérence : toute suite de mutations qui représente un état métier valide doit être
appliquée avant le prochain `.await` — le runtime coopératif monoio garantit qu'aucune
autre tâche ne peut s'intercaler entre deux mutations synchrones.

## Protocole — proto/messages.proto

Le brouillon halluciné initial a été remplacé : `proto/messages.proto` est désormais
le vrai schéma, dérivé des user stories dans `proto/user-stories.md` (chaque message
y est tracé jusqu'à la story qui le justifie). C'est la source de vérité — coder
contre ce fichier directement, plus contre `architecture.md` (qui ne fait que le
référencer + documenter les flows et le modèle de données OxidArt qui en découlent).

Toute nouvelle feature qui touche au protocole doit d'abord ajouter/amender une user
story dans `proto/user-stories.md` avant de modifier `messages.proto` — même
discipline que celle qui a produit le schéma actuel.

Génération de code prévue :
```bash
# Rust — build.rs du crate back-end
prost_build::compile_protos(&["../proto/messages.proto"], &["../proto/"]).unwrap();

# JS/TS — front/
npx pbjs -t json proto/messages.proto > proto/messages.json
npx pbts proto/messages.json > proto/messages.d.ts
```

## Authentification

> **Révision 2026-10-12 (stories 65-69 de `proto/user-stories.md`)** : comptes à
> **email + mot de passe** (bcrypt coût 6 + pepper serveur, verrouillage après 10
> échecs), entrée **sur invitation** créée par l'admin (lien à usage unique, durée
> choisie, TTL OxidArt) ; le lien magique ne sert plus qu'au dépannage et n'est créé
> que par l'admin. Les points 1-2 ci-dessous (« n'importe quel email reçoit un lien »)
> sont remplacés ; le reste (sessions opaques, multi-session, bootstrap admin) tient.

Passwordless par email, décidé pour la v1 :

1. L'utilisateur entre **n'importe quel email** (pas d'allowlist, pas d'inscription
   préalable) → le serveur génère un lien contenant un **token à usage unique de type
   UUID complet** (pas un code court à 6 chiffres — un code court sans rate limiting
   serait brute-forçable en quelques minutes).
2. **V1** : le lien est simplement loggé côté serveur (stdout/debug), pas d'envoi
   d'email réel. Conséquence assumée : en v1, seul l'admin (accès console) peut
   récupérer un lien — pour un ami, il faut le lui transmettre à la main hors-bande.
   Prévoir l'envoi réel comme point d'extension (ex. `EmailSender` trait) sans le
   sur-designer avant qu'il soit nécessaire.
3. **Auto-création de compte au clic** : cliquer un lien valide crée le compte s'il
   n'existe pas encore, puis authentifie. Pas de flow d'inscription séparé, pas
   d'allowlist à maintenir — la porte d'entrée réelle en v1, c'est l'accès aux logs
   serveur, pas une liste d'emails autorisés.
4. Une fois le lien consommé, le serveur émet un **token de session opaque**, stocké
   comme clé dans OxidArt (`token → user_id`). Choisi plutôt qu'un JWT : révocation
   triviale (`DEL`), pas de clé de signature à gérer, cohérent avec "zéro SQL".
5. **Multi-session autorisé** : plusieurs tokens actifs simultanément par utilisateur
   (plusieurs appareils/onglets).
6. **Expiration du lien magique** : via le **TTL natif d'OxidArt** (`set_ttl`/
   `get_ttl`, éviction paresseuse + active déjà implémentées dans oxidart) — le token
   non consommé disparaît de lui-même, zéro code de nettoyage à écrire.

### Bootstrap admin

Le tout premier lancement reçoit un email en paramètre CLI ou variable d'env. Ce n'est
pas un compte spécial pré-créé : quand ce compte se connecte normalement pour la
première fois (même flow magic-link que tout le monde), il est automatiquement
marqué admin. Pas de distinction de flow entre admin et membre.

### Ce qui est volontairement hors scope niveau garde-fous

Pas de rate limiting métier, pas de limite de taille de message, pas de timeout de
connexion inactive en v1, pas de révocation de session ciblée ("déconnecter cet
appareil"), pas de mécanisme pour bannir/révoquer un compte compromis — groupe d'amis
de confiance, risque accepté, à traiter plus tard si besoin réel. **Exception :** le
flow d'auth lui-même doit rester strict (token long, usage unique, expirant) précisément
parce que le reste du système ne l'est pas.

## Scope v1 — texte uniquement

Le vocal/vidéo (WebRTC/str0m) est une extension prévue mais **hors du périmètre
d'implémentation immédiat**. V1 = salons texte + WebSocket + protocole de transport,
conçu pour que le vocal s'ajoute sans refonte (cf. architecture.md pour le design cible).

Opérations messages v1 :
- Envoyer / lister (SyncRequest avec `last_seen_id`)
- Supprimer : **tombstone**, pas de suppression physique. Le tombstone est une donnée
  OxidArt comme une autre (persistée par le snapshot) ; le contenu original n'est pas
  conservé, seule la suppression est tracée. Nécessaire pour que `SyncResponse` puisse notifier les suppressions
  survenues depuis le dernier `last_seen_id` d'un client qui était hors ligne — sinon
  un client qui resync verrait un trou silencieux.
  **Droit de suppression** : l'auteur du message, ou l'admin (l'admin peut supprimer
  n'importe quel message, pas seulement les siens — évite les blocages/quiproquos
  quand la personne concernée n'est pas joignable).
- Édition par l'auteur seul, mention « (modifié) », pas d'historique (story 40,
  ajoutée le 2026-10-12 — remplace « pas d'édition en v1 »). Réponse à un message
  (story 39).
- Présence (stories 23, 41-42, remontée en v1 le 2026-10-12) : liste des membres
  en ligne / hors ligne, statut En ligne ou Invisible, annonce retardée de 15 s. Pas
  de « en train d'écrire » ni de statut absent.
- Images (stories 27, 45-50, remontées en v1 le 2026-10-12) : une image est un lien
  `/media/{id}` dans le texte du message, fichiers sur disque par SHA-256, quota par
  personne, HTTP sur le même port. Fichiers de tout type et dossiers compressés en ZIP
  (stories 51-53), téléchargés par ticket.

Création de salon : **admin uniquement** (pas de rôles/permissions granulaires — c'est
la seule distinction de privilège qui existe dans tout le système avec le bootstrap
admin lui-même).

## IDs (message/user/channel)

Un **compteur global `u64` unique**, pas de compteur par entité/par salon — le plus
simple possible, u64 est virtuellement infini même si des valeurs sont "gâchées" côté
edge cases. Pattern : lire la valeur courante, l'utiliser comme ID, incrémenter,
persister. Le compteur est une clé OxidArt (`id_counter`, `incr`) et part dans le
snapshot avec le reste : snapshot et compteur sont toujours cohérents entre eux. Le
jour où un journal existe (cf. § Persistance), recaler le compteur au replay sur
`max(ID déjà vu) + 1` plutôt que de faire confiance à la valeur du snapshot.

## WebRTC — post-v1 (à garder en tête dès la conception du protocole)

Architecture **SFU**, pas P2P : chaque client se connecte uniquement au serveur (str0m
forward les paquets, zéro décodage). Conséquence sur le NAT traversal : pas besoin de
STUN/TURN tiers. Le serveur fait de l'**ICE-lite auto-hébergé** — str0m répond
lui-même aux requêtes STUN binding reçues sur son port UDP média, puisque la seule
destination qui compte est le serveur lui-même (adresse publique fixe). Cohérent avec
"un seul binaire, zéro service externe".

## Résilience — v1 assumé simple

**Single point of failure accepté pour la v1.** Le single-thread n'est pas vu comme
une limitation temporaire mais comme **une feature à pousser au maximum** : code très
soigné, usage intensif d'io_uring pour déléguer un maximum de travail à l'OS plutôt que
de le faire en userspace. Pas de réplication live en v1 ; une réplication/backup
périodique via un job cron est une piste pour plus tard, pas un prérequis.

**Reprise après crash** : le process doit pouvoir redémarrer seul (supervision via un
conteneur léger / micro-docker prévue côté déploiement, pas dans le code applicatif).
Le snapshot suit déjà la règle atomique (rename seulement si le scan est complet ;
sinon l'ancien snapshot fait foi) — cette garantie existe déjà et couvre le cas crash
pendant un snapshot.

**Persistance v1 = BGSAVE only** (décision 2026-10-11). Snapshot oxidart (`BGSAVE`,
reload en masse au démarrage), pas de journal. Conséquence assumée : un crash perd ce
qui a été écrit depuis la dernière save.

Règle de partage log / oxidart :
- **Log pur** (trace d'événements lisible par un humain, jamais relu par le serveur :
  connexions, liens magiques émis, suppressions par l'admin…) → simple fichier
  append-only écrit par audio. Aucun replay, aucun impact sur l'état.
- **Tout ce qui porte de la logique métier** (état que le serveur doit retrouver :
  messages, tombstones, compteur, sessions) → OxidArt. Si un jour la durabilité
  entre deux saves devient nécessaire, c'est l'AOF d'oxidart qui s'en charge (cf.
  `SAVE_DESIGN.md` de radixox, reporté), pas un journal métier propre à audio.

**Pas de chiffrement des données au repos en v1.** Le snapshot reste en clair sur
disque — cohérent avec le reste des risques acceptés v1 (pas de rate limiting, pas de
modération). Le chiffrement disque, si souhaité, est une responsabilité infra
(LUKS/chiffrement au niveau OS de la VM), pas une feature du code applicatif.

**Heartbeat WebSocket, idempotence des envois, tests automatisés** : volontairement
non tranchés maintenant. Principe pour toute la v1 — construire fonctionnel d'abord,
sans prendre de décision qui hypothèquerait une évolution future vers du scalable,
mais sans essayer de scaler dès le départ.

## TLS / ACME

**TLS-ALPN-01** exclusivement (pas de HTTP-01) — le challenge ACME passe par le même
port 443 que le trafic normal, donc un seul port à exposer/firewaller. Ne pas ouvrir
le port 80 "pour être sûr" : ça casserait la contrainte un-seul-port sans nécessité,
rustls-acme supporte TLS-ALPN-01 nativement.

## Hors scope (voir architecture.md pour la liste complète)

Modération/rôles/permissions granulaires, notifications push, recherche full-text,
multi-serveur/fédération, HTTP/3, réactions/emojis custom, « en train d'écrire » (v1),
rate limiting métier (v1).
