# Lagon Kart

Un jeu de kart 3D arcade à partager entre amis : **douze circuits originaux**, trois tours par course, routes évolutives, drift et mini-turbo, objets, aspiration et tournois de deux à huit courses. Le garage, six championnats progressifs, les courses classées, les replays et les équipes 4 contre 4 complètent les parties libres. L'interface est en français. Le serveur calcule les déplacements, collisions, objets et résultats ; le navigateur envoie les touches de conduite.

Les **trois modèles gratuits**, Zsky, Sprint et Rétro, acceptent chacun huit peintures, des roues animées, le braquage et une légère inclinaison visuelle de la carrosserie. Quatorze personnages sont disponibles. Les modèles de Zsky, Poly by Google et Ben Harrison sont crédités sous [CC BY 3.0](https://creativecommons.org/licenses/by/3.0/) ; leurs sources restent dans le dépôt. Coût des assets et de la préparation : **0 €**, sans service payant ni nouvelle dépendance. Voir [la bibliothèque de modèles](docs/KART_MODELS.md).

Voir la [démo intégrée, ses captures et ses tests](docs/DEMO.md), ainsi que le [suivi des tâches](todo.md).

Les douze circuits ont du **relief** : montées, descentes, crêtes et virages inclinés. Leurs tracés mêlent épingles, lacets et enchaînements de S, et les embranchements (déviation, voie turbo, raccourci) suivent le terrain. Les loopings ont été retirés. [Détail des changements, mesures et limites](docs/RELIEF_PERF_PROGRESS.md).

## Créer et partager un circuit

Depuis l’accueil, **Créer un circuit** ouvre l’atelier : déplacer/ajouter des
points, choisir la largeur et le thème, puis ajouter des bandes turbo, glace
ou boue. Les repères des modules se déplacent aussi directement sur le plan.
**Essayer en privé** lance le brouillon sans le publier ; **Retour à l’éditeur**
permet de reprendre le tracé. **Publier pour la classe** ajoute explicitement la
création à la sélection des circuits et aux programmes de tournoi des joueurs.

Les fichiers sont conservés sur la machine hôte dans **`data/tracks/`**, à côté
des comptes. Chaque modification crée une version : les courses déjà ouvertes
et les anciens replays gardent leur tracé. Un joueur modifie ses créations ou
duplique celles de la classe. [Utilisation et validation](docs/TRACK_EDITOR.md).

## Lancer une partie avec Docker

Seuls **Docker et Docker Compose** sont nécessaires sur l'ordinateur qui héberge la partie. Les amis utilisent un navigateur récent sur ordinateur (Chrome, Edge ou Firefox avec WebGL activé).

- **Windows** : installer Docker Desktop, activer son moteur Linux/WSL 2 et démarrer Docker Desktop. Ouvrir PowerShell dans ce dossier.
- **macOS** : installer et démarrer Docker Desktop, puis ouvrir Terminal dans ce dossier.
- **Linux** : installer Docker Engine et le plugin Docker Compose ; démarrer le service Docker et disposer des droits d'accès au moteur.

Vérifier l'installation avec `docker compose version`. Depuis le dossier contenant `compose.yaml` :

```bash
# Construire et démarrer le jeu en local
docker compose up --build -d

# Voir l'état et les logs du serveur
docker compose ps
docker compose logs -f app
```

Ouvrir **http://localhost:3000**. La première construction télécharge les dépendances ; les parties suivantes utilisent l'image déjà construite. Aucune installation de Node.js, de base de données ou de cloudflared n'est nécessaire sur l'ordinateur.

## Inviter des amis sur Internet

```bash
# Démarrer le jeu et son tunnel public
docker compose --profile tunnel up --build -d

# Lire l'URL https://...trycloudflare.com dans les logs
docker compose logs -f tunnel
```

Attendre l'apparition de l'adresse `https://…trycloudflare.com`. `Ctrl+C` quitte l'affichage des logs et laisse le jeu et le tunnel actifs. **Ouvrir cette adresse publique soi-même avant de créer le salon** : le bouton de copie du salon produira alors un lien public utilisable par les amis. Depuis `localhost`, le lien copié est local ; les amis doivent ouvrir l'adresse publique et saisir le code du salon.

1. Choisir un pseudo, une couleur et un circuit ; le **Garage** permet aussi de choisir le modèle, le personnage et les pièces. Créer un salon.
2. Copier son lien ou communiquer son code aux amis.
3. L'hôte règle la course ou le tournoi, puis chaque pilote se déclare prêt.
4. L'hôte lance la course. Un décompte commun de trois secondes précède le départ.
5. Après chaque manche, consulter les résultats et le classement cumulé. L'hôte prépare la course suivante ou un nouveau tournoi ; tous se déclarent prêts à nouveau.

Le mode **Entraînement** permet de courir seul sur le circuit choisi. Un nouvel arrivant pendant une manche attend la prochaine course. Le rôle d'hôte est transféré à un participant connecté lorsque l'hôte part ou perd sa connexion.

## Circuits et tournois

| Circuit | Particularités |
| --- | --- |
| Île des Alizés | 829 m. Grande courbe de plage, S entre les palmiers et épingle large ; colline de 6 m, turbos et boue. |
| Canyon solaire | 1 269 m. Deux lacets accrochés à la falaise, montée de 12 m vers le plateau puis longue descente. |
| Banquise boréale | 1 034 m. Courbes rapides, chicane sur la crête à 9 m et descente glacée. |
| Métropole néon | 1 079 m. Boulevards, angles droits et crochet entre les tours ; trois lignes turbo. |
| Mangrove sinueuse | 1 166 m. Serpent de virages et grand méandre autour du village sur pilotis ; boue alternée. |
| Dunes de cuivre | 1 067 m. Deux longues lignes droites qui ondulent sur les dunes (jusqu'à 8 m) ; quatre turbos. |
| Caldeira ardente | 1 435 m. Montée de 16 m autour du cratère, viaduc au-dessus de la lave, épingle et tremplin. |
| Forêt des géants | 1 505 m. Courbes vallonnées entre les séquoias, pont de bois, boue évitable et saut. |
| Port des cargos | 1 434 m. Grands quais, pont métallique, tour du bassin et rampe de chargement. |
| Archipel céleste | 1 382 m. Parcours en aile entre les îlots, deux viaducs, crêtes et grand saut. |
| Fonderie des pistons | 1 375 m. Tracé en coudes entre les hauts-fourneaux, passerelle et rampe d'essai. |
| Citadelle royale | 1 285 m. Montée de 14 m vers le donjon, pont de pierre sur les douves et saut de parade. |

Les tracés, largeurs, décors, zones et checkpoints sont propres à chaque circuit. Les terrains suivent leur silhouette ; les reliefs et monuments laissent libres les routes et les branches qui peuvent s'ouvrir. Les réglages d'un salon n'affectent pas les autres salons. Voir [les paysages, leur coût et leurs sources](docs/SCENERY.md).

Les événements se règlent du niveau **0 à 3**. Le niveau 0 garde le circuit classique. Dès le niveau 1, une déviation large avec objets et une voie turbo glissante offrent des alternatives ; un raccourci ouvre au troisième tour du leader. À partir du niveau 2, un barrage et une modification du terrain apparaissent au deuxième tour. Le niveau 3 combine météo et terrains difficiles. Tous les joueurs rencontrent la même phase, y compris ceux qui ont un tour de retard.

Les bifurcations sont annoncées en amont et dessinées sur la mini-carte, avec le barrage et le raccourci fermé. Les nouveaux raccordements ont des courbes progressives et une largeur de 12 à 14 m ; les raccourcis économisent **8 à 32 % de distance** sur la portion de route normale remplacée. Les checkpoints alternatifs doivent être réellement franchis, dans l'ordre. Six pistes ajoutent des ponts et des tremplins, avec montée, saut et réception simulés ; un embranchement ne passe jamais sur un pont ni un tremplin. Les documents [CIRCUITS.md](docs/CIRCUITS.md), [CIRCUITS_APPENDIX.md](docs/CIRCUITS_APPENDIX.md) et [LOOPINGS.md](docs/LOOPINGS.md) décrivent les tracés précédents.

L'hôte choisit **Une course** ou **Un tournoi**, avant le premier départ. Pour un tournoi de **2 à 8 courses** :

- **À la carte** : choisir le circuit de chaque manche, dans l'ordre souhaité ; les répétitions sont permises.
- **Au hasard** : cocher les circuits autorisés. Le serveur tire le programme parmi cette sélection, sans réutiliser un circuit avant d'avoir épuisé le groupe. Avec plusieurs circuits, deux manches consécutives ne sont jamais identiques.

Le programme est visible de tous et verrouillé dès que le tournoi commence. Les arrivants gagnent respectivement **15, 12, 10, 8, 6, 4, 2 et 1 point** ; une course non terminée rapporte zéro point. Les égalités sont départagées par les victoires, les courses terminées, le temps cumulé, puis un identifiant stable. La reconnexion conserve les points. Un pilote rejoignant un tournoi commencé part avec zéro point et participe à la prochaine manche. Les points d'un pilote parti restent dans le classement.

Entre les courses, l'hôte clique sur **Prochaine course** et les pilotes se déclarent prêts. Après la dernière course, le podium affiche le classement général. Un nouveau tournoi remet les scores à zéro, conserve les réglages et effectue un nouveau tirage si le mode est aléatoire.

En **4 contre 4**, Corail affronte Lagon. Le salon complète les places avec des CPU, qui suivent les mêmes règles de conduite et de garage. Les points des quatre membres s'additionnent entre les manches ; les objets guidés ciblent les adversaires et les impacts épargnent les coéquipiers. Les CPU ne gagnent ni classement ni progression persistante. Voir [les équipes et leurs tests](docs/TEAMS.md).

```bash
# Couper uniquement l'accès public ; continuer à jouer en local
docker compose stop tunnel

# Réactiver le tunnel (consulter de nouveau son URL)
docker compose --profile tunnel up -d tunnel

# Arrêter et supprimer les conteneurs du jeu et du tunnel
docker compose --profile tunnel down
```

L'ordinateur doit rester allumé et connecté, Docker et le tunnel doivent rester actifs. L'URL est temporaire et peut changer à chaque redémarrage du tunnel. Aucune reconstruction du jeu n'est nécessaire : les fichiers, le matchmaking et les WebSockets utilisent l'origine de la page, automatiquement HTTP/WS en local ou HTTPS/WSS en public.

Les [Quick Tunnels Cloudflare](https://developers.cloudflare.com/tunnel/get-started/quick-tunnels/) fonctionnent sans compte ni domaine mais n'ont pas de garantie de disponibilité. Leur limite annoncée de 200 requêtes simultanées et l'absence de SSE ne constituent **pas** une garantie de capacité en joueurs. Le jeu utilise WebSocket. Les salons amicaux n'ont pas de mot de passe : toute personne connaissant l'URL et le code peut les rejoindre. Les rencontres classées sont réservées aux profils inscrits par le matchmaking.

## Garage, carrière et classement

Le **Garage** propose trois modèles, huit couleurs et **quatorze personnages**. Aux cinq pilotes d'origine s'ajoutent Macron, Angela Merkel, Napoléon et six clins d'œil aux jeux, séries et films : Plombier turbo, Lutin vert, Hérisson pressé, Mineur cubique, Prof de chimie et Seigneur du casque. Chaque choix a son aperçu animé et sa description humoristique. [Portraits et casting](docs/CHARACTERS.md). Ces choix sont visuels. Les **18 pièces**, trois par emplacement, modifient réellement la conduite : châssis, moteur, pneus, turbo, aileron et poids. L'interface montre leurs effets et les pièces verrouillées. Les niveaux de carrière 0 à 3 débloquent les variantes ; le serveur vérifie les choix reçus.

Le bouton **Championnats, classement et replays** ouvre les six coupes :

| Coupe | Programme | Niveau requis → obtenu sur le podium |
| --- | --- | --- |
| Premiers virages | Alizés, Alizés | 0 → 1 |
| Les explorateurs | Alizés, Canyon | 1 → 1 |
| La traversée | Canyon, Banquise, Mangrove | 1 → 2 |
| Au millimètre | Néon, Dunes, Port | 2 → 2 |
| Rien ne reste en place | Forêt, Caldeira, Fonderie, Citadelle | 2 → 3 |
| La grande tournée | Néon, Banquise, Mangrove, Dunes, Caldeira, Archipel, Fonderie, Citadelle | 3 → 3 |

Il faut terminer toutes les manches et finir dans les trois premiers du classement final pour valider une coupe. La progression introduit les terrains, les bifurcations, les événements, puis les ponts et les sauts à partir du niveau 2. Chaque coupe accorde une seule fois sa récompense et son déblocage.

**Rechercher une course classée**, directement sur l’accueil, recherche au moins deux profils humains de niveau proche pour deux courses. Le MMR et le grade affichés viennent du serveur : Bronze, Argent, Or, Platine, Diamant et Maître. La recherche continue lorsqu’on ferme le menu Carrière ; entrer dans un salon ou l’éditeur l’annule. Le MMR évolue selon les résultats face aux autres joueurs. Le classement concerne cette instance du serveur. Une saison dure un trimestre UTC ; le changement de saison ajuste le MMR et conserve la carrière.

**Mes replays** relit les trajectoires enregistrées par le serveur, en vue de dessus, avec pause et curseur. Sur l'accueil, **Fantôme du meilleur temps en entraînement** affiche un ghost disponible pour le circuit choisi et le niveau 3 des événements de l'entraînement. Ce fantôme n'a pas de collisions et ne participe pas au classement. Les replays sont des traces de position, pas une resimulation exacte des objets et des contacts.

À l’accueil, dans **Mon compte et ma couleur**, **Sauvegarder mon pilote** crée un compte avec un nom d'utilisateur et un mot de passe, en conservant la progression de l'invité actuel. **Se connecter** retrouve ce même pilote depuis un autre navigateur, téléphone ou lien de tunnel : XP, coupes, déblocages, classement et replays. Aucun courriel ni compte externe n'est nécessaire. Le nom d'utilisateur comporte 3 à 24 lettres, chiffres, points, tirets ou `_`, et le mot de passe au moins 6 caractères. Les mots de passe sont dérivés avec scrypt et un sel individuel, jamais enregistrés en clair.

Le jeu invité reste disponible. Sans compte, son accès dépend de la clé conservée par le navigateur pour cette adresse du site : créer le compte avant d'effacer cette clé ou de changer de tunnel. Les choix visuels du garage restent propres au navigateur. Voir [les comptes et sauvegardes](docs/ACCOUNTS_STORAGE.md) et [la progression](docs/PROGRESSION.md).

## Commandes

| Action | Touches |
| --- | --- |
| Accélérer | ↑, Z ou W |
| Freiner / reculer | ↓ ou S |
| Tourner | ←/→, Q/D ou A/D |
| Drift | Maintenir Espace en tournant ; relâcher après la charge pour le mini-turbo |
| Utiliser l'objet | E |
| Remettre le kart en piste | R |

Sur écran tactile, **glisser le pouce gauche pour tourner** ; les boutons de drift, objet, frein/recul et remise en piste restent sous le pouce droit. L’accélération automatique est activée par défaut et peut être désactivée pour utiliser la pédale. Plusieurs doigts fonctionnent simultanément. Une interruption ou un changement d’orientation relâche les commandes ; toucher **Reprendre** ou une commande pour repartir. Le HUD se compacte en portrait et en paysage, jusqu’à 320 px. [Analyse des jeux mobiles, fonctionnement et captures avant/après](docs/MOBILE_CONTROLS.md).

Les boîtes mystères distribuent huit objets : **turbo**, **triple turbo**, **balise piège**, **projectile vert**, **fusée rouge guidée**, **comète bleue visant le leader**, **étoile d'énergie** et **bouclier**. Le triple turbo se consomme en trois pressions distinctes sur E ; le HUD indique les charges et les protections actives. Le tirage favorise les outils de rattrapage à l'arrière du peloton. Cibles, impacts et durées sont calculés par le serveur. Voir [les règles des objets](docs/ITEMS.md).

Les musiques fournies **`Lap 1.mp3`** et **`Lap 2.mp3`** accompagnent tous les circuits : le premier fichier joue au premier tour, puis le second aux deuxième et troisième tours. Les originaux sont conservés dans `assets/audios/` et leurs copies versionnées sont servies par le jeu. Le réglage du volume s'applique à la musique et aux effets ; le son démarre après une interaction avec la page. En quittant la fenêtre, les commandes sont relâchées et la musique est suspendue. L'intégration ne nécessite aucun achat, service externe ou nouvelle dépendance. Voir [les fichiers et leur intégration](docs/MUSIC.md).

Pour varier la conduite sans ajouter de touches :

- **Départ turbo** : commencer à accélérer pendant la dernière seconde du décompte et maintenir jusqu'au départ. Appuyer trop tôt ne donne pas le bonus.
- **Aspiration** : rester dans le sillage d'un adversaire pour charger une accélération, puis le dépasser. Un délai sépare deux bonus.
- **Bandes turbo** : viser les bandes lumineuses au sol. Chaque bande donne au maximum un bonus par tour ; reculer dessus ou se remettre en piste ne permet pas de le répéter.
- **Glace et boue** : la glace rend la direction plus glissante ; la boue ralentit le kart. Le HUD indique l'effet de la surface.

Les checkpoints se franchissent dans l'ordre et dans le sens de la course. La remise en piste utilise le dernier checkpoint valide. Après le premier arrivé, les autres ont 25 secondes pour terminer ; la manche dure au maximum cinq minutes. Les pilotes n'ayant pas terminé sont classés selon leur progression avec une indication d'abandon/non-arrivée. Une coupure réserve la place environ 30 secondes et neutralise les commandes. L'actualisation de la page reprend la session grâce à un jeton conservé **par onglet** ; après expiration, rejoindre de nouveau le salon. Arrêter le serveur efface les salons, qui résident en mémoire.

Les **comptes, profils, saisons et replays** sont enregistrés dans **`data/players/` sur la machine hôte**. Compose monte `./data` dans `/app/data` ; les fichiers restent présents après reconstruction, recréation et même `docker compose down -v`. Un autre nom de projet retrouve les données s'il utilise ce même dossier. Une seule instance de serveur doit écrire dans un même répertoire. Hors Docker, `PLAYER_DATA_DIR` choisit le répertoire de sauvegarde.

Pour reconstruire et relancer le jeu pendant les tests, en gardant les données et l'URL du tunnel :

```bash
npm run data:reset
```

Une installation utilisant encore l'ancien volume `lagon-kart_player-data` doit d'abord suivre la [migration sans écrasement](docs/ACCOUNTS_STORAGE.md#migration-de-lancien-volume-nommé). Le script conserve ce volume original. `npm run data:backup` crée une archive locale lorsque le jeu est arrêté. Les salons en cours disparaissent au redémarrage ; les résultats déjà enregistrés restent disponibles.

## Configuration facultative

Les valeurs par défaut fonctionnent sans fichier `.env`. Pour les changer, copier `.env.example` en `.env`, modifier les valeurs puis relancer `docker compose up -d`.

| Variable | Défaut | Usage |
| --- | --- | --- |
| `HOST_PORT` | 3000 | Port local ; par exemple 3100 donne http://localhost:3100 |
| `PLAYER_DATA_PATH` | `./data` | Dossier dédié sur l'hôte, monté dans Docker ; conserve les comptes et la progression |
| `MAX_ROOMS` | 16 avec Compose | Limite de salons simultanés, pas une capacité de performance garantie ; 32 par défaut hors Docker |
| `MAX_PLAYERS` | 8 | De 2 à 8 par salon multijoueur ; entraînement limité à 1 |
| `SIM_HZ` | 30 | Pas fixe de simulation serveur et prédiction client |
| `SNAPSHOT_HZ` | 20 | Fréquence des instantanés réseau |
| `RECONNECT_SECONDS` | 30 | Fenêtre de reprise |
| `INPUT_TIMEOUT_MS` | 250 | Neutralisation après silence réseau |

Dans le conteneur, le serveur écoute `0.0.0.0:3000`. Compose publie uniquement `127.0.0.1:3000` sur l'ordinateur ; le tunnel joint directement `http://app:3000` sur le réseau Docker. Aucun port de routeur ne doit être ouvert. `/healthz` vérifie que le serveur répond. Le service tunnel attend que ce contrôle réussisse.

## Modèles des karts et préparation

Les fichiers `kart-zsky-v1.glb`, `kart-sprint-v1.glb` et `kart-retro-v1.glb` sont inclus dans `client/public/models/` et servis depuis la même origine que la page. `GLTFLoader` charge chaque modèle une seule fois par page. Les instances partagent leurs géométries et leurs matériaux fixes ; les matériaux teintés sont propres à chaque pilote. Les roues ont des pivots préparés autour de leur axe, distincts du braquage. L'ancien kart procédural est conservé comme secours en cas d'échec de chargement d'un modèle.

Le roulement des roues, leur braquage et l'inclinaison de carrosserie sont des effets de rendu : ils ne changent ni la position simulée, ni les collisions, ni les messages réseau. Une ombre de contact légère reste visible lorsque le jeu réduit les ombres dynamiques sur une machine lente.

Les originaux, leurs provenances et leurs licences sont conservés dans `assets/sources/zsky/`, `assets/sources/poly-google/` et `assets/sources/ben-harrison/`. Pour reproduire la préparation, **facultativement**, avec Python 3 :

```bash
npm run prepare:kart
npm run check:kart
npm run prepare:kart-library
npm run check:kart-library
```

La conversion utilise la bibliothèque standard Python, sans téléchargement. Ni Python ni Blender ne sont nécessaires pour construire l'image Docker ou jouer. Voir [l'inspection du modèle initial](docs/KART_ASSET.md), [les trois modèles et leurs pivots](docs/KART_MODELS.md), [les captures avant/après](docs/KART_DEMO.md) et [les notices](THIRD_PARTY_NOTICES.md).

## Développement et tests

Pour développer hors Docker, installer Node.js 20.19+ ou 22, puis :

```bash
npm ci
npm run dev
```

Ouvrir http://localhost:5173. Vite recharge le client, `tsx watch` relance le serveur ; ses redémarrages perdent les salons en mémoire. Le proxy Vite conserve une origine unique. Pour vérifier la version compilée :

```bash
npm run build
npm start
```

```bash
# Types et règles déterministes
npm run typecheck
npm test

# Un serveur doit tourner sur localhost:3000 pour ces tests
npm run test:network

# Tournoi complet sur les quatre circuits historiques, quatre clients SDK par défaut
npm run test:tournament

# Deux sessions indépendantes dans Chromium
npx playwright install chromium
npm run test:browser

# Interface des tournois, sur un serveur de test privé (après npm run build)
npm run test:browser-tournament

# Comparatifs visuels et contrôles du modèle, sur un serveur de test isolé
npm run test:kart-visual

# Quatre pilotes SDK et deux navigateurs observateurs, contre un serveur actif
BASE_URL=http://127.0.0.1:3000 npm run test:kart-demo

# Nouveaux objets : clavier et HUD sur un serveur privé à fixtures (après build)
npm run test:items-browser

# Musique : lecture des MP3, changement de tour, volume et reprise
npm run test:music

# Trois modèles, quatorze personnages et interface carrière/équipes sur serveurs privés
npm run test:kart-library
npm run test:characters
npm run test:characters-roster
npm run test:features-browser

# Comptes : deux navigateurs privés, puis persistance Docker dans un dossier temporaire
npm run test:accounts-browser
npm run test:accounts-persistence
npm run test:storage-migration

# CPU : fermetures tardives en salon privé, puis course sur un serveur explicitement choisi
npm run test:cpu-obstacles-browser
BASE_URL=http://127.0.0.1:3000 npm run test:cpu-race
```

Les scripts réseau et le test navigateur de course complète acceptent `BASE_URL` pour tester une URL publique. Le test réseau accepte `CLIENTS=2` ou `8`, ainsi que `LATENCY_MS=75` pour retarder les commandes et la réception des instantanés de 75 ms chacun. Le test de tournoi accepte `CLIENTS=2` à `8` et fait réellement parcourir trois tours sur les quatre circuits historiques de son programme. Les tests de simulation couvrent les douze circuits et leurs branches. Le test navigateur utilise deux contextes isolés dans un même Chromium, pilotés automatiquement par les commandes clavier ordinaires. Les tests d'interface des tournois et des fonctionnalités utilisent aussi des arrivées imposées sur leur serveur privé : ils vérifient les écrans et transitions, sans constituer des courses complètes conduites. Les rapports indiquent le lot compilé réellement testé. Exemple sous bash :

```bash
BASE_URL=https://votre-adresse.trycloudflare.com CLIENTS=2 npm run test:network
LATENCY_MS=75 npm run test:network
```

Sous PowerShell : `$env:BASE_URL="https://votre-adresse.trycloudflare.com"`, puis `npm run test:network`. Selon le script, les rapports et captures sont écrits dans `test-results/` (ignoré par Git) ou dans les sous-dossiers de `docs/` indiqués par son rapport.

Suite complète du lot précédent (bots et comptes), le 7 octobre 2026 : **312/312 tests réussis**, sans échec ni test ignoré, en **107,34 s**, avec `node --import tsx --test --test-concurrency=4 tests/*.test.ts`. Elle couvre aussi les comptes et la récupération des bots lors des fermetures : huit CPU terminent les douze circuits, et 29 tests supplémentaires vérifient rails, branches et remises en piste. [Fonctionnement des bots](docs/TEAMS.md). Le parcours des comptes réussit **9 contrôles Chromium** sur deux contextes indépendants, dont un écran de 320 px. Les **15 contrôles tactiles** du lot précédent couvrent cinq formats et les commandes simultanées. Après `npm run build`, `npm run test:mobile-browser` et `npm run test:scenes-browser` exécutent ces parcours sur serveurs privés. Le lot initial de dix nouveaux personnages avait réussi **27 tests ciblés** et **6 contrôles de rendu Chromium**, avant le retrait d’un personnage ambigu et le passage à quatorze choix ; ces résultats historiques ne valident pas ce retrait. La suite complète ci-dessus précède cet ajout. Voir [VALIDATION.md](VALIDATION.md) pour les captures, les contrôles réseau, les versions réellement testées et les limites sur appareils physiques.

## Architecture et ressources

- `shared/track.ts` : catalogue des circuits, zones et checkpoints communs.
- `shared/track-events.ts` : branches, surfaces évolutives, barrages et portes alternatives.
- `shared/road-pose.ts`, `client/road-mesh.ts`, `client/scenery-terrain.ts` : pente et inclinaison de la route, ruban sans repli dans les virages serrés, glissières, talus et terrain vallonné.
- `shared/game.ts` : conduite déterministe, surfaces, aspiration, départ turbo, progression, collisions et objets.
- `shared/tournament.ts` : configuration, tirage des circuits, points et classement cumulé.
- `shared/garage.ts`, `shared/teams.ts`, `shared/cpu.ts` : pièces, équipes et conduite des CPU.
- `shared/progression.ts`, `server/player-store.ts`, `server/career.ts` : coupes, MMR, saisons, stockage local, matchmaking et replays.
- `server/` : salons Colyseus, règles d'accès, reconnexion, contrôles des messages et serveur HTTP statique.
- `client/` : Three.js, caméra, interface, musique MP3 et effets synthétiques, prédiction locale et interpolation.
- `client/scenery-terrain.ts`, `client/scenery-world.ts`, `client/scenery-assets.ts` : terrains polygonaux, repères des douze thèmes et cache du modèle d'arbre gratuit.
- `tests/` : tests ciblés des règles ; `scripts/` : vérifications de bout en bout.

La simulation est autoritaire à pas fixe. Les commandes sont bornées et numérotées ; leur génération de connexion (`epoch`) invalide les anciennes commandes après reprise. Le serveur ne rejoue aucune file de commandes accumulées après une coupure. Le client réconcilie sa prédiction avec les commandes acquittées ; les autres karts sont interpolés et le rendu utilise `requestAnimationFrame` indépendamment du réseau. Les instantanés complets simplifient cette première version à huit joueurs, au prix d'une bande passante plus élevée que des deltas de schéma.

L'audit de [react-racing-game](https://github.com/colyseus/react-racing-game) a montré que `movementData` y recopie les positions du client. Adapter sa physique Cannon côté serveur et ses anciennes dépendances économisait moins de travail qu'une conduite arcade commune. Le projet assemble donc Three.js et Colyseus, sans React ni moteur physique externe. Les packs [Kenney Car Kit](https://kenney.nl/assets/car-kit) et [Racing Kit](https://kenney.nl/assets/racing-kit), sous CC0, ont été examinés comme solutions possibles. Les trois karts retenus sont détaillés dans les notices. Les décors combinent des reliefs et monuments originaux avec [Tree de Kenney](https://poly.pizza/m/QN3Ru02ayU), sous CC0 : un GLB de 14 480 octets et 200 triangles, téléchargé une seule fois par page puis partagé entre les arbres. Sa source, son inspection et sa licence sont conservées dans `assets/sources/kenney-nature/`. Les circuits et personnages restent procéduraux. Toutes les ressources sont locales au serveur du jeu ; voir [la documentation des paysages](docs/SCENERY.md).

Les licences et les versions figurent dans [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md). L'usage de Colyseus 0.16 est volontaire et ses API sont vérifiées dans les sources installées ; les primitives netcode 0.18 ne sont pas utilisées. Toutes les dépendances npm sont figées dans `package-lock.json`, les images Docker ont des versions explicites.

## Dépannage

- **Docker inaccessible** : démarrer Docker Desktop et attendre son état « running ». Sous Linux, vérifier le service et les droits du socket Docker.
- **Port occupé** : définir `HOST_PORT=3100` dans `.env`, relancer Compose et ouvrir le port choisi.
- **Tunnel sans URL** : consulter `docker compose logs tunnel`. Vérifier la connexion Internet et les pare-feu/proxy autorisant cloudflared ; le tunnel utilise ici HTTP/2. Sa disponibilité dépend de Cloudflare.
- **Salon plein** : une place déconnectée reste réservée pendant la fenêtre de reprise. Revenir après expiration ou créer un autre salon.
- **Salon inexistant/expiré** : vérifier le code et le serveur ; le dernier départ ou un redémarrage du serveur supprime le salon.
- **Écran 3D indisponible** : activer l'accélération graphique du navigateur et mettre à jour ses pilotes. Le jeu réduit automatiquement les ombres et la résolution si le rendu reste lent. Les commandes tactiles sont testées en émulation Chromium ; confort et fluidité restent à vérifier sur téléphone physique. La manette n'est pas prise en charge.
