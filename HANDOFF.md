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
| Clés message | `keys.rs` | `message:{ch}:{id}`, id en hex sur 9 caractères |
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

## Décisions de la session du 2026-10-11

- Persistance v1 = snapshot oxidart only ; log pur (trace humaine) en fichier
  append, logique métier dans OxidArt, AOF oxidart reporté (CLAUDE.md § Résilience).
- audio reste sur monoio même si radixox passe à sa boucle io_uring maison.
- Save périodique = `SAVE` sync tant qu'oxidart n'expose pas sa BGSAVE en lib
  (le fsync fige le serveur pendant l'écriture, négligeable à cette échelle).
- Story 15 : le client resync depuis `last_seen_id = 0` à la reconnexion (la
  suppression d'un message d'id ≤ `last_seen_id` n'est pas renvoyée autrement).
- Clés message en hex à longueur fixe, pour un futur `getn` ordonné côté oxidart ;
  d'ici là, `getn` renvoie l'ordre d'insertion → tri par id côté audio.
- Broadcast : connexions authentifiées seulement ; file d'envoi non bornée (TODO.md).
- Nom de salon unique par type (un salon vocal pourra reprendre le nom d'un salon texte).

## Prochaine étape — le vrai client front

React + Vite + Tailwind + shadcn (`front/`), en réutilisant `src/lib/protocol.ts`
(`ProtocolClient`, helpers de requêtes, `onEvent` pour les broadcasts) :

1. Écran de login : email → `RequestMagicLink` → saisie / lien contenant le token →
   `AuthRequest` ; `session_token` en `localStorage`, renvoyé à l'ouverture.
2. Liste des salons (`AuthResponse.channels` + `ChannelCreated`), création si admin.
3. Fil d'un salon : `SyncRequest` depuis 0, `NewMessage` / `MessageDeleted` en direct,
   envoi, suppression (bouton pour l'auteur et l'admin).
4. Reconnexion automatique (story 17) : nouveau WS → `AuthRequest` avec le
   `session_token` → resync depuis 0 de chaque salon ouvert.

URL du back-end codée en dur (`wss://127.0.0.1:8443`) dans la page debug : à rendre
configurable pour le vrai client.

## Limites connues du serveur (non bloquantes en local)

- Écoute sur `127.0.0.1:8443` avec un cert auto-signé (`back-end/certs/`) : pas
  encore d'ACME/TLS-ALPN-01 ni de port 443 public (le spike vit dans `spike-acme/`).
- Requête HTTP d'upgrade lue en un seul `read` (4 Ko) ; frame WebSocket lue en un
  seul `read` : pas de frame fragmentée ni de frame à cheval sur deux lectures, et
  une frame non décodable ferme la connexion. Suffisant pour des messages courts,
  à reprendre pour de gros messages.
- Ping/pong et frames texte ignorés ; pas de heartbeat (CLAUDE.md : non tranché).
- Un crash (pas un arrêt propre) perd au plus les 10 dernières secondes.
