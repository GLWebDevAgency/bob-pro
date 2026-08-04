# O7 — Isolation déterministe du certificat vocal Ventes

Date : 2026-08-04

Statut : `implemented`

Objectif canonique : O7 — release reproductible

## Constat

Le CI post-merge `main@9eeb542d` (run `30936911786`) a échoué sur un seul test mobile après
2 149 succès : la commande vocale « affiche que les devis » semblait laisser la section Factures
visible. Le code produit filtre bien les deux collections avec le même `kindFilter`.

Le certificat montait plusieurs instances de l'écran sans jamais les démonter. Chaque instance
conserve des effets différés, notamment le debounce de recherche à 250 ms, et republie sa surface
agent à chaque rendu. Avec une capture globale mutable, cette absence d'isolation laisse ouverte
une race entre une ancienne instance et l'instance courante sous contention. Le run CI prouve le
défaut d'isolation observé, mais ne désigne pas un timer particulier comme déclencheur unique.

## Périmètre

- isoler chaque test de `ventes.states.test.tsx` en démontant toutes les instances créées ;
- remettre à zéro la capture de surface agent après le démontage ;
- ne modifier ni l'écran Ventes, ni son matching vocal, ni une donnée de production.

## Invariants

1. La commande vocale et le contrôle tactile continuent de piloter le même `kindFilter`.
2. Aucun renderer, effet ou timer d'un test ne peut survivre au test suivant.
3. Le correctif ne rend pas l'assertion moins stricte et ne repose pas sur un retry CI.
4. La release staging reste bloquée jusqu'au CI complet vert du micro-correctif.

## Critères d'acceptation binaires

- [x] le test ciblé passe de façon répétée (20 processus, 4 en parallèle) ;
- [x] les 16 scénarios du fichier restent exercés, sans skip ni assouplissement ;
- [x] typecheck global, lint global et suite mobile complète passent (198 fichiers, 2 150 tests) ;
- [ ] le CI complet de la PR passe ;
- [ ] le CI post-merge de `main` passe avant la release staging.

## Definition of Done

Une PR atomique, issue de `main`, ne contenant que cette spec et l'isolation du test est revue,
verte, mergée, puis confirmée verte sur le SHA de merge. Aucune production n'est modifiée.

## Preuves locales

- fichier ciblé : 20 exécutions, concurrence 4, 320 scénarios verts ;
- mobile : 198 fichiers et 2 150 tests verts ;
- monorepo : typecheck 17/17, lint 9/9, tests 15/15, build 10/10 ;
- revue adversariale lecture seule : correctif minimal approuvé, aucune modification produit.
