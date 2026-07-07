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

---

## Post-v1 — hors périmètre d'implémentation, mais utilisées pour ne pas fermer de porte dans le protocole

### Vocal / Vidéo

18. En tant qu'utilisateur, je veux rejoindre le canal vocal d'un salon pour parler
    avec les membres présents.
19. En tant qu'utilisateur, je veux activer ma caméra pour partager ma vidéo.
20. En tant qu'utilisateur à connexion limitée, je veux recevoir automatiquement une
    version basse résolution de la vidéo des autres, sans réglage manuel.
21. En tant qu'utilisateur, je veux quitter le vocal à tout moment sans perdre ma
    connexion au reste du chat.
22. En tant qu'utilisateur, je veux savoir qui est présent dans un canal vocal avant
    de le rejoindre.

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
