# SPEC U1-i — CAS de l'effet `client-modifier@1`

- **Date** : 2026-08-20
- **Statut** : `specified`
- **Objectif primaire** : O4 — mission continue et vérité relue jusqu'au résultat.
- **Contraintes** : O6/O7 — vérité métier, concurrence et preuve reproductible.
- **Parents** : `OBJECTIFS_SPECS_DOD_PUBLICATION.md` §4.2/§4.3,
  `SPEC_JARVIS_UNIVERSEL_ORCHESTRATION_20260817.md` §5.3/§7.1/§8/§9.1/§15,
  SPEC U1-e §2 et SPEC U1-f §6/§8.

## 1. Défaut fermé par ce lot

La proposition serveur scelle déjà la cible et sa révision. Le worker recalcule également le
`targetDigest` avant l'autorisation. Ces preuves ne sont toutefois qu'un préflight : l'effet réel
relit ensuite la fiche dans une autre transaction puis appelle aujourd'hui un `upsert` sans
révision attendue. Une écriture humaine placée entre le préflight et cet `upsert` peut être
écrasée.

Cette spec corrige donc deux formulations antérieures :

- la transaction U1-e ferme présentation -> confirmation -> création du work item, mais pas la
  course différée préflight dispatch -> écriture métier ;
- le `targetDigest` U1-f reste une défense utile, mais n'est pas le CAS autoritaire au point
  d'écriture et sa preuve happy-path ne couvre pas une mutation concurrente.

Après une écriture dont le résultat local a été perdu, `reconcileEffect(update)` affirme aussi
`safe_to_replay` sans reçu purpose-specific. Ce rejeu peut réécrire une fiche déjà modifiée et
incrémenter sa révision une seconde fois. Tant qu'un reçu transactionnel par `effectId` n'existe
pas, une reprise d'update est indécidable et ne réexécute rien.

## 2. Contrat CAS unique

La révision attendue provient exclusivement de `state.intent.target.revision`, recoupée avec
`state.proposal.targetRevision` et avec le `targetDigest` du work item. Une valeur fournie par le
mobile, le modèle ou une relecture tardive ne fait jamais autorité.

L'unique écriture de modification est :

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
2. `count = 0` rend `target_revision_stale`, sans second essai et sans mutation.
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

- [ ] La révision scellée atteint l'autorité d'écriture et une révision absente/incohérente produit
      zéro mutation.
- [ ] Le repository Prisma effectue un unique `UPDATE ... WHERE companyId/id/revision`, jamais un
      `upsert`, et incrémente la révision exactement une fois.
- [ ] Deux postimages concurrentes partant de la même révision donnent exactement un `saved` et un
      `revision_conflict`; le postimage gagnant est intact et la révision vaut `N + 1`.
- [ ] Une cible absente n'est pas créée par le chemin CAS.
- [ ] L'exécuteur mappe le conflit vers `target_revision_stale`, sans retry.
- [ ] `reconcileEffect(update)` rend `undecidable` et n'appelle jamais
      `updateCustomerAtRevision`.
- [ ] Un succès `N -> N + 1`, suivi d'une correction humaine `N + 2` avant le signal, produit un
      reçu stable portant `N + 1`.
- [ ] Un failpoint logique commit métier -> avant `storeResult` prouve zéro second `UPDATE`, zéro
      faux succès/échec terminal et une issue inconnue honnête.
- [ ] Les tests rougissent si le prédicat de révision est supprimé ou si `safe_to_replay` est
      restauré.
- [ ] Domaine, reducer, frame, catalogue, flags et schéma PostgreSQL restent inchangés.

## 5. Hors lot et gates conservées

- Le commit U1-h étapes 1–2 de Claude (`3a51593f6` : oracle du domaine, libellé candidat unique,
  rafraîchissement du TTL) reste intact et ne partage aucun chemin avec ce lot. Les surfaces
  tactiles et la convergence terminale restantes d'U1-h ne sont pas revendiquées ici.
- Aucun changement de création client, contact, `customerType`, catalogue ou reducer.
- Aucun flag, matrice, activation, cutover, publication ou claim produit.
- Aucun registre/reçu `ForJarvis` n'est ajouté dans ce lot.
- Le CAS ne ferme pas encore la parité complète avec l'édition manuelle : l'autorité Jarvis doit
  encore partager le verrou société, le refus de compte clôturé et les barrières d'archives du
  parcours manuel. Cette extraction reste un bloqueur d'activation, pas une dette facultative.
- Le lot safety qui conserve `outcome_unknown` sans faux reçu terminal doit être intégré avant ce
  lot. Un binaire N-1 susceptible d'écrire hors de ces fences est arrêté et attesté avant toute
  ouverture.

## 6. Definition of Done

- [ ] Tests unitaires core et exécuteur ciblés verts.
- [ ] Preuve PostgreSQL réelle sous la RLS du rôle applicatif : course CAS, absence, révision du
      reçu et reprise indécidable.
- [ ] Typecheck et lint ciblés verts ; `git diff --check` vert.
- [ ] Aucun fichier revendiqué par U1-h n'est modifié.
- [ ] Statut final au plus `implemented`; `client-modifier@1` reste non publié.
