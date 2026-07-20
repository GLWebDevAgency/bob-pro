# Bob Pro — espace cabinet web

## Surface et hiérarchie

- Coque desktop : rail latéral marine de 236 px, barre supérieure simple, espace de travail ouvert.
- Vues : portefeuille des dossiers, import FEC, détail de révision, lettre de mission.
- Modèle de conteneur : une table dense pour le portefeuille ; des panneaux fonctionnels pour le dossier ; formulaire + feuille A4 pour la lettre. Pas de grille de cartes décorative.
- Premier niveau de lecture : action courante, résultat des contrôles, prochain travail à faire.

## Source unique des tokens

- Aucune palette web locale : `@bob/tokens` est l’unique source de couleurs, rayons,
  profondeurs et thèmes.
- `packages/tokens/scripts/generate-css.mjs` génère `@bob/tokens/variables.css` ; le layout
  racine l’importe avant les styles de l’application.
- Les alias d’usage (`--canvas`, `--surface`, `--ink`, `--navy`, etc.) référencent uniquement
  les variables `--bob-*` et `--brand-*`. Les dérivations utilisent `color-mix()`.
- Le CTA primaire utilise `--brand-gradient-cta` marine. Le vert `--bob-color-success` reste
  réservé aux états réellement positifs : contrôle conforme, membre actif, opération réussie.
- Les rayons et ombres viennent de `--bob-radius-*` et `--bob-shadow-*`.
- Un test scanne CSS/TS/TSX et refuse tout nouveau littéral hexadécimal ou RGB dans `apps/web`.

## Typographie

- Titres et chiffres : **Schibsted Grotesk**, graisses 700 et 800, auto-hébergée par
  `next/font` au build.
- Corps et contrôles : **Hanken Grotesk**, graisses 500, 600 et 700.
- Chiffres financiers : `font-variant-numeric: tabular-nums`.
- Densité volontairement élevée : corps 13–15 px, libellés 11–12 px, titres 28–36 px.

## Familles de composants

- Navigation latérale avec état actif et repli mobile.
- Authentification Supabase SSR par magic link, callback PKCE, cookies et CSP à nonce. Le
  layout lit les headers de requête pour forcer le rendu dynamique ; le smoke vérifie que
  chaque script Next porte le nonce unique de la réponse.
- Sélection multi-cabinet, équipe, invitations et rôles issus de l’API, jamais du JWT.
- Boutons primaire, secondaire et danger ; focus visible systématique.
- Zone de dépôt accessible au clavier, état `drag-active`, erreurs contextualisées.
- Tableau de production responsive : table desktop, lignes structurées mobile.
- Bande de confiance locale permanente.
- Contrôles comptables `ok`, `attention`, `anomalie`, sans emoji.
- Feuille de lettre imprimable en A4, signatures et disclaimer conservés à l'impression.

## Interactions

- Importer un FEC ouvre le sélecteur ou accepte le drag & drop, puis demande uniquement l'identité absente du fichier.
- Un SIREN existant met à jour le dossier, sans doublon.
- Aucun FEC brut n'est téléversé ; l’analyse structurée validée est persistée dans PostgreSQL,
  isolée par cabinet via RLS et relue uniquement sous une session authentifiée active.
- Les suppressions demandent confirmation et une révision serveur exacte ; les conflits de
  concurrence rechargent la version d’autorité sans copie locale de secours.
- Les jetons d’invitation arrivent en fragment, sont immédiatement déplacés dans un cookie
  `HttpOnly` à TTL court limité à `/auth/invitation`, puis consommés une seule fois par un BFF
  après vérification de session.
- Sans configuration Supabase/API ou sans membership actif, l’Espace Cabinet échoue fermé :
  aucun mode démonstration ni portefeuille local ne remplace la source serveur.

## Références acceptées

- `cabinet-portfolio-concept.png`
- `cabinet-dossier-concept.png`
- `cabinet-lettre-concept.png`
- `@bob/tokens` pour la palette et les composants de marque ; les captures servent uniquement
  de référence visuelle, jamais de seconde source de tokens.
