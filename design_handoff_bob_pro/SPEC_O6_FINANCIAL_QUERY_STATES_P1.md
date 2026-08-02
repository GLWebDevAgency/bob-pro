# O6 — États financiers fail-closed après PR #56

Date : 2026-08-02
Objectif parent : `O6 — Zéro donnée fabriquée en production`
Statut : `implemented`

## Pourquoi

La PR #56 a amélioré la présentation d'un solde absent ou périmé, mais elle a aussi laissé des
chemins où une donnée TanStack Query mise en cache reste affichée comme nominale après un échec de
requalification. Elle assimile également des erreurs d'intégrité à une simple demande de
confirmation. Ces deux comportements contredisent l'invariant publication §4.5 :
`missing/error => unavailable`, jamais un montant crédible.

## Périmètre

- Écrans mobile `Aujourd'hui` et `Argent`.
- Classification pure des erreurs de prérequis bancaire.
- Cohérence entre le solde qualifié, la provenance de projection et les priorités agrégées.
- Consommation réutilisable du deep-link `confirmBalance`.
- Libellés i18n et état accessible du squelette de solde.
- Tests de rendu et de logique ciblés.

## Hors périmètre

- Aucun changement de calcul financier, de politique de fraîcheur ou d'API.
- Aucun changement de schéma ou de migration.
- Aucune refonte visuelle des écrans.
- Aucune donnée de repli, locale ou inventée.

## Invariants

1. Une query en erreur ne fournit jamais de donnée nominale, même si TanStack conserve une valeur
   antérieure dans `data`.
2. Seuls `bank-balance-stale`, l'absence exacte de `bank_balance_snapshot` et le prérequis explicite
   `cashflow-banking-source` sont des entrées bancaires attendues.
3. `bank-balance-tenant-scope`, `bank-balance-qualification` et toute erreur inconnue restent des
   incidents fail-closed.
4. Un message d'erreur affiché décrit une cause ayant réellement déclenché l'état d'erreur courant.
5. Un deep-link consommé ne bloque pas une seconde demande de confirmation dans la même session.
6. Pendant le chargement, l'accessibilité annonce un chargement occupé, jamais une absence de solde
   non encore établie.
7. Une projection cashflow ne devient affichable qu'après qualification du solde ; un succès
   `bankingSource: none` ne peut pas fabriquer des KPI à zéro pendant le chargement ou après le 404.
8. Un signal cashflow exact `bank-balance-stale` invalide immédiatement tout solde bancaire mis en
   cache, même si le refetch du GET solde n'a pas encore exposé sa propre erreur.
9. `bankingSource: none` est un état sans projection qualifiée : avec un solde absent il conduit au
   parcours de confirmation ; avec un solde qualifié il révèle une incohérence et échoue fermé.
10. L'état vide « Rien d'urgent » n'est affichable qu'après réussite et snapshot défini de toutes
    les sources qui composent `allPriorities`, notamment les priorités serveur et les contrats de
    maintenance.
11. Chaque CTA de reprise visible sur les deux écrans reçoit son libellé du catalogue i18n ; un
    composant partagé ne décide jamais lui-même d'une chaîne française.
12. Une agrégation partiellement chargée peut conserver les cartes prouvées par une source saine,
    mais elle n'annonce jamais un compteur exhaustif tant que toutes ses sources ne sont pas prêtes.

## Critères d'acceptation binaires

- [x] Avec `isError=true` et une ancienne donnée bancaire/cashflow en cache, aucun montant issu de
      cette query n'est rendu comme disponible sur Aujourd'hui ou Argent.
- [x] Les erreurs `bank-balance-tenant-scope` et `bank-balance-qualification` n'ouvrent pas le parcours
      de confirmation ; les trois entrées attendues exactes continuent de l'ouvrir.
- [x] Deux navigations successives avec `confirmBalance` rouvrent la feuille sans remonter l'écran.
- [x] L'état d'erreur Aujourd'hui n'affiche jamais le code d'une erreur bancaire attendue si une
      autre query est la cause réelle de l'échec.
- [x] Le CTA de reprise utilise le catalogue `@bob/i18n` pour les trois personnalités.
- [x] Le placeholder de solde expose un libellé neutre et `accessibilityState.busy=true`, puis le
      message d'absence seulement après résolution.
- [x] La course « cashflow zéro servi avant le GET solde » reste en skeleton, puis le couple
      `bank-balance 404 + cashflow bankingSource:none` ouvre la confirmation sans ErrorRetry.
- [x] Un cache solde encore nominal est masqué dès qu'un cashflow signale
      `bank-balance-stale`, avant même la résolution du refetch solde.
- [x] Un cashflow réussi `bankingSource:none` n'affiche jamais de projection : avec un solde
      nominal, Aujourd'hui et Argent rendent une récupération fail-closed et aucun montant.
- [x] `contracts.isLoading` ou l'absence de snapshot maintient les priorités en skeleton ;
      `contracts.isError`, même avec un ancien tableau en cache, rend une erreur honnête et jamais
      « Rien d'urgent ».
- [x] Un briefing partiel conserve ses priorités connues sans afficher « N restants » comme un
      total exhaustif.
- [x] Les CTA `ErrorRetry` d'Aujourd'hui et Argent utilisent eux aussi les libellés i18n des trois
      personnalités, sans chaîne française décidée dans la primitive UI.

## Preuves locales du commit candidat

- Suites complètes : `@bob/mobile`, `@bob/ui` (440 tests) et `@bob/i18n` (112 tests) vertes.
- Typechecks : `@bob/mobile`, `@bob/ui` et `@bob/i18n` verts.
- ESLint ciblé sur chaque fichier TypeScript/TSX du lot : vert.
- `git diff --check` : vert.
- Revue adversariale lecture seule : approuvable, aucun P0/P1 ouvert.

## Definition of Done

- Tests unitaires des classifieurs, de la dérivation de confirmation et de la consommation du
  deep-link.
- Tests de rendu Aujourd'hui, Argent et primitives UI couvrant tous les critères ci-dessus.
- Typecheck `apps/mobile`, `packages/ui` et `packages/i18n` vert.
- Lint et suites ciblées verts depuis un checkout propre du commit candidat.
- Revue adversariale lecture seule ; aucun P0/P1 ouvert.
- PR unique, CI exacte verte, puis fusion avant d'ouvrir le chantier suivant.
