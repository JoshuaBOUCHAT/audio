# Handoff — point de reprise

Note de travail, pas de la doc durable : décrit où en est le projet et quoi faire
ensuite. Décisions durables → `CLAUDE.md` / `architecture.md` / `proto/user-stories.md`
(stories 1-69, chacune avec ses **Décisions**). Points repoussés → `TODO.md`.

## État au 2026-10-12 — texte, médias, présence, notifications, comptes : faits

Tout est testé contre le vrai serveur (scripts de `tests-e2e/`), **mais rien n'a été
vu dans un navigateur** pendant la session (pas d'outil navigateur) : rendu, barre de
saisie riche, menus, lecteurs, thème sombre, défilement paginé sont vérifiés par la
logique seulement. Les retours de l'utilisateur en usage réel ont déjà corrigé
quelques points ; à relire visuellement en priorité.

### Lancer

```bash
cd back-end && cargo run -- ton@email     # https://127.0.0.1:8443, données dans ./data
cd front && npm run dev                   # http://localhost:5173 (+ /debug, page brute)
```

- Navigateur : ouvrir https://127.0.0.1:8443 une fois pour accepter le cert auto-signé
  (sinon « Connexion au serveur… » sans fin). Piste durable : `mkcert` (non fait,
  ajoute une CA locale : à l'utilisateur de décider).
- Build debug : comptes de dev permanents `00000000-0000-0000-0000-00000000000N`
  (1 = admin du bootstrap, sinon `devN@dev.local`), boutons Admin / Dev 2 / Dev 3 sur
  l'écran de login. Absents en release (`#[cfg(debug_assertions)]`).
- Premier lancement sans compte admin : le serveur affiche
  `[boot] compte admin … à créer : ouvrir /?invite=…` → ouvrir
  `http://localhost:5173/?invite=…` et créer le compte avec l'email du bootstrap.
- Un compte venu d'un lien ou d'un token de dev n'a pas de mot de passe : le définir
  dans Paramètres > Profil. (Le compte de l'utilisateur est dans ce cas.)
- Proxy Vite : `/media` → back-end (`AUDIO_BACK_END` pour viser un autre port).

Variables d'environnement serveur : `ADMIN_EMAIL` (ou argument), `AUDIO_DATA_DIR`
(`./data`), `AUDIO_LISTEN` (`127.0.0.1:8443`), `AUDIO_MEDIA_QUOTA_GIB` (25, 0 =
illimité), `AUDIO_PEPPER` (sinon `data/pepper`), et pour les tests
`AUDIO_PRESENCE_DELAY_MS`, `AUDIO_HEARTBEAT_MS`.

### Données (`data/`)

- `dump.rxd` : snapshot OxidArt (SAVE toutes les 10 s si modifié, et à l'arrêt).
  **Debug** : un champ ajouté en fin de type est relu avec sa valeur par défaut et le
  dump remis à niveau au démarrage (`codec.rs`) ; un média illisible est retiré.
  **Release** : échec franc. Règle : **un nouveau champ protobuf va toujours à la
  fin de son message** ; retirer / déplacer / retyper un champ casse les dumps.
- `media/{sha256}` : fichiers envoyés (dédupliqués), `media/tmp/` pendant l'envoi.
- `pepper` : secret des mots de passe (0600). Le perdre invalide tous les mots de
  passe (sortie de secours : liens de connexion de l'admin).

### Back-end (`back-end/src/`)

| Fichier | Rôle |
|---|---|
| `main.rs` (~1600 lignes, **à découper**) | dispatch des `ClientEnvelope`, auth (lien, session, mot de passe, invitation), salons, messages (envoi, sync paginée, modification, suppression), DM, profils, statut, thème |
| `http.rs` | HTTP/1.1 sur le même port : requêtes accumulées, keep-alive, upgrade WS, `POST /media` (en flux), `GET /media/{id}` (Bearer ou ticket, `Range` → 206) |
| `ws.rs` | frames WebSocket accumulées, plafond 1 Mio |
| `registry.rs` | connexions : broadcast, envoi ciblé par utilisateur (DM), ping de toutes les connexions |
| `presence.rs` | présence en mémoire, délais de 15 s (stories 23, 41-42) |
| `reads.rs` | non-lus (`read:{user}:{conv}`, krange paginé plafonné à 100, mentions) et réglages de notification (`settings:{user}`) |
| `accounts.rs` | mots de passe (bcrypt coût 6 + pepper HMAC), verrouillage 10 échecs / 15 min, invitations, liens de connexion |
| `media.rs` | images / vidéos / sons / fichiers : reconnaissance par octets magiques, quota, déduplication, tickets de téléchargement et de lecture |
| `codec.rs` | bincode strict ; relecture tolérante en debug |
| `keys.rs`, `validate.rs`, `email.rs`, `persist.rs`, `proto.rs` | clés hex triables, validations, email, snapshot, code prost |

Clés OxidArt : voir `architecture.md` § Modèle de données. Principes radix : préfixe
dédié par famille (`dm:` hors de `channel:`, `user_dms:{moi}:`, `read:{moi}:`), listes
et pages par `krange`, aucune écriture de notification à l'envoi d'un message (non-lus
comptés à la connexion à partir du marqueur).

Heartbeat (story 69) : ping serveur toutes les 15 s, connexion fermée après 45 s de
silence ; client : `Heartbeat` toutes les 20 s, reconnexion sans réponse sous 10 s.

### Front (`front/src/chat/`)

| Fichier | Rôle |
|---|---|
| `store.ts` (~1000 lignes, à découper aussi) | `ChatStore` hors React : WS, auth, broadcasts, reconnexion, heartbeat, pages d'historique, médias, non-lus, notifications, admin |
| `ChatView.tsx` | colonne Salons / Privé (badges, 🔔 par salon, clic droit), en-tête, membres, paramètres |
| `ChannelFeed.tsx` | fil d'une conversation : pagination au scroll, réponse, modification, suppression confirmée, mentions surlignées |
| `Composer.tsx` | saisie riche contenteditable : texte + médias + mentions (`@` autocomplétion), envoi d'images / fichiers / dossiers (ZIP) |
| `MessageBody.tsx` | rendu du contenu : images (vue en grand), vidéo, audio, cartes fichier / dossier, pastilles de mention |
| `media.ts` | analyse du contenu : `/media/{id}` et `<@id>` dans le texte |
| `MembersPanel.tsx`, `ProfileCard.tsx`, `NotifyMenus.tsx` | membres par statut, carte de profil, menus de notification |
| `SettingsPanel.tsx`, `ProfileSettings.tsx`, `AdminSettings.tsx` | Paramètres : Profil (photo, statut, pseudo, description, mot de passe), Apparence, Notifications, Administration |
| `Login.tsx`, `PseudoScreen.tsx` | connexion email + mot de passe, inscription sur invitation, choix du pseudo |
| `sounds.ts`, `zip-folder.ts`, `avatar-image.ts`, `session.ts`, `model.ts`, `lib/theme.ts` | sons Web Audio, ZIP fflate, recadrage avatar, localStorage / URL, types, thème |

## Décisions marquantes du 2026-10-12 (détail dans les stories)

- Présence remontée en v1 ; invisible mémorisé ; délais 15 s (stories 23, 41-42).
- DM : livraison ciblée, invisibles pour l'admin (404), révélés au premier message.
- Une image / un fichier = un lien `/media/{id}` dans le texte ; fichiers sur disque
  par SHA-256 ; quota par personne ; auth des médias par `Authorization` (pas de
  cookie, pour Tauri) ; tickets pour le téléchargement natif et la lecture vidéo.
- Mentions `<@id>` ; un salon ne notifie que sur mention par défaut ; réglages par
  personne et par salon (story 63) ; non-lus synchronisés côté serveur.
- Comptes email + mot de passe sur invitation admin ; plus de lien en libre-service.
- Historique paginé (64 messages, `krange` inversé).
- Persistance bincode stricte en release, tolérante en debug.

## Prochaines étapes (ordre recommandé, validé avec l'utilisateur)

1. **Découper `main.rs`** (auth/comptes, messages, DM, profils, dispatch fin) — et
   `store.ts` côté front — avant d'ajouter le vocal.
2. **Déploiement** — *à discuter avant de coder* : port 443 public, ACME
   TLS-ALPN-01 (spike dans `back-end/examples/acme_spike.rs` ; `spike-acme/` est vide), front servi par le
   binaire (`rust-embed`, même origine, plus de proxy), port(s) UDP média pour
   str0m (un seul démultiplexé ou une plage ?), IP publique pour l'ICE-lite.
3. **Playwright** : vrais tests navigateur (login, message, image, DM ; plus tard
   micro simulé) — remplacera `tests-e2e/`.
4. **Salons vocaux** (stories 18-22, protocole `WebRtcOffer` = 22 déjà là, numéros
   40+ réservés pour JoinVoice / LeaveVoice / IceCandidate).

Ensuite / plus tard : mise en page mobile ; photos de profil par le chemin HTTP des
médias (story 37) ; reprise de téléchargement par `Range` + checksum (story 53) ;
envoi de très gros dossiers en flux ; nettoyage des médias orphelins (compteur de
références, story 50) ; saves chiffrées côté oxidart ; AOF (durabilité entre deux
saves) ; file d'envoi bornée (`TODO.md`).

## Limites connues

- Pas encore de 443 public / ACME ; cert auto-signé en dev.
- Messages WebSocket fragmentés (FIN=0) non gérés (les navigateurs n'en envoient pas).
- Un crash (pas un arrêt propre) perd au plus les 10 dernières secondes.
- Un dossier envoyé est entièrement compressé en mémoire du navigateur avant l'envoi.
- Une conversation créée après « Tout couper » n'est pas coupée (voulu).
