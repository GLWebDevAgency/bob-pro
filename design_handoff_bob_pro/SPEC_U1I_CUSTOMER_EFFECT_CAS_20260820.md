# SPEC U1-i — CAS de l'effet `client-modifier@1`

- **Date** : 2026-08-20
- **Statut normatif** : `specified` — le delta CAS est codé et prouvé localement dans
  `90d55de02` et `aaa6a7750`, mais la gate `implemented` du parent Jarvis §17/§21.2 reste fermée
  tant que l'ancien moteur et ses abstractions exécutables ne sont pas supprimés. Non `certified`,
  non `released` ; manifest runtime vide.
- **Deltas mesurés** : `90d55de02` = 12 fichiers, +683/-127 ; `aaa6a7750` = 1 fichier,
  +201/-4. Aucun de ces deux commits n'appartient au périmètre U1-h.
- **Objectif primaire** : O4 — mission continue et vérité relue jusqu'au résultat.
- **Contraintes** : O6/O7 — vérité métier, concurrence et preuve reproductible.
- **Parents** : `OBJECTIFS_SPECS_DOD_PUBLICATION.md` §4.2/§4.3,
  `SPEC_JARVIS_UNIVERSEL_ORCHESTRATION_20260817.md` §5.3/§7.1/§8/§9.1/§15,
  SPEC U1-e §2 et SPEC U1-f §6/§8.

## 1. Défaut fermé par ce lot

À la baseline `dd953e435`, la proposition serveur scellait déjà la cible et sa révision, et le
worker recalculait le `targetDigest` avant l'autorisation. Ces preuves n'étaient toutefois qu'un
préflight : l'effet relisait ensuite la fiche dans une autre transaction puis appelait un `upsert`
sans révision attendue. Une écriture humaine placée entre ces étapes pouvait être écrasée.
`90d55de02` remplace ce comportement par le CAS décrit ci-dessous.

Cette spec corrige donc deux formulations antérieures :

- la transaction U1-e ferme présentation -> confirmation -> création du work item, mais pas la
  course différée préflight dispatch -> écriture métier ;
- le `targetDigest` U1-f reste une défense utile, mais n'est pas le CAS autoritaire au point
  d'écriture et sa preuve happy-path ne couvre pas une mutation concurrente.

À la baseline, `reconcileEffect(update)` affirmait aussi `safe_to_replay` sans reçu
purpose-specific. `90d55de02` rend désormais `undecidable` et ne réexécute rien ; `aaa6a7750`
prouve cette loi dans le vrai worker après perte du résultat local.

## 2. Contrat CAS unique

La révision attendue provient exclusivement de `state.intent.target.revision`, recoupée avec
`state.proposal.targetRevision` et avec le `targetDigest` du work item. Une valeur fournie par le
mobile, le modèle ou une relecture tardive ne fait jamais autorité.

L'unique écriture autorisée pour l'effet Jarvis de modification est :

```sql
UPDATE customers
SET <postimage validé par Customer.of>, revision = revision + 1
WHERE companyId = :companyId
  AND id = :customerId
  AND revision = :expectedRevision;
```

Règles fermées :

1. `count = 1` est le seul succès ; la révision écrite par cet effet vaut exactement
   `expectedRevision + 1`.
2. `count = 0` rend `revision_conflict` au repository, mappé en
   `target_revision_stale` par l'exécuteur, sans second essai et sans mutation.
3. La cible supprimée n'est jamais recréée : le chemin CAS n'emploie ni `upsert`, ni `create`.
4. Les validations de `UpdateCustomer` et `Customer.of` restent une source unique, partagée par
   l'entrée historique et l'entrée CAS ; il n'existe pas de second use case Jarvis.
5. Une incohérence entre intention, proposition et work item échoue avant toute lecture/écriture
   métier.
6. Une panne après autorisation dont le commit ne peut être prouvé reste `outcome_unknown`.
7. Une reprise d'update autorisée sans résultat persistant rend `undecidable`, jamais
   `safe_to_replay`, et n'appelle pas l'autorité d'écriture.

## 3. Reçu de succès honnête

Le reçu du run décrit la révision produite par CET effet, pas la révision courante au moment où le
worker redélivre le signal :

- création : révision écrite `1` ;
- modification : `state.intent.target.revision + 1`.

Avant de décrire ce succès, l'exécuteur prouve seulement que la fiche existe encore et que sa
révision courante est supérieure ou égale à la révision écrite attendue. Une correction humaine
ultérieure peut donc faire avancer la fiche sans réécrire l'histoire de l'effet Jarvis. Si le run
porte déjà le reçu de ce même `effectId`, ce reçu reste renvoyé byte-for-byte.

## 4. Critères d'acceptation binaires

- [x] La révision scellée atteint l'autorité d'écriture et une révision absente/incohérente produit
      zéro mutation.
- [x] Le repository Prisma effectue un unique `UPDATE ... WHERE companyId/id/revision`, jamais un
      `upsert`, et incrémente la révision exactement une fois.
- [x] Deux postimages concurrentes partant de la même révision donnent exactement un `saved` et un
      `revision_conflict`; le postimage gagnant est intact et la révision vaut `N + 1`.
- [x] Une cible absente n'est pas créée par le chemin CAS.
- [x] L'exécuteur mappe le conflit vers `target_revision_stale`, sans retry.
- [x] `reconcileEffect(update)` rend `undecidable` et n'appelle jamais
      `updateCustomerAtRevision`.
- [x] Un succès `N -> N + 1`, suivi d'une correction humaine `N + 2` avant le signal, produit un
      reçu stable portant `N + 1`.
- [x] Un vrai work item `authorized` sans résultat, après commit CAS réel, traverse
      `reconcileEffect` puis le dispatcher : `outcome_unknown` persiste, aucun signal ni événement
      terminal n'est produit, aucun second `UPDATE` n'a lieu et la révision reste `N + 1`.
- [ ] Mutations anti-faux-vert exécutées et consignées : suppression du prédicat de révision ;
      restauration de `safe_to_replay`.
- [x] Le delta U1-i laisse domaine, reducer, frame, catalogue, flags et schéma PostgreSQL
      inchangés ; les changements Safety intégrés séparément ne lui sont pas attribués.

## 5. Hors lot et gates conservées

- Les commits U1-h `3a51593f6`, `ab7b4439d` et `5a86f94d6` sont intégrés séparément. Le delta
  U1-i ne partage aucun fichier avec eux et ne revendique aucun livrable tactile.
- Aucun changement de création client, contact, `customerType`, catalogue ou reducer.
- Aucun flag, matrice, activation, cutover, publication ou claim produit.
- Aucun registre/reçu `ForJarvis` n'est ajouté dans ce lot.
- Le CAS ne ferme pas encore la parité complète avec l'édition manuelle : l'autorité Jarvis doit
  encore partager le verrou société, le refus de compte clôturé et les barrières d'archives du
  parcours manuel. Cette extraction reste un bloqueur d'activation, pas une dette facultative.
- La dépendance Safety qui conserve `outcome_unknown` sans faux reçu terminal est satisfaite dans
  la chaîne intégrée. Un binaire N-1 susceptible d'écrire hors de ces fences reste arrêté et
  attesté avant toute ouverture.

## 6. Definition of Done

- [x] Tests unitaires ciblés verts : core 14/14, exécuteur 12/12.
- [x] Preuve PostgreSQL 17 réelle sous rôles séparés et RLS applicative : 8 suites, 121/121 ;
      course CAS, absence, révision du reçu et reprise indécidable comprises.
- [x] Typechecks core/API et lint ciblé verts ; `git diff --check` vert.
- [x] Aucun fichier des trois commits U1-h n'est modifié par les commits U1-i.
- [x] Statut normatif conservé à `specified`; `client-modifier@1` reste non publié.
