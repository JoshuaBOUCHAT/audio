# Architecture — Discord Clone Self-Hosted

> Document de référence pour les LLM et contributeurs.
> Source de vérité pour toutes les décisions d'architecture.

---

## Vue d'ensemble

Un serveur de communication self-hosted minimaliste — salons texte, voix, vidéo — conçu pour un usage privé entre amis. Zéro SaaS, zéro dépendance externe, un seul binaire Linux.

**Philosophie**
- Single-thread, single-process, single-binary
- Zéro Tokio, zéro nginx, zéro Docker Compose complexe
- Protocole défini une fois en Protobuf — source de vérité absolue
- Persistence via OxidArt + append-only log, zéro SQL
- Le bottleneck est toujours la bande passante, jamais le CPU

---

## Stack Technique

| Composant | Technologie | Raison |
|-----------|-------------|--------|
| Runtime | monoio (io_uring) | Single-thread, Linux natif, zéro Send/Sync requis |
| DB in-memory | OxidArt (ART custom) | O(k) sur toutes les ops, runtime-agnostique |
| Persistence | Append-only log + snapshot incrémental | Zéro SQL, zéro dépendance |
| Transport texte | WebSocket (manuel, ~100 lignes) | Natif browser, Tauri, mobile |
| Transport media | WebRTC via str0m | Sans I/O, runtime-agnostique |
| Protocole | Protobuf (prost côté Rust, protobufjs côté JS) | Source de vérité unique |
| TLS + ACME | rustls-acme | Runtime-agnostique, Let's Encrypt auto |
| Desktop | Tauri (WebView) | Frontend JS/HTML/CSS, zéro modification client |

---

## Modèle de Thread

```
un seul thread OS (monoio io_uring)
  ├── accept() TCP + WebSocket handshake
  ├── dispatch messages Protobuf entrants
  ├── OxidArt mutations (sync, atomique entre .await)
  ├── str0m WebRTC state machine (Sans I/O)
  ├── append-only log writes (io_uring async)
  ├── snapshot incrémental (100 clés/tick)
  └── rustls-acme TLS + renouvellement Let's Encrypt
```

**Pas de spawn_blocking, pas de thread pool, pas de channel inter-thread.**
Tout tourne sur un seul core. Le bottleneck réseau apparaît bien avant le CPU.

---

## Protocole — messages.proto

> Le fichier `.proto` est la RFC du projet. Toute modification de protocole
> commence ici. Les types Rust et JS sont générés automatiquement.

Schéma validé via user stories : voir `proto/user-stories.md` (les stories) et
`proto/messages.proto` (le schéma qui en découle, seule source de vérité —
ne pas dupliquer son contenu ici pour éviter la dérive entre deux copies).

### Génération de code

```bash
# Rust — via prost-build dans build.rs
prost_build::compile_protos(&["proto/messages.proto"], &["proto/"]).unwrap();

# JS/TS — via protobufjs
npx pbjs -t json proto/messages.proto > proto/messages.json
npx pbts proto/messages.json > proto/messages.d.ts
```

### Modèle de données — clés OxidArt

Pas de schéma relationnel : chaque type d'entité est une clé préfixée. Les scans de
liste utilisent `getn(prefix)` (traversal ART natif, O(k)).

| Clé | Valeur | Notes |
|---|---|---|
| `user:{id}` | `User` (bincode) | `id` = compteur global |
| `email_index:{email}` | `user_id` (u64) | résout un email vers un compte existant |
| `magiclink:{token}` | `email` (string) | **TTL courte** via `set_ttl` — expire seule, zéro code de nettoyage |
| `session:{token}` | `user_id` (u64) | pas de TTL en v1 — révocation = `del` explicite (non implémenté v1) |
| `channel:{id}` | `Channel` (bincode) | listing via `getn("channel:")` |
| `message:{channel_id}:{id}` | `Message` (bincode) | `id` encodé en **8 octets big-endian** dans la clé (pas en décimal) pour que l'ordre lexicographique de l'ART corresponde à l'ordre chronologique — indispensable pour que `getn("message:{channel_id}:")` retourne les messages triés sans tri applicatif |
| `global_id_counter` | `u64` | un seul compteur partagé user/channel/message (cf. section IDs plus bas) ; persisté avec le snapshot, reclampé sur `max(id vu)+1` au replay du log par sécurité |

### Flows

**Login (stories 1-2)**
```
Client --RequestMagicLink{email}--> Serveur
Serveur: token = uuid4
         set_ttl("magiclink:{token}", 15min, email)
         log stdout: https://host/auth?token={token}
Serveur --MagicLinkSent{}--> Client   (ack neutre, n'indique pas si le compte existe)

[hors-bande: quelqu'un avec accès aux logs transmet le lien]

Client (a cliqué le lien, token en query param) --AuthRequest{token}--> Serveur
Serveur: email = get("magiclink:{token}")     — si absent/expiré -> Error
         del("magiclink:{token}")              — usage unique
         user_id = get("email_index:{email}") ou création (nouvel id, is_admin
                   si email == admin bootstrap fourni au premier lancement)
         session_token = uuid4
         set("session:{session_token}", user_id)  — pas de TTL v1
Serveur --AuthResponse{me, channels}--> Client
```

**Envoi de message (story 10-11)**
```
Client --SendMessage{channel_id, content}--> Serveur
Serveur: id = global_id_counter++ ; insert message:{channel_id}:{id}
         append LogEntry::SendMessage
Serveur --NewMessage{message}--> TOUS les clients connectés (broadcast global,
         voir décision de conception dans user-stories.md — pas de JoinChannel)
```

**Sync après reconnexion (story 12, 15)**
```
Client --SyncRequest{channel_id, last_seen_id}--> Serveur
Serveur: getn("message:{channel_id}:") -> filtre id > last_seen_id
         (inclut les messages deleted=true pour réconcilier les suppressions
         survenues pendant la déconnexion)
Serveur --SyncResponse{channel_id, messages}--> Client
```

**Suppression (story 13-15)**
```
Client --DeleteMessage{channel_id, message_id}--> Serveur
Serveur: vérifie auteur == sender OU sender.is_admin, sinon Error
         message.deleted = true ; append LogEntry::DeleteMessage
Serveur --MessageDeleted{channel_id, message_id}--> TOUS les clients connectés
```

**Création de salon (story 7-8)**
```
Client --CreateChannel{name}--> Serveur
Serveur: vérifie sender.is_admin, sinon Error
         id = global_id_counter++ ; insert channel:{id}
Serveur --ChannelCreated{channel}--> TOUS les clients connectés
```

---

## Transport WebSocket

WebSocket est utilisé pour **tout le plan de contrôle** :
- Messages texte (Protobuf encodé en binary frames)
- Signaling WebRTC (SDP offer/answer, ICE candidates)
- Synchronisation DB (SyncRequest/SyncResponse)
- Présence (UserJoined/UserLeft)

**Text frames** → Protobuf → messages structurés
**Binary frames** → bytes bruts → frames Opus audio + H264 vidéo

### Corrélation request/response

Chaque requête qui attend une réponse inclut un `request_id` UUID.
Le serveur retourne le même `request_id` dans la réponse.
Le client maintient une `Map<string, Promise>` pour résoudre les Promises.

```javascript
class WSClient {
    pending = new Map();

    request(payload) {
        const id = crypto.randomUUID();
        return new Promise((resolve, reject) => {
            this.pending.set(id, { resolve, reject });
            setTimeout(() => {
                this.pending.delete(id);
                reject(new Error('timeout'));
            }, 5000);
            this.ws.send(encode({ requestId: id, ...payload }));
        });
    }

    onMessage(envelope) {
        if (envelope.requestId && this.pending.has(envelope.requestId)) {
            this.pending.get(envelope.requestId).resolve(envelope);
            this.pending.delete(envelope.requestId);
            return;
        }
        this.handleEvent(envelope);
    }
}
```

---

## WebRTC — Audio & Vidéo

### Signaling via WebSocket

```
navigateur                    serveur (str0m)
──────────────                ──────────────
getUserMedia()
createOffer()        ──────→  accept_offer()
                     ←──────  create_answer()
setRemoteDesc()
onicecandidate       ──────→  add_remote_candidate()
                     ←──────  ICE candidates

WebRTC établi ✓
audio/vidéo UDP ─────────────────────────────→ SFU str0m
                ←───────────────────────────── forward aux autres
```

### Vidéo — Simulcast H264

Le client encode **deux layers simultanément** via NVENC/AMF (hardware, quasi-gratuit) :

```javascript
const params = sender.getParameters();
params.encodings = [
    { rid: 'low',  maxBitrate: 1_000_000, scaleResolutionDownBy: 3 },
    { rid: 'high', maxBitrate: 8_000_000, scaleResolutionDownBy: 1 },
];
await sender.setParameters(params);
```

Le serveur str0m forward le layer approprié selon `RTCP REMB` (bandwidth estimation du viewer) :
- Petite fenêtre ou connexion lente → layer `low` (360p, 1Mbps)
- Grande fenêtre ou bonne connexion → layer `high` (1080p, 8Mbps)

**Zéro décodage côté serveur — forward de packets H264 bruts.**

### Audio — Opus

- Bitrate : 256kbps
- Frame size : 20ms
- DTX activé (discontinuous transmission — silence = 0 bytes)
- PTT (push-to-talk) recommandé pour gaming

---

## Persistence — OxidArt + Log

### Règle fondamentale de cohérence

```
Toutes les mutations OxidArt qui forment un état logiquement
valide DOIVENT être appliquées avant le premier .await suivant.

Un subset de mutations est acceptable si ce subset représente
lui-même un état métier valide.

Jamais d'état intermédiaire invalide qui traverse un point de yield.
```

OxidArt est synchrone — `insert/get/delete` sont des fonctions normales, jamais `async fn`.
Le runtime monoio est coopératif — aucun autre task ne peut s'intercaler entre deux mutations
synchrones. La cohérence est garantie par construction.

### Append-Only Log

```
chaque mutation métier → encode en LogEntry (bincode) → append via io_uring
format : [u32 length][bytes LogEntry]

LogEntry {
    Set { key: Vec<u8>, value: Value, ttl: Option<u64> },
    Del { key: Vec<u8> },
    HSet { key, field, value },
    HDel { key, field },
    ...
}
```

### Snapshot Incrémental

Toutes les N ms (entre les requêtes), scan 100 clés de l'ART et les écrit dans le snapshot :

```
tick 1 : scan clés [0..100]   → append dans snapshot_wip.bin
tick 2 : scan clés [100..200] → append
...
tick N : scan terminé
         dirty keys (modifiées pendant le scan) → append
         rename atomic snapshot_wip.bin → snapshot.bin
         tronque le log (snapshot couvre tout)
```

**Dirty tracking** : toute mutation sur une clé déjà scannée est marquée dirty et
resauvegardée à la fin du cycle de snapshot.

### Sérialisation

OxidArt n'est **pas** sérialisé directement (HiSlab avec raw pointers, index croisés).
Seules les données brutes sont sérialisées :

```rust
// snapshot = liste de (key_bytes, Value)
// restore = O(n) inserts dans un OxidArt neuf

impl Serialize for SharedByte {
    fn serialize<S>(&self, s: S) -> Result<S::Ok, S::Error> {
        s.serialize_bytes(self.as_slice())  // déréférence ptr → bytes bruts
    }
}
// la deserialize crée une nouvelle allocation mimalloc
// le ptr original n'est jamais sérialisé
```

### Restore au démarrage

```
1. charge snapshot.bin → deserialise Vec<(key, Value)> → O(n) inserts dans OxidArt
2. replay append-only log depuis la position après le snapshot
3. serveur prêt
```

---

## État par Client (Rust)

```rust
struct Client {
    ws_writer:        RefCell<WsWriter>,
    rtc:              Option<RefCell<Rtc>>,      // str0m — None si pas en vocal
    user_id:          u64,
    voice_channel:    Cell<Option<u64>>,
    pending_requests: RefCell<HashMap<String, (Waker, RefCell<Option<Value>>)>>,
}
```

Tout en `Rc<RefCell<>>` — single-thread, zéro `Arc`, zéro `Mutex`.

### Read Loop

```
connexion TCP → WebSocket handshake → auth
loop {
    frame = ws.next_frame().await
    match frame {
        Binary → audio/vidéo frame → forward immédiat via str0m
        Text   → decode Protobuf → dispatch selon type
    }
}
```

Les frames audio/vidéo ne touchent jamais la DB.
Les messages texte passent par OxidArt puis le log.

---

## Bande Passante — 10 Personnes

### Audio seul

```
upload clients → serveur : 10 × 32KB/s  = 320KB/s
download client          : 9  × 32KB/s  = 288KB/s
```

### Vidéo H264 1080p60 simulcast

```
upload vers serveur : 10 × 9Mbps  = 90Mbps
download par client : 9  × 8Mbps  = 72Mbps (layer high, grande fenêtre)
                      9  × 1Mbps  = 9Mbps  (layer low, petite fenêtre)
total sortant max   : ~720Mbps
```

Ces chiffres supposent un lien symétrique (typique VPS, ex. Hetzner CX32 : 1Gbps,
20TB inclus, ~7€/mois). En auto-hébergement (box résidentielle), l'upload est presque
toujours très inférieur au download — à mesurer sur sa propre ligne avant de viser
10 participants en vidéo simultanée, indépendamment du choix d'hébergement ci-dessous.

### Encodage client

GPU moderne (GTX 1660+) : encode 1080p60 + 360p60 H264 simultanément via NVENC/AMF.
CPU : quasi zéro. GPU : ~8-10%.

---

## TLS & ACME

rustls-acme gère automatiquement :
- Obtention du certificat Let's Encrypt au premier démarrage
- Renouvellement automatique avant expiration
- Zéro configuration manuelle

```rust
let mut tls_incoming = AcmeConfig::new(["chat.example.com"])
    .contact_push("mailto:admin@example.com")
    .cache(DirCache::new("./certs"))
    .incoming(tcp_listener.incoming(), Vec::new());

while let Some(tls_stream) = tls_incoming.next().await {
    monoio::spawn(handle_client(tls_stream?));
}
```

---

## Déploiement

```bash
# installation
cargo install mon-discord

# démarrage — c'est tout
mon-discord --domain chat.example.com --port 443
```

- TLS Let's Encrypt automatique
- Zéro nginx, zéro Caddy, zéro reverse proxy
- Zéro Docker Compose
- Données dans `./data/` (snapshot + log + certs)

### Où le faire tourner — indifférent au logiciel, choix de l'opérateur

Le serveur ne suppose rien de particulier sur l'hébergement : VPS ou machine
personnelle (mini-PC, NAS...) derrière une box résidentielle, chacun fait comme il
veut. La seule contrainte dure, quel que soit le choix : **le port 443 (TCP+TLS-ALPN)
et le port UDP média (post-v1) doivent être joignables depuis l'extérieur**, pour le
trafic normal comme pour le renouvellement ACME.

- **VPS** : IP publique par défaut, rien à configurer côté réseau.
- **Auto-hébergement résidentiel** : nécessite (a) que le FAI ne fasse pas de CGNAT
  (vérifiable en faisant déjà tourner n'importe quel service self-hosted joignable de
  l'extérieur, ex. TeamSpeak), (b) le port-forwarding configuré sur le routeur, (c) un
  DDNS si l'IP publique n'est pas fixe, pour que le domaine reste à jour.

Rien dans le code applicatif ne distingue les deux cas — c'est purement une question
de réseau/infra en amont du binaire.

### Requirements

```
Serveur : Linux kernel 5.1+ (io_uring requis)
Client  : Windows, macOS, Linux via Tauri
          ou navigateur web directement (WebSocket + WebRTC natifs)
```

---

## Dépendances Cargo

```toml
[dependencies]
monoio        = { version = "0.2", features = ["iouring"] }
monoio-rustls = "0.2"
rustls-acme   = "0.12"
str0m         = "0.5"
prost         = "0.13"
bincode       = "1"
serde         = { version = "1", features = ["derive"] }

[build-dependencies]
prost-build   = "0.13"
```

**Zéro Tokio. Zéro OpenSSL. Zéro SQL. Zéro dépendance système externe.**

---

## Hors Scope (Phase 1)

- Modération, ban, kick, rôles
- Notifications push mobile
- Search full-text des messages
- Multi-serveur / fédération
- HTTP/3 QUIC
- Screen share dédié (la vidéo WebRTC couvre ce besoin)
- Emojis custom, stickers, réactions

---

## Propriétés de Sécurité

- TLS 1.3 obligatoire (rustls, zéro TLS 1.2)
- Auth par token (JWT ou token opaque — à définir)
- Zéro donnée transmise en clair
- Zéro dépendance C pour le TLS (rustls = pur Rust)
- Clés Let's Encrypt renouvelées automatiquement

---

*Dernière mise à jour : juillet 2026*
