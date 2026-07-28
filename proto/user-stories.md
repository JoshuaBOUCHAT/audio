# User Stories

Document d'entrée pour la conception de `messages.proto`, du modèle de données
OxidArt et des flows protocolaires. Chaque story est tracée jusqu'aux messages
Protobuf qu'elle justifie dans `messages.proto`.

## V1 — dans le périmètre d'implémentation immédiat

### Auth / Onboarding

1. En tant que nouvel utilisateur, je veux entrer mon email pour recevoir un lien de
   connexion, afin d'accéder au chat sans mot de passe.
2. En tant qu'utilisateur, je veux cliquer sur le lien reçu pour être automatiquement
   connecté (et mon compte créé s'il n'existe pas), afin de ne pas avoir d'étape
   d'inscription séparée.
3. En tant qu'opérateur du serveur, je veux fournir un email au tout premier
   démarrage (CLI/env) pour que le premier compte qui se connecte avec cet email
   devienne automatiquement admin.
4. En tant qu'utilisateur, je veux que mon lien de connexion expire après un court
   délai s'il n'est pas utilisé, afin de limiter le risque en cas de fuite des logs.
5. En tant qu'utilisateur, je veux pouvoir être connecté simultanément depuis
   plusieurs appareils/onglets.
6. En tant qu'utilisateur, je veux que ma session reste valide indéfiniment après
   connexion (pas d'expiration automatique en v1), pour ne pas avoir à me reconnecter
   sans cesse.

### Salons

7. En tant qu'admin, je veux créer un salon texte avec un nom, afin d'organiser les
   discussions par thème.
8. En tant qu'utilisateur authentifié, je veux voir la liste de tous les salons dès
   ma connexion (pas de salons privés/restreints en v1 — tout le monde voit tout).
9. En tant qu'utilisateur, je veux envoyer et recevoir des messages dans n'importe
   quel salon existant, sans étape explicite de "rejoindre" un salon.

### Messages

10. En tant qu'utilisateur, je veux envoyer un message texte dans un salon.
11. En tant qu'utilisateur connecté, je veux recevoir en temps réel les nouveaux
    messages de tous les salons, afin de suivre l'activité sans action manuelle.
12. En tant qu'utilisateur qui se (re)connecte, je veux récupérer l'historique d'un
    salon depuis mon dernier point de synchronisation (`last_seen_id`), afin de ne
    rien manquer de ce qui a été dit pendant mon absence.
13. En tant qu'auteur d'un message, je veux pouvoir le supprimer.
14. En tant qu'admin, je veux pouvoir supprimer n'importe quel message, en l'absence
    de rôles/modération formelle.
15. En tant qu'utilisateur qui était hors ligne, je veux être informé des messages
    supprimés pendant mon absence lors de ma resynchronisation, pour que mon
    historique local reste cohérent (pas de trou silencieux).

### Résilience (côté produit, pas juste infra)

16. En tant qu'admin, je veux que le serveur redémarre automatiquement après un
    crash sans perte au-delà du dernier message non persisté.
17. En tant qu'utilisateur, je veux que ma connexion WebSocket se rétablisse
    automatiquement après une coupure réseau, sans recharger la page.

### Messages privés (DM)

Numérotées à la suite (28+) pour ne pas décaler les stories 18-27 déjà référencées
ailleurs — l'ordre des numéros ne reflète pas l'ordre d'apparition dans le document.

28. En tant qu'utilisateur, je veux démarrer une conversation privée à 1-à-1 avec un
    autre utilisateur, sans passer par un admin (contrairement aux salons, story 7) —
    n'importe quel utilisateur peut ouvrir un DM avec n'importe quel autre.
29. En tant qu'utilisateur, je veux que le contenu de mes conversations privées ne soit
    **jamais** envoyé aux clients connectés qui n'en sont pas participants — pas de
    broadcast global comme pour les salons (voir décision de conception révisée
    ci-dessous). C'est la propriété qui distingue fondamentalement un DM d'un salon.
30. En tant qu'utilisateur, je veux voir la liste de mes conversations privées
    existantes dès ma connexion, sans avoir à les rechercher.
31. En tant qu'utilisateur, je veux envoyer/recevoir des messages en temps réel dans une
    conversation privée, avec le même mécanisme de synchronisation (`last_seen_id`) que
    pour les salons.
32. En tant qu'auteur d'un message privé, je veux pouvoir le supprimer — **sans droit de
    suppression admin** ici, à la différence des salons (story 14) : l'admin n'a par
    design aucune visibilité sur le contenu d'un DM **via l'app/le protocole** (pas de
    broadcast, pas de route de lecture pour un non-participant), donc rien à modérer
    côté admin sans réintroduire une lecture qui casserait cette confidentialité
    applicative.
    **Limite explicite de cette garantie** : c'est une confidentialité de niveau
    protocole, pas de niveau stockage. Le log append-only et le snapshot restent en
    clair sur disque en v1 (aucun chiffrement au repos, cf. section Résilience
    d'`architecture.md`) — quiconque a un accès filesystem au serveur (l'opérateur/admin
    du VPS, typiquement la même personne) peut lire le contenu des DM directement dans
    le log, sans modifier une ligne de code ni passer par l'app. Risque accepté, cohérent
    avec le reste de la posture "pas de chiffrement au repos" déjà assumée pour tout le
    système (cf. CLAUDE.md) — le chiffrement disque, si souhaité, reste une
    responsabilité infra (LUKS), pas une feature applicative.

---

## Post-v1 — hors périmètre d'implémentation, mais utilisées pour ne pas fermer de porte dans le protocole

### Vocal / Vidéo

18. En tant qu'utilisateur, je veux rejoindre le canal vocal d'un salon pour parler
    avec les membres présents. **Un seul canal vocal actif à la fois par utilisateur**
    (pas de présence simultanée dans deux vocaux) — rejoindre un second vocal quitte
    implicitement le premier, cohérent avec `voice_channel: Cell<Option<u64>>` (un seul
    slot, pas une liste) déjà esquissé dans `architecture.md`.
19. En tant qu'utilisateur, je veux activer ma caméra pour partager ma vidéo.
20. En tant qu'utilisateur à connexion limitée, je veux recevoir automatiquement une
    version basse résolution de la vidéo des autres, sans réglage manuel.
21. En tant qu'utilisateur, je veux quitter le vocal à tout moment sans perdre ma
    connexion au reste du chat. **Une coupure WebSocket est traitée comme un
    `LeaveVoice` implicite** : pas de distinction entre départ explicite et
    déconnexion — dans les deux cas le `Rtc` (str0m) du client est détruit et les
    autres participants du même vocal sont notifiés. Évite un état "fantôme" (connexion
    vocale orpheline sans session WS pour la piloter).
22. En tant qu'utilisateur, je veux savoir qui est présent dans un canal vocal avant
    de le rejoindre, et être notifié en temps réel des arrivées/départs pendant que je
    suis dedans (arrivée/départ d'un participant = diffusion aux autres membres du même
    vocal uniquement, pas un broadcast global comme pour story 11 — même logique de
    routage ciblé que les DM, story 29).

### Signaling — clarifications protocolaires (nécessaires avant messages.proto)

- **Trickle ICE obligatoire** : les candidats ICE sont envoyés au fil de l'eau via des
  messages `IceCandidate` séparés, jamais bundlés dans l'offer/answer SDP — c'est le
  comportement natif de l'API WebRTC navigateur (`RTCPeerConnection.onicecandidate`),
  pas une option à désactiver.
- **Mute/unmute est un détail client, pas un message protocole** : couper son micro
  correspond à arrêter d'envoyer des paquets RTP (ou désactiver la piste locale) côté
  navigateur — le serveur n'a rien à modéliser côté état ("muted: bool" n'existe pas
  dans `Client`), il continue de forward ce qui arrive, ou rien s'il n'arrive rien.
  Un indicateur visuel "untel est mute" côté UI des autres clients se déduirait de
  l'absence de paquets RTP entrants, pas d'un message dédié — hors scope tant que ce
  n'est pas demandé explicitement.
- **Renégociation non supportée en v1** : un seul `WebRtcOffer`/`WebRtcAnswer` par
  session vocale (à l'entrée dans le canal). Activer la caméra en cours de session
  (story 19) nécessiterait une renégociation SDP (`createOffer` avec `iceRestart` ou
  une piste ajoutée après coup) — **non traité dans ce premier batch**, prévoir plutôt
  que la caméra soit décidée avant l'offer initial (l'utilisateur active son micro/sa
  caméra puis rejoint), quitte à revisiter si l'UX l'exige.

### Présence

23. En tant qu'utilisateur, je veux voir qui est actuellement connecté au serveur.
24. En tant qu'utilisateur, je veux voir un indicateur "en train d'écrire".

### Sécurité / gestion de compte

25. En tant qu'admin, je veux pouvoir révoquer toutes les sessions actives d'un
    utilisateur, pour réagir à une fuite de compte.
26. En tant qu'admin, je veux voir la liste des sessions actives d'un utilisateur
    avant de décider de les révoquer.

### Pièces jointes

27. En tant qu'utilisateur, je veux envoyer une image dans un message.

---

## Décision de conception induite (à confirmer si elle surprend)

Story 11 implique un **broadcast global** des nouveaux messages à tous les clients
connectés, quel que soit le salon affiché côté client — pas de modèle
d'abonnement/`JoinChannel` explicite côté serveur. Choisi pour rester au plus simple
(cohérent avec l'absence de rôles/permissions par salon) : le client reçoit tout,
décide localement quoi afficher/notifier. À revisiter seulement si le nombre de
salons ou le volume de messages devient un vrai problème de bande passante — pas un
souci pour un groupe d'amis.

**Exception introduite par les DM (story 29)** : ce broadcast global ne s'applique
qu'aux salons (`Channel.Type.TEXT`/`VOICE`), où "tout le monde voit tout" est un choix
assumé. Pour un DM, broadcaster le contenu à tous les clients violerait la
confidentialité qui est la raison d'être même du DM — le serveur doit donc faire une
livraison **ciblée** aux seules sessions des participants. C'est la première fois que le
protocole a besoin de savoir "qui doit recevoir quoi" plutôt que "tout le monde reçoit
tout" ; voir le modèle de routage dans `architecture.md`.
