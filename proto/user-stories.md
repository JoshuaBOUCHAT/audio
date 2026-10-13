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
33. (numérotée à la suite, cf. convention story 28 pour ne pas décaler les stories
    7-32 déjà référencées ailleurs) En tant qu'utilisateur qui rouvre l'app (nouvel
    onglet, refresh, reconnexion réseau), je veux que le client puisse réutiliser un
    jeton reçu à la connexion précédente pour me réauthentifier directement, sans
    devoir recliquer un lien magique à chaque fois — l'auth se fait une fois par
    connexion WebSocket (`AuthRequest` accepte indifféremment un token de lien
    magique ou un token de session), et reste valable pour toute la durée de vie de
    cette connexion (y compris pour le signaling WebRTC post-v1) : aucune requête
    suivante sur cette même connexion n'a besoin de reporter un token, l'identité est
    portée par la connexion elle-même côté serveur (état en mémoire, pas dans
    OxidArt).

**Révision 2026-10-12 (stories 65-68) : comptes à mot de passe, entrée sur invitation.**
Les stories 1-2 (« j'entre mon email et je reçois un lien ») sont remplacées : on ne
demande plus soi-même un lien. L'admin crée les liens (invitation pour un nouveau
compte, lien de connexion de dépannage pour un membre) ; on se connecte ensuite par
email et mot de passe.

65. En tant qu'admin, je veux créer un **lien d'invitation** à usage unique, avec une
    durée de validité que je choisis, le copier pour l'envoyer à un ami, voir mes
    invitations en cours et en révoquer une — dans un onglet **Administration** des
    paramètres, visible de l'admin seul.
    **Décisions** : `invite:{token}` avec le TTL natif d'OxidArt (durée choisie,
    30 jours max) ; consommé à l'inscription. Au premier lancement, si le compte du
    bootstrap admin (story 3) n'existe pas, le serveur affiche dans la console une
    invitation pour lui.
66. En tant qu'invité, je veux ouvrir le lien et **créer mon compte** : email, pseudo,
    mot de passe ; je suis connecté aussitôt.
    **Décisions** : email unique (409), pseudo selon la story 34, mot de passe de 8
    caractères min. Mot de passe haché en **bcrypt coût 12 + pepper**
    (révision 2026-10-12, coût 6 au départ) : ~185 ms de calcul, découpés en
    tranches de 16 tours qui rendent la main à la boucle — le serveur single-thread ne
    se fige jamais plus de ~1 ms (audio, vidéo). Les anciens hash restent valides et
    sont refaits au coût 12 à la connexion suivante. En plus, un secret serveur de 32 octets (`data/pepper`, ou `AUDIO_PEPPER`) mêlé au mot
    de passe par HMAC-SHA256 avant bcrypt — un dump seul ne permet pas de tester des
    mots de passe. Hash dans `password:{user}`, jamais dans `User` (qui part au
    client).
    **Révision 2026-10-13** : le lien est **vérifié à l'ouverture** (`CheckInvite`,
    avant toute connexion) — un lien expiré, révoqué ou déjà utilisé affiche
    « lien plus valide, demande-en un autre à l'admin » au lieu d'un formulaire qui
    n'échouerait qu'à l'envoi. Ne révèle rien : seul qui détient le jeton (UUID
    complet) peut demander.
67. En tant qu'utilisateur, je veux me connecter avec **email et mot de passe**, et
    définir ou changer mon mot de passe dans mon profil (un compte venu d'un lien
    magique n'en a pas encore).
    **Décisions** : erreur unique « email ou mot de passe incorrect » (pas de fuite
    sur l'existence du compte, un hash factice est vérifié pour un email inconnu) ;
    **10 échecs** sur un email le bloquent 15 min (TTL OxidArt) — le flow d'auth
    reste strict (CLAUDE.md). Changer son mot de passe demande l'actuel s'il existe.
68. En tant qu'admin, je veux créer un **lien de connexion** pour un membre (mot de
    passe oublié), à usage unique et de durée choisie : c'est le lien magique de la
    v1, désormais créé par l'admin seulement (`RequestMagicLink` refusé).

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
    **Décision v1 (2026-10-11)** : à la reconnexion, le client resynchronise depuis
    zéro (`SyncRequest.last_seen_id = 0`) et remplace son historique local. Le
    serveur renvoie tout le salon, tombstones compris (`deleted=true`). Limite
    connue : avec un `last_seen_id > 0`, la suppression d'un message d'id ≤
    `last_seen_id` n'est pas renvoyée — à traiter (ex. id de suppression tiré du
    compteur global + index des tombstones) si la resync complète devient trop lourde.

Stories 38-40 numérotées à la suite (convention des stories 28 et 33), ajoutées le
2026-10-12 :

38. En tant qu'utilisateur, je veux confirmer une suppression de message dans une
    fenêtre (« Supprimer ce message ? », aperçu du message, Annuler / Supprimer), pour
    ne pas supprimer par erreur — la suppression est définitive. Détail client
    uniquement, aucun impact protocole.
39. En tant qu'utilisateur, je veux répondre à un message précis : ma réponse affiche
    au-dessus d'elle l'auteur et le début du message cité ; cliquer sur cet extrait
    fait défiler jusqu'au message d'origine, qui se colore brièvement puis revient à
    la normale (fondu) pour attirer l'œil.
    **Décisions** : la réponse porte l'id du message cité (`reply_to_id`), le serveur
    vérifie qu'il existe dans le **même salon** (404 sinon). L'extrait n'est pas copié
    dans la réponse : le client le lit dans le message d'origine qu'il a déjà, donc
    une modification (story 40) ou une suppression de l'original se reflète dans la
    citation (« message supprimé »). Tant que la sync renvoie tout le salon, l'original
    est toujours chargé ; la future pagination devra charger l'original absent au
    clic (« message d'origine non chargé » d'ici là).
40. En tant qu'auteur d'un message, je veux le modifier comme si je l'écrivais : le
    texte repasse dans la barre de saisie, l'interface montre clairement que je suis
    en train de **modifier** (et non d'envoyer un nouveau message) et permet
    d'annuler ; les autres voient la modification en temps réel, et un message
    modifié porte une mention discrète « (modifié) ».
    **Décisions** : modification par l'**auteur uniquement** (pas l'admin, contrairement
    à la suppression — l'admin ne doit pas pouvoir faire dire quelque chose à
    quelqu'un) ; pas de modification d'un message supprimé ; mêmes règles de contenu
    qu'à l'envoi (non vide). Pas d'historique des versions : seul le dernier contenu
    et la date de dernière modification (`edited_at`) sont gardés, même logique que
    les tombstones (story 13). Une modification faite pendant qu'un client était hors
    ligne lui parvient par la resync complète (story 15).

64. *(ajoutée le 2026-10-12, révise 12 et 15)* En tant qu'utilisateur, je veux qu'une
    conversation s'ouvre sur ses **64 derniers messages** et que les plus anciens se
    chargent quand je remonte, sans que ma lecture saute.
    **Décisions** : `SyncRequest` en mode page (`limit` > 0) rend les `limit` messages
    précédant `before_id` (0 = les plus récents) par un `krange` inversé — jamais tout
    le salon — et `has_more` s'il en reste. Cliquer une citation dont l'original
    n'est pas chargé (story 39) charge les pages jusqu'à lui. À la reconnexion, la
    conversation repart de sa dernière page (story 15 : modifications et suppressions
    survenues pendant la coupure prises en compte), on remonte à nouveau si besoin.
    Le mode `last_seen_id` (tout ce qui suit) reste disponible.

69. *(ajoutée le 2026-10-12)* En tant qu'utilisateur, je veux qu'une connexion morte
    (réseau perdu sans fermeture propre) soit détectée vite, des deux côtés : je me
    reconnecte seul, et je ne reste pas « en ligne » ni dans un futur salon vocal
    (story 21) chez les autres.
    **Décisions** : le serveur envoie un ping WebSocket toutes les 15 s à chaque
    connexion et la ferme sans aucune trame reçue depuis 45 s (le navigateur répond
    aux pings tout seul, même onglet en arrière-plan). Le client envoie un
    `Heartbeat` toutes les 20 s quand l'onglet est visible et se reconnecte sans
    réponse sous 10 s.

### Résilience (côté produit, pas juste infra)

16. En tant qu'admin, je veux que le serveur redémarre automatiquement après un
    crash sans perte au-delà du dernier message non persisté.
17. En tant qu'utilisateur, je veux que ma connexion WebSocket se rétablisse
    automatiquement après une coupure réseau, sans recharger la page.

### Profil (pseudo, photo)

Numérotées à la suite (34+), même convention que les stories 28 et 33.

34. En tant que nouvel utilisateur, je veux choisir un pseudo à ma première connexion,
    avant d'accéder au chat, afin que les autres me reconnaissent sans voir mon email.
    **Décisions (2026-10-12)** : pseudo **obligatoire** (aucune écriture — message,
    salon, suppression, photo — n'est acceptée tant qu'il n'est pas choisi), **unique
    casse ignorée** (même règle que les noms de salon, évite qu'on se fasse passer
    pour quelqu'un), trimé, 1 à 32 caractères, sans caractère de contrôle. L'email
    n'est **jamais** transmis aux autres utilisateurs, seulement à soi-même (`me`).
35. En tant qu'utilisateur, je veux changer mon pseudo à tout moment (mêmes règles
    que story 34), et que les autres voient le changement en temps réel — y compris
    sur mes anciens messages, qui référencent mon id et non mon pseudo.
36. En tant qu'utilisateur, je veux voir le pseudo et la photo de l'auteur de chaque
    message. Tous les profils (id, pseudo, version de la photo) sont envoyés à la
    connexion — groupe d'amis, cohérent avec « tout le monde voit tout » (décision de
    conception ci-dessous) — puis tenus à jour par broadcast (nouveau compte qui
    choisit son pseudo, changement de pseudo ou de photo).
37. En tant qu'utilisateur, je veux définir, changer ou retirer ma photo de profil, et
    que les autres voient le changement en temps réel.
    **Décisions (2026-10-12)** : l'image est recadrée et réduite **côté client**
    (carré 256×256) avant l'envoi ; le serveur n'accepte que PNG, JPEG ou WebP
    (vérifiés par leurs octets magiques) et au plus 256 Kio — seule limite de taille
    métier du système, nécessaire parce que l'image est stockée dans OxidArt et part
    dans le snapshot. **Transport par WebSocket** (envoi et lecture) faute de chemin
    HTTP pour les images aujourd'hui : quand le chemin HTTP des images existera
    (pièces jointes, story 27, cf. `architecture.md` § HTTP/1.1), les photos devront
    l'emprunter (`GET /avatar/{id}?v={version}`, cache navigateur). La version de
    photo est conçue pour ça : un id tiré du compteur global à chaque changement, qui
    sert aujourd'hui de clé de cache côté client et demain de paramètre d'URL.

43. *(ajoutée le 2026-10-12)* En tant qu'utilisateur, je veux ajouter une description
    à mon profil (« À propos de moi »), visible par les autres dans ma carte de
    profil, pour donner un peu de personnalité. **Décisions** : texte libre, retours
    à la ligne permis, 190 caractères max (comme Discord), trimé, vide = pas de
    description ; transmise dans le profil public (story 36) et mise à jour en temps
    réel.
44. *(ajoutée le 2026-10-12)* En tant qu'utilisateur, je veux qu'un clic sur un
    membre de la liste ouvre sa carte de profil (grande photo, pseudo, statut,
    description) avec un bouton « Envoyer un message » pour ouvrir le DM (story 28),
    plutôt qu'un DM ouvert directement au clic. Sur ma propre carte, le bouton ouvre
    l'édition de mon profil. Détail client, aucun impact protocole.

### Images

Story 27 remontée en v1 le 2026-10-12 ; 45-50 à la suite.

27. En tant qu'utilisateur, je veux envoyer des images dans une conversation (salon ou
    DM), par un bouton qui ouvre le sélecteur de fichiers, par Ctrl+V ou par
    glisser-déposer. Une image apparaît en miniature **à l'endroit du curseur** dans
    la barre de saisie et je continue d'écrire : texte et images se mélangent
    librement, dans l'ordre où je les place (contrairement à Discord). Les GIF restent
    animés.
    **Décisions** : une image est stockée une fois et reçoit un lien `/media/{id}` ;
    dans un message, une image **est** ce lien, à sa place dans le texte, et le client
    affiche en image tout lien `/media/…` du serveur. Le message reste donc du texte
    (modification story 40, réponse story 39 inchangées) et partager une image ne
    copie rien (story 46). Fichiers sur disque (`data/media/`, nommés par leur
    SHA-256 : un même fichier envoyé deux fois n'est stocké qu'une fois),
    métadonnées dans OxidArt — les images ne vont pas dans OxidArt (elles seraient
    toutes en RAM et réécrites à chaque snapshot). Transport HTTP sur le même port
    (`POST /media`, `GET /media/{id}`), pas WebSocket (un gros fichier bloquerait les
    messages).
45. En tant qu'utilisateur, je veux sauter une ligne avec Maj+Entrée sans envoyer ;
    Entrée envoie.
46. En tant qu'utilisateur, je veux copier le lien d'une image pour la partager dans
    une autre conversation : c'est la même image, pas une copie. Le lien ne s'ouvre
    que **dans l'app** (accès authentifié, story 48) ; pour garder une image hors de
    l'app, je l'enregistre en local (story 49).
47. En tant qu'utilisateur, je veux que le serveur refuse ce qui n'est pas une image
    propre. **Décisions** : PNG, JPEG, WebP ou GIF reconnus à leurs octets magiques,
    en-tête lu pour les dimensions (refus au-delà de 16 384 px de côté : une « bombe »
    de pixels ferait planter le navigateur des autres) ; pas de décodage complet
    (le serveur single-thread serait bloqué), pas de réencodage (les GIF gardent leur
    animation).
48. En tant qu'opérateur, je veux un **quota d'images par personne** plutôt qu'une
    limite par fichier. **Décisions** : configurable au lancement, 25 Gio par
    personne par défaut, 0 = illimité ; dépassement refusé (413) avant d'écrire sur
    le disque. Accès aux images réservé aux utilisateurs connectés : le client charge
    l'image avec son token de session (`Authorization`), pas de cookie — un cookie ne
    suivrait pas la future app Tauri (autre origine que le serveur). Id d'image
    aléatoire (128 bits) : impossible de deviner les images d'un DM, admin compris
    (story 32).
49. En tant qu'utilisateur, je veux cliquer sur une image pour la voir en grand, et
    pouvoir l'enregistrer en local ou copier son lien depuis là.
50. En tant qu'utilisateur, je veux supprimer une image : **« ici »** la retire de mon
    message (modification, story 40) ; **« pour tout le monde »**, réservé à celui qui
    l'a envoyée, la supprime du serveur — partout où elle est partagée elle s'affiche
    « image supprimée », et son poids est rendu à mon quota.
    **Décisions** : en v1 rien n'est nettoyé automatiquement (une image qu'aucun
    message ne référence reste sur le disque, un lien partagé ne casse jamais seul).
    Le fichier sur disque est compté par empreinte (counter `media_file:{sha}`) et
    effacé quand plus aucune image ne le désigne. Plus tard : compter les références
    depuis les messages (counter par image) pour nettoyer les images orphelines.

### Fichiers et dossiers

Ajoutées le 2026-10-12 (51-53), dans la continuité des images (§ Images).

51. En tant qu'utilisateur, je veux envoyer un fichier de **n'importe quel type**, de la
    même façon qu'une image (bouton, Ctrl+V, glisser-déposer, à sa place dans le
    texte) ; il s'affiche comme une carte (icône, nom, taille, bouton de
    téléchargement) et se partage par son lien in-app (story 46).
    **Décisions** : même chemin que les images (`/media/{id}`, quota par personne,
    déduplication, suppression ici / pour tout le monde). Le serveur ne refuse aucun
    type : ce qui est une image propre (story 47) s'affiche dans le fil, tout le reste
    est un fichier — **toujours servi en téléchargement** (`Content-Disposition:
    attachment`, `application/octet-stream`, `nosniff`), jamais interprété par le
    navigateur. Le nom est fourni par le client et assaini (pas de `/`, pas de
    caractère de contrôle, 255 caractères max). Les métadonnées (nom, taille, type)
    se lisent par le WebSocket (`GetMedia`) sans télécharger le fichier.
52. En tant qu'utilisateur, je veux envoyer un **dossier** entier (bouton ou
    glisser-déposer) : il est compressé en **ZIP** dans mon navigateur puis envoyé
    comme un seul fichier ; sa carte montre son nom, le nombre de fichiers, la taille
    d'origine et la taille compressée.
    **Décisions** : ZIP (s'ouvre partout sans rien installer) produit par fflate dans
    des workers ; les fichiers déjà compressés (images, vidéos, archives…) sont
    stockés tels quels. Progression affichée pendant la compression et l'envoi.
    Limite connue v1 : l'archive est construite entièrement avant l'envoi (HTTP/1.1
    n'a pas d'envoi en flux depuis le navigateur) — un dossier de plusieurs Go pèse
    sur la mémoire du navigateur.
53. En tant qu'utilisateur, je veux télécharger un gros fichier (plusieurs Go) avec le
    gestionnaire de téléchargement de mon navigateur, sans qu'il passe par la mémoire
    de l'app.
    **Décisions** : l'app demande un **ticket** (`RequestDownload`, UUID aléatoire
    gardé 60 s par le TTL natif d'OxidArt) et le navigateur télécharge
    `/media/{id}?ticket=…` directement. Le lien partagé reste réservé à l'app : sans
    ticket valide (ou session en `Authorization`), rien ne sort.
    **Plus tard** : reprise d'un téléchargement interrompu (requêtes `Range`) et
    vérification de ce qui a déjà été téléchargé par checksum (le serveur connaît déjà
    le SHA-256 de chaque fichier).

54. *(ajoutée le 2026-10-12)* En tant qu'utilisateur, je veux lire une vidéo
    directement dans la conversation (lecteur intégré, déplacement dans la
    timeline, plein écran), sans la télécharger d'abord.
    **Décisions** : vidéos reconnues à leurs octets magiques (MP4/MOV `ftyp`,
    WebM/Matroska EBML), comme les images (story 47). Le lecteur du navigateur ne
    porte pas de token et lit par morceaux : le serveur gère les requêtes `Range`
    (206, une plage par requête — utile aussi pour la reprise de téléchargement, story
    53) et l'app demande un **ticket de lecture** (même mécanisme que le ticket de
    téléchargement, mais servi en ligne et valable 1 h, prolongé à chaque requête : une
    vidéo en pause ne coupe pas). Format que le navigateur ne sait pas lire (HEVC,
    certains MKV) : retour à la carte fichier avec téléchargement.

61. *(ajoutée le 2026-10-12)* En tant qu'utilisateur, je veux écouter un fichier audio
    directement dans la conversation (lecteur intégré). **Décisions** : MP3, AAC,
    M4A, OGG/Opus, FLAC, WAV reconnus à leurs octets magiques ; même lecture par
    plages et ticket de lecture que la vidéo (story 54).

### Apparence

55. *(ajoutée le 2026-10-12)* En tant qu'utilisateur, je veux choisir un thème
    **Système** (suit mon OS, par défaut), **Clair** ou **Sombre**, et le retrouver
    sur tous mes appareils.
    **Décisions** : choix mémorisé avec le compte (`User.theme`), jamais transmis aux
    autres ; un changement est poussé à mes autres connexions (onglets, appareils) qui
    basculent en direct. Copie locale du dernier thème, appliquée avant le chargement
    de l'app : pas d'écran blanc furtif au démarrage en sombre.

### Notifications et paramètres

Ajoutées le 2026-10-12.

56. En tant qu'utilisateur, je veux voir un **compteur de messages non lus** à côté de
    chaque salon et de chaque personne (liste Privé), et le total sur les onglets
    Salons / Privé et le titre de la page ; ouvrir la conversation la marque lue.
    **Décisions** : état « lu » **sur le serveur**, synchronisé entre mes appareils
    (lire sur l'un efface le badge sur les autres) : dernier message lu par
    conversation (`read:{moi}:{conversation}`, ne fait qu'avancer). Le compte se fait
    par `krange` à partir du dernier lu — seuls les non-lus sont parcourus — et
    s'arrête à 100 (« 99+ »). Ne comptent que les messages des autres, non
    supprimés. Sans marqueur, tout est non lu.
57. En tant qu'utilisateur, je veux un **son** quand un message arrive (salon ou DM)
    et que je ne regarde pas cette conversation, en choisissant parmi plusieurs sons
    ou aucun. **Décisions** : sons synthétisés dans le navigateur (Web Audio), pas de
    fichiers à héberger ; au plus un son par seconde.
58. En tant qu'utilisateur, je veux régler les notifications **par conversation**
    (un salon, ou une personne via notre DM) : couper complètement, ou seulement le
    son ; et un bouton **« Tout couper »** qui règle chaque conversation sur muet
    une par une, pour pouvoir ensuite n'en réactiver qu'une.
    **Décisions** : une conversation coupée garde son compteur (grisé), sans son ni
    popup. Une conversation créée après « Tout couper » n'est pas coupée.
59. En tant qu'utilisateur, je veux en option des **notifications système** (popup de
    l'OS) quand l'app n'est pas au premier plan ; cliquer dessus ouvre la
    conversation. Désactivées par défaut, autorisation du navigateur demandée à
    l'activation.
62. *(ajoutée le 2026-10-12, révise 56-57 pour les salons)* En tant qu'utilisateur, je
    veux **mentionner** quelqu'un avec `@` : une autocomplétion propose les membres
    pendant que je tape, et la personne choisie devient une pastille visible (mini
    photo, pseudo coloré) ; un message qui me mentionne est surligné.
    **Décisions** : une mention est `<@{id}>` dans le texte (comme Discord) — par id,
    donc un changement de pseudo se reflète partout. Dans un **salon**, seules les
    mentions de moi notifient (son, popup) et font le compteur rouge ; un salon non
    lu sans mention apparaît juste en gras. Dans un **DM**, chaque message notifie et
    compte (inchangé). Le serveur compte les mentions non lues comme les non-lus
    (story 56). Pas de `@everyone` en v1.
63. *(ajoutée le 2026-10-12, remplace le réglage par conversation de la story 58)* En
    tant qu'utilisateur, je veux régler les notifications **là où sont les gens et les
    salons** : clic droit sur une personne (liste Privé, liste des membres) ou section
    de sa carte de profil ; petit bouton 🔔 (ou clic droit) sur un salon.
    **Décisions** — par **personne** : ses messages privés (notifier, son) et ses
    mentions de moi dans les salons (notifier, son). Par **salon** : notifier pour tous
    les messages, les mentions seulement (défaut) ou rien, et son oui/non. Une mention
    dans un salon notifie si le salon ne dit pas « rien » et que la personne le
    permet ; le son demande l'accord du salon et de la personne. « Tout couper »
    (Paramètres) règle chaque salon sur « rien » et chaque personne sur « ne pas
    notifier », un par un. Badge grisé quand la conversation ne notifie plus.
60. En tant qu'utilisateur, je veux un **menu Paramètres** (bouton ⚙ en bas à gauche)
    regroupant Profil, Apparence et Notifications, extensible plus tard (vidéo,
    audio…). **Décisions** : réglages de notification mémorisés avec le compte
    (`settings:{moi}`), poussés à mes autres appareils, comme le thème (story 55).

### Présence

Remontée en v1 le 2026-10-12 (story 23, jusque-là post-v1) ; 41-42 à la suite.
« En train d'écrire » (story 24) reste post-v1, pas de statut « absent ».

23. En tant qu'utilisateur, je veux voir à droite la liste des membres, groupés par
    statut (« En ligne — N » puis « Hors ligne — N »), triés par pseudo, avec leur
    photo et un indicateur de statut, mis à jour en temps réel.
41. En tant qu'utilisateur, je veux choisir mon statut entre **En ligne** et
    **Invisible** : invisible, je reste connecté et peux tout faire, mais les autres
    me voient hors ligne. « Hors ligne » n'est pas un choix, c'est l'état vu par les
    autres quand je ne suis pas connecté ou que je suis invisible.
    **Décisions** : le choix est **mémorisé** avec le compte (on reste invisible
    d'une connexion à l'autre). Le statut d'un autre n'est jamais transmis tel quel :
    les autres reçoivent seulement « en ligne / hors ligne », donc rien ne distingue
    un invisible d'un absent. Limite assumée : un invisible qui écrit se trahit par
    ses messages (comme sur Discord).
42. En tant qu'utilisateur, je veux qu'on ne me voie pas en ligne pendant les **15 s**
    qui suivent ma connexion, pour pouvoir passer invisible sans que les autres
    m'aient vu arriver ; et qu'une coupure courte (refresh, réseau) ne me fasse pas
    clignoter hors ligne.
    **Décisions** : la présence est un **état de connexion en mémoire** dans le
    serveur, pas une donnée OxidArt (rien à retrouver après un redémarrage, où tout le
    monde se reconnecte). En ligne = au moins une connexion authentifiée (plusieurs
    onglets/appareils, story 5) et statut En ligne. Annonce « en ligne » 15 s après la
    première connexion si elle tient toujours ; annonce « hors ligne » 15 s après la
    dernière déconnexion si personne ne s'est reconnecté — une reconnexion pendant ce
    délai ne refait pas les 15 s d'attente. Passer invisible annonce « hors ligne »
    tout de suite ; repasser En ligne annonce « en ligne » tout de suite si connecté.

### Messages privés (DM)

Numérotées à la suite (28+) pour ne pas décaler les stories 18-27 déjà référencées
ailleurs — l'ordre des numéros ne reflète pas l'ordre d'apparition dans le document.

28. En tant qu'utilisateur, je veux démarrer une conversation privée à 1-à-1 avec un
    autre utilisateur, sans passer par un admin (contrairement aux salons, story 7) —
    n'importe quel utilisateur peut ouvrir un DM avec n'importe quel autre.
    **Décisions (2026-10-12)** : on ouvre un DM depuis la liste des membres (story 23),
    ce qui bascule directement sur cette conversation ; un seul DM par paire
    (rouvrir rend l'existant), pas de DM avec soi-même. L'autre ne voit la
    conversation qu'**au premier message** (comme Discord) : ouvrir sans écrire ne lui
    révèle rien.
29. En tant qu'utilisateur, je veux que le contenu de mes conversations privées ne soit
    **jamais** envoyé aux clients connectés qui n'en sont pas participants — pas de
    broadcast global comme pour les salons (voir décision de conception révisée
    ci-dessous). C'est la propriété qui distingue fondamentalement un DM d'un salon.
30. En tant qu'utilisateur, je veux voir la liste de mes conversations privées
    existantes dès ma connexion, sans avoir à les rechercher.
    **Décisions (2026-10-12)** : un bouton en haut à gauche bascule la colonne entre
    les salons et les conversations privées ; celles-ci sont triées par dernière
    activité (dernier message, à défaut création), avec photo et statut de l'autre.
    Le fil reprend l'interface d'un salon (réponse, modification, suppression).
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
    **Réaffirmé le 2026-10-12** : l'admin ne doit rien voir des DM via l'app — un
    non-participant reçoit 404 sur tout DM (lecture, envoi, sync, suppression),
    comme s'il n'existait pas. Piste pour le disque : snapshots chiffrés côté oxidart
    (clé fournie par variable d'environnement), sans chiffrement de bout en bout.

### Vocal

Remonté en v1 le 2026-10-13 (stories 18, 21, 22, jusque-là post-v1) ; 70-73 à la
suite (73-76 : volumes, micro coupé, sourdine). La vidéo (19-20) reste post-v1. Spike de validation :
`back-end/examples/voice_echo.rs` (écho par le serveur, validé dans un navigateur).

70. En tant qu'admin, je veux créer un **salon vocal** (en plus des salons texte),
    afin que les membres puissent s'y retrouver pour parler.
    **Décisions** : même règle que la story 7 (admin seul) ; `CreateChannel` porte le
    type (`TEXT` par défaut). Un salon vocal n'a pas de fil de messages.
18. En tant qu'utilisateur, je veux rejoindre le vocal d'un salon pour parler avec
    les membres présents. **Un seul vocal à la fois** : en rejoindre un second quitte
    implicitement le premier.
    **Décisions** :
    - **SFU, pas P2P** : chaque navigateur ne parle qu'au serveur, qui fait suivre
      les paquets Opus aux autres participants sans les décoder.
    - **Une seule offre du navigateur**, envoyée avec `JoinVoice` (son micro). Le
      serveur n'ajoute jamais de piste dans sa réponse : il envoie aussitôt après une
      offre à lui (`VoiceOffer`) avec une piste de réception par participant déjà là.
    - **Renégociation par le serveur seul**, à chaque arrivée ou départ : une offre
      `VoiceOffer` (numérotée), le navigateur répond (`VoiceAnswer`). Jamais deux
      offres en cours : un changement survenu pendant une négociation attend la
      réponse, puis part dans l'offre suivante. Pas de limite arbitraire au nombre de
      participants (choix de l'utilisateur, plutôt que des emplacements fixes).
    - **Pistes réutilisées** : la piste d'un participant parti est recyclée pour le
      prochain arrivant (le SDP ne grossit pas indéfiniment). Chaque offre dit quelle
      piste (`mid`) porte la voix de qui.
    - **Pas de trickle ICE** (validé par le spike) : l'offre part sans candidats ; le
      serveur est en ICE-lite et apprend l'adresse du navigateur par ses requêtes
      STUN. Pas de message `IceCandidate`.
    - **Un seul port, 443/udp**, un seul socket pour tous (démultiplexé par
      `Rtc::accepts`) : 443/udp est celui de HTTP/3, rarement bloqué. Candidats
      annoncés : l'IP publique (`AUDIO_PUBLIC_IP`) et l'IP locale de la machine (amis
      sur le même réseau que le serveur) — jamais 127.0.0.1, que les navigateurs
      refusent.
    - **État vocal en mémoire seulement**, pas dans OxidArt : un redémarrage du
      serveur vide les vocaux ; les clients rejoignent d'eux-mêmes (story 21).
    - Rejoindre le vocal se voit même en **invisible** (story 41) : on ne peut pas
      parler aux autres en restant caché.
21. En tant qu'utilisateur, je veux quitter le vocal à tout moment sans perdre ma
    connexion au reste du chat.
    **Décisions** : une coupure WebSocket vaut `LeaveVoice` (le `Rtc` est détruit,
    pas de connexion vocale orpheline sans session pour la piloter) ; ICE perdu
    aussi. Après une coupure, le client **rejoint de lui-même** le vocal où il était
    une fois reconnecté (nouvelle offre).
22. En tant qu'utilisateur, je veux voir qui est dans chaque salon vocal, avant de le
    rejoindre comme pendant, mis à jour en temps réel.
    **Décisions** (révision 2026-10-13) : diffusé **à tout le monde** (`VoiceChanged`,
    comme la présence) et non plus aux seuls participants — sinon impossible de
    savoir qui est là avant d'entrer. État initial dans `AuthResponse`.
71. En tant qu'utilisateur, je veux que **rien ne soit envoyé quand je ne parle
    pas**, et pouvoir régler la sensibilité de la détection.
    **Décisions** : détection de voix dans le navigateur (niveau du micro par trame
    de 20 ms, seuil réglable dans Paramètres, mémorisé localement), calculée dans un
    `AudioWorklet` et non par un minuteur — les navigateurs ralentissent les
    minuteurs d'un onglet en arrière-plan à une fois par seconde ; sous le seuil
    pendant 400 ms, le micro est détaché de la connexion (`replaceTrack(null)`) :
    plus aucun paquet audio. En plus, le serveur demande la transmission
    discontinue d'Opus (`usedtx=1`). Reste un filet d'environ un paquet par seconde
    (contrôles ICE, rapports RTCP) qui dit au serveur qu'on est toujours là.
72. En tant qu'utilisateur, je veux voir **qui parle** en ce moment.
    **Décisions** : calculé par chaque navigateur à partir du son reçu sur chaque
    piste — aucun message protocole.
73. En tant qu'utilisateur, je veux **couper mon micro** et me **mettre en sourdine**
    (ne plus rien entendre) facilement, et les enlever aussi facilement.
    **Décisions** : deux boutons toujours visibles pendant un vocal, plus des
    raccourcis clavier (onglet actif ; raccourcis globaux avec l'app Tauri). La
    sourdine coupe aussi le micro ; l'enlever rend au micro l'état d'avant (coupé
    avant la sourdine = reste coupé). Micro coupé = plus rien n'est envoyé (comme le
    silence, story 71) ; sourdine = lecture coupée localement.
    **Révision 2026-10-13** : les autres **voient** micro coupé et sourdine
    (`SetVoiceState`, diffusé dans `VoiceChanged` ; état initial dans `JoinVoice`).
    En sourdine, le serveur **n'envoie plus rien** à la personne (bande passante).
74. En tant qu'utilisateur, je veux régler le **volume général** des vocaux.
    **Décisions** : appliqué dans le navigateur (0-100 %), mémorisé sur l'appareil.
75. En tant qu'utilisateur, je veux régler le **gain de mon micro**, au-delà de 100 %
    pour un micro faible.
    **Décisions** : amplification (0-200 %) appliquée au micro **avant** l'envoi et
    avant la détection de voix (story 71) — sinon un micro faible ne déclencherait
    jamais l'envoi. Mémorisé sur l'appareil (dépend du matériel).
76. En tant qu'utilisateur, je veux régler le **volume d'une personne** (0-200 %),
    dans les vocaux comme plus tard dans les appels privés.
    **Décisions** : appliqué par le navigateur de celui qui écoute, à la piste de
    cette personne. Rangé dans le compte (synchronisé entre appareils, comme les
    règles par personne de la story 63), confirmé le 2026-10-13 — mais **hors de
    `Settings`** : ce type est stocké tel quel en bincode strict, un champ de plus
    ferait planter la relecture des réglages existants en release. Clé dédiée
    `voice_volume:{moi}:{autre}` (un entier, 100 % = clé absente), `SetVoiceVolume`,
    état initial dans `AuthResponse`.

---

## Post-v1 — hors périmètre d'implémentation, mais utilisées pour ne pas fermer de porte dans le protocole

### Vidéo

18, 21 et 22 sont remontées en v1 le 2026-10-13 (voir § Vocal de la partie V1).

19. En tant qu'utilisateur, je veux activer ma caméra pour partager ma vidéo.
    (Activer la caméra en cours de session passera par la même renégociation par le
    serveur que les arrivées dans le vocal, story 18.)
20. En tant qu'utilisateur à connexion limitée, je veux recevoir automatiquement une
    version basse résolution de la vidéo des autres, sans réglage manuel.

### Présence

23. *(remontée en v1 le 2026-10-12, voir § Présence de la partie V1)*
24. En tant qu'utilisateur, je veux voir un indicateur "en train d'écrire".

### Sécurité / gestion de compte

25. En tant qu'admin, je veux pouvoir révoquer toutes les sessions actives d'un
    utilisateur, pour réagir à une fuite de compte.
26. En tant qu'admin, je veux voir la liste des sessions actives d'un utilisateur
    avant de décider de les révoquer.

### Pièces jointes

27. *(remontée en v1 le 2026-10-12, voir § Images de la partie V1)*

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
