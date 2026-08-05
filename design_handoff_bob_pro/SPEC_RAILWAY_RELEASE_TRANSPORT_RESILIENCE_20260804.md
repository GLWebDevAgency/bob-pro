# SPEC O7 — Transport de déploiement Railway résilient

**Statut :** `implemented`
**Objectif canonique :** O7 — release reproductible
**Date :** 4 août 2026
**Incident source :** workflow staging `30921527702`, SHA
`3af32e1230e168866b60f2b125ce0764d16c69d6`

**Incident de certification découvert après merge :** workflow staging `30930082557`, SHA
`87583d32aa43c7a87f97bbf485ace76a9b04f5fd`

**Incident de parité ACL V2 découvert après merge :** workflow staging `30939161845`, SHA
`042607f920e7bc1ecd4c2448f84fcbdd5b5e005e`

**Incident de cohérence archive et de drainage découvert après merge :** workflow staging
`30956265151`, SHA `ca9b6916d7a1fa4a53e89cbf6cb6802213347c3d`, déploiement d'audit
`403beb4b-c9b4-4a94-a954-071583dd6cd5`

**Incident de timeout WAN du certificat d'émission découvert avant déploiement :** workflow
staging `30987951860`, SHA `f88e3a5618576b63b22daa2c7d702862963a8ebd`

## 1. Objectif

Une release ne doit pas échouer parce que le flux de logs attaché du CLI Railway est interrompu
après que l'upload a été accepté. Le déploiement est identifié par son UUID autoritaire, attendu
jusqu'à un état terminal via l'API Railway, puis rapproché du déploiement réellement servant avant
la readiness au SHA exact.

Le 4 août 2026, Railway a créé le déploiement
`7c7e7a74-d994-4e9f-871d-2446a969df85`, qui a atteint `SUCCESS`, mais `railway up` a quitté avec
`Failed to stream build logs: Failed to retrieve build log`. La CI s'est arrêtée avant l'audit
archive, l'activation et le postdeploy alors que l'API saine servait déjà le bon SHA. Le flux de
logs n'est donc pas une autorité de publication.

Le premier rituel staging exécuté avec ce transport a ensuite prouvé les 15 scénarios métier de
`public-capability-lifecycle.postgres.test.ts`, puis a échoué uniquement dans son `afterAll` : le
client administrateur du nettoyage n'héritait pas de `PRISMA_TRANSACTION_TIMEOUT_MS`, contrairement
aux clients runtime `PrismaService`. Sur Supabase distant, la transaction interactive de purge a
donc expiré avec `P2028` avant de produire le reçu predeploy. Le correctif doit réutiliser le même
contrat transactionnel WAN, sans masquer une dépendance oubliée ni affaiblir le nettoyage strict.

La CI suivante (`30934039453`) a confirmé la disparition de `P2028` et le passage des 15 scénarios,
mais a révélé un second défaut du contrat de nettoyage : le scénario « signature gagnante » crée
volontairement l'ordre durable et le snapshot append-only du devis signé. La garde les traitait à
tort comme des archives étrangères. Le certificat doit conserver ce chemin de bout en bout, puis
reconnaître et retirer uniquement son graphe synthétique exact ; il ne doit ni désactiver le scénario
d'archive ni élargir la purge à une archive utilisateur.

Le rejeu réel suivant (`30939161845`) a ensuite prouvé que le parking ajouté au certificat
contredisait l'ACL terminale de l'archive V2 : après le vrai enqueue V3, l'adapter de test exécutait
un `UPDATE document_archive_jobs` direct avec le rôle runtime. C'est précisément une capacité que
le cutover V2 révoque. La base Supabase a donc refusé l'opération avec `42501`, alors que la CI
éphémère l'avait exercée sous l'état expand V1. Le correctif ne doit surtout pas rendre `UPDATE` au
runtime. Il doit garder l'enqueue métier réel, neutraliser uniquement l'accélération post-commit du
worker dans l'instance de certificat — comme le fait déjà le certificat d'émission de facture — et
laisser la purge administrateur vérifier puis retirer le graphe synthétique exact.

La release normale suivante (`30956265151`) a déployé et servi l'API staging au SHA exact, puis
l'audit V2 a refusé l'activation avec cinq objets Storage sans référence SQL et deux références SQL
sans objet. L'analyse en lecture seule a séparé deux causes qui ne doivent pas être confondues :

- les deux références SQL sont des `document_versions` synthétiques portant la signature exacte du
  certificat snapshot. Son cleanup passe temporairement `session_replication_role` à `replica`,
  puis supprimait le parent `documents` en comptant à tort sur une cascade FK désactivée par ce
  mode ;
- les cinq objets Storage appartiennent au tenant FLY SERVICES et proviennent d'émissions
  interrompues. Ils ne sont pas des fixtures et restent hors de ce correctif. Leur retrait exige
  un manifeste scellé et l'opérateur de quarantaine séparé ; l'audit ne sera pas affaibli.

Le cleanup durable a ensuite rencontré `deploymentStopped=true` alors que l'instance était encore
`RUNNING` pendant la fenêtre de drainage Railway. Ce snapshot n'est pas contradictoire : l'arrêt
est acquitté mais pas encore quiescent. Le runner doit attendre la fin effective sans rejouer de
mutation, et n'accepter le cleanup qu'après deux observations quiescentes.

Le rejeu du 5 août a appliqué les 169 migrations staging, puis s'est arrêté avant tout déploiement :
le certificat `invoice-issue-lifecycle` utilisait encore un `PrismaClient` administrateur brut. Sa
purge interactive retombait donc au timeout Prisma de 5 secondes et échouait avec `P2028`, alors que
le rituel exportait déjà un budget WAN borné de 30 secondes. Ce certificat doit consommer le même
`PrismaService` que les autres certifications distantes et donner à ses hooks un budget explicite ;
les erreurs de FK, triggers et dépendances restent bloquantes et ne sont jamais avalées.

## 2. Périmètre

### Inclus

- upload Railway détaché avec sortie JSON bornée à un `deploymentId` UUID ;
- attente bornée de ce déploiement exact via GraphQL Railway ;
- validation stricte de `projectId`, `environmentId` et `serviceId` à chaque poll ;
- rapprochement avant mutation des IDs Railway avec les noms d'environnement/service attendus ;
- refus de tout état inconnu ou terminal en échec ;
- certification qu'une seule réplique sert et qu'elle correspond au déploiement attendu ;
- readiness HTTPS au SHA et à l'environnement exacts, conservée comme autorité applicative ;
- absence d'erreur secondaire d'artefact quand l'audit n'a jamais démarré ;
- parité du timeout transactionnel certifié entre clients runtime et administrateur du certificat
  de cycle de vie des capacités publiques ;
- parité du même timeout WAN pour le client administrateur du certificat d'émission de facture,
  avec des hooks de reprise et de nettoyage explicitement bornés ;
- récupération bornée des seules fixtures de ce certificat laissées par une interruption ;
- chemin de reprise staging manuel et explicite lorsqu'un déploiement Railway terminal en échec
  est plus récent que l'unique réplique saine ;
- réutilisation du même contrat de déploiement par les opérateurs staging existants.
- suppression explicite des versions du certificat snapshot avant leurs parents sans suspendre les
  FK/cascades/RLS, et récupération bornée des seuls résidus synthétiques à signature exacte laissés
  par les runs interrompus ;
- distinction Railway entre arrêt acquitté et quiescence réelle d'un déploiement, y compris pendant
  l'état d'instance `REMOVING`.

### Exclus

- aucune mutation métier, fiscale ou documentaire ;
- aucune modification des données métier utilisateur staging ou production ; les seules lignes
  nettoyées ici sont les fixtures réservées du certificat en development/staging ;
- aucune activation Bob Live ou Archive hors du workflow canonique ;
- aucune relance automatique d'un upload dont l'acceptation est ambiguë ;
- aucune quarantaine ou suppression des objets Storage historiques.
- aucune suppression, réécriture ou création de référence SQL pour les cinq objets FLY SERVICES ;
  leur opération de quarantaine est un lot séparé et ne devient exécutable qu'avec un manifeste
  scellé et la décision fondatrice contre-signée ; elle n'est pas exécutée par cette PR.

## 3. Invariants

1. `railway up --detach --json` est la seule commande qui crée un déploiement dans le rituel.
2. Un UUID absent, ambigu ou mal formé arrête la release avant tout poll.
3. Le poll n'accepte `SUCCESS` que pour le même projet, environnement, service et déploiement.
4. Un UUID tout juste créé est recherché pendant au plus 60 secondes via la connexion paginée
   `deployments`, sans hypothèse d'ordre. Chaque page et curseur est borné, chaque nœud doit porter
   l'identité project/environnement/service exacte, et une pagination tronquée ou dupliquée échoue
   fermée. Après sa découverte, seul `deployment(id)` suit son état ; toute disparition ou
   divergence d'identité échoue immédiatement.
5. `BUILDING`, `DEPLOYING`, `INITIALIZING`, `QUEUED` et `WAITING` sont les seuls états transitoires.
6. Tout état inconnu ou terminal en échec ferme la release ; aucun retry d'upload n'est implicite.
7. Les appels GraphQL ont une deadline monotone partagée, une taille de réponse maximale, un
   backoff exponentiel et respectent `Retry-After` borné à 60 secondes. Une indisponibilité de
   lecture reste dans le polling du même UUID ; elle ne crée jamais un autre déploiement.
8. En release normale, `latestDeployment` doit être exactement l'unique déploiement actif sain
   avant toute commande `railway run`, puis `latest == active == UUID créé` avant l'audit, avant
   activation et avant postdeploy. Un latest plus récent même terminal interdit toute mutation.
9. La readiness doit encore prouver `ready=true`, le SHA exact et l'environnement exact ; un
   `SUCCESS` Railway seul n'est jamais une preuve applicative.
10. L'enveloppe d'audit est exigée uniquement si l'étape d'audit a effectivement démarré. Un échec
    antérieur reste unique et lisible.
11. `release-recovery` est un chemin staging uniquement, déclenchable seulement par dispatch manuel
    direct de `railway-api.yml` sur `main`. `github.workflow_ref` doit être celui de ce workflow —
    propager `workflow_dispatch` depuis un workflow appelant ne suffit pas. Il autorise avant upload
    un `latest` distinct uniquement s'il est terminal, non servant, et si l'unique `active` reste
    sain. Il re-prouve immédiatement les IDs, la topologie, l'environnement et la paire de bases
    avant les migrations. Dès le nouvel upload, toutes les preuves redeviennent strictes sans
    exception. Un appel réutilisable, une cible production, une autre ref ou un latest transitoire
    sont refusés. L'audit, les activations et le postdeploy restent intégralement obligatoires.
12. Le nettoyage du certificat PostgreSQL des capacités publiques utilise `PrismaService` pour son
    accès administrateur : il hérite ainsi du timeout WAN borné et réservé au rituel par
    `PRISMA_TRANSACTION_TIMEOUT_MS`. Les erreurs de FK, triggers ou dépendances restent propagées ;
    aucune erreur de purge n'est avalée.
13. Avant de créer de nouvelles fixtures, le certificat purge par lots bornés uniquement les
    sociétés portant simultanément son préfixe d'identifiant réservé, son SIREN de certification et
    son préfixe de nom. Chaque lot reverrouille les sociétés, revalide les trois marqueurs dans la
    transaction et exige une bijection exacte avant toute neutralisation de trigger. Il recompte
    ensuite les sociétés visées et exige zéro ; une interruption ne doit ni polluer staging
    durablement ni élargir la purge à une donnée utilisateur.
14. Ce certificat mutatif refuse tout environnement autre que `development` ou `staging`, y compris
    `production`, même si son flag Vitest est activé manuellement.
15. Le scénario « signature gagnante » crée légitimement un graphe d'archive synthétique
    `quote-signed` au moyen du vrai enqueue V3 et des ACL runtime terminales. Le certificat ne fait
    aucun `INSERT`/`UPDATE` direct sur `document_archive_jobs` et ne réaccorde aucun droit retiré par
    le cutover V2. Seule l'accélération locale post-commit `runDocumentArchiveJobs` de l'instance
    `BackendService` construite par la suite est neutralisée ; l'outbox durable et son snapshot
    restent réellement écrits dans la transaction de signature. En staging, le certificat refuse
    de créer une fixture si `JOB_COMPANY_IDS` est vide ; après le gate live qui exige déjà cette
    variable, le scheduler canonique rend immédiatement cette allowlist sans utiliser son fallback
    de découverte. L'identifiant UUID réservé et alloué dynamiquement par ce certificat ne peut donc
    pas appartenir à cette configuration préexistante. Avant sa purge, la transaction
    administrateur verrouille les jobs puis exige, pour chaque job, le tenant de
    certification, l'identifiant de devis déterministe de la fixture, le motif `quote-signed`, un
    état non terminal sans preuve, un snapshot bijectif de même identité et, pour récupérer un run
    antérieur déjà interrompu, au plus l'intention `signed_quote` déterministe associée au même
    snapshot. Un lease encore détenu provoque une attente/reprise bornée hors transaction ; après
    la deadline, la purge échoue fermée. Toute autre forme échoue fermée.
16. Une fixture possédant un artefact d'archive terminé, un document/version matérialisé ou un job
    terminal n'est jamais purgée par ce certificat. Chaque `storageKey` préparée est recherchée
    directement dans `storage.objects` et doit être absente ; aucune suppression Storage n'est
    tentée. Pour le seul graphe synthétique non matérialisé prouvé, les triggers append-only sont
    neutralisés localement le temps de supprimer intentions puis snapshots ; ils sont rétablis
    avant la suppression normale du job et des lignes métier. Les compteurs de suppression doivent
    égaler les ensembles validés, puis le graphe est recompté à zéro. La bijection des sociétés
    reste tenue sous verrou pendant toute l'opération.
17. Le certificat snapshot est borné à `development` et `staging`. Avant de créer sa fixture, il
    prend le même verrou advisory transactionnel que l'audit des octets, puis verrouille les
    versions orphelines portant son préfixe réservé. En staging, leur ensemble doit être soit vide,
    soit exactement égal au manifeste fermé des deux identifiants de l'incident `30956265151` ; un
    état partiel ou un identifiant supplémentaire ferme le certificat. Chaque candidate doit
    prouver la même UUID v4 dans `id`, `documentId`, `storageKey` et les identifiants de tenant
    attendus, ainsi que version, hash synthétique, MIME, taille, date, motif et absence de parent,
    dépendance et objet Storage exacts. Une seule divergence ferme le certificat sans suppression.
    Une transaction `READ COMMITTED` prend d'abord, dans l'ordre canonique Storage → graphe métier
    → archive, des verrous `SHARE ROW EXCLUSIVE` sur toutes les tables pouvant invalider ces
    prédicats d'absence. Le `session_user` déployeur verrouille et lit Storage ; sans aucun GRANT,
    la même transaction inventorie ensuite l'owner public commun exact, prouve
    `pg_has_role(session_user, owner, 'SET')`, bascule par une commande `SET LOCAL ROLE` quotée par
    PostgreSQL et vérifie `current_user` avant de verrouiller et lire les tables publiques. Chaque
    relecture Storage repasse explicitement par `SET LOCAL ROLE NONE`, vérifie le retour au
    `session_user`, puis reprend et revérifie l'owner public. Elle relit ainsi un snapshot frais
    après drainage des writers puis revalide l'ensemble juste avant le DELETE. Elle suspend uniquement le
    constraint trigger de représentation de `document_versions`, puis restaure exactement son
    état antérieur `O`, `D`, `R` ou `A`, exige le compteur exact et un second passage à zéro. Le
    cleanup courant garde FK, cascades, RLS et les autres triggers actifs ; il supprime
    explicitement la version avant son document sous la même suspension étroite. La CI rejoue ce
    certificat après le transfert effectif de toutes les tables publiques vers l'owner NOLOGIN.
18. Un déploiement Railway est quiescent si et seulement si `deploymentStopped=true` et qu'aucune
    instance n'est dans `CREATED`, `INITIALIZING`, `RESTARTING`, `RUNNING` ou `REMOVING`. Les autres
    états d'instance connus sont terminaux. Un arrêt déjà acquitté avec une instance non terminale
    reste bloquant pour le preflight et le cleanup, mais ne déclenche jamais un second `cancel` ou
    `stop`. Deux snapshots quiescents consécutifs sont requis ; une autre release non quiescente ou
    une instance qui ne draine pas dans la fenêtre bornée échoue fermée. Une fois
    `deploymentStopped=true` observé pour un identifiant suivi ou corrélé, toute observation
    ultérieure à `false` est une régression de contrôle refusée : elle ne réarme jamais une mutation. Toute cible
    corrélée, même déjà quiescente lors de sa découverte, entre dans le suivi ; sa première
    observation compte pour une des deux confirmations, si bien qu'une cible découverte au dernier
    snapshot est refusée et qu'une cible découverte à l'avant-dernier doit être revue au dernier.
19. Le client administrateur de `invoice-issue-lifecycle` est un `PrismaService` et hérite de
    `PRISMA_TRANSACTION_TIMEOUT_MS` comme les clients runtime. Les hooks `beforeAll` et `afterAll`
    portent des deadlines explicites supérieures au timeout d'une transaction distante. Ce
    changement n'élargit ni le namespace de fixtures, ni les suppressions, ni les neutralisations
    de triggers ; toute erreur de purge continue d'échouer fermé.

## 4. Critères d'acceptation binaires

- [x] Le parser accepte uniquement une sortie JSON portant un `deploymentId` UUID canonique.
- [x] Le waiter converge de chaque état transitoire vers `SUCCESS` pour l'identité exacte.
- [x] Une inscription GraphQL retardée converge par pagination sans second upload ; page/cursor
      invalide, doublon, mauvaise identité, troncature ou absence durable échoue fermé.
- [x] `Retry-After`, le backoff et la deadline absolue sont testés sans retry d'upload.
- [x] Une identité différente, un état inconnu, un état terminal en échec ou un timeout échoue fermé.
- [x] Les erreurs HTTP transitoires sont rejouées de façon bornée ; les erreurs permanentes ne le
      sont pas.
- [x] Le workflow déploie en mode détaché et attend l'UUID exact sans dépendre du streaming de logs.
- [x] La certification de topologie rapproche l'UUID servant de l'UUID créé par la release.
- [x] La cible est re-probée par project/environment/service IDs immédiatement avant le prédeploy,
      et les deux `railway run` utilisent seulement ces IDs avec `--no-local`.
- [x] Ce rapprochement exact est rejoué après l'audit, avant activation puis avant postdeploy.
- [x] La release normale refuse `latest != active`. Le recovery staging manuel accepte seulement
      un latest terminal non servant, puis revient au contrat strict après upload ; routage,
      environnement et refus via `workflow_call` sont testés.
- [x] La readiness SHA/environnement reste bloquante avant audit et activation.
- [x] Un audit non démarré ne crée pas une seconde erreur `No files were found`.
- [x] Les tests de contrat du workflow empêchent le retour à un `railway up` attaché.
- [x] Un test de contrat interdit au certificat d'émission de réintroduire un `PrismaClient`
      administrateur brut et exige les deux deadlines de hooks.
- [x] Les suites ciblées, la suite API complète, le typecheck, le lint et le build API passent.
- [x] La CI complète de la PR de transport passe (`30928805632`) et la CI post-merge de `main`
      passe au SHA exact (`30929418952`).
- [ ] Le certificat PostgreSQL des capacités publiques termine aussi son nettoyage administrateur
      contre une base distante avec `PRISMA_TRANSACTION_TIMEOUT_MS` actif.
- [ ] Le rejeu staging récupère les fixtures du run interrompu puis prouve qu'il ne reste aucune
      société portant les trois marqueurs réservés.
- [ ] Le rejeu staging exécute les cinq scénarios `invoice-issue-lifecycle` avec le timeout WAN,
      nettoie son namespace réservé et atteint le déploiement sans `P2028`.
- [ ] La preuve distante confirme que le seul graphe archive éventuellement rencontré est le
      `quote-signed` synthétique non matérialisé attendu, qu'il est intégralement nettoyé et
      qu'aucune archive utilisateur ni objet Storage n'est supprimé.
- [ ] Le certificat passe sous l'ACL terminale V2 sans `UPDATE document_archive_jobs` direct et
      sans réaccorder ce privilège au rôle runtime.
- [ ] Le scénario gagnant prouve exactement un job `quote-signed` pending sans lease/preuve et son
      snapshot V3 scellé avant la purge ; staging refuse le seed si `JOB_COMPANY_IDS` est vide.
- [ ] Un nouveau workflow staging au SHA mergé termine audit, activation et postdeploy.
- [ ] Le certificat snapshot conserve FK/cascades/RLS actifs, supprime explicitement sa version
      avant son parent sous suspension du seul trigger de représentation, récupère le manifeste
      exact, refuse les états partiels et les formes voisines puis prouve qu'un second passage ne
      trouve plus rien. Sa CI post-owner-split prouve aussi les verrous d'absence, le `SET ROLE`
      depuis un déployeur non-superuser et la restauration exacte de l'état des triggers.
- [ ] `deploymentStopped=true` avec une instance `RUNNING` puis `EXITED` converge sans nouvelle
      mutation ; la même instance persistante échoue fermée et `REMOVING` reste non quiescent.
- [ ] Le preflight refuse un nouveau one-shot tant qu'une instance arrêtée mais non drainée existe,
      et le cleanup ne masque jamais une autre release non quiescente.
- [ ] Après un ACK stop, un snapshot périmé à `deploymentStopped=false` est refusé sans remutation ;
      une cible corrélée apparue à l'avant-dernier snapshot doit être confirmée au dernier, tandis
      qu'une première apparition au dernier snapshot échoue fermée.

## 5. Blocage explicite de promotion production

`[BLOQUÉ FONDATEUR : GO de promotion production + provisioning/certification des variables GitHub
production]`

Au 4 août 2026, l'environnement GitHub `production` porte uniquement `API_BASE_URL` et
`RAILWAY_API_SERVICE`. Il ne porte pas `RAILWAY_PROJECT_ID`, `RAILWAY_ENVIRONMENT_ID`,
`RAILWAY_API_SERVICE_ID` ni `RAILWAY_ARCHIVE_AUDIT_SERVICE_ID`, alors que le rituel exige une cible
par UUID. Les valeurs Railway sont observables, mais elles ne seront installées qu'après validation
staging et GO de promotion, conformément à la loi `PR → staging validé → production`. Aucune
compatibilité production n'est revendiquée avant ce preflight réel.

## 6. Definition of Done

- `implemented` : module partagé, workflow et tests présents sur une PR atomique ;
- `certified` : CI complète verte et déploiement Railway testé avec identité exacte ;
- `released` : workflow staging canonique vert, `/health/ready` au SHA mergé, audit archive vert,
  activation et postdeploy terminés avec receipts non-PII.
