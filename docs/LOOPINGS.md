# Circuits et loopings magnétiques — révision 2

> **Archive.** Les loopings ont été retirés du jeu le 9 octobre 2026 (branche `feat/track-relief-perf`) : modules, physique, éditeur et tests. Ce document décrit l'état précédent. Voir [RELIEF_PERF_PROGRESS.md](RELIEF_PERF_PROGRESS.md).

Les douze tracés ont été redessinés. Les distances restent compatibles avec des courses courtes : 628 à 711 m pour les six premiers, 1 150 à 1 285 m pour les six grands circuits. Les routes sont fermées, sans croisement au sol ; douze portes ordonnées valident chaque tour.

| Circuit | Silhouette et rythme |
| --- | --- |
| Île des Alizés | Petit tour côtier asymétrique, deux courbes ouvertes et une sortie diagonale. |
| Canyon solaire | Coude intérieur progressif et remontée entre deux bras du canyon. |
| Banquise boréale | Pointe arrondie au sud, longue diagonale glissante et grande courbe de retour. |
| Métropole néon | Périmètre urbain arrondi, lignes droites et angles lisibles. |
| Mangrove sinueuse | Deux baies et une succession de changements de direction. |
| Dunes de cuivre | Circuit étiré, lignes droites et deux grands demi-tours. |
| Caldeira ardente | Croissant autour du cratère, approche rentrante, pont et saut. |
| Forêt des géants | Deux lobes reliés par un passage sinueux, pont de bois et racines. |
| Port des cargos | Rectangle allongé des quais, grandes lignes droites et pont métallique. |
| Archipel céleste | Aile asymétrique, looping magnétique de 32 m, deux ponts et tremplin. |
| Fonderie des pistons | Tracé en coude, looping magnétique de 27 m et rampe déplacée sur une sortie dégagée. |
| Citadelle royale | Remparts à deux renfoncements, grandes cours arrondies et pont de pierre. |

Chaque circuit conserve sa déviation, sa voie turbo et son raccourci. Les 36 branches sont recalculées pour les nouveaux tracés ; leurs raccords suivent les tangentes de la route et les raccourcis réduisent réellement la distance. Les boucles et leurs huit mètres de raccord restent exclus des branches. Les tremplins disposent toujours d'un corridor d'atterrissage de 55 m.

## Contrat de simulation

`shared/track-loop.ts` transforme une coordonnée de route en pose 3D déterministe (`x/y/z`, `tangent`, `right`, `up`, `speedScale`). La progression logique reste monotone : elle sert aux checkpoints, au classement, aux commandes et à la prédiction. La pose se replie au-dessus de la route et retourne réellement le kart au sommet. Les deux côtés de la boucle sont décalés latéralement ; le dévers garde le ruban large sans replier son bord intérieur.

`Kart.loopId` enregistre l'adhésion sur le serveur. La conversion `speedScale` tient compte de la longueur physique de la piste, et la composante verticale de sa tangente ajoute une variation de vitesse gravitaire. Le rail est magnétique : le joueur peut freiner, s'arrêter, repartir ou faire marche arrière même au plafond. Il n'exige donc pas une vitesse minimale cachée. L'entrée se fait par les raccords bas ; passer sous la boucle n'accroche pas le kart à son sommet.

Les collisions de karts engagés utilisent leur séparation 3D et projettent l'impulsion sur la piste. Les objets suivent la métrique de la boucle ; leur collision balayée inclut la hauteur. Un objet sur le rail supérieur ne touche pas un kart au sol. Le bouton de remise en piste conserve le checkpoint et les tours validés.

Le rendu utilise la même base 3D pour le kart, le ruban, les rails et les objets. Blender et aucune dépendance supplémentaire ne sont nécessaires.

## Vérifications automatisées

- `tests/loops.test.ts` : deux boucles, raccords continus, sommet inversé, bases orthonormées, bords non repliés, branches séparées, passage complet en commandes ordinaires, prédiction identique, arrêt/reprise/reverse, remise en piste et séparation des hauteurs pour les objets.
- `tests/tracks.test.ts` : douze tracés fermés, espacements, huit pilotes avec objets, tours ordonnés, ponts, tremplins et atterrissages.
- `tests/events.test.ts` : 36 branches, courses à huit pilotes avec fermeture commune et gain de temps réel des raccourcis.
- Les tests de tours, de murs, de sauts, d'objets et de récupération CPU restent utilisés.

Exécution du 7 octobre 2026 : **266 tests réussis dans la suite complète d'intégration**, dont les huit cas propres aux loopings. La fixture de récupération CPU calcule désormais le barrage et sa porte depuis le circuit courant ; elle ne dépend plus des anciennes coordonnées fixes de Néon. Le rapport global figure dans `VALIDATION.md`.

Les courses à huit pilotes ordinaires terminent les douze circuits. Pour Sky : 115,50 s de simulation en course classique et 122,80 s avec événements ; pour Foundry : 107,47 s et 115,10 s. Les contrôles de branches mesurent toujours un gain de temps réel des raccourcis, avec les mêmes commandes modérées sur la route principale et la branche.

La course publique via le tunnel a également réussi : quatre pilotes SDK en commandes ordinaires et deux navigateurs indépendants, dont un profil tactile 390 × 844. Les quatre pilotes passent réellement à l'envers, sautent et terminent les trois tours ; hauteur maximale observée : 32 m. Les six connexions présentent le même classement et le replay commun de révision 2 contient 603 images par pilote. Le rapport est `docs/mobile-scenes-public-race.json` ; il ne contient aucune erreur JavaScript ou de chargement. Les deux navigateurs ont chargé une seule fois chacun des trois modèles et le GLB de décor, puis lu et arrêté les deux MP3. Les sessions de test ont été fermées.

Les captures navigateur sont répertoriées dans le rapport de validation principal. L'essai tactile humain sur un téléphone physique et la mesure de fluidité sur son GPU restent à faire : le test réseau utilise Chromium avec rendu logiciel SwiftShader, pas un appareil mobile réel.
