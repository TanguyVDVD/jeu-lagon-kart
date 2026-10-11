# Objets mystères

Les cubes marqués « ? » distribuent huit outils originaux. Ils utilisent les
géométries Three.js du projet : aucun asset, son, personnage ou modèle Nintendo,
aucun téléchargement supplémentaire et aucune dépendance payante.

| Objet | Effet | Durée / charges |
| --- | --- | --- |
| Turbo | Accélération habituelle, vitesse maximale de 46 m/s sur route | 2,2 s |
| Triple turbo | Trois accélérations déclenchées séparément avec E | 3 × 1,65 s |
| Balise piège | Obstacle déposé derrière le kart, sans toucher son propriétaire | 18 s au maximum |
| Disque vert | Projectile droit, interceptable par un adversaire | 62 m/s, 4 s |
| Fusée rouge | Suit le pilote le plus proche devant au classement validé | 64 m/s, 9 s |
| Comète bleue | Suit le premier pilote actif devant son propriétaire et change de cible si le leader change ; traverse les autres pilotes | 82 m/s, 18 s |
| Étoile d’énergie | Annule l’étourdissement, protège des objets et des contacts, déclenche un turbo ; traverse les karts et étourdit les adversaires touchés | 5,5 s |
| Bouclier | Absorbe un impact, puis disparaît | 8 s maximum |

Les ralentissements du circuit et le frein restent actifs pendant les turbos et
l’étoile. Utiliser un turbo pendant un autre rafraîchit sa durée sans additionner
les durées. Chaque charge du triple turbo exige une nouvelle pression ; garder E
enfoncé n’épuise pas les charges. L’inventaire reste occupé jusqu’à la troisième.

## Tirages et impacts

Le serveur tire un objet quand un pilote connecté, actif et sans objet traverse
un cube disponible. Le cube se recharge après 4 s. Aucun nouveau tirage ne peut
écraser l’objet tenu, y compris les charges restantes du triple turbo.

Pendant les 6 premières secondes de course, le peloton est encore groupé : un
cube ne donne alors qu’un turbo (60 %) ou un bouclier (40 %). Quand un événement
barre la route principale, les rangées de cubes de ce tronçon passent sur la
déviation en conservant leur recharge ; aucune rangée n’est posée dans la
trajectoire d’un saut.

Poids en pourcentage, dans l’ordre de la table ci-dessus :

| Situation | Turbo | Triple | Piège | Disque | Rouge | Bleue | Étoile | Bouclier |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Aucun adversaire devant, dont solo | 35 | 10 | 20 | 20 | 0 | 0 | 3 | 12 |
| Partie avant du peloton | 22 | 18 | 12 | 15 | 18 | 5 | 5 | 5 |
| Moitié arrière du peloton | 12 | 25 | 5 | 8 | 18 | 12 | 14 | 6 |

La position dépend de la progression validée aux checkpoints, tours compris.
Les spectateurs, arrivés, abandons et pilotes déconnectés sont exclus des cibles.
Une fusée rouge disparaît si sa cible devient indisponible. La comète bleue
recherche alors le nouveau leader admissible. S’il n’existe aucune cible au
moment d’utiliser une fusée ou une comète conservée en inventaire, elle devient
un petit turbo de 1,2 s. Les objets déjà lancés expirent normalement même si leur
propriétaire quitte la course.

Un impact ordinaire étourdit pendant 1,05 s, réduit la vitesse à 20 % et interrompt
le turbo et la charge de drift. Une protection de 1,7 s contre les impacts répétés
évite les enchaînements immédiats ; un bouclier absorbé protège encore 0,6 s. Les
objets touchant une protection disparaissent. La détection balaie tout le trajet
du projectile dans un tick, pour ne pas traverser un kart entre deux positions.

Il peut exister au maximum 32 objets simultanés et quatre par propriétaire. Les
plus anciens sont retirés si nécessaire. Les projectiles guidés suivent des
points du circuit puis visent directement une cible proche. Ils restent des
armes esquivables/interceptables ; aucune téléportation ou modification du
classement n’est utilisée pour garantir un impact.

## Rendu et réseau

Le HUD affiche le nom, une couleur et un pictogramme distincts, les charges du
triple turbo, l’action de E et les secondes de protection restantes. L’étoile
ajoute trois étoiles orbitantes et un anneau jaune ; le bouclier une bulle cyan.
Ces effets sont des objets séparés. Ils ne modifient aucun matériau partagé du
modèle GLB du kart et leurs géométries restent partagées entre joueurs.

Les nouveaux champs diffusés dans les snapshots sont `itemCharges`, `invincible`,
`shield`, `hitGrace`, et `targetId` pour les projectiles guidés. Le protocole de
commande reste inchangé : seuls les contrôles de conduite sont acceptés.
L’inventaire, les cibles, les impacts et les tirages appartiennent à `stepWorld`
côté serveur. `stepKart` décrémente les temporisations de manière déterministe
pour conserver la prédiction locale. Une nouvelle course réinitialise tous ces
champs ; un abandon enlève également les protections et l’inventaire.

## Validation exécutée

Le 6 octobre 2026 : `npm run typecheck` et `npm test` réussis ; **63 tests passent**,
dont 13 tests d’objets nouveaux et les tests HTTP/Colyseus existants enrichis pour
refuser la falsification des objets, charges et protections. Les suites font
terminer trois tours à huit pilotes avec les objets actifs sur les quatre
circuits. Les cas de cible déconnectée/arrivée, changements de leader, tours
différents, absorption des impacts, expiration, charge maintenue, plafonds et
reproductibilité sont couverts dans `tests/items.test.ts`.

La validation navigateur des commandes E, du HUD et des durées fait l’objet du
script `scripts/items-browser-check.ts`, exécuté séparément sur un serveur privé
de test. Les résultats de cette validation et des courses publiques figurent
dans le rapport de livraison principal. Le ressenti d’équilibrage avec huit
personnes et les performances sur leurs GPU restent à essayer pendant la démo.
