# Bob Pro — espace cabinet web

## Surface et hiérarchie

- Coque desktop : rail latéral marine de 236 px, barre supérieure simple, espace de travail ouvert.
- Vues : portefeuille des dossiers, import FEC, détail de révision, lettre de mission.
- Modèle de conteneur : une table dense pour le portefeuille ; des panneaux fonctionnels pour le dossier ; formulaire + feuille A4 pour la lettre. Pas de grille de cartes décorative.
- Premier niveau de lecture : action courante, résultat des contrôles, prochain travail à faire.

## Tokens locaux

- `--canvas`: `#eff2f7`
- `--surface`: `#ffffff`
- `--ink`: `#0f2235`
- `--navy`: `#0c2340`
- `--muted`: `#607086`
- `--line`: `#d6deea`
- `--success`: `#0e7c5a`
- `--warning`: `#c77a12`
- `--danger`: `#c8463c`
- `--indigo`: `#4338ca`
- Rayon principal : 18 px ; contrôles : 10–12 px.
- Ombre : bleutée, diffuse, faible opacité.

## Typographie

- Titres et chiffres : pile locale géométrique (`Avenir Next`, `Segoe UI`, sans-serif).
- Corps et contrôles : pile système lisible.
- Chiffres financiers : `font-variant-numeric: tabular-nums`.
- Densité volontairement élevée : corps 13–15 px, libellés 11–12 px, titres 28–36 px.

## Familles de composants

- Navigation latérale avec état actif et repli mobile.
- Boutons primaire, secondaire et danger ; focus visible systématique.
- Zone de dépôt accessible au clavier, état `drag-active`, erreurs contextualisées.
- Tableau de production responsive : table desktop, lignes structurées mobile.
- Bande de confiance locale permanente.
- Contrôles comptables `ok`, `attention`, `anomalie`, sans emoji.
- Feuille de lettre imprimable en A4, signatures et disclaimer conservés à l'impression.

## Interactions

- Importer un FEC ouvre le sélecteur ou accepte le drag & drop, puis demande uniquement l'identité absente du fichier.
- Un SIREN existant met à jour le dossier, sans doublon.
- Aucun FEC brut n'est persisté ; seules les synthèses dérivées et les préférences fiscales restent dans `localStorage`.
- Les suppressions demandent confirmation ; les imports JSON sont validés avant mutation.
- Le fonctionnement principal ne déclenche aucune requête réseau.

## Références acceptées

- `cabinet-portfolio-concept.png`
- `cabinet-dossier-concept.png`
- `cabinet-lettre-concept.png`
- `design_handoff_bob_pro/Bob Pro.dc.html` pour la palette, les rayons et le rythme Bob Pro.
