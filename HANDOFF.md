# Handoff — auth flow (AuthRequest → AuthResponse)

Note de reprise. Contexte : voir `CLAUDE.md` (racine et `back-end/`) et
`architecture.md`. Ce fichier est du travail en cours, pas de la doc durable — à
supprimer une fois le flow d'auth mergé.

## État actuel (fait, testé end-to-end)

- `proto/user-stories.md` : story 33 ajoutée (numérotée à la suite, cf. convention
  story 28) — reprise de session via `session_token`, auth valable pour toute la
  durée de vie de la connexion WebSocket.
- `proto/messages.proto` : `AuthResponse.session_token` ajouté ; `AuthRequest.token`
  documenté comme acceptant indifféremment un token de lien magique ou de session.
- `back-end/src/email.rs` : `Email` migré de `String` vers
  `radixox_lib::shared_byte::SharedByte` — zéro conversion à la frontière OxidArt,
  `Deref<Target=str>` via `unsafe { from_utf8_unchecked }` (invariant UTF-8 garanti
  une fois pour toutes dans `Email::parse`, jamais revérifié ailleurs).
- `back-end/Cargo.toml` : dépendance path `radixox-lib` ajoutée (à côté d'`oxidart`).
- `back-end/build.rs` : `prost_build::Config` avec `type_attribute` serde sur
  `User`/`Channel`/`Message` (persistance bincode dans OxidArt, cf.
  architecture.md § modèle de données).
- `back-end/src/validate.rs` : `validate_auth_request` (Uuid brut, pas de newtype —
  décidé : un token n'a pas d'invariant métier au-delà du format UUID).
- `back-end/src/main.rs` :
  - `AppState { art: SharedArt, bootstrap_admin_email: Option<Email> }`, construit
    une fois dans `main()` (email admin lu en argument CLI ou `ADMIN_EMAIL`), cloné
    dans chaque `monoio::spawn`.
  - `RequestMagicLink` persiste réellement : `magic_link:{token}` → email, TTL 15
    minutes (`MAGIC_LINK_TTL`).
  - `AuthRequest → AuthResponse` implémenté (`handle_auth`) : consomme le lien
    magique (get+del) sinon retente sur `session:{token}` (jamais consommé) ;
    résout/crée l'utilisateur (`id_counter` via `incr`, bootstrap admin sur premier
    login de l'email fourni au démarrage) ; émet un `session_token` (ou renvoie tel
    quel le token de session si c'était une reprise, pas de rotation).
  - Auth bind à la connexion WS (pas au message) : `user_id: Option<u64>` vit dans
    `handle_ws_connection`, pas de champ session à reporter dans les messages
    suivants sur la même connexion (couvre aussi le futur signaling WebRTC).
- Validé bout-en-bout (script jetable, supprimé après usage) : lien magique →
  compte créé → session_token → reconnexion sur un nouveau WS avec le
  session_token → même `user_id` → réutilisation du lien magique déjà consommé
  rejetée (`401`).

## Décisions actées cette session

- TTL lien magique : **15 minutes**.
- Binding de session : **auth par message après upgrade WS**, identité portée par
  la connexion (pas un champ token par message) — pas d'auth au niveau du handshake
  HTTP (aurait sorti l'auth du protobuf, contraire à "le protocole est la source de
  vérité").
- `AuthRequest.token` unique pour lien magique et reprise de session (pas de message
  `ResumeSession` séparé) — le serveur essaie magic_link puis session.
- Pas de newtype `MagicLinkToken`/`SessionToken` : un UUID brut suffit, aucun
  invariant métier supplémentaire (contrairement à `Email`).
- `SharedByte` généralisé à `Email` dès maintenant (pas seulement aux clés/valeurs
  OxidArt) — fait.

## Reste à faire

- **Front — seeding debug** (pas encore fait) : page/route debug dans `front/src`
  (zéro CSS) réutilisant `ProtocolClient` pour taper un email → `RequestMagicLink`
  → coller le token loggé côté serveur → `AuthRequest` → afficher `AuthResponse`
  brute. Objectif : tester le flow sans ligne de commande.
- `CreateChannel`/salons pas encore implémenté — `AuthResponse.channels` reste
  volontairement vide.
- Pas de broadcast/diffusion : hors scope de ce ticket.
