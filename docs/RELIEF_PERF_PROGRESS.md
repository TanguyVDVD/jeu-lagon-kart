# Relief, circuits et performances — journal de reprise

Branche : `feat/track-relief-perf` (rien n'est commité). État au **9 octobre 2026**.

## État vérifié

| Contrôle | Résultat |
| --- | --- |
| Tests avant modification (`main`) | 492/492 |
| Tests après | **467/467**, aucun ignoré (`node --import tsx --test --test-concurrency=4 tests/*.test.ts`) |
| `npx tsc --noEmit` (sources, tests, scripts) | aucune erreur |
| `npm run build` | réussi |
| Serveur compilé + `scripts/network-check.ts`, 4 clients | réussi : course complète, reconnexion, revanche |
| Serveur compilé + `scripts/tournament-check.ts`, 4 clients | réussi : tournoi de quatre courses (lagon, canyon, glacier, neon) |
| Rendu 3D réel (Chromium, rendu logiciel) | les 12 circuits et Spa regardés : vue d'ensemble et vues embarquées, image fixe |
| Navigateur réel, téléphone, Docker, tunnel | **non testé** |
| Scripts de bout en bout Playwright (`test:browser`, `test:ux-editor`…) | **non lancés** (voir Outils) |

Le nombre de tests baisse de 492 à 467 : trois fichiers dédiés aux loopings sont supprimés, et un test d'exactitude plus des tests de relief sont ajoutés.

## Ce qui a changé

### Loopings supprimés
- Retirés du modèle de piste, de la simulation, des combos, de l'éditeur et du catalogue. `shared/track-loop.ts` et `client/track-loops.ts` n'existent plus.
- Un brouillon enregistré avec des loopings se charge toujours : le champ est ignoré.
- `data/tracks/` contient deux versions de « Mon grand ovale » avec loopings : leur route est plate à ces endroits.
- La géométrie des autres créations est inchangée, vérifié par empreinte (`tests/custom-tracks.test.ts`).

### Relief
- `shared/track.ts` : champ `relief` (points `[fraction du tour, hauteur]`). Le sol est plat à chaque point et progressif entre deux ; la grille de départ est toujours plate.
- Ponts, tremplins et croisements s'ajoutent au relief. Hors piste, le sol est à la hauteur du relief.
- Conduite : une montée retire jusqu'à 6 % de vitesse de pointe, une descente la rend. Les turbos gardent leur plafond.
- `TRACK_LAYOUT_REVISION` passe à 3 : **anciens fantômes, replays et meilleurs temps sont archivés.**

### Virages inclinés
- `trackBank` et `shared/road-pose.ts`. **Affichage uniquement** : la simulation garde une route plate en travers.
- Circuits officiels seulement ; nul sur les ponts et les tremplins.

### Les 12 circuits
| Circuit | Longueur | Relief max. | Pente max. | Raccourci |
| --- | --- | --- | --- | --- |
| lagon | 829 m | 6 m | 6,0 % | −14 % |
| canyon | 1 269 m | 12 m | 5,2 % | −14 % |
| glacier | 1 034 m | 9 m | 5,8 % | −16 % |
| neon | 1 079 m | 5 m | 3,5 % | −32 % |
| mangrove | 1 166 m | 3,5 m | 2,3 % | −32 % |
| dunes | 1 067 m | 8 m | 9,8 % | −26 % |
| volcan | 1 435 m | 16 m | 7,0 % | −21 % |
| forest | 1 505 m | 11 m | 4,3 % | −24 % |
| harbor | 1 434 m | 5 m | 3,5 % | −29 % |
| sky | 1 382 m | 10 m | 6,0 % | −20 % |
| foundry | 1 375 m | 8 m | 6,2 % | −8 % |
| castle | 1 285 m | 14 m | 7,3 % | −18 % |

Les circuits sont plus longs qu'avant (628 à 1 285 m) : une course dure plus longtemps. Huit CPU terminent les trois tours de chaque circuit, sans événements comme au niveau 3 ; au niveau 3, aucun n'a besoin de se remettre en piste.

### Embranchements (`shared/track-events.ts`)
- Un embranchement quitte la route une fois et y revient une fois, sans la retraverser.
- Déviation et raccourci partent de côtés opposés ; la déviation est une vraie route séparée sur au moins 30 % de son parcours.
- Aucun embranchement ne passe sur un pont ni un tremplin.
- Gain d'un raccourci plafonné à 34 %.
- Là où un embranchement recouvre la route, il a la même hauteur qu'elle (plus de marche sur une pente).
- Nouveau générateur `bypass` (voie parallèle) en plus de la corde de Bézier.

### Maillage de la route — bug des virages serrés
- Cause mesurée sur Spa : 71 points où le rayon est inférieur à la demi-largeur (minimum 1,8 m pour 20 m de large) ; le ruban se repliait sur lui-même.
- `client/road-mesh.ts` : les bords repliés se rejoignent en un point, glissières continues, marquages masqués là où une autre portion de route passe, talus vers le terrain.
- Vérifié à l'image sur les épingles de Spa.

### Terrain et décor
- `client/scenery-terrain.ts` : l'île suit le relief, maillage plus fin sur les circuits vallonnés, décor posé sur les collines.
- Aux embranchements : plus de plots sur les voies de la route principale, plus de liseré qui dépasse de la chaussée.

### Performances
Simulation mesurée (8 CPU, 63 s simulées, médiane de 5 passes, même machine) :

| Scénario | Avant | Après |
| --- | --- | --- |
| lagon, sans événements | 1 463 µs / pas | 338 µs / pas |
| lagon, événements niveau 3 | 1 243 µs / pas | 520 µs / pas |
| forest, événements niveau 3 | 1 333 µs / pas | 515 µs / pas |
| Spa (création) | 730 µs / pas | 366 µs / pas |

Les circuits « après » sont plus longs que ceux « avant » ; seul Spa est strictement identique des deux côtés. Ce code tourne aussi dans le navigateur pour la prédiction.

- Recherche du point de route le plus proche par grille ; résultat identique au balayage complet (`tests/nearest-track.test.ts`).
- Les embranchements trop loin d'une position ne sont plus parcourus.
- Les glissières sont reconstruites seules quand un raccourci s'ouvre (avant : toute l'île à chaque changement de phase).
- Carte d'ombres rafraîchie une image sur deux en course, une sur vingt dans le menu.

**Non mesuré : le débit d'images.** Le rendu logiciel utilisé pour les captures ne dit rien d'une vraie carte graphique. Le terrain vallonné ajoute des triangles (31 000 à 64 000 par image selon le circuit et la vue).

## Reste à faire

1. **Jouer dans un vrai navigateur** (`npm run dev`), au clavier et sur téléphone : sensation des pentes, lisibilité des épingles, débit d'images.
2. Les captures sont des images fixes à deux ou trois endroits par circuit : un défaut local (terrain qui affleure, décor mal posé) peut subsister ailleurs.
3. La « rivière » de lave ou d'eau sous les ponts est un rectangle plat posé sur la colline : à redessiner.
4. Lancer les scripts de bout en bout Playwright. `editor-features-browser-check`, `ux-editor-browser-check`, `public-editor-presence-check` et `scenes-browser-check` ont été adaptés sans pouvoir être exécutés.
5. Équilibrage : les raccourcis de neon et mangrove gagnent 32 %.
6. Relief dans l'éditeur de circuits : non fait.
7. `docs/CIRCUITS.md`, `CIRCUITS_APPENDIX.md`, `DEMO.md`, `SCENERY.md` et `VALIDATION.md` décrivent encore les anciens tracés ; `docs/LOOPINGS.md` est marqué comme archive.

## Outils

- `node --import tsx scripts/track-design-plan.ts [id]` : mesures par circuit et plan dans `test-results/track-plan.html`.
- `node --import tsx scripts/track-view-check.ts [id …] [--shots=overview,0.1,0.5] [--stage=2 --level=3]` : captures du vrai moteur de rendu dans `test-results/track-views/`. Une création s'adresse par son nom de fichier dans `data/tracks/`.
- Playwright attend Chromium 1208 ; cette machine a la 1243. Soit `npx playwright install chromium`, soit, pour `track-view-check` seulement, `CHROMIUM_PATH=%LOCALAPPDATA%/ms-playwright/chromium-1243/chrome-win64/chrome.exe`.
- Node installé : 20.10 (le projet demande 20.19) ; tests et build fonctionnent.
