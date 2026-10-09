# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

Trois publics confirmés, sans priorité entre eux :

- **Camarades de classe** qui se retrouvent sur l'instance hébergée par l'un d'eux ; « la classe » est le groupe qui partage les circuits publiés.
- **Groupes d'amis** invités par lien de tunnel pour une soirée de courses.
- **Public ouvert** : toute personne qui reçoit le lien ou le QR code.

Situation type : quelqu'un lance le serveur sur son ordinateur, envoie un lien, et 2 à 8 personnes courent ensemble dans leur navigateur en quelques instants. **L'ordinateur au clavier est l'appareil principal** ; le téléphone tactile est un appoint (rejoindre par QR), pris en charge mais pas la cible première.

## Product Purpose

Lagon Kart est un jeu de kart 3D arcade multijoueur jouable dans le navigateur. Il existe pour qu'un groupe puisse faire une course complète ensemble (drift, objets, classement, revanche) sans rien installer côté invités. Le succès : entre le lien reçu et le départ de la course, il n'y a presque rien à faire ni à comprendre.

## Positioning

Un jeu de kart auto-hébergé : une commande Docker Compose et un tunnel Cloudflare suffisent à l'hôte, un navigateur suffit aux invités. Pas de compte obligatoire, pas de service payant, pas d'hébergement externe ; toutes les ressources sont servies par le serveur du jeu. Les joueurs créent, essaient et publient leurs propres circuits pour leur groupe.

## Operating Context

- L'hôte démarre `docker compose` (profil `tunnel` pour Internet), ouvre l'URL publique, crée un salon, partage le lien, le code ou le QR code.
- Accueil en quatre vues : Jouer, Pilote, En ligne, Options. Grade, MMR et recherche classée sont visibles dès l'accueil.
- Salon : l'hôte règle une course ou un tournoi (2 à 8 courses), chacun se déclare **Prêt**, décompte commun de trois secondes.
- Modes : Entraînement solo, course libre, tournoi, 4 contre 4 (Corail contre Lagon, complété par des CPU), Soirée (vote de circuit), Couronne, courses classées, six championnats de carrière.
- Garage (3 modèles, 8 peintures, 14 personnages, 18 pièces), atelier de création de circuits, replays et fantôme du meilleur temps.
- Commandes clavier (flèches / ZQSD / WASD, Espace, E, R) ; au tactile, pouce gauche pour tourner et boutons sous le pouce droit, accélération automatique par défaut.

## Capabilities and Constraints

- Serveur autoritaire (Colyseus, 30 Hz) ; le client Three.js prédit et interpole. Une seule origine pour client, assets, matchmaking et WebSocket.
- TypeScript, Vite, Three.js, sans React ni moteur physique externe. Interface en DOM/CSS au-dessus d'un canvas WebGL.
- 2 à 8 joueurs par salon ; salons en mémoire, perdus au redémarrage. Comptes, profils, replays et circuits persistés dans `data/` sur la machine hôte.
- **Zéro coût, tout local** : aucun service payant, aucun CDN, aucune nouvelle dépendance pour quelques lignes ; assets sous licence libre, crédités dans `THIRD_PARTY_NOTICES.md`.
- **Jouable à 320 × 568 sans défilement** pour les actions principales (Créer, Rejoindre, Entraînement, barre Prêt).
- **Invité sans compte** : on joue immédiatement ; le compte (nom d'utilisateur et mot de passe, sans courriel) reste facultatif.
- Graphismes Auto / Fluide / Détaillé mémorisés ; le jeu réduit ombres et résolution sur machine lente.
- Non pris en charge : manette. Non validé : téléphone physique, Safari iOS, performances GPU réelles.

## Brand Commitments

- Nom **Lagon Kart**, accroche « À vous la piste. », univers de courses tropicales.
- **Interface entièrement en français**, ton léger et humoristique (descriptions des personnages, noms des coupes).
- Vocabulaire à conserver : salon, hôte, Prêt, Garage, atelier, « publier pour la classe », équipes Corail et Lagon, les douze noms de circuits.
- **La direction artistique actuelle est conservée** : le produit est jugé sur de bonnes bases, les évolutions l'affinent sans la remplacer.

## Evidence on Hand

- `README.md`, `VALIDATION.md`, `todo.md` : fonctionnalités, résultats de tests réels et limites déclarées.
- `docs/` : captures avant/après et rapports par chantier (`ux-home`, `home-navigation`, `ux-ranked`, `ux-editor`, `ux-driving`, `mobile-controls`, `party-crown`, etc.).
- `docs/CHARACTERS.md`, `docs/CIRCUITS.md`, `docs/ITEMS.md` : contenu réel du jeu.
- Aucun témoignage, chiffre d'audience ou capacité garantie en joueurs : ne pas en inventer.

## Product Principles

1. **Jouer avant tout le reste.** Chaque écran raccourcit le chemin entre le lien reçu et le départ ; rien d'obligatoire ne s'intercale.
2. **L'ordinateur d'abord, le téléphone jamais cassé.** On conçoit pour le clavier et le grand écran, et le résultat tient toujours à 320 px.
3. **Autonome et gratuit.** Ce qui exige un service externe, un paiement ou une ressource distante n'entre pas.
4. **Affiner, ne pas refaire.** Les bases sont bonnes ; on améliore la clarté et le confort sans changer d'identité.
5. **Dire vrai.** L'interface et la documentation n'annoncent que ce qui a été réellement vérifié.

## Accessibility & Inclusion

Navigation au clavier dans les menus, vues inactives inertes, retour du focus après les dialogues et zone visible adaptée (`visualViewport`) sont déjà en place et doivent être préservés. Aucune norme formelle (WCAG) n'a été fixée.
