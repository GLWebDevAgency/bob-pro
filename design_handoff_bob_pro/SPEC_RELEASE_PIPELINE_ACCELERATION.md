# SPEC — Accélération sûre du pipeline de release API

**Objectif servi : O7 — Release reproductible**

**Statut : implemented**

**Baseline :** staging `30351623978`, SHA
`e11d985fa74ba2253dc6450b8944232d589624d0`, 28/07/2026

## 1. Problème prouvé

La release staging de référence est verte, exacte au SHA et fail-closed, mais son job API dure
`63 min 48 s`. Le détail GitHub Actions montre que la lenteur ne vient ni du build ni de Railway :

| Phase observée                               |       Durée |
| -------------------------------------------- | ----------: |
| setup, build, tests, image locale            |  5 min 10 s |
| `release.sh predeploy`                       | 17 min 44 s |
| déploiement Railway + readiness              |  2 min 36 s |
| premier `release.sh postdeploy`              | 17 min 44 s |
| audit archive one-shot                       |  2 min 36 s |
| activations + second `release.sh postdeploy` | 17 min 51 s |

Le même corps de certification Supabase est donc rejoué trois fois. Le premier `postdeploy` rouvre
Bob Live avant l’audit et les activations, puis le second le referme et recommence toutes les
preuves. Cette réouverture intermédiaire ne constitue ni une preuve supplémentaire ni une fenêtre
de disponibilité utile.

Le run de référence montre notamment `149 s` pour Devices, `92 s` pour les capacités publiques,
`60 s` pour le cycle de vie Company et `56 s` pour l’émission facture. Une revue plus profonde a
cependant prouvé que le bloc complet n’est pas parallélisable en sécurité : certaines suites
utilisent des fixtures fixes, modifient des flags globaux, prennent des verrous exclusifs ou
désactivent temporairement des triggers. Le gain doit donc venir de la suppression des rejeux,
jamais d’une concurrence opportuniste.

Enfin, le même chemin est appelable pour production et y exécute aujourd’hui des fixtures
comportementales. Même nettoyées en sortie normale, ces données de certification n’ont rien à
faire dans la base des utilisateurs et peuvent survivre à une terminaison dure.

## 2. Résultat attendu

La release conserve toutes les preuves de migration, RLS, concurrence, archive, protocoles et SHA,
mais ne les exécute qu’à la phase où elles ont une valeur :

1. qualification locale exacte du commit ;
2. `predeploy` complet, exécuté une seule fois sur staging sous admissions fermées, puis émission
   d’un reçu strict lié au SHA, à l’environnement, à l’identité de base et aux digests de schéma ;
3. déploiement et readiness du SHA exact ;
4. audit archive isolé ;
5. activations monotones archive, settlement et outbox ;
6. `postdeploy` ciblé qui refuse tout reçu absent ou divergent, certifie le write-set des
   activations, rejoue uniquement sur staging les preuves comportementales devenues pertinentes
   au premier cutover, puis rouvre en dernier geste sans reprovisionner l’autorité.

Le budget binaire du chemin staging est **35 minutes au plus** sur un run exact-SHA sans attente
externe exceptionnelle. Ce lot mesure un run réel ; il ne prétend pas encore établir un p95.

Production reste obligatoirement promue par `cabinet-release.yml` après la certification et le
parcours E2E staging du **même SHA**. Elle applique les migrations et les politiques nécessaires,
mais n’insère aucune fixture de certification.

## 3. Portée

### Inclus

1. Un seul appel `postdeploy` dans le workflow Railway, strictement après l’audit archive et les
   trois activations.
2. Maintien de Bob Live fermé de `predeploy` jusqu’à la dernière instruction de `postdeploy`.
3. Reçu atomique de certification `predeploy`, non-PII et strictement validé dans le même job. Il
   lie aussi une allowlist de configuration opérationnelle non secrète et l’inventaire des
   versions de keyrings, jamais les clés, tokens, secrets ou leurs empreintes. Une liaison privée
   éphémère détecte séparément toute rotation concurrente des secrets scalaires usage/control ;
   elle est exclue de GitHub, de l’upload Railway et de l’image Docker.
4. Maintien séquentiel des suites qui écrivent, verrouillent ou partagent une autorité globale.
5. Transformation de `postdeploy` en finalisation ciblée :
   - bijection stricte des migrations ;
   - état V2 exact des trois protocoles ;
   - certificats structurels/ACL en lecture seule ;
   - preuve archive terminale liée à l'identité DB et au one-shot ;
   - sur staging uniquement, policy Outbox V2 testée avec la seed RLS bornée et certificats
     Archive/Settlement V2 rejoués seulement lorsqu’ils viennent d’être activés par ce SHA ;
   - retrait des anciennes clés prévu par le protocole ;
   - réouverture de la capacité via `activate-existing`, sans DDL ni provisioning, en dernier.
6. Séparation des environnements :
   - `development` et `staging` exécutent les fixtures comportementales ;
   - `production` exécute uniquement les mutations opérationnelles requises et les preuves sans
     fixture, après le gate staging exact-SHA déjà imposé.
7. Tests anti-drift du graphe de release, du reçu, des phases, de l’interdiction du parallélisme
   non déclaré read-only et de l’interdiction des fixtures en production.
8. Mise à jour du runbook et du registre O7 avec les preuves réelles.

### Non inclus

- supprimer build, typecheck, lint, tests ou image locale de la qualification ;
- accepter un cache comme preuve ;
- construire dans ce lot une attestation OCI/GitHub réutilisable ;
- créer un runner Railway de certification ou déplacer `psql` dans le conteneur runtime ;
- paralléliser les scripts ou suites qui modifient rôles, RLS, release flags, triggers, protocoles
  ou fixtures ;
- modifier une migration, un schéma métier ou Production ;
- reprendre Mistral Realtime V3.

## 4. Invariants

1. **Fail-closed.** Toute erreur laisse Bob Live fermé. Aucun `always()`, cleanup ou retry ne peut
   rouvrir la capacité.
2. **Une seule autorité de réouverture.** Seul le `postdeploy` final, après toutes les preuves,
   applique la configuration live demandée.
3. **Aucune migration postdeploy.** `prisma migrate deploy`, `rls.sql`, le provisioning des rôles
   et le staging des keyrings restent dans `predeploy`.
4. **Activation avant finalisation.** Archive, settlement et outbox sont activés avant l’unique
   `postdeploy`. Un état non V2 ou partiellement activé est refusé avant réouverture.
5. **Archive inchangée.** Le one-shot conserve son deployment id, son SHA, sa double observation
   terminale, son artefact non-PII et son cleanup borné.
6. **Reçu non transférable.** Le reçu est produit seulement après succès du bloc lourd. Il contient
   le SHA complet, l’environnement, l’identité PostgreSQL, le digest canonique des migrations et
   des surfaces RLS, ainsi que le mode de certification. Il est vérifié par relecture de la cible ;
   il ne permet jamais une reprise sur un autre run, SHA, environnement ou cluster.
7. **Séquentiel par défaut.** Toute suite non explicitement `BEGIN READ ONLY` reste séquentielle.
   Les fixtures fixes, flags, triggers, clés, capacités et protocoles ne sont jamais parallélisés.
8. **Production sans test data.** Aucune seed RLS, société `*-cert-*`, cabinet de concurrence,
   release flag de test ou suite Vitest PostgreSQL n’est créée sur la base production.
9. **Preuve staging obligatoire.** La branche production du workflow reste inaccessible hors
   `cabinet-release.yml`, `main` et dépendance réussie du parcours staging au même `github.sha`.
10. **Aucun faux gain.** Une preuve retirée du chemin général doit exister dans le certificat
    ciblé final ou rester au `predeploy`; elle n’est jamais remplacée par un commentaire.
11. **Cible et configuration immuables pendant le run.** Le workflow transmet un environnement
    attendu indépendant de la variable distante. Toute différence avec `CABINET_RELEASE_ENV`
    bloque avant mutation. Le reçu refuse également toute dérive de provider, modèle, flags,
    limites, versions ou inventaire de versions de clés entre `predeploy` et `postdeploy`. La
    liaison privée refuse une substitution de secret scalaire à version inchangée sans exposer son
    digest hors du runner.
12. **Révision revalidée au dernier moment.** Topologie mono-réplique, SHA, environnement et
    capacités, y compris la source d’IP Railway attendue, sont sondés après l’audit avant les
    activations, puis une seconde fois après les activations immédiatement avant le finaliseur
    mutable.
13. **Une seule base logique.** Avant toute activation irréversible, l’opérateur prouve que
    `DATABASE_URL` et `DIRECT_URL` désignent le même système PostgreSQL, le même OID et la même
    base writable.

## 5. Séquence normative

### 5.1 Staging

1. Checkout, install, build, couverture, typecheck, lint, tests et image locale.
2. Préflight du prédécesseur et topologie mono-réplique.
3. `predeploy` :
   - fermeture/drain ;
   - migrations ;
   - rôles, grants, RLS ;
   - certificats structurels ;
   - certificats SQL statiques séquentiels ;
   - suites Vitest PostgreSQL séquentielles ;
   - certificat Mistral historique séquentiel ;
   - cleanup ;
   - émission atomique du reçu public exact et de la liaison secrète privée ;
   - capacité laissée fermée.
4. Déploiement Railway, mono-réplique et readiness SHA/environnement/capacités.
5. Audit archive one-shot exact-SHA et artefact non-PII.
6. Revalidation immédiate de la révision, puis un opérateur Railway unique prouve la paire
   `DATABASE_URL`/`DIRECT_URL` et vérifie le reçu dans son propre snapshot d’environnement avant
   d’activer Archive V2, Settlement V2 et Outbox V2.
7. Nouvelle revalidation immédiate de la révision, puis `postdeploy` ciblé après double validation
   du reçu. Sur staging, il rejoue la policy RLS active et, seulement lors du premier cutover, les
   deux certificats métier V2. Il retire ensuite les clés N-1 et rouvre via l’autorité existante.

### 5.2 Production

La promotion exécute la même séquence opérationnelle, mais le corps de fixtures du point 3 est
omis, comme la branche de preuves comportementales du point 7. Le finaliseur production reste
strictement structurel et sans fixture. Le gate staging exact-SHA et le parcours Cabinet E2E sont
obligatoires avant l’appel production.

## 6. Critères d’acceptation binaires

- [x] Le workflow Railway contient exactement un appel `BOB_RELEASE_PHASE=postdeploy`.
- [x] Cet appel est situé après l’audit archive réussi et après les trois activations.
- [x] Aucune commande ne rouvre Bob Live entre `predeploy` et ce `postdeploy`.
- [x] `postdeploy` refuse migrations absentes/divergentes et n’appelle jamais `migrate deploy`.
- [x] `postdeploy` refuse Archive, Settlement ou Outbox dans un état autre que V2 terminal.
- [x] `postdeploy` ne réapplique ni `rls.sql`, ni provisioning de rôle, ni broad suite métier.
- [x] `predeploy` écrit son reçu seulement après le cleanup réussi et la fermeture confirmée.
- [x] Un reçu au mauvais SHA, environnement, cluster, digest ou mode est refusé sans mutation.
- [x] Un environnement distant différent de la cible du workflow est refusé avant mutation.
- [x] Une dérive de configuration Bob Live ou d’inventaire de versions de clés invalide le reçu,
      sans enregistrer de secret ni d’empreinte de secret dans l’artefact.
- [x] Une substitution des secrets scalaires usage/control à version inchangée invalide la liaison
      privée ; cette liaison est absente des artefacts GitHub, du contexte Railway et de l’image.
- [x] L’opérateur d’activation refuse une paire `DATABASE_URL`/`DIRECT_URL` divergente avant toute
      mutation.
- [x] Archive et Settlement sélectionnent le bon certificat selon la version active.
- [ ] Au premier cutover staging, les comportements Archive V2, Settlement V2 et la policy Outbox
      V2 sont prouvés après activation ; production ne reçoit aucune de leurs fixtures.
- [x] Le SHA, l’environnement, la mono-réplique, les capacités et `railway-x-real-ip` sont
      revalidés avant activation puis juste avant le `postdeploy`.
- [x] La réouverture finale utilise `activate-existing` et ne rejoue aucun DDL/provisioning.
- [x] Les scripts de rôle/RLS, la seed statique, les suites Vitest et le certificat Mistral restent
      séquentiels.
- [x] `CABINET_RELEASE_ENV=production` ne peut atteindre ni seed/cleanup RLS, ni certificats
      Cabinet/flags mutables, ni suite Vitest PostgreSQL.
- [x] Le test du workflow prouve que production dépend du staging E2E au même SHA.
- [ ] La CI PostgreSQL non-superuser complète reste verte.
- [ ] Une release staging du SHA exact réussit en 35 minutes au plus et préserve toutes les preuves.
- [ ] L’artefact archive final est corrélé au SHA et ne contient aucune donnée métier.
- [x] Une panne injectée avant la fin ne peut pas rouvrir la capacité.

## 7. Definition of Done

- [x] Spec et source de vérité O7 mises à jour avant le changement de comportement.
- [x] Tests ciblés des scripts et du graphe de workflow verts.
- [x] Typecheck, lint, tests et build API verts depuis le checkout propre.
- [ ] CI complète de PR verte.
- [x] Review adversariale correctness/sécurité confirmant zéro preuve perdue et zéro fixture prod.
- [ ] Run Railway staging exact-SHA vert, durée et étapes consignées.
- [ ] Aucun déploiement production déclenché par ce lot.
- [ ] PR unique rebasée, fusionnée ; branche et worktree supprimés avant le chantier suivant.

## 8. Suites séparées

La réutilisation d’une qualification CI attestée, la corrélation du déploiement API par deployment
id, la correction préalable de chaque cleanup interrompable et l’exécution des certificats au plus
près de Supabase peuvent encore réduire la durée. Elles exigent leurs propres specs et preuves de
provenance ; elles ne sont pas nécessaires pour retirer la duplication prouvée ici.
