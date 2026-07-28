# Handoff — auth flow (AuthRequest → AuthResponse)

Note de reprise avant changement de machine. Contexte : voir `CLAUDE.md` (racine et
`back-end/`) et `architecture.md` pour les décisions déjà actées. Ce fichier est du
travail en cours, pas de la doc durable — à supprimer une fois le flow d'auth mergé.

## État actuel (déjà fait, testé)

- `back-end/src/proto.rs` : types prost générés depuis `proto/messages.proto`
  (via `build.rs`).
- `back-end/src/email.rs` : newtype `Email` (parse-don't-validate, trim+lowercase).
  Convention actée dans `architecture.md` § Validation : tout champ scalaire avec un
  invariant devient un newtype pervasif ; variable non validée = `unchecked_<nom>_str`.
- `back-end/src/validate.rs` : `validate_request_magic_link` (RawX prost →
  `ValidRequestMagicLink { email: Email }`).
- `back-end/src/main.rs` : WS binaire (opcode 0x2, longueur étendue 126/127),
  `RequestMagicLink → MagicLinkSent` câblé mais **sans aucune persistance** — le
  token est généré (`Uuid::new_v4()`) et juste loggé, jamais stocké nulle part. C'est
  la prochaine chose à corriger.
- `front/src/proto/messages.{js,d.ts}` : générés via `npm run proto:gen` (gitignorés,
  régénérés depuis `proto/messages.proto`).
- `front/src/lib/protocol.ts` : `ProtocolClient` (encode/decode + corrélation
  request_id↔réponse), transport-agnostic (DOM `WebSocket` ou `ws` npm package).
- `front/tests/proto-ping-pong.ts` (`npm run test:proto`) : round-trip validé en
  conditions réelles contre `cargo run` — `RequestMagicLink` → log du token côté
  serveur → `MagicLinkSent` reçu côté JS.

Décision actée pendant la session : **la persistance OxidArt sera écrite à la main
par l'utilisateur** (pas par Claude) — mais le code doit être écrit *comme si* elle
existait déjà (appels réels à l'API OxidArt ci-dessous), pas des stubs/TODO. Donc la
suite ci-dessous est à implémenter avec de vrais appels `tree.get/set/...`.

## Recherche OxidArt — API à utiliser (crate sœur `~/rust/radixox/oxidart`)

`OxidArt` est **synchrone** et **pas `Send`** (pensé pour un runtime monoio
single-thread). Pattern de partage recommandé par la crate elle-même
(`oxidart::monoio`) :

```rust
use oxidart::OxidArt;
use std::time::Duration;

// Rc<RefCell<OxidArt>> avec ticker (met à jour l'horloge interne pour les TTL) +
// évicteur (nettoie les clés expirées en tâche de fond) — recommandé pour la prod
// dès qu'on utilise des TTL (le lien magique en a un).
let art: oxidart::monoio::SharedArt =
    OxidArt::shared_with_evictor(Duration::from_millis(100), Duration::from_secs(1));

// Clone (Rc::clone, pas de deep copy) dans chaque tâche spawn (monoio::spawn) qui a
// besoin d'accéder à l'état — cohérent avec CLAUDE.md § OxidArt : toute suite de
// mutations qui représente un état métier valide doit être appliquée avant le
// prochain `.await` (aucune autre tâche ne peut s'intercaler entre deux `.borrow_mut()`
// consécutifs sur le même thread monoio).
```

API pertinente (signatures exactes, `~/rust/radixox/oxidart/src/lib.rs`) :

```rust
pub fn set(&mut self, key: SharedByte, val: Value)
pub fn get(&mut self, key: &[u8]) -> Option<Value>       // &mut self : éviction paresseuse au read
pub fn del(&mut self, key: &[u8]) -> Option<Value>
pub fn getn(&self, prefix: SharedByte) -> Vec<(SharedByte, Value)>   // scan préfixe
pub fn deln(&mut self, prefix: &[u8]) -> usize

pub fn set_ttl(&mut self, key: SharedByte, ttl: Duration, val: Value)
pub fn get_ttl(&self, key: SharedByte) -> TtlResult       // KeyNotExist | KeyWithTtl(secs) | KeyWithoutTtl
pub fn expire(&mut self, key: SharedByte, ttl: Duration) -> bool
pub fn persist(&mut self, key: SharedByte) -> bool        // retire le TTL

// Compteur atomique intégré — utile pour le compteur global d'ID (CLAUDE.md § IDs)
pub fn incr(&mut self, key: SharedByte) -> Result<i64, CounterError>
pub fn incrby(&mut self, key: SharedByte, delta: i64) -> Result<i64, CounterError>
```

`Value` (enum, `oxidart::value::Value`) : variante utile ici = `Value::String(SharedByte)`
— sert aussi bien pour du texte que pour des octets bruts (ex. `User` sérialisé en
bincode). `Value::as_bytes(&self) -> Option<SharedByte>` pour relire.

`SharedByte` (`radixox_lib::shared_byte::SharedByte`) : construction via
`SharedByte::from_str(&str)` ou `SharedByte::from_slice(impl AsRef<[u8]>)` (accepte
`Vec<u8>`, `&[u8]`, etc. — utile pour du bincode). `Deref<Target = [u8]>`,
`as_str() -> Result<&str, Utf8Error>`.

⚠️ `get`/`del` prennent `&[u8]` en paramètre (pas `SharedByte`) — asymétrie avec `set`
qui prend `SharedByte`. Ne pas se faire surprendre en écrivant le code.

## Schéma de clés (déjà décidé dans `architecture.md`, à compléter)

| Clé | Valeur | TTL |
|---|---|---|
| `user:{id}` | `User` (bincode dans `Value::String`) | non |
| `email_index:{email}` | `user_id` (u64, stringifié) | non |
| `magic_link:{token}` | email (String) | **oui** — durée non tranchée, cf. question ouverte plus bas |
| `session:{token}` | `user_id` (u64, stringifié) | non (story 6 : session valide indéfiniment) |
| `id_counter` | compteur global u64 (via `incr`) | non |

## Plan d'implémentation — AuthRequest → AuthResponse

1. **Threader l'état partagé.** Aucune fonction actuelle (`handle_conn`,
   `handle_ws_connection`, `handle_client_envelope`) ne reçoit d'état applicatif.
   Introduire un struct `AppState { art: SharedArt, bootstrap_admin_email: Option<Email> }`,
   le construire une fois dans `main()`, le cloner (`Rc::clone` implicite si `AppState`
   lui-même est dans un `Rc`, ou juste cloner `art` + `Email` si `AppState: Clone`)
   dans chaque `monoio::spawn(handle_conn(stream, acceptor, state.clone()))`.

2. **Corriger `RequestMagicLink`** (actuellement ne persiste rien) : après
   `Email::parse`, générer le token, `art.borrow_mut().set_ttl(magic_link:{token}, ttl, Value::String(email))`,
   logger le token (toujours pas d'envoi email réel en v1).

3. **`AuthRequest → AuthResponse`** (nouveau, à ajouter dans `handle_client_envelope`) :
   - Valider le `AuthRequest.token` (newtype `MagicLinkToken` ? à trancher — cohérent
     avec la convention `Email` si on veut être rigoureux jusqu'au bout, mais un simple
     `Uuid::parse_str` en guise de validation structurelle peut suffire si on juge que
     ça n'apporte pas assez pour l'instant — **question ouverte**, cf. plus bas).
   - `art.borrow_mut().get(magic_link key)` → si absent (jamais existé ou expiré via
     TTL), `Error`. Si présent : `art.borrow_mut().del(...)` pour le côté usage unique
     (consommer avant tout autre traitement, cohérent avec CLAUDE.md § cohérence
     synchrone).
   - Résoudre l'utilisateur : `get(email_index:{email})`. Absent → nouveau compte :
     `id = art.incr(id_counter)`, `User { id, email, is_admin }`,
     `is_admin = Some(&email) == bootstrap_admin_email.as_ref()` (bootstrap admin,
     CLAUDE.md § Bootstrap admin — premier login de cet email = admin, pas de flow
     séparé). Stocker `user:{id}` et `email_index:{email} → id`.
   - Générer un token de session opaque (`Uuid::new_v4()`), stocker
     `session:{token} → user_id` (pas de TTL, story 6).
   - Construire `AuthResponse { me: User, channels: vec![] }` — `channels` restera
     vide tant que `CreateChannel`/le stockage de salons n'est pas implémenté (hors
     scope de ce ticket, à ne pas bloquer dessus).
   - Le token de session doit être renvoyé au client d'une manière ou d'une autre pour
     les requêtes futures (`AuthResponse` actuel n'a pas de champ pour ça dans
     `messages.proto` — **à vérifier/amender le proto si besoin**, cf. question
     ouverte).

## Questions ouvertes (à trancher avant/pendant l'implémentation, pas par moi seul)

- **Durée du TTL du lien magique** : CLAUDE.md dit juste "expire après un court
  délai", pas de valeur. Proposition : 15 minutes, à confirmer.
- **Le token de session voyage comment jusqu'au client ?** `AuthResponse` dans
  `messages.proto` actuel ne contient que `me` + `channels`, pas de champ token. Soit
  on l'ajoute au message, soit on suppose un autre mécanisme (cookie ? pas cohérent
  avec "un seul port TLS, WS direct", donc probablement un champ à ajouter au proto).
  **Ne pas oublier `proto/user-stories.md` avant `messages.proto`** — discipline déjà
  actée dans `CLAUDE.md` § Protocole.
- **`MagicLinkToken`/session token en newtype comme `Email` ?** Cohérent avec la
  discipline pervasive actée cette session, mais pas encore tranché explicitement pour
  les tokens. À demander avant d'implémenter si ambigu.
- **Comment les requêtes suivantes (après auth) prouvent leur identité ?** Il faudra
  probablement un champ `session_token` dans `ClientEnvelope` (ou dans chaque message
  qui le nécessite) — pas encore dans le proto. À vérifier avec les user stories avant
  de toucher au schéma.

## Idée notée — généraliser `SharedByte` au-delà d'OxidArt

Suggestion de l'utilisateur (2026-07-28) : puisque `radixox_lib::SharedByte` fait
déjà partie de l'environnement global du projet (dépendance transitive via
`oxidart`), ça pourrait valoir le coup de l'utiliser plus largement dans le
back-end — pas seulement aux clés/valeurs OxidArt — plutôt que de faire naviguer des
`String`/`&str` partout puis convertir à chaque lecture/écriture vers OxidArt.

Pas encore implémenté, à réfléchir avant de trancher :

- **Ce que ça changerait concrètement** : `Email` (et les futurs newtypes du même
  genre, tokens compris) stockerait un `SharedByte` en interne au lieu d'un `String`.
  Bénéfice : zéro conversion String↔SharedByte à la frontière OxidArt (`set`/`get`
  prennent déjà des `SharedByte`/`&[u8]`), et clone bon marché (`SharedByte` est
  refcounté en interne, cf. `rc()` / `Clone`/`Drop` custom dans
  `radixox-lib/src/shared_byte.rs`) — cohérent avec le style "cheap clone" déjà
  utilisé par OxidArt lui-même.
- **Différence de garanties avec `String`** : `SharedByte` ne garantit pas l'UTF-8
  (`as_str() -> Result<&str, Utf8Error>`, fallible) alors que `String` le garantit par
  construction. Si `Email` passe sur `SharedByte`, il faudrait soit vérifier l'UTF-8
  une fois dans `Email::parse` et ne plus jamais avoir à re-vérifier ensuite (le
  newtype porterait alors *deux* garanties : UTF-8 + format email), soit accepter d'
  appeler `.as_str()` (fallible) à chaque usage — ce qui casserait un peu l'esprit
  "la garantie est portée par le type, plus personne ne revérifie" déjà acté pour le
  pattern parse-don't-validate.
- **`SharedByte` n'est probablement pas `Send`** (contrairement à `OwnedByte` qui a un
  `unsafe impl Send` explicite dans `radixox-lib`) — cohérent avec un backend
  single-thread monoio, mais à vérifier avant de l'utiliser dans un contexte qui
  suppose implicitement `Send` (peu probable ici, juste à garder en tête).
- **Périmètre à trancher** : tout le crate (`Email`, futurs `MagicLinkToken`,
  `SessionToken`, contenu de message...) ou seulement les types qui transitent
  effectivement par OxidArt ? Pas tranché — à décider avant d'implémenter, pas une
  décision à prendre seul en cours de route vu que ça touche la forme de tous les
  newtypes déjà posés (`Email`) et à poser (auth, cf. plan ci-dessus).

## Front — seeding debug (décidé cette session, pas encore fait)

Objectif : pouvoir tester le flow d'auth sans taper de commandes, **sans aucun
travail visuel** (zéro CSS, HTML en vrac accepté). Pas de mot de passe — l'app est
passwordless par design (lien magique par email uniquement, CLAUDE.md § Authentification).

Approche la plus simple : une page/route debug dans `front/src` (pas dans le HTML brut
servi par le back-end) qui réutilise `ProtocolClient`/`requestMagicLink` déjà écrits
dans `front/src/lib/protocol.ts` — un bouton qui envoie `RequestMagicLink` avec un
email tapé dans un `<input>`, affiche la réponse brute (JSON.stringify) à l'écran.
Zéro style, juste pour faire avancer le back sans attendre un vrai design.
