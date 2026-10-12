# Handoff — point de reprise

Note de travail, pas de la doc durable : décrit où en est le projet et quoi faire
ensuite. Décisions durables → `CLAUDE.md` / `architecture.md` / `proto/user-stories.md`.
Points repoussés → `TODO.md`.

## État au 2026-10-11 — serveur texte v1 complet

Tout est testé de bout en bout (scripts Node jetables avec `ProtocolClient` contre le
vrai serveur, redémarrage compris).

| Fonction | Où | Notes |
|---|---|---|
| Auth lien magique + reprise de session | `main.rs` `handle_auth` | lien loggé sur stdout, TTL 15 min, usage unique ; `session_token` sans expiration ; auth liée à la connexion WS (story 33) |
| Bootstrap admin | `main.rs` `main` | email en argument CLI ou `ADMIN_EMAIL`, admin à sa première connexion |
| Salons | `create_channel`, `list_channels` | admin only (403), nom trimé non vide (400), unique parmi les salons texte, casse ignorée (409) ; liste dans `AuthResponse.channels` |
| Messages | `send_message`, `sync_messages`, `delete_message` | salon texte uniquement (DM refusés : pas encore de livraison ciblée) ; tombstones (`deleted`, contenu vidé) ; suppression par l'auteur ou l'admin (403) |
| Broadcast | `registry.rs` | modèle proactif repris du `SubRegistry` de radixox ; aux connexions authentifiées sauf l'émetteur, qui reçoit sa réponse avec `request_id` |
| Persistance | `persist.rs` | reload de `data/dump.rxd` au démarrage ; `SAVE` toutes les 10 s si `dirty` ; `SAVE` sur Ctrl-C/SIGTERM (second signal : sortie sans save) |
| Clés salon / message | `keys.rs` | `channel:{id}`, `message:{ch}:{id}`, id en hex sur 9 caractères ; listes triées par `krange` d'oxidart, ids client hors borne → 404 / sync vide |
| Front debug | `front/src/debug/AuthDebug.tsx` | `/debug`, zéro CSS, toutes les requêtes + broadcasts reçus |

Codes d'erreur utilisés : 400 (entrée invalide), 401 (non authentifié / token
invalide), 403 (droit manquant), 404 (salon ou message inconnu), 409 (nom de salon pris).

### Lancer et tester à la main

```bash
cd back-end && cargo run -- ton@email     # https://127.0.0.1:8443, données dans ./data
# navigateur : ouvrir https://127.0.0.1:8443 une fois pour accepter le cert auto-signé
cd front && npm run dev                   # http://localhost:5173/debug
```

Le token du lien magique s'affiche dans la console serveur (`[auth] lien magique pour …`).
En build debug, connexion directe sans lien : tokens permanents
`00000000-0000-0000-0000-00000000000N` (N = 1 à 9 ; 1 = admin du bootstrap, sinon
`devN@dev.local`), boutons « Admin / Dev 2 / Dev 3 » sur l'écran de login de `npm run
dev`. Compilés hors d'un build release (`#[cfg(debug_assertions)]`).

## Décisions de la session du 2026-10-11

- Persistance v1 = snapshot oxidart only ; log pur (trace humaine) en fichier
  append, logique métier dans OxidArt, AOF oxidart reporté (CLAUDE.md § Résilience).
- audio reste sur monoio même si radixox passe à sa boucle io_uring maison.
- Save périodique = `SAVE` sync tant qu'oxidart n'expose pas sa BGSAVE en lib
  (le fsync fige le serveur pendant l'écriture, négligeable à cette échelle).
- Story 15 : le client resync depuis `last_seen_id = 0` à la reconnexion (la
  suppression d'un message d'id ≤ `last_seen_id` n'est pas renvoyée autrement).
- Clés en hex à longueur fixe (ordre des octets = ordre numérique) ; le 2026-10-12,
  `krange` d'oxidart remplace `getn` + tri par id, et `channel:{id}` passe au même
  encodage (un dump antérieur n'est plus relu correctement).
- Broadcast : connexions authentifiées seulement ; file d'envoi non bornée (TODO.md).
- Nom de salon unique par type (un salon vocal pourra reprendre le nom d'un salon texte).
- Persistance en bincode, gardée volontairement (2026-10-12) : en **release**, un dump
  dont le schéma ne correspond plus fait planter le chargement plutôt que d'être relu
  avec des valeurs par défaut qui masqueraient une incohérence (protobuf écarté pour
  cette raison). En **debug** (`codec.rs`), un champ ajouté en fin de type est relu
  avec sa valeur par défaut et le dump est remis au schéma courant au démarrage :
  plus besoin de supprimer `data/dump.rxd`. Règle : **un nouveau champ va toujours à
  la fin** de son message (`StoredMedia` : `sha256` puis `meta`) ; retirer, déplacer
  ou retyper un champ plante toujours.

## Client front (2026-10-12) — fonctionnel, pas encore relu visuellement

`front/src/chat/` sur `/` (la page `/debug` reste) :

| Fichier | Rôle |
|---|---|
| `store.ts` | `ChatStore` hors React (`useSyncExternalStore`) : un WS par onglet, auth, broadcasts, reconnexion à backoff 0,5 s → 10 s (story 17) puis resync depuis 0 des salons ouverts |
| `session.ts` | `session_token` en `localStorage` (try/catch), token de lien magique lu dans `?token=` puis retiré de l'URL |
| `model.ts` | conversion proto → types d'affichage (`Long` → number), fusion des messages par id |
| `Login.tsx` / `ChatView.tsx` | login (email, puis lien ou token collé) ; salons + fil + saisie, suppression au survol (auteur ou admin), création de salon (admin) |
| `PseudoScreen.tsx` / `ProfilePanel.tsx` / `Avatar.tsx` | pseudo obligatoire avant le chat (story 34) ; profil : pseudo, photo (stories 35, 37) ; photo ou initiale, chargée à la demande et mise en cache par version (story 36) |
| `MembersPanel.tsx` | membres à droite, « En ligne / Hors ligne — N », triés par pseudo ; statut En ligne / Invisible dans le profil (stories 23, 41-42 ; présence en mémoire côté serveur, `presence.rs`) |
| `ChatView.tsx` (DM) | bouton Salons / Privé en haut à gauche ; DM triés par dernière activité ; clic sur un membre = ouvrir le DM et basculer dessus (stories 28-32) ; même `ChannelFeed` que les salons |
| `MessageBody.tsx` (vidéo) | lecteur intégré, lecture par plages avec ticket de lecture renouvelé, repli sur la carte fichier si le format n'est pas lisible (story 54) |
| `lib/theme.ts` | thème Système / Clair / Sombre (story 55) : `User.theme`, poussé à ses autres connexions, copie locale appliquée par un script inline d'`index.html` avant le chargement ; palette sombre bleutée dans `index.css` |
| `zip-folder.ts` | fichiers de tout type et dossiers compressés en ZIP par fflate (chargé à la demande) ; carte nom / taille / nombre de fichiers ; téléchargement natif par ticket (stories 51-53) |
| `Composer.tsx` / `MessageBody.tsx` / `media.ts` | images (stories 27, 45-50) : barre de saisie riche (texte et miniatures mélangés, bouton, Ctrl+V, glisser-déposer, Maj+Entrée) ; une image = lien `/media/{id}` dans le texte ; vue en grand, copier le lien, enregistrer, supprimer ici / pour tout le monde. Back-end : `http.rs`, `media.rs` (fichiers `data/media/{sha256}`, quota `AUDIO_MEDIA_QUOTA_GIB`) |
| `avatar-image.ts` | recadrage carré 256×256, WebP (repli JPEG) ≤ 256 Kio avant envoi |

URL du back-end : `VITE_BACK_END_URL`, défaut `wss://127.0.0.1:8443` (`src/lib/config.ts`).
Un token de session refusé explicitement par le serveur est effacé ; une coupure réseau
pendant l'auth le garde.

Testé : le `ChatStore` piloté sous Node (chargé par Vite) contre le vrai serveur, deux
clients, redémarrage serveur compris. **Le rendu dans un navigateur n'a pas encore été
vérifié** (pas d'outil navigateur dans la session) : premier point à faire.

## Prochaines étapes

1. Vérifier le rendu dans le navigateur, ajuster l'UI.
2. Quand le chemin HTTP des images existera (pièces jointes, story 27) : y basculer
   les photos de profil (`GET /avatar/{id}?v={version}`) et retirer `GetAvatar`.
3. Le serveur logge le token seul : logger un lien complet (`…/?token=`) suppose de
   connaître l'URL publique du front (variable d'env), à trancher avec le service des
   fichiers statiques par le binaire.

## Limites connues du serveur (non bloquantes en local)

- Écoute sur `127.0.0.1:8443` avec un cert auto-signé (`back-end/certs/`) : pas
  encore d'ACME/TLS-ALPN-01 ni de port 443 public (le spike vit dans `spike-acme/`).
- Requête HTTP d'upgrade lue en un seul `read` (4 Ko).
- Frames WebSocket (`ws.rs`) : accumulées sur plusieurs lectures, plusieurs par
  lecture ; plafond de transport 1 Mio par frame ; messages fragmentés (FIN=0) non
  gérés (les navigateurs n'en envoient pas). Une frame invalide ferme la connexion.
- Ping/pong et frames texte ignorés ; pas de heartbeat (CLAUDE.md : non tranché).
- Un crash (pas un arrêt propre) perd au plus les 10 dernières secondes.
