# Handoff — point de reprise

Note de travail, pas de la doc durable : décrit où en est le projet et quoi faire
ensuite. Décisions durables → `CLAUDE.md` / `architecture.md` / `proto/user-stories.md`
(stories 1-76, chacune avec ses **Décisions**). Points repoussés → `TODO.md`.

## État au 2026-10-13 — texte, médias, présence, notifications, comptes, vocal : faits, en ligne

**En prod sur https://audio.joshua-bouchat.fr, vocal compris, validé par
l'utilisateur** (Firefox, deux comptes, puis déployé et testé sur le serveur).

Côté texte, tout est testé contre le vrai serveur (scripts de `tests-e2e/`) ; l'outil
de session n'a pas de navigateur (le téléchargement du Chromium de Playwright a calé),
ce sont les retours de l'utilisateur qui valident le rendu.

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
| `main.rs` | démarrage, `AppState`, boucle d'acceptation |
| `connection.rs` | vie d'une connexion WS : lecture des trames, réponse, diffusion (`notify`) |
| `dispatch.rs` | aiguillage des `ClientEnvelope`, contrôles d'accès (connecté, admin) |
| `auth.rs` | portes d'entrée : session, mot de passe, invitation (vérifiée à l'ouverture), lien de dépannage, tokens de dev |
| `users.rs` | profils : pseudo, statut, thème, description, photo ; volume par personne (`voice_volume:{moi}:{autre}`) |
| `channels.rs` | salons et DM |
| `messages.rs` | envoi, modification, suppression, sync et pages d'historique |
| `voice.rs` | vocal (SFU) : un `Rtc` str0m par participant, une tâche pour tout l'UDP (`accepts`), audio transmis tel quel, renégociation par le serveur, pistes recyclées, micro coupé / sourdine, IP publique par DNS du domaine vu dans `Host` |
| `dns.rs` | requête DNS A minimale en UDP sur monoio (pas de `getaddrinfo` bloquant) |
| `http.rs` | HTTP/1.1 sur le même port : requêtes accumulées, keep-alive, upgrade WS, `POST /media` (en flux), `GET /media/{id}` (Bearer ou ticket, `Range` → 206), front embarqué (`rust-embed` sur `front/dist`) |
| `ws.rs` | frames WebSocket accumulées, plafond 1 Mio |
| `registry.rs` | connexions : broadcast, envoi ciblé par utilisateur (DM), ping de toutes les connexions |
| `presence.rs` | présence en mémoire, délais de 15 s (stories 23, 41-42) |
| `reads.rs` | non-lus (`read:{user}:{conv}`, krange paginé plafonné à 100, mentions) et réglages de notification (`settings:{user}`) |
| `accounts.rs` | mots de passe (bcrypt coût 12 par tranches de 16 tours + pepper HMAC, rehash des anciens hash à la connexion), verrouillage 10 échecs / 15 min, invitations, liens de connexion |
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
| `store.ts` | `ChatStore` hors React, dernière couche : WS, reconnexion, heartbeat, auth, admin, broadcasts |
| `store-core.ts` ← `store-media.ts` ← `store-profiles.ts` ← `store-notify.ts` ← `store-conversations.ts` ← `store-voice.ts` | couches du store (une classe abstraite par fichier, chacune n'appelle que celles du dessous) : état et requête ; médias ; profils ; non-lus et notifications ; salons, DM, messages ; vocal |
| `voice-engine.ts` | son du vocal hors React : micro → gain → détection de voix (AudioWorklet) → envoi ; pistes reçues → volume par personne → volume général ; SDP en file |
| `VoicePanel.tsx`, `VoiceSettings.tsx` | salons vocaux (qui parle, micro coupé, sourdine), barre du vocal, boutons micro / sourdine (Ctrl+Alt+M / D), Paramètres › Voix |
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

## Déploiement (fait le 2026-10-13)

En ligne sur **https://audio.joshua-bouchat.fr** (mini-PC Intel N150, Ubuntu 24.04,
`joshua@mini-pc.home`). Tout est dans `deploy/` :

- `deploy/deploy.sh` : construit front + back-end **sur le PC** pour le processeur du
  serveur (`target-cpu=gracemont`, sans Key Locker ; LTO complet), copie le binaire
  (front inclus), redémarre le service. Binaire : glibc ≥ 2.38 (serveur : 2.39) ;
  musl impossible (monoio 0.2.4 utilise `statx`).
- `--setup <email>` (fait) : utilisateur système `audiod` (le groupe `audio` existe
  déjà sous Ubuntu), `/var/lib/audio`, `/etc/audio.env`, service systemd.
- `--nginx` (fait) : **écart à « zéro nginx » propre à ce déploiement** (option A) —
  le nginx du mini-PC garde le 443 pour d'autres sites et relaie vers audio en
  `127.0.0.1:8443` ; certificat par certbot (webroot, renouvelé, nginx rechargé). Le
  binaire reste autonome ; l'UDP du vocal ne passera pas par nginx. ACME dans audio
  n'est donc plus nécessaire ici.
- Logs : `journalctl -u audio` (liens d'invitation du bootstrap, `[voice] …`).
- **Vocal** : 443/udp, à côté du 443/tcp de nginx (qui ne touche pas à l'UDP).
  Fait une fois : redirection UDP 443 → 192.168.1.24 sur la box, `ufw allow 443/udp`
  (désormais aussi dans `setup-server.sh`). Rien dans `/etc/audio.env` : port 443 par
  défaut en release, IP locale par la route par défaut (filaire `.24`), IP publique
  par DNS du domaine vu dans l'en-tête `Host` (suivie si elle change).
  `AUDIO_VOICE_LISTEN` / `AUDIO_PUBLIC_IP` restent possibles pour forcer.
- Mise à jour : `deploy/deploy.sh`, rien d'autre. Lancer le serveur de dev **avec
  l'email admin** (`cargo run -- moi@…`), sinon ni invitation admin ni bouton Admin
  admin (le serveur le signale au démarrage).

## Vocal — ce qui a été appris (2026-10-13)

- **Pas de trickle ICE** : offre sans candidats, ICE-lite, le serveur apprend
  l'adresse du navigateur par ses requêtes STUN (spike `examples/voice_echo.rs`).
- **Jamais 127.0.0.1 comme candidat** : les navigateurs le refusent (ICE échoue).
- **str0m ne recycle pas ses propres lignes SDP stoppées** (malgré le commentaire de
  son exemple `chat.rs`) : pistes passées en `inactive` et réutilisées à la main.
- **Latence** (250 ms-1 s, variable) : deux causes corrigées. (1) str0m retenait
  jusqu'à 15 paquets (300 ms) après une perte → `set_reordering_size_audio(0)`, le
  navigateur comble les trous. (2) Détacher le micro dans les silences
  (`replaceTrack(null)`) gelait les horodatages RTP : la mémoire tampon de Firefox
  montait à 1,4 s (`about:webrtc`, `jitterBufferTargetDelay`) → on envoie du silence
  numérique, `usedtx=1` réduit à un paquet minuscule toutes les 400 ms.
- **Opus à 64 kbps** : `maxaveragebitrate` ajouté par le navigateur à la description
  du serveur (str0m ne sait pas l'annoncer). FEC intégrée négociée.
- **Bincode strict** : ne jamais ajouter de champ à un type stocké (`Settings`…)
  sans migration — la prod plante à la relecture. D'où `voice_volume:` à part.
- Tests du SFU : navigateurs simulés par str0m, réseau en mémoire, horloge injectée
  (`voice.rs`, `mod tests`) — plusieurs participants, recyclage, sourdine, perte.

## Vidéo — spike du diffuseur natif (2026-10-14)

But : diffuser son écran en 1080p120 (jeux) à ~8 amis, ce que le navigateur ne sait
pas faire (capture d'écran Firefox ≈ 15-60 images/s, VP8 plafonné à 60). Modèle retenu
avec l'utilisateur : comme l'app Discord — capture et encodage **natifs**, WebRTC pour
le transport. Ici : GStreamer (« OBS sans OBS ») qui envoie en **WHIP** (un `POST` SDP
sur le port HTTP) au SFU str0m, qui fait suivre le H264 tel quel aux navigateurs.
Spike : `back-end/examples/video_whip.rs` (serveur + page spectateur avec stats) et
`back-end/examples/screen_whip.py` (diffuseur). Paquet Arch : `gst-plugin-rswebrtc`.

Résultat : **1080p120 fluide** (RTX 3060 Ti, KDE Wayland, Firefox), 30 Mbps CBR,
0 perte, ~2 ms de décodage par image. Ce qu'il a fallu trouver, dans l'ordre :

- **Capture en DMA-BUF obligatoire** : en mémoire CPU, KWin recopie chaque image du
  GPU et ne fournit que 1-9 images/s ; en DMA-BUF, 160-260.
- **`nvautogpuh264enc`, pas `nvh264enc`** (choisi par défaut, rang le plus haut) :
  `nvh264enc` attend une synchronisation GPU par image en capture directe et plafonne
  vers 100 images/s (il en encode 530/s hors capture). Image passée en **mémoire CUDA**
  (`glupload ! glcolorconvert` → NV12 → `cudaupload`) : la copie rend aussitôt son
  tampon à KWin, sinon KWin, à court de tampons, saute des images.
- **`whipclientsink` ne sait pas régler `nvautogpuh264enc`** (il le laisse sans limite :
  110 Mbps) → réglé par nous dans `encoder-setup` : CBR, `p4`, `ultra-low-latency`,
  `zerolatency`, pas d'image clé périodique (seulement sur PLI). Conséquence : sa
  régulation de débit (`gcc`) ne pilote pas cet encodeur — à faire nous-mêmes.
- **Cadence fixe par `glvideomixer`, pas par `keepalive` + `videorate`** : KWin n'envoie
  rien quand l'écran est immobile ; `videorate` ne comble un trou qu'à l'arrivée de
  l'image suivante (au premier mouvement, une seconde d'images partait d'un coup :
  retard puis accélération du direct). Le `keepalive-time` de `pipewiresrc` corrige ça
  mais renvoie le tampon DMA-BUF de KWin lui-même, que KWin a pu réutiliser (texte tapé
  qui apparaît, disparaît, réapparaît). `glvideomixer force-live=true` sort 120 images/s
  à son rythme en répétant **sa copie** (vraie copie forcée : BGRA → NV12 → RGBA ; une
  conversion vers RGBA seule peut n'être qu'une vue du tampon de KWin).
- **VBV de l'encodeur ≈ 4 images** (`vbv-buffer-size`) : par défaut ~1 s, l'encodeur
  thésaurise pendant un écran immobile et dépense tout au mouvement suivant (pics à
  40 Mbps+ pour 30 demandés).
- **H264 Constrained Baseline niveau 5.2** côté str0m (`0x42e034`) : l'émetteur
  (`42c033`) et Firefox (`42e01f`) passent (str0m accepte un niveau offert ≤ le sien).
- **Tampon de réception UDP** du serveur à 4 Mo+ (`SO_RCVBUF`, plafonné par
  `net.core.rmem_max`) : sinon le noyau jette des paquets (`RcvbufErrors`).
- **Pacer str0m : laissé désactivé.** Il n'existe qu'avec l'estimation de bande passante
  (TWCC), qui fait des dents de scie (monte vers le débit voulu à coups de sondes,
  s'effondre à 10-18 Mbps) : sous le débit du diffuseur, la file grossit, le direct
  ralentit puis accélère. Avec un encodeur en CBR strict, les rafales sont petites
  (~26 paquets par image à 30 Mbps) et rien ne se perd sans lui. Sur Internet, il
  faudra une vraie régulation de bout en bout (débit par spectateur, simulcast).
- Banc reproductible : mire plein écran sur DP-1 (`waylandsink fullscreen-output=`),
  **en pause** pour un écran vraiment immobile (une mire qui tourne redessine sans
  cesse, et son bloc de bruit bouge toujours). Firefox `--headless` ne lance pas WebRTC.
- Débit côté serveur : un live de jeu en 120 images/s aura **1 à 2 spectateurs** en
  pratique (dit par l'utilisateur), soit 30-60 Mbps sortants ; 8 × 30 Mbps ≈ 240 Mbps
  reste le pire cas. Débit montant du serveur : inconnu à ce jour.
- Ressenti final (utilisateur) : mouvements fluides, texte tapé propre avec un léger
  jitter (écran à 240 Hz échantillonné à 120 : jusqu'à 8 ms d'écart par lettre).

Reste à valider : un spectateur **à distance** (le test était tout en local : même GPU
pour capturer, encoder et décoder) ; les premières images d'un mouvement brusque sont
floues (CBR à faible délai : chaque image n'a que sa part du débit — normal, élargir un
peu le VBV si besoin) ; Windows (`d3d11screencapturesrc`, encodeurs NVENC / AMF / QSV).

## Prochaines étapes (à revoir avec l'utilisateur à la reprise)

1. **Vidéo** : user stories (caméra et écran depuis le navigateur ; diffusion haute
   qualité par le diffuseur natif WHIP ; « Regarder » un partage d'écran, envoyé
   seulement à qui regarde ; régulation du débit), puis intégration au vrai serveur
   (WHIP dans `http.rs`, pistes vidéo dans `voice.rs`) et test avec un ami à distance.
   P2P pour les appels à deux : proposé à l'abandon (il faudrait STUN/TURN), à confirmer.
2. **Vocal / mobile / push-to-talk** : testés par l'utilisateur, rien à signaler ; le
   push-to-talk sert peu. Raccourci global du push-to-talk : seulement avec Tauri.
3. **Redondance RED** (trame précédente recopiée dans chaque paquet, sans latence
   ajoutée) si la FEC ne suffit pas : str0m ne connaît pas RED → passer le SFU en
   mode RTP brut, vérifier d'abord que str0m laisse passer un type de charge non
   négocié ; surtout utile sous Chrome (support Firefox incertain). Trames de 10 ms :
   à tester.
4. **Playwright** : vrais tests navigateur — remplacera `tests-e2e/`, qui ont vieilli
   (`reads.mts` échoue sur le format de la story 63 ; la moitié de `store/*.mjs` ne
   simulent pas assez le navigateur — `window`, `AudioContext`).
5. **Appels privés** (le volume par personne, story 76, s'y appliquera).

Ensuite / plus tard : photos de profil par le chemin HTTP des
médias (story 37) ; reprise de téléchargement par `Range` + checksum (story 53) ;
envoi de très gros dossiers en flux ; nettoyage des médias orphelins (compteur de
références, story 50) ; saves chiffrées côté oxidart ; AOF (durabilité entre deux
saves) ; file d'envoi bornée (`TODO.md`).

## Limites connues

- Cert auto-signé en dev ; en prod, TLS terminé par nginx (cf. Déploiement).
- Messages WebSocket fragmentés (FIN=0) non gérés (les navigateurs n'en envoient pas).
- Un crash (pas un arrêt propre) perd au plus les 10 dernières secondes.
- Un dossier envoyé est entièrement compressé en mémoire du navigateur avant l'envoi.
- Une conversation créée après « Tout couper » n'est pas coupée (voulu).
