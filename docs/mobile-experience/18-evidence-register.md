# Registre des preuves et verdicts

Statut : **Proposed — initialisé, aucune preuve d'implémentation**
Couverture : **77 lignes sur 77**
Owner de registre attendu : QA owner · **personne à affecter avant Accepted**
Dernière mise à jour : 2026-07-29

> **Amendement A6 — 2026-07-29.** Les amendements A1 à A5 modifient **ce qu'il faut prouver** pour
> `G11` et `G20` (voir la [matrice de traçabilité](15-traceability-matrix.md)), pas **qui** le
> prouve ni **comment** on l'enregistre. Aucune ligne n'est ajoutée, supprimée ou renumérotée : la
> couverture reste **77/77**, tous les verdicts restent `NOT RUN` et tous les owners restent **à
> affecter**. Le format de manifest, les données interdites et la politique de partage sont
> inchangés.

## 1. Rôle

La [matrice de traçabilité](./15-traceability-matrix.md) décrit ce qui doit être prouvé. Ce registre
indique qui le prouve, où se trouve la preuve réelle, pour quel build et avec quel verdict. Il est
la seule autorité de suivi opérationnel ; une capture collée dans un ticket sans ligne mise à jour
ne ferme aucune exigence.

Le stockage normatif est :

`docs/mobile-experience/evidence/<release>/<ID>/manifest.md`

Le format du manifest, les données interdites et la politique de partage sont définis dans
[evidence/README.md](./evidence/README.md). Le mot `release` désigne un identifiant stable de
preview/canary/release, jamais « latest ».

## 2. Statuts et verdicts

| Champ | Valeurs autorisées |
|---|---|
| Statut exigence | `Proposed`, `Accepted`, `In progress`, `Verified`, `Rejected`, `Deferred`, `Superseded` |
| Applicabilité exigence | `Applicable` ou `N/A`, avec décision et justification exigées pour `N/A`. |
| Verdict preuve applicable | `NOT RUN`, `PASS`, `PASS-LIMITED`, `FAIL`, `BLOCKED` |
| Owner | Personne nommée, pas seulement une équipe ou un rôle. |
| Reviewers | Personnes/date ; QA toujours, plus owner métier/Design/A11y/Bob/Security selon applicabilité. |
| Waiver | ID, approbateurs, preuve compensatoire et date d'expiration ; interdit pour P0/P1 ou bloqueur automatique. |

`PASS-LIMITED` est l'abréviation de `PASS WITH ACCEPTED LIMITATION` définie dans la DoD. `N/A`
est une valeur d'applicabilité, jamais un verdict. Elle n'est permise qu'après application de la
matrice DoD et ne peut pas rendre `Verified` une exigence non exécutée. Une ligne `Verified` doit
être `Applicable` et posséder manifest, build/commit/flags, verdict `PASS` ou `PASS-LIMITED`,
reviewers et date. Une exigence `N/A` conserve son ID et prend une disposition `Deferred` ou
`Rejected` signée.

## 3. Registre initial

Toutes les lignes sont volontairement non exécutées. L'absence d'owner est visible et bloque leur
passage à `Accepted`.

| ID | Owner nommé | Statut | Applicabilité | Manifest de preuve | Commit · build · flags | Verdict · date | Reviewers | Waiver · expiration |
|---|---|---|---|---|---|---|---|---|
| G01 | À affecter | Proposed | Applicable | — | — | NOT RUN | — | — |
| G02 | À affecter | Proposed | Applicable | — | — | NOT RUN | — | — |
| G03 | À affecter | Proposed | Applicable | — | — | NOT RUN | — | — |
| G04 | À affecter | Proposed | Applicable | — | — | NOT RUN | — | — |
| G05 | À affecter | Proposed | Applicable | — | — | NOT RUN | — | — |
| G06 | À affecter | Proposed | Applicable | — | — | NOT RUN | — | — |
| G07 | À affecter | Proposed | Applicable | — | — | NOT RUN | — | — |
| G08 | À affecter | Proposed | Applicable | — | — | NOT RUN | — | — |
| G09 | À affecter | Proposed | Applicable | — | — | NOT RUN | — | — |
| G10 | À affecter | Proposed | Applicable | — | — | NOT RUN | — | — |
| G11 | À affecter | Proposed | Applicable | — | — | NOT RUN | — | — |
| G12 | À affecter | Proposed | Applicable | — | — | NOT RUN | — | — |
| G13 | À affecter | Proposed | Applicable | — | — | NOT RUN | — | — |
| G14 | À affecter | Proposed | Applicable | — | — | NOT RUN | — | — |
| G15 | À affecter | Proposed | Applicable | — | — | NOT RUN | — | — |
| G16 | À affecter | Proposed | Applicable | — | — | NOT RUN | — | — |
| G17 | À affecter | Proposed | Applicable | — | — | NOT RUN | — | — |
| G18 | À affecter | Proposed | Applicable | — | — | NOT RUN | — | — |
| G19 | À affecter | Proposed | Applicable | — | — | NOT RUN | — | — |
| G20 | À affecter | Proposed | Applicable | — | — | NOT RUN | — | — |
| G21 | À affecter | Proposed | Applicable | — | — | NOT RUN | — | — |
| G22 | À affecter | Proposed | Applicable | — | — | NOT RUN | — | — |
| V01 | À affecter | Proposed | Applicable | — | — | NOT RUN | — | — |
| V02 | À affecter | Proposed | Applicable | — | — | NOT RUN | — | — |
| V03 | À affecter | Proposed | Applicable | — | — | NOT RUN | — | — |
| V04 | À affecter | Proposed | Applicable | — | — | NOT RUN | — | — |
| V05 | À affecter | Proposed | Applicable | — | — | NOT RUN | — | — |
| V06 | À affecter | Proposed | Applicable | — | — | NOT RUN | — | — |
| V07 | À affecter | Proposed | Applicable | — | — | NOT RUN | — | — |
| V08 | À affecter | Proposed | Applicable | — | — | NOT RUN | — | — |
| V09 | À affecter | Proposed | Applicable | — | — | NOT RUN | — | — |
| V10 | À affecter | Proposed | Applicable | — | — | NOT RUN | — | — |
| V11 | À affecter | Proposed | Applicable | — | — | NOT RUN | — | — |
| V12 | À affecter | Proposed | Applicable | — | — | NOT RUN | — | — |
| V13 | À affecter | Proposed | Applicable | — | — | NOT RUN | — | — |
| V14 | À affecter | Proposed | Applicable | — | — | NOT RUN | — | — |
| S01 | À affecter | Proposed | Applicable | — | — | NOT RUN | — | — |
| S02 | À affecter | Proposed | Applicable | — | — | NOT RUN | — | — |
| S03 | À affecter | Proposed | Applicable | — | — | NOT RUN | — | — |
| S04 | À affecter | Proposed | Applicable | — | — | NOT RUN | — | — |
| S05 | À affecter | Proposed | Applicable | — | — | NOT RUN | — | — |
| S06 | À affecter | Proposed | Applicable | — | — | NOT RUN | — | — |
| S07 | À affecter | Proposed | Applicable | — | — | NOT RUN | — | — |
| S08 | À affecter | Proposed | Applicable | — | — | NOT RUN | — | — |
| S09 | À affecter | Proposed | Applicable | — | — | NOT RUN | — | — |
| S10 | À affecter | Proposed | Applicable | — | — | NOT RUN | — | — |
| S11 | À affecter | Proposed | Applicable | — | — | NOT RUN | — | — |
| S12 | À affecter | Proposed | Applicable | — | — | NOT RUN | — | — |
| S13 | À affecter | Proposed | Applicable | — | — | NOT RUN | — | — |
| S14 | À affecter | Proposed | Applicable | — | — | NOT RUN | — | — |
| S15 | À affecter | Proposed | Applicable | — | — | NOT RUN | — | — |
| S16 | À affecter | Proposed | Applicable | — | — | NOT RUN | — | — |
| S17 | À affecter | Proposed | Applicable | — | — | NOT RUN | — | — |
| S18 | À affecter | Proposed | Applicable | — | — | NOT RUN | — | — |
| S19 | À affecter | Proposed | Applicable | — | — | NOT RUN | — | — |
| S20 | À affecter | Proposed | Applicable | — | — | NOT RUN | — | — |
| S21 | À affecter | Proposed | Applicable | — | — | NOT RUN | — | — |
| S22 | À affecter | Proposed | Applicable | — | — | NOT RUN | — | — |
| S23 | À affecter | Proposed | Applicable | — | — | NOT RUN | — | — |
| S24 | À affecter | Proposed | Applicable | — | — | NOT RUN | — | — |
| S25 | À affecter | Proposed | Applicable | — | — | NOT RUN | — | — |
| S26 | À affecter | Proposed | Applicable | — | — | NOT RUN | — | — |
| S27 | À affecter | Proposed | Applicable | — | — | NOT RUN | — | — |
| S28 | À affecter | Proposed | Applicable | — | — | NOT RUN | — | — |
| S29 | À affecter | Proposed | Applicable | — | — | NOT RUN | — | — |
| S30 | À affecter | Proposed | Applicable | — | — | NOT RUN | — | — |
| S31 | À affecter | Proposed | Applicable | — | — | NOT RUN | — | — |
| S32 | À affecter | Proposed | Applicable | — | — | NOT RUN | — | — |
| S33 | À affecter | Proposed | Applicable | — | — | NOT RUN | — | — |
| T01 | À affecter | Proposed | Applicable | — | — | NOT RUN | — | — |
| T02 | À affecter | Proposed | Applicable | — | — | NOT RUN | — | — |
| T03 | À affecter | Proposed | Applicable | — | — | NOT RUN | — | — |
| T04 | À affecter | Proposed | Applicable | — | — | NOT RUN | — | — |
| T05 | À affecter | Proposed | Applicable | — | — | NOT RUN | — | — |
| T06 | À affecter | Proposed | Applicable | — | — | NOT RUN | — | — |
| T07 | À affecter | Proposed | Applicable | — | — | NOT RUN | — | — |
| T08 | À affecter | Proposed | Applicable | — | — | NOT RUN | — | — |

## 4. Règles de mise à jour

1. Le Product owner accepte le scope ; l'owner nommé passe la ligne à `Accepted`.
2. Le WP démarre ; la ligne passe à `In progress` et le chemin du manifest est créé.
3. Chaque preuve indique exactement commit, build, plateforme, appareil, scénario, fixture et flags.
4. Les reviewers signent le manifest ; le registre reçoit le verdict et la date.
5. `Verified` n'est permis que si la DoD applicable est fermée et le verdict admissible.
6. Un nouveau build invalidant la preuve repasse la ligne à `In progress` ou `BLOCKED`.
7. Une exigence différée ou rejetée reste dans le registre avec décision liée ; elle n'est jamais
   supprimée du total historique 77/77.
8. `GATE-ROLLOUT-READY` autorise `WP-0010-01` après contrôle automatique et revue humaine du
   registre ; `WP-0010-01` produit ensuite les preuves nécessaires à `GATE-GLOBAL`.
9. `WP-0010-02` ne démarre qu'après `GATE-GLOBAL` et ferme le registre après R4 et sa fenêtre de
   surveillance ; aucun de ces passages ne peut être auto-déclaré par l'implémenteur seul.
