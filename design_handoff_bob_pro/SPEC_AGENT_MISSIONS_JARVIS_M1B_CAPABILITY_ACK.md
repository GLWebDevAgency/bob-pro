# Bob AgentMission M1-B — capability Realtime durable et ACK écran

> Statut : `implemented`
>
> Objectif parent : O4 — mission continue
>
> Base : `origin/main@4fb5e688`
>
> Dépend de : `SPEC_AGENT_MISSIONS_JARVIS.md`,
> `SPEC_AGENT_MISSIONS_JARVIS_M1A_SERVER.md`, ADR-0006
>
> Activation publique/production : interdite par ce lot

## 1. Pourquoi ce lot existe

M1-A a livré l'agrégat `AgentMission`, son journal append-only, le brouillon de devis possédé
atomiquement et les routes `start/get/cancel`. Ces routes sont volontairement fermées en
production : un JWT, un `sessionHandle` ou un header libre ne prouvent pas qu'une session Bob Live
a réellement négocié le protocole mission.

M1-B installe l'autorité minimale qui manque :

1. le mobile annonce la version mission pendant le bootstrap Bob Live initial ;
2. le serveur décide l'éligibilité et persiste la version négociée avec le hash d'une capability
   de possession aléatoire dans la même transaction que la lease Realtime ;
3. le secret de capability n'est rendu qu'au mobile N+1, conservé en mémoire vive et présenté sur
   chaque requête Mission ;
4. le mobile acquitte explicitement et durablement la réception du bootstrap avant que le handle
   soit exposé au transport ; sans ce reçu, le heartbeat ne prolonge pas la lease et aucune route
   Mission ne peut l'utiliser ;
5. chaque route Mission revalide, dans sa propre transaction métier, la possession, le reçu et la
   lease active du principal dérivé côté serveur ;
6. l'ACK `/devis/new` lie atomiquement mission, contexte sideband appliqué et brouillon réel.

Le résultat n'est pas encore le devis vocal complet. Il rend la prochaine tranche M1-C possible
sans ouvrir une faille d'autorité ni fabriquer un état local.

## 2. Résultat binaire

Une requête authentifiée ne peut lire ou muter une mission devis que si le serveur retrouve
**exactement une** lease Bob Live active du même principal, négociée en protocole mission V1 lors
de son admission, explicitement acquittée par le mobile et dont le hash correspond au secret de
possession présenté. Un ACK écran accepté produit exactement une nouvelle révision Mission, un
event `screen_acknowledged` corrélé et une liaison au contexte/draft autoritaires, ou ne produit
rien.

## 3. Périmètre

### Inclus

- négociation bootstrap `agentMissionProtocolVersion: 1 | null` et capability de possession pour
  les contrats N+1 ;
- compatibilité exacte avec un mobile N qui omet le champ ;
- gates cumulatives, évaluées avant `reserve` :
  - master env `BOB_AGENT_MISSIONS_QUOTE_V1_ENABLED`,
  - release flag `bob.agent_missions.quote.v1` pour le vrai `userId`,
  - keyrings sujet Bob Live et fingerprint AgentMission prêts,
  - allowlist serveur fournisseur/transport/mode certifiée pour Mission V1 ;
- capability aléatoire 256 bits, hashée dans la lease, rendue une seule fois au bootstrap, gardée
  uniquement en mémoire mobile et interdite aux logs, métriques, traces et crash reports ;
- persistance atomique de la version, du hash de capability et de la version de release flag dans
  `RealtimeSessionLease` ;
- reçu de bootstrap durable, idempotent et lié à la même capability, obligatoire avant exposition
  du handle au transport ou autorité Mission ;
- autorité HTTP request-scoped dérivée du JWT et des HMAC serveur ;
- revalidation de la lease dans la même UoW que chaque lecture/mutation Mission ;
- use case et route `screen-acks` ;
- event `screen_acknowledged` corrélé à session/contexte ;
- codecs serveur et client exacts ;
- barrière mobile : une réponse N+1 absente ou discordante ferme le bootstrap avant micro/uplink ;
- migrations expand/validate, RLS/ACL, writer N-1 et certification PostgreSQL réelle ;
- état persistant des flags/environnements inchangé : le lot reste OFF partout hors fenêtre de
  certification staging interne, immédiatement refermée et attestée.

### Exclus

- recherche client 0/1/N, décisions client et catalogue ;
- orchestration de tours LLM, `turn_settled` et parole canonique ;
- `AgentMissionProvider` React complet, sheets et intégration du wizard devis ;
- lignes de devis, M2, émission ou action financière ;
- scheduler d'expiration/purge ;
- changement de fournisseur ou activation Mistral V3 ;
- activation d'un compte, staging public, production ou promesse marketing ; seule une activation
  staging interne, bornée au smoke de certification puis remise à OFF, est autorisée.

## 4. Décisions d'architecture

### 4.1 Capability de possession liée à la lease

Le JWT ne prouve pas que la requête provient du terminal ayant admis la session Bob Live. M1-B
ajoute donc une capability opaque de possession :

- 32 octets générés par CSPRNG serveur, encodés sans padding en
  `bam1_<43 caractères base64url>` ;
- secret retourné une seule fois dans le bootstrap N+1 ;
- seul son SHA-256 canonique est persisté dans `RealtimeSessionLease` ;
- le résultat d'admission atteste ce hash dans une preuve sibling séparée de
  `RealtimeAdmissionLease` ; l'orchestrateur compare preuve, version et décision avant de rendre
  le secret, afin qu'aucun spread de lease ne le propage vers lifecycle/ticket/release ;
- secret conservé uniquement en mémoire volatile mobile, jamais dans AsyncStorage, SecureStore,
  SQLite, logs, métriques, traces, analytics ou crash reports ;
- secret présenté dans `X-Bob-Agent-Mission-Capability` sur chaque route Mission.

Le décodeur `HttpBobClient` est la seule frontière mobile qui voit le secret wire. Après décodage
strict, il envoie obligatoirement le reçu de bootstrap authentifié par JWT + capability. Il
n'encapsule et ne retourne le secret dans un handle de session opaque, non sérialisable, qu'après
succès ou rejeu idempotent de ce reçu. Le champ privé du handle ajoute lui-même le header aux
méthodes Mission et `dispose()` efface la référence. Ni le DTO remis à React ni les transports
n'exposent une chaîne de secret. Le transport transfère ce handle une seule fois au
`RealtimeSessionController`, qui en devient l'unique propriétaire et le dispose avant tout
`await` sur erreur, abort, fallback, background, hangup, logout ou changement d'identité. Une
méthode appelée après dispose échoue localement avant réseau. Les clients local/in-memory de test
implémentent le même contrat mais ne fabriquent jamais de capability.

La remise du secret est volontairement **at-most-once** ; son acquisition d'autorité est
**at-least-once idempotente** par le reçu explicite. Une réponse bootstrap perdue avant réception
du secret n'est jamais rejouée à partir du hash durable, qui ne permet pas de le reconstruire. Une
réponse de reçu perdue est rejouée une fois par le client avec la même capability tant que la
courte fenêtre de réception est vivante. Le budget de réservation couvre le bootstrap serveur,
deux tentatives de reçu de quatre secondes et une seconde de marge ; une configuration plus courte
échoue au boot. Avant reçu, `activate` conserve `leaseExpiresAt` comme deadline de réception
issue du TTL de réservation et `renew` ne la prolonge jamais. À expiration, le reaper existant
claim la lease, termine le provider puis la supprime. Le client repart ensuite uniquement après un
nouveau geste utilisateur et avec un nouveau `sessionHandle`; le produit ne présente pas ce cas
comme une reprise transparente.

L'autorisation reste la conjonction de faits que le client ne peut pas choisir :

- principal JWT request-scoped ;
- `companyId` et `userId` dérivés du principal ;
- `principalBindingHash = SHA-256("bob.agent-mission.principal-lock.v1\0" + companyId + "\0" +
userId)` dérivé côté serveur, jamais persisté ni loggé ;
- tous les `subjectHash` HMAC calculés côté serveur depuis les versions retenues du keyring Bob
  Live ;
- hash de la capability présentée ;
- lease durable V1 active et non expirée correspondant à exactement un candidat.

`sessionHandle`, tenant, owner, version, digest et hash fournis par le client ne sont jamais une
preuve. Lors de **toute** admission serveur N+1, y compris champ omis, `null` et Mistral, le serveur
prend d'abord un advisory lock tenanté sur
`principalBindingHash`, stable et indépendant des versions HMAC, via
`pg_advisory_xact_lock` **dans la transaction**. Il verrouille ensuite toutes les lignes candidates
par ordre `subjectHash, sessionId` avant de décider ou d'insérer ; le verrou stable protège aussi
**l'absence** de ligne, donc deux admissions concurrentes ancien/nouveau HMAC convergent vers une
seule lease active. L'input distingue le binding HMAC courant, seul autorisé pour un nouvel
`INSERT`, de la liste courant+historiques. Recherche de lease, replay de `sessionId` et quotas
utilisateur minute/heure agrègent toute cette liste : une rotation ne remet ni la session active ni
les quotas à zéro.

Une annulation explicite est une autorité, même si elle atteint le serveur avant l'`INSERT` de la
lease. `claimTermination` prend donc le même verrou stable et écrit, dans la même transaction, un
fence d'annulation pour chaque hash sujet courant/historique. Zéro lease n'est déclaré terminé
qu'après le commit de ces fences. `reserve` refuse tout fence vivant correspondant au
`sessionHandle`, et un trigger `BEFORE INSERT` applique le même refus aux writers N-1 qui ne
connaissent pas encore la table. Les fences expirent deux heures après la première annulation ;
un retry idempotent ne prolonge pas ce délai. Si une rotation HMAC ajoute un candidat lors d'un
retry, le nouveau fence hérite du plus ancien `cancelledAt` encore présent et de sa même échéance :
la rotation ne recrée jamais une fenêtre de deux heures. Ils ne comptent ni dans les quotas, ni
dans la capacité, et ne contiennent ni `userId`, ni `principalBindingHash`, ni secret/token.

Le déploiement qui introduit ce protocole suit un cutover en deux phases :

1. `predeploy` ferme les nouvelles admissions Bob Live et, si le prédécesseur ne publie pas encore
   `realtimeAdmissionCancellationFence=v1`, attend l'autorité globale `closed|0` avant d'appliquer
   l'expand puis la validate ;
2. le pipeline déploie N, prouve l'unique réplique, la readiness du SHA/environnement exacts, la
   capability d'annulation `v1` et `agentMissionBootstrapReceipt=v1`, puis exécute immédiatement
   le `postdeploy` comme unique autorité de réouverture ;
3. `postdeploy` est une phase explicite obligatoire, ferme avant le build et toute mutation
   d'autorité, exige la bijection stricte entre toutes les migrations locales et appliquées,
   n'appelle jamais `prisma migrate deploy`, recertifie le schéma sous le nouveau binaire et ne
   rouvre qu'en dernier geste.

Entre les étapes 1 et 3, `closed` est un état de rollout attendu, pas une absence d'autorité. Le
nouveau processus N peut terminer son boot si l'inspector runtime relit un snapshot durable
`closed` valide. Ce snapshot peut encore porter les bindings N-1 et des sessions en drainage lors
d'une release suivante ; au premier cutover, le protocole ci-dessus exige séparément `closed|0`.
Cette attestation structurelle ne vaut jamais ouverture : le préflight SQL exige toujours
`active` et les bindings N exacts dans la transaction de réservation, et reste l'unique autorité
d'admission. Un état `tracking`, une inspection indisponible ou un état `active` divergent font
échouer le boot. Dans cette fenêtre, `/health/ready` prouve le binaire, ses dépendances et ses
capabilities sous admissions fermées ; seul `postdeploy` applique les bindings N et fait passer
l'autorité à `active`.

Sur les releases suivantes, un prédécesseur qui publie déjà la capability ferme toujours les
nouvelles admissions, mais ses sessions vivantes peuvent terminer pendant le rollout sans imposer
un drain zéro préalable. Le trigger protège un INSERT N-1 après qu'un pod N a posé le fence ; aucun
mécanisme DB ne peut en revanche inventer le fence d'un ancien pod qui a déjà traité un hangup sans
écriture.

Lors d'une requête HTTP Mission, l'UoW lit/verrouille d'abord toutes les leases correspondant aux hashes
candidats **sans filtrer par capability**, puis exige exactement une lease V1 active et vivante.
Cette lease doit porter un reçu de bootstrap non nul. Seulement ensuite, elle compare en temps
constant son hash stocké au hash de la capability présentée. Zéro ou plusieurs leases, reçu absent
ou hash différent échouent fermés avant tout accès Mission.

### 4.2 Éligibilité figée à l'admission

Le master flag et la readiness statique sont évalués avant `reserve`. Le release flag réel du
`userId` est d'abord évalué par le use case domaine existant sous
`persistence.runWithIdentity(userId)` : la route Realtime étant hors transaction tenant
interceptor, une lecture sans cette identité serait un faux `missing` sous FORCE RLS. Une décision
ON transporte seulement la clé, l'environnement, la version attendue et le `principalBindingHash`
calculé pour **ce même** couple société/utilisateur vers l'admission — jamais le `userId` brut. La
transaction exige l'égalité exacte entre ce binding et celui de la demande de réservation. Une
décision valide pour un principal ne peut donc pas être réutilisée pour un autre.

Dans la transaction d'admission, la ligne parente du flag est relue et verrouillée `FOR SHARE`;
clé, environnement, version et absence de kill switch doivent être identiques. Toute mutation du
global, du kill switch ou d'un override utilisateur/cabinet prend cette ligne parente `FOR UPDATE`
et incrémente sa version **dans la même transaction** que l'écriture de l'override. Les écritures
directes sur `release_flag_subjects` hors scripts opérateur explicitement allowlistés sont interdites
par ACL et par test de contrat.
Une dérive fait échouer l'admission entière, sans downgrade. La version autoritaire verrouillée est
écrite avec la décision. Cette revalidation est placée immédiatement avant le preflight de capacité
et l'`INSERT` afin de garder le verrou opérateur le moins longtemps possible sans rouvrir le TOCTOU.

Le runtime tenanté ne reçoit pas un `SELECT` élargi sur les tables de flags. L'adapter appelle dans
la transaction une fonction DB privée/bornée `revalidate_agent_mission_release_flag_v1` qui ne
retourne aucune donnée de flag : elle verrouille la ligne parente `FOR SHARE` et confirme seulement
clé+environnement+version+kill-switch. Cette fonction est obligatoirement `SECURITY DEFINER`,
possédée par un rôle dédié `NOLOGIN`, sans SQL dynamique, avec toutes les références de tables
schema-qualified et `SET search_path = pg_catalog`. Son `EXECUTE` est révoqué de `PUBLIC`, `anon`,
`authenticated` et `service_role`, puis accordé explicitement au seul rôle runtime sous l'owner
Supabase ; une certification tente une substitution de `search_path` et une escalade.

Le repository runtime de flags devient strictement **read-only** (`findByKey`) : les méthodes
`lockByKey/save`, non appelées par le produit et divergentes entre Prisma et mémoire, sont retirées
du port exposé. Les scripts opérateur privilégiés persistent les overrides `user` et `cabinet` avec
parité create/update/delete. Le trigger de suppression cabinet suit le même protocole
parent-lock/version/audit ; aucun cleanup ne contourne l'invalidation. Le flag
`bob.agent_missions.quote.v1` est créé OFF pour chaque environnement par migration additive, sans
override ni activation.

Une lecture préliminaire hors transaction peut éviter du travail, mais ne peut jamais autoriser à
elle seule. La décision `1 | null`, le hash de capability et la version du flag font partie de
l'`INSERT` de la lease avant tout bootstrap retourné. Il n'existe aucun endpoint d'upgrade tardif.

Une indisponibilité ou absence du release flag négocie explicitement `null`. En revanche, master ON
avec keyring, migration, provider/transport allowlist ou dépendance obligatoire partielle fait
échouer le boot ou l'admission : une configuration invalide ne se déguise jamais en parcours
historique.

Conformément à ADR-0006, le release flag est le kill switch qui ferme les **nouvelles admissions** ;
il ne réécrit pas une lease déjà admise et ne coupe pas brutalement une session en cours. Une
capability expire avec la lease. Le master env est un hard-disable de configuration : s'il a déjà
été actif, il ne peut repasser à OFF et retirer le keyring qu'après drain prouvé de toutes les
leases V1. Une coupure immédiate relève d'une future commande durable de terminaison.

### 4.3 Négociation exacte N/N-1

La requête initiale a trois formes distinctes :

| Requête                             | Réponse                                     | Effet                                               |
| ----------------------------------- | ------------------------------------------- | --------------------------------------------------- |
| champ omis                          | réponse historique sans les deux clés       | mobile N inchangé                                   |
| `agentMissionProtocolVersion: null` | version `null`, capability `null`           | parcours historique explicitement négocié           |
| `agentMissionProtocolVersion: 1`    | `1` + secret si éligible, sinon deux `null` | capability durable ou parcours historique explicite |

Une réponse N+1 porte exactement les deux clés `agentMissionProtocolVersion` et
`agentMissionCapability`, soit toutes deux nulles, soit `1` et un secret canonique. Toute autre
combinaison, valeur absente/inconnue/discordante, timeout, 5xx ou rejet ferme la session avant
l'ouverture du micro ou de l'uplink **sans bascule legacy ni Mistral**. Seul un `null/null`
explicitement négocié autorise le parcours historique.

Tous les transports qui utilisent le endpoint commun doivent parser ces champs. Le serveur possède
l'allowlist `provider + transport + mode` certifiée pour Mission V1 ; le client ne peut pas
s'auto-certifier. Pour M1-B, elle contient uniquement `openai + webrtc +
openai-native-webrtc-v1` et `openai + webrtc + audited-signed-url-v1` ; tous les modes Mistral
reçoivent `null/null`. La version mission reste orthogonale à la configuration acoustique, à la
voix choisie et au futur wire hybride V5.

### 4.4 Transaction Mission autorisée

Le port `AgentMissionUnitOfWorkPort` reçoit une preuve serveur contenant uniquement les hashes
sujet candidats dérivés, le `principalBindingHash` et le hash de la capability présentée. Avant
d'exposer les repositories Mission, une mutation :

1. transaction owner/tenant isolée ;
2. `Company FOR SHARE` pour un writer ;
3. verrou advisory owner+kind ;
4. lecture et verrouillage de **toutes** les leases correspondant aux hashes candidats, filtrées
   par tenant, sans filtre capability et par ordre `subjectHash, sessionId` identique à
   l'admission ;
5. dans cet ensemble verrouillé, filtrage des seules leases `state=active`, TTL/hard TTL vivants,
   `agentMissionProtocolVersion=1`, reçu de bootstrap non nul, binding exact non nul et release
   flag versionné ;
6. exigence d'exactement une lease ainsi admissible, puis comparaison en temps constant du hash de
   capability. Une ancienne candidate expirée, historique ou `reaping` n'est pas choisie et ne rend
   pas ambiguë l'unique lease active.

Un refus ne lance aucune requête sur `agent_missions`, `agent_mission_events` ou
`quote_draft_slots`. Le `GET` utilise une transaction `REPEATABLE READ READ ONLY` stricte : preuve
de lease et lecture Mission appartiennent au même snapshot, sans `FOR SHARE` ni écriture. Chaque
mutation verrouille la lease de manière compatible avec terminaison/reaper afin d'éliminer le
TOCTOU. `agentMissionProtocolBoundAt` reprend exactement le `reservedAt` DB de la lease dans le
même `INSERT`, pas une horloge client, un second `now()` ni un timestamp recalculé.

## 5. Schéma additif

`realtime_session_leases` reçoit, sans backfill :

```text
agentMissionProtocolVersion    INTEGER NULL
agentMissionProtocolBoundAt    TIMESTAMPTZ NULL
agentMissionCapabilityHash     CHAR(64) NULL
agentMissionReleaseFlagVersion INTEGER NULL
agentMissionBootstrapAcknowledgedAt TIMESTAMPTZ NULL
```

CHECK :

- les quatre colonnes sont nulles ensemble ou non nulles ensemble ;
- la seule version non nulle est `1` ;
- le hash est exactement 64 caractères hexadécimaux minuscules ;
- la version de release flag est positive ;
- `agentMissionProtocolBoundAt = reservedAt` exactement ;
- aucune FK Mission → lease ;
- aucun backfill ne transforme une lease historique en capability ;
- un writer N-1 qui omet les quatre colonnes continue à écrire quatre `NULL` ;
- une négociation `null/null` insère explicitement quatre `NULL`.
- le reçu reste `NULL` pour tout writer historique et toute lease V1 avant acquittement ;
- seul le passage `NULL → clock_timestamp()` est autorisé, exactement une fois, sur une lease V1 ;
- un reçu non nul est fini, postérieur ou égal au binding et antérieur ou égal au hard cap ;
- le rejeu exact ne réécrit ni le reçu ni la deadline active.

Une table additive porte le fence de course hangup/bootstrap :

```text
realtime_admission_cancellation_fences
  companyId     TEXT
  sessionId     UUID
  subjectHash   CHAR(64)
  cancelledAt   TIMESTAMPTZ
  expiresAt     TIMESTAMPTZ
  PRIMARY KEY (companyId, sessionId, subjectHash)
```

- une annulation insère tous les hashes candidats avec `ON CONFLICT DO NOTHING` ;
- `expiresAt = cancelledAt + 2 heures`, sans `UPDATE` ni prolongation ;
- index `(companyId, expiresAt, sessionId, subjectHash)` pour purge bornée ;
- `FORCE ROW LEVEL SECURITY`, policy tenant et ACL runtime `SELECT/INSERT/DELETE` seulement ;
- `PUBLIC`, `anon`, `authenticated`, `service_role` et le reaper global n'ont aucun accès direct ;
- le trigger de lease refuse tout triplet possédant un fence vivant ;
- l'annuaire reaper inclut la prochaine expiration de fence et la purge est paginée.

La contrainte est créée `NOT VALID`, puis validée dans une migration ultérieure. Chaque migration
commence par `SET LOCAL lock_timeout` et `SET LOCAL statement_timeout`. La liste de valeurs du
`CHECK` est générée depuis la source TypeScript, jamais recopiée à la main.

## 6. Contrats HTTP exacts

```text
POST /voice/realtime/calls
  body N+1 : { agentMissionProtocolVersion: 1 | null, ...contrat existant }
  response N+1 : {
    agentMissionProtocolVersion: 1 | null,
    agentMissionCapability: string | null,
    ...bootstrap existant
  }

POST /voice/realtime/calls/:sessionHandle/agent-mission-bootstrap-acknowledgements
  header X-Bob-Agent-Mission-Capability: <secret canonique>
  body absent
  response {
    acknowledged: true,
    replayed: boolean
  }

GET /agent-missions/current/quote-creation
  header X-Bob-Agent-Mission-Capability: <secret canonique>
  body absent

POST /agent-missions/quote-creation/start
  header X-Bob-Agent-Mission-Capability: <secret canonique>
  body { commandId }

POST /agent-missions/:missionId/screen-acks
  header X-Bob-Agent-Mission-Capability: <secret canonique>
  body {
    commandId,
    expectedMissionRevision,
    realtimeSessionId,
    contextRevision,
    contextDigest,
    draftSessionId,
    expectedDraftSlotRevision,
    expectedDraftContentRevision
  }

POST /agent-missions/:missionId/cancel
  header X-Bob-Agent-Mission-Capability: <secret canonique>
  body { commandId, expectedMissionRevision }
```

Le reçu de bootstrap dérive tenant, owner, bindings HMAC et `principalBindingHash` côté serveur,
verrouille les candidats dans le même ordre que l'admission, exige exactement une lease V1
`active`, liée au provider, vivante, non `reaping`, puis compare la capability en temps constant.
Il écrit une seule fois le timestamp DB et convertit atomiquement la deadline courte en TTL actif.
Un rejeu exact répond `200` sans écriture ni prolongation ; mauvaise capability, ambiguïté,
expiration et état invalide échouent sous une erreur générique sans révéler la cause.

Les champs de `screen-acks` sont des fences attendues, jamais l'autorité. La route relit les faits
réels dans la même transaction. Le header est obligatoire, borné et parsé canoniquement avant
l'appel métier ; sa valeur n'est jamais reflétée dans une erreur.

## 7. ACK écran autoritaire

Pour accepter `screen-acks`, la transaction exige :

- même société et propriétaire pseudonymisé ;
- lease active, non expirée, protocole mission V1 ;
- `realtimeSessionId` attendu égal à la lease réellement autorisée ;
- contexte publié complet ;
- `contextRevision === contextAppliedRevision` ;
- `contextDigest === contextAppliedDigest` ;
- `contextAppliedOwnerEpoch === sidebandOwnerEpoch` ;
- `sidebandOwnerLeaseExpiresAt > clock_timestamp()` au moment du verrou ;
- le payload stocké est reparsé par `parseAgentContext`, recanonisé puis rehashé par
  `prepareRealtimeContext` ; son digest recalculé égale le digest appliqué et attendu ;
- le contexte reparsé porte `screen.name === '/devis/new'` ;
- `screen.instanceId` canonique et borné ;
- draft possédé par cette mission ;
- `draft.sessionId`, slot revision et content revision égaux aux fences attendues ;
- la présence réelle du client dans le draft détermine seule la phase suivante.

Succès :

- transition pure `AgentMission.acknowledgeQuoteScreen()` ;
- `currentBinding` construit depuis la lease et l'horloge DB ;
- CAS mission `revision + 1` ;
- event `screen_acknowledged` append-only avec `realtimeSessionId`,
  `contextRevision`, `contextDigest`, `actor=system`, `turnId=null`, sans transcript ni donnée
  client.

Replay exact :

- même `commandId` + même fingerprint → vue autoritaire, aucune écriture ;
- même `commandId` + contenu différent → `idempotency_conflict` ;
- faute après n'importe quelle écriture → rollback de l'ensemble.

Le fingerprint couvre uniquement la sémantique rejouable : opération, mission, principal et toutes
les fences du body. Version protocole, version de flag, capability et hash de capability sont des
preuves d'authentification réévaluées à chaque requête, jamais des données métier du fingerprint.

### 7.1 Cycle de vie fail-closed

- abort avant remise du bootstrap : aucune ouverture micro/uplink, handle mobile disposé s'il
  existe et lease libérée/terminée par le chemin autoritaire ;
- bootstrap V1 reçu mais reçu durable non acquitté : aucun handle n'est exposé, aucun heartbeat ne
  prolonge la lease et aucune opération Mission n'est autorisée ; échec/abort du reçu déclenche le
  hangup de la session et reste fatal sans fallback ;
- réponse N+1 absente, mal formée, inconnue, timeout ou 5xx : résultat racine
  `fail_closed(agent_mission_negotiation_failed)`, non reconnectable et sans repli legacy/Mistral ;
- background, hangup, logout ou changement d'identité : le controller mobile dispose synchroniquement le
  handle **avant tout `await`**, puis termine/libère la session ;
- toute terminaison serveur — requête HTTP, fermeture sideband, kill-switch, heartbeat perdu,
  hard cap ou shutdown — passe d'abord la lease à `reaping` sous claim durable possédé, puis
  appelle le provider avec l'identité de ce claim et ne complète qu'avec son `reaperToken` ;
  aucun lifecycle process-local n'appelle le provider avant ce claim. Une capability liée à une
  lease `reaping`, terminée ou expirée est refusée ;
- un handle est transférable une seule fois au controller, non copiable et inutilisable après
  `dispose()`.

## 8. Keyrings et configuration

Bloc tout-ou-rien :

```text
BOB_AGENT_MISSIONS_QUOTE_V1_ENABLED=false
BOB_AGENT_MISSION_HMAC_KEY_VERSION=<int>
BOB_AGENT_MISSION_HMAC_KEYRING={"<version>":"<secret dédié>"}
```

Règles :

- master absent/`false` : les deux variables de keyring AgentMission sont absentes ;
- master `true` : keyring complet, version active présente, secrets sans placeholder ;
- passage d'un environnement déjà actif à master `false` interdit tant que le drain des leases V1
  n'est pas prouvé : le manager prend le verrou exclusif, relit le floor durable et, si
  `writerEnabled=true`, exige la capacité `closed|0` puis persiste `writerEnabled=false` dans la
  même transaction. Un environnement jamais stageé et un retry OFF observant déjà
  `writerEnabled=false` sont des no-op ; tout writer reste refusé par le trigger tant que ce fence
  durable est désarmé. Le release flag OFF reste le mécanisme normal de fermeture des admissions ;
- secret dédié, distinct de sujet/preuve/usage/contrôle/audit Bob Live ;
- le manager applique le même prérequis que le boot (`Bob Live actif + provider OpenAI`) et vérifie
  la dédication face aux scalaires et keyrings Bob Live **avant** toute insertion append-only ;
- chaque secret canonique est engagé par une empreinte SHA-256 domain-separated de ses 32 octets
  décodés dans un registre global append-only ; une même version ne peut jamais désigner un autre
  matériau et un même matériau ne peut pas être réutilisé sous une autre version ;
- le rituel `stage` privilégié prend le verrou advisory exclusif
  `bob-agent-mission-fingerprint-hmac-v1`, relit d'abord toutes les versions retenues et refuse
  toute version sans binding **avant le premier INSERT**. Il insère ensuite sans écrasement les
  bindings configurés, puis relit et compare exactement chaque empreinte et version retenue avant
  d'armer un floor writer monotone `[N,N]` ou `[N,N+1]`. Au premier stage d'une version `N+1`, la
  présence de la clé adjacente `N` arme directement `[N,N+1]` afin de ne jamais couper le writer
  précédent ; si cette clé n'est pas configurée, `closed|0` est exigé avant d'armer
  `[N+1,N+1]` ;
- chaque writer d'event prend le verrou advisory partagé du même keyspace ; avant le tout premier
  floor, la forme N-1 reste compatible, mais le stage exclusif attend ces writers puis inclut tous
  leurs events dans son snapshot. La transaction manager est `READ COMMITTED` : la lecture
  pré-binding prend son snapshot **après** l'attente du verrou exclusif, afin de voir le commit du
  dernier writer partagé. Si cet event historique n'avait pas déjà un binding durable, le stage
  échoue sans aucune mutation : le secret fourni au déploiement ne peut pas devenir
  rétroactivement la preuve d'un ancien HMAC. Une fois cette lecture passée, le verrou exclusif
  reste possédé jusqu'au commit ; le trigger partagé empêche donc tout nouvel event de s'intercaler
  entre la preuve et les INSERT de binding/floor. Le trigger writer est explicitement `VOLATILE`,
  réarmé et certifié à chaque provisionnement : ses sous-requêtes prennent un snapshot frais après
  l'attente du verrou partagé, même si une dérive DDL avait tenté de le rendre `STABLE`. Après
  stage, toute version hors floor ou sans binding est refusée. Une écriture tardive et une rotation
  concurrente ne peuvent donc pas contourner le snapshot ;
- `stage(N+1)` est la seule transition qui étend `[N,N]` vers `[N,N+1]`. `retire(N)` exige la
  capacité Bob Live `closed|0` verrouillée dans la même transaction, puis ferme durablement le
  floor en `[N+1,N+1]` avant que le secret N puisse être retiré de la configuration. Pendant la
  fenêtre `[N,N+1]`, le runtime N reste volontairement admis et un replay de `stage(N)` ne réduit
  jamais le floor ; le `postdeploy` du SHA N+1 exécute `retire` après toutes les certifications et
  avant la réouverture. Un retry de ce retire déjà commité est idempotent ;
- la readiness runtime prend ce verrou en partagé et compare les bindings durables aux secrets
  configurés, y compris les versions encore référencées par un event ; une version retirée,
  non liée ou liée à un autre matériau fait échouer le boot. L'appelant arme explicitement
  `lock_timeout=1s` et `statement_timeout=3s`, et un index btree exact sur
  `agent_mission_events.fingerprintKeyVersion` sert au plus 33 probes récursifs `min puis > N`
  par index seek ; aucun `DISTINCT` n'épuise le journal à chaque boot ;
- retirer une ancienne version de la configuration exige le floor déjà retiré, zéro event retenu
  sous cette version et le drain de tous les writers qui pouvaient encore l'émettre ; les bindings
  restent append-only et ne sont jamais supprimés ;
- aucune valeur réelle n'est committée ;
- **[BLOQUÉ FONDATEUR : keyring HMAC AgentMission de production et destination de secrets
  approuvée]** ;
- compte technique staging provisionné par le vrai onboarding et épinglé dans le secret store
  GitHub `staging` ; son identité exacte ne doit jamais être committée. Ce prérequis est soldé
  pour staging et reste distinct de toute future identité production ;
- **[BLOQUÉ FONDATEUR : autorisation explicite, datée et rattachée à son canal, de modifier la
  ligne correspondante dans `MATRICE_FLAGS_V1.md`]** ;
- le blocage n'empêche pas d'implémenter ni de tester le chemin OFF et les tests avec secrets
  éphémères ; sans smoke staging positif, le statut maximal reste `implemented`.

### 8.1 Fenêtre de certification staging et rollback exact

La stabilisation du bootstrap ambigu et le remplacement des appels transitifs au rituel global
par un gate M1-B ciblé sont spécifiés dans
`SPEC_M1B_STAGING_STABILIZATION.md`. Ce raffinement est normatif pour cette fenêtre : staging doit
déjà porter le train M1-A/M1-B exact, toute migration en attente échoue fermée, et aucune
recertification M1-B ne peut appeler `release.sh` ou réparer un protocole étranger.

La certification positive est une opération bornée, `workflow_dispatch` uniquement, sur le SHA
candidat. Elle possède son propre workflow staging et ne réutilise pas le pipeline Railway
générique : elle ne lance ni audit archive, ni cutover settlement/outbox, ni mutation d'un autre
protocole. Comme GitHub ne distribue un nouveau `workflow_dispatch` qu'après présence du fichier
sur la branche par défaut, le workflow Railway déjà publié expose uniquement un choix de routage
`m1b-staging-certification` : sur la branche candidate, ce choix appelle le workflow M1-B local
réutilisable et désactive entièrement le job de release générique. Ce trampoline permet la preuve
staging **avant** merge sans faire exécuter le pipeline Railway général.

Préconditions fail-closed :

- environnement GitHub exact `staging`, concurrence repository-global
  `railway-api-staging`, identique au pipeline Railway staging générique,
  `cancel-in-progress=false` et aucun changement Railway déjà stageé ;
- projet, environnement et service Railway ciblés par leurs UUID sur **chaque** commande CLI
  (`--project`, `--environment`, `--service`) ; aucune commande `railway link`, aucun export
  `RAILWAY_ENV` — ce nom sélectionne le backend de la CLI et ne désigne pas l'environnement Bob ;
- cluster Supabase staging épinglé par son project ref, son `system_identifier`, son OID de base et
  son nom de base attendus dans les variables GitHub staging. Avant **chaque** migration ou
  mutation de flag, un opérateur interroge `DIRECT_URL` et `DATABASE_URL`, exige la même primaire
  inscriptible, les quatre identités exactes, le rôle runtime non-superuser/sans `BYPASSRLS` et
  l'origine `SUPABASE_URL=https://<project-ref>.supabase.co` ; une simple paire cohérente mais
  pointant vers un autre projet est refusée ;
- compte interne dédié, provisionné par le vrai use case d'onboarding : `company_id` du JWT égal
  à la société attendue, société ouverte, abonnement persistant actif autorisant `voice_live`,
  réglages de facturation et dossiers initiaux présents, sans mission active ni brouillon de devis
  préexistant. Le harness refuse de fabriquer cet entitlement, de supprimer, préempter ou
  « nettoyer » une donnée qu'il n'a pas créée lui-même ;
- immédiatement après la validation du SHA/inputs et l'installation du runtime Node — **avant**
  installation des dépendances, build, déploiement Whisper ou mutation Railway — le workflow
  s'authentifie réellement comme ce compte, revalide le JWT et la société puis exige que
  `GET /voice/realtime/config` rende `available=true`, `transport=webrtc` et un mode OpenAI
  supporté. Un refus publie seulement une cause bornée (`disabled`, `not_entitled`,
  `entitlement_unavailable` ou contrat incompatible), jamais email, identifiant, token, modèle ou
  secret. Le job `certify` s'arrête alors avant toute installation, compilation ou mutation ;
  le job `cleanup`, volontairement `always()` et autonome, continue toutefois ses vérifications
  et peut prendre plusieurs minutes même quand aucune activation n'a eu lieu ;
- Bob Live OpenAI, sa capacité et son auditeur Whisper Bob-managed privé déjà complets dans
  staging, ou livrés et certifiés par le même SHA candidat avant l'ouverture de la fenêtre
  positive. La fenêtre M1-B ne bascule pas le provider et ne remplace aucun secret Bob Live ;
- autorisation fondateur datée+canal, identité exacte du compte et contre-signature Claude+GPT de
  la ligne de matrice fournies comme entrées distinctes, non inférées par le workflow ;
- keyring AgentMission **stable pour staging** conservé dans le secret store GitHub staging. Le
  secret n'est pas régénéré à chaque run : le registre d'empreintes et les events sont append-only,
  donc une version déjà liée doit toujours retrouver exactement le même matériau. Après le test,
  le bloc est retiré de Railway mais reste dans ce coffre approuvé pour un prochain run. Cette clé
  staging n'est jamais une clé production.

Le préflight est aussi valide sur un staging encore en N-1 : l'absence du flag canonique n'est
acceptée que si la migration additive qui le crée n'est pas marquée terminée dans
`_prisma_migrations` et si le bloc Railway M1-B est absent. L'état impossible « migration terminée
mais flag absent » comme l'état « flag présent avant sa migration » échouent fermés. Ce mode
bootstrap ne vaut jamais preuve de flag OFF : immédiatement après `predeploy`, le workflow exige
la migration terminée, une ligne canonique unique, global OFF, kill-switch libre et zéro override
**actif**, ainsi que l'absence de toute ligne attachée au compte cible, avant de déployer le
candidat. Les lignes désactivées d'autres sujets ne confèrent aucune autorité et restent intactes :
ce lane n'efface jamais l'historique ou l'état d'un autre compte. Le cleanup `always()` applique la
même distinction afin qu'un échec antérieur aux migrations puisse être attesté propre sans appeler
une table ou une fonction encore absente ; dès qu'une migration est terminée, seule la preuve
stricte de son état OFF est admise.

Le run staging OFF `30306792678` a appliqué la première numérotation M1-B avant que le train
chantiers/contacts n'ajoute sur `main` des migrations allant jusqu'à `20260727120000`. Le rebase
final déplace donc les onze migrations M1-B, encore absentes de production, dans la plage
`20260727130000` → `20260727230000`. Staging est réconcilié une seule fois sans rejouer de SQL :
transaction verrouillée sur `_prisma_migrations`, identité de base exacte, onze anciennes lignes
terminées/non rollbackées, onze checksums SHA-256 identiques aux fichiers et onze nouvelles clés
absentes ; seule `migration_name` change selon la table de correspondance revue. Toute différence
de cardinalité, checksum, état ou identité annule la transaction. La preuve post-opération exige
les onze nouveaux noms, les mêmes checksums et l'absence des anciens noms. Production ne reçoit
aucune réconciliation : elle applique directement la lignée finale dans l'ordre canonique.
L'opérateur idempotent
`apps/api/scripts/agent-mission-m1b-staging-migration-reconcile.mjs` a été appelé une seule fois
pendant la réparation tracée de staging et revalidait l'identité dans sa propre transaction afin
de fermer la fenêtre TOCTOU. Une fois cette réparation acquittée, il reste dans le dépôt comme
preuve auditée mais sort définitivement du lane M1-B : le workflow exige désormais la lignée
finale et ses checksums exacts, sans aucune mutation de `_prisma_migrations`. Un état ancien,
mixte, divergent ou incomplet échoue fermé avant le gate.

La négociation WebRTC OFF finale n'est exigée que si un deployment du binaire M1-B a réellement
été acquitté `SUCCESS` par Railway — un identifiant créé ne vaut pas cet ACK — ou si le bloc
runtime a été possédé ; avant cela, absence des variables, migration
encore absente et zéro override constituent la preuve exacte, sans demander au binaire N-1 un
champ de protocole qu'il ne connaît pas. Ici aussi, « zéro override » signifie zéro override actif
et aucune ligne du compte cible ; les lignes désactivées étrangères sont hors propriété du run.

Chaque opérateur `psql` de ce lane garde l'URI et le mot de passe hors de `argv`. L'URI est
décomposée en paramètres libpq explicitement allowlistés ; le mot de passe vit uniquement dans un
`PGPASSFILE` temporaire `0600`, supprimé en `finally` après le processus synchrone. Une option URI
non supportée, un fichier impossible à créer ou un cleanup de secret impossible échoue fermé avant
de qualifier la preuve.

Le bootstrap du keyspace HMAC distingue deux lignées N-1 valides et seulement elles :

- avant M1-A, les migrations `agent_missions_expand` et `agent_missions_validate` sont toutes deux
  absentes et les tables mission/event sont toutes deux absentes ;
- après M1-A, ces deux migrations sont toutes deux terminées, les deux tables existent et une
  lecture exacte prouve zéro mission et zéro événement conservé. Inventaire des migrations/objets
  et présence des lignes proviennent du même snapshot PostgreSQL `REPEATABLE READ`, avec
  `row_security=off` sous un `DIRECT_URL` préalablement certifié `SUPERUSER|BYPASSRLS` : aucun
  double snapshot ni policy tenantée ne peut fabriquer un faux état vierge.

Dans les deux cas, la migration de readiness M1-B n'est pas terminée et ses deux tables ainsi que
ses quatre fonctions sont toutes absentes. Une seule migration M1-A terminée, une seule table
présente, un objet readiness isolé ou une mission/un événement conservé échoue fermé : le bootstrap
ne lie jamais rétroactivement un événement historique à un secret HMAC non prouvé. Une migration
readiness terminée exige inversement la lignée M1-A complète et chaque objet readiness avant
d'appeler sa fonction de preuve.

Quand la migration readiness est déjà terminée, l'inventaire bootstrap et l'appel de readiness
utilisent deux sessions bornées distinctes. Cette tolérance staging n'est valide que sous la
concurrence GitHub exclusive **et** en l'absence de migration, rotation/stage/retrait de clé ou
mutation SQL manuelle concurrente entre le préflight et le cleanup. Toute intervention externe
invalide le run, même si ses assertions finales passent ; elle doit être tracée puis la fenêtre
rejouée depuis un état OFF. L'unicité transactionnelle reste la cible du durcissement ultérieur,
pas une propriété prétendue du présent lot.

Mutation Railway :

- avant toute activation, le workflow inventorie les noms de variables du service et refuse la
  présence d'une variable scellée que l'API ne pourrait pas restaurer. La collection de valeurs
  non rendues doit correspondre exactement aux métadonnées de propriété du service : une variable
  héritée, partagée ou devenue ambiguë n'est jamais matérialisée silencieusement au niveau service
  pendant le rollback ;
- les trois variables runtime M1-B et un marqueur non secret
  `BOB_M1B_STAGING_CERTIFICATION_OWNER=<github.run_id>` sont ajoutés dans la
  **même** mutation `variableCollectionUpsert` avec `skipDeploys=true`, sans remplacer les autres
  variables. Le produit n'interprète jamais ce marqueur : il existe uniquement pour rendre
  l'ownership du rollback durable même si GitHub perd la sortie de l'étape après le commit
  Railway ;
- l'ownership est stable au niveau du `github.run_id`, jamais du `github.run_attempt` : un rerun
  des jobs échoués conserve donc l'autorité de retirer l'override et les variables laissés par la
  tentative précédente. `github.run_attempt` reste consigné séparément dans la preuve, sans entrer
  dans l'autorité de cleanup. Un nouveau dispatch reçoit un autre `run_id` et ne peut jamais
  supprimer l'état possédé par un autre run. La récupération opératoire rejoue donc le **même**
  workflow via `gh run rerun <github.run_id> --failed` ; lancer un nouveau dispatch n'est jamais
  une procédure de cleanup. Si la première relance retrouve l'état ON, son préflight positif
  échoue fermé mais son job `cleanup` retire l'état avec l'owner stable ; cette relance reste
  rouge. Une seconde relance du même workflow repart alors de l'état OFF et rejoue la
  certification complète. Aucun succès de cleanup n'est maquillé en succès de certification ;
- le rollback relit la collection **non rendue**, retire uniquement les trois noms M1-B et la
  marque d'ownership lorsque celle-ci correspond exactement au run courant, puis restaure la
  collection atomiquement avec `replace=true` et `skipDeploys=true`. Une marque absente ou
  appartenant à un autre run interdit toute suppression. Toute variable scellée, valeur illisible
  ou dérive concurrente fait échouer la précondition avant activation ; le workflow ne
  reconstruit jamais une collection partielle et ne journalise aucune valeur ;
- si Railway committe cette restauration mais perd toutes les réponses HTTP, l'opérateur relit
  l'état durable : seule l'égalité exacte avec la collection non-M1-B attendue transforme la
  réponse perdue en ACK récupéré et déclenche le redéploiement OFF. Une collection encore active,
  différente ou illisible reste un échec fermé. Si le run avait déjà publié
  `variables_owned=true`, une collection désormais absente impose quand même ce redéploiement
  OFF, car le processus encore vivant peut conserver l'ancien environnement ;
- l'API Railway ne fournit pas de CAS de collection. L'opérateur effectue donc une double lecture
  identique avant mutation, refuse tout patch en attente, puis compare exactement toute la
  collection non-M1-B après rollback. Cette fenêtre résiduelle est couverte par la concurrence
  GitHub exclusive et l'interdiction opérationnelle de modifier le service pendant la
  certification ; une mutation Railway externe concurrente reste un incident, jamais un état
  automatiquement « réparé » ;
- chaque état de configuration est relu et comparé sans afficher de secret, puis un seul
  déploiement explicite du SHA exact l'applique.

Séquence :

1. consigner SHA, environnement, acteur et heure de début ; vérifier que le checkout correspond
   exactement au SHA demandé, puis exécuter le préflight réseau du compte dédié avant tout travail
   coûteux ; prouver ensuite l'identité Supabase staging épinglée sous les deux connexions et le
   déployeur runtime non-superuser ;
2. déployer d'abord le SHA exact avec M1-B OFF, exécuter `predeploy`, attendre le deployment ID
   exact jusqu'à `SUCCESS`, puis prouver mono-réplique, readiness, SHA/environnement/capabilities
   et exécuter `postdeploy` ;
3. exécuter une négociation réelle avec un offer SDP WebRTC généré par navigateur et prouver
   `agentMissionSession=null` ;
4. certifier le keyspace HMAC durable avant mutation : keyspace vierge uniquement avec version
   initiale `1`, ou floor exact `[N,N]` désarmé avec binding/empreinte identiques au secret stable.
   Toute rotation, floor adjacent ou matériau divergent est refusé ; ajouter ensuite atomiquement
   le bloc M1-B staging **et le marqueur du run**, publier `variables_owned=true` comme information
   secondaire, exécuter `predeploy`, déployer le même SHA exact et rejouer deployment-ID,
   topologie, readiness et `postdeploy`, puis prouver le floor exact `[N,N]` armé ;
5. garder le flag global OFF ; créer/activer uniquement l'override `user` du compte interne,
   avec compare-and-swap sur la version parente et un acteur d'audit contenant le run ID exact,
   puis publier `override_owned=true` comme information secondaire. Le `updatedByUserId` durable
   de la ligne override est la preuve d'ownership utilisée par le cleanup ;
6. s'authentifier comme cet utilisateur via Supabase, valider les identités utilisateur+société,
   puis exécuter une vraie session WebRTC :
   bootstrap V1 → reçu durable → `startQuoteCreation` → contexte sideband `/devis/new` appliqué →
   `screen-ACK` ;
7. sous `DATABASE_URL` et le rôle runtime non-superuser, prouver la mission, ses événements, la
   lease et le brouillon exacts, puis changer le GUC tenant et prouver zéro ligne inter-tenant ;
8. annuler la mission, supprimer uniquement son propre brouillon encore vide par CAS, terminer la
   session et prouver zéro mission/lease/brouillon actif appartenant au run ;
9. dans un job de cleanup indépendant avec `if: always()`, retirer l'override **uniquement** si son
   acteur durable correspond au run courant, prouver global OFF, retirer le bloc Railway
   **uniquement** si son marqueur durable correspond au même run, exécuter impérativement
   `predeploy` OFF afin de fermer/drainer et désarmer durablement le writer, puis redéployer le
   même SHA et attendre son deployment ID exact. Si la base, l'override ou le `predeploy` deviennent
   indisponibles après activation, le redéploiement d'urgence avec le bloc Railway déjà retiré a
   quand même lieu afin de couper immédiatement toute nouvelle admission ; le run reste rouge et
   le writer durable doit être réconcilié avant tout nouveau run. Après le chemin nominal, prouver
   topologie/readiness, exécuter `postdeploy`, puis prouver une nouvelle négociation `null`, floor
   `[N,N]` avec binding inchangé et `writerEnabled=false`, et zéro lease ;
10. consigner heure de fin, acteur, deployment IDs et résultats dans un artefact borné sans PII,
    token, SDP, identifiant brut ou secret. Un échec déclenche le cleanup ; il ne transforme jamais
    une preuve partielle en succès. L'artefact `schemaVersion: 5` conserve
    `workflowRun.id` comme chaîne décimale canonique de 1 à 20 chiffres, car l'identifiant GitHub
    est opaque et peut dépasser la précision sûre de JavaScript ; `workflowRun.attempt` reste un
    entier borné. La V5 ajoute la durée totale et le verdict binaire strictement inférieur à
    30 minutes ; elle ne transforme pas un dépassement en succès. Aucun consommateur ne doit
    confondre silencieusement ce contrat avec les versions antérieures.

Le pipeline est autorisé à monter au statut `certified` uniquement si le job positif **et** le job
de cleanup sont verts. Une annulation forcée de runner reste un incident de release : avant tout
nouveau run, le préflight prouve à nouveau global/override/master/keyring OFF et zéro lease V1.
Un cleanup ne déduit jamais sa propriété de la seule présence d'un bloc ou d'un override : il exige
la marque durable exacte du run. Si le preflight découvre un état préexistant, une marque absente
ou une marque appartenant à un autre run, il échoue sans rien supprimer. Une annulation forcée du
workflow qui empêche le job de cleanup reste une intervention tracée au prochain run ; une simple
perte de sortie GitHub après mutation n'abandonne plus l'état activé.

La matrice n'est modifiée ni interprétée comme une décision fondateur par l'auteur seul. Toute
contre-signature manquante bloque seulement la fenêtre positive, jamais l'implémentation.

### 8.2 Auditeur Whisper privé, indépendant et réellement exercé

L'audit acoustique n'est pas une variable décorative. Pour la cible à plusieurs milliers de
tenants, le modèle Whisper n'est pas embarqué dans chaque réplique API : il est déployé comme un
service Railway dédié, dans le même projet et le même environnement que l'API, et dimensionnable
indépendamment. Cette séparation conserve le domaine de confiance `bob.local-whisper`, évite
d'alourdir ou de bloquer chaque réplique métier et permet d'ajouter des répliques d'inférence sans
redéployer l'API.

Frontière réseau :

- aucun domaine public Railway n'est attaché au service ; l'API l'appelle uniquement par le nom
  privé exact `bob-live-whisper-audit.railway.internal`, sur le réseau privé de
  l'environnement ;
- le client API refuse toute destination publique, adresse link-local, IP privée arbitraire,
  redirection, userinfo, query ou fragment. Le loopback reste admis uniquement pour le
  développement et la certification locale ;
- l'endpoint d'inférence exige un bearer token dédié d'au moins 32 caractères, comparé en temps
  constant. Ce secret n'est égal à aucune clé fournisseur ni à aucun keyring
  Bob Live/AgentMission et n'est jamais transmis au mobile, à OpenAI, aux logs ou aux artefacts ;
- le service ne reçoit ni `OPENAI_API_KEY`, ni clé Mistral, ni URL/clé Supabase, ni accès base ou
  Storage. Une compromission de l'auditeur ne doit donner aucune autorité métier ou tenant.

Supply chain et runtime :

- `whisper.cpp`, son archive source et le modèle quantifié sont épinglés par version, révision et
  SHA-256 exacts ; le build échoue avant compilation au moindre octet divergent ;
- le modèle est inclus dans l'image immuable. Aucun téléchargement, changement de modèle ou route
  `/load` n'existe au runtime ;
- l'image tourne sous un utilisateur non-root, sans `ffmpeg`, sans shell d'administration exposé,
  sans volume persistant et sans écriture de l'audio sur disque ;
- la surface HTTP est fermée à `GET /v1/health` et
  `POST /v1/audio/transcriptions`. Toute autre méthode ou route, y compris l'UI upstream,
  `/load` et CORS, est refusée ;
- l'inférence accepte uniquement un multipart borné contenant un WAV, le modèle canonique et
  `language=fr`. Taille, nombre de champs, MIME, signature RIFF/WAVE, durée, timeout et nombre de
  requêtes simultanées sont bornés avant l'appel au moteur ;
- l'API Speech OpenAI peut livrer un WAV pourtant complet avec les longueurs RIFF et `data`
  laissées à la sentinelle de streaming `0xffffffff`. Après téléchargement intégral déjà borné,
  l'adaptateur OpenAI matérialise ces deux longueurs à partir des octets réellement possédés,
  sans modifier les échantillons audio. Cette normalisation n'est admise que pour un conteneur
  RIFF/WAVE structurellement exact, au plus 64 chunks, un unique chunk `data` terminal et des
  tailles représentables ; toute troncature détectable au transport ou structurellement, taille
  contradictoire, second chunk `data` ou octet résiduel échoue fermé.
  L'auditeur privé continue d'exiger un WAV canonique à longueurs finies ;
- l'audio et le transcript restent en mémoire le temps de la requête puis sont libérés. Ni le
  gateway ni `whisper.cpp` ne journalisent filename fourni par l'appelant, audio, transcript,
  prompt ou contenu métier ;
- la readiness appelle réellement le moteur chargé et retourne uniquement un statut, la version
  épinglée du moteur et les digests attendus. Une simple présence d'URL/token ne vaut jamais
  `healthy`.
- la readiness API qui garde les nouvelles admissions combine cette santé courte avec une preuve
  acoustique complète : contrôles négatifs du gateway, TTS du fournisseur actif, WAV réel,
  transcription Whisper et passage dans **le même** `RealtimeSpeechRenderer`. Une réussite
  acoustique — contrôles compris — est réutilisable au plus quinze minutes par réplique ; un échec
  est rejoué après un court backoff borné et ferme immédiatement les nouvelles admissions.
  `fresh=true` force la santé réseau mais ne contourne pas cette fenêtre : un nouveau déploiement
  part toujours sans preuve et doit donc effectuer le round-trip avant de devenir ready ;
- le round-trip n'expose et ne persiste ni phrase, ni audio, ni transcript. Le buffer audio rendu
  est explicitement effacé en mémoire après le verdict ; seules readiness, versions/digests et
  durées bornées peuvent sortir de cette frontière.

Scalabilité :

- une réplique accepte au plus une inférence active, avec file d'attente strictement bornée ; une
  surcharge répond `503`/`429` avant de conserver l'audio ;
- Railway peut répartir les appels sur plusieurs répliques du service privé sans multiplier la
  mémoire du modèle dans les pods API ;
- staging commence avec une réplique et prouve son budget réel. Toute ouverture production exige
  un test de charge qui mesure débit, p50/p95, saturation, redémarrage et répartition
  multi-réplique ; augmenter le nombre de répliques sans cette preuve ne vaut pas certification.

Preuve staging obligatoire avant la fenêtre positive M1-B :

1. déployer l'image auditeur liée au SHA candidat et attendre le deployment ID exact jusqu'à
   `SUCCESS` ;
2. prouver via l'API Railway que le service appartient au projet/environnement staging attendus,
   qu'il n'a aucun domaine public, proxy TCP ou volume persistant, que l'auto-déploiement est
   désactivé, que sa collection **non rendue** contient exactement une variable utilisateur — le
   jeton dédié — puis comparer sa valeur **rendue** avec celle reçue par l'API, et que sa
   configuration référence les digests épinglés. Les variables système
   `RAILWAY_*` et références réseau injectées par la plateforme apparaissent seulement dans la
   collection rendue : elles ne sont ni comptées comme secrets utilisateur ni acceptées à la place
   de cet inventaire non rendu. Toute autre variable non rendue échoue fermée ;
3. depuis le réseau privé du runtime API, vérifier la readiness réelle, le refus sans/mauvais
   bearer, le refus d'une route `/load` et d'un payload trop grand ;
4. produire avec **la même clé OpenAI du profil actif** un WAV d'une phrase française fixe sans
   donnée métier, matérialiser ses éventuelles sentinelles RIFF/`data` par le même adaptateur que
   le runtime, l'envoyer à l'auditeur privé, puis appliquer le même canoniseur et la même
   comparaison texte/faits que `RealtimeSpeechRenderer` ;
5. l'échec de TTS, DNS privé, auth, modèle, ASR, canonisation ou budget rend le workflow rouge et
   interdit toute négociation Mission positive ;
6. l'artefact GitHub conserve seulement SHA, deployment IDs, versions/digests, codes de contrôle,
   durées et verdicts. Il ne contient ni audio, ni transcript, ni token, ni URL signée.

Le smoke M1-B n'est donc pas autorisé à conclure sur la présence des variables
`BOB_LIVE_LOCAL_AUDIT_*`. Il doit appeler cette preuve fonctionnelle sur le binaire et le service
réellement déployés. Le service privé peut rester prêt dans staging après le rollback M1-B ; le
flag Mission, son override et son keyring Railway restent soumis au retour OFF/absent de §8.1.

### 8.3 Métrologie bornée

Les noms et labels autorisés sont fermés :

- `bob_agent_mission_negotiations_total{requested,outcome,provider,transport}` avec
  `requested=omitted|null|v1|unknown`, `outcome=historical|accepted|refused|error`,
  `provider=openai|mistral|unknown`, `transport=webrtc|mistral_pcm|unknown` ;
- `bob_agent_mission_capability_rejections_total{operation,reason}` avec
  `operation=bootstrap_ack|get|start|cancel|screen_ack` et
  `reason=missing|malformed|not_found|ambiguous|expired|state|hash_mismatch` ;
- `bob_agent_mission_bootstrap_receipts_total{outcome}` avec
  `outcome=acknowledged|replayed|refused|error` ;
- `bob_agent_mission_screen_ack_total{outcome}` avec
  `outcome=accepted|replayed|conflict|context_stale|draft_stale|unavailable`.

Tout champ source vide ou inconnu devient explicitement `unknown` quand ce label l'autorise ; il ne
produit jamais une chaîne vide. Aucun label ne porte tenant, utilisateur, session, mission,
commande, contenu, secret ou hash.

Les événements d'audit Mission utilisent uniquement des pseudonymes HMAC séparés par namespace
(`tenant`, `owner`, `mission`) et les transitions allowlistées. Ils ne journalisent jamais les
identifiants bruts société/utilisateur/mission, même si le logger général accepte encore ces clés
pour d'autres domaines.

## 9. Critères d'acceptation binaires

### Wire et gates

- [ ] Omission, `null` et `1` sont distingués par les parseurs exacts WebRTC et Mistral.
- [ ] Un mobile N reçoit une réponse historique sans clé inconnue.
- [ ] Master OFF ou release flag manquant/OFF/indisponible négocient explicitement `null/null`.
- [ ] L'évaluation préliminaire du flag s'exécute sous l'identité réelle malgré
      `WithoutTenantPersistenceTransaction` ; aucun faux `missing` FORCE RLS n'autorise ni ne
      masque une configuration.
- [ ] Master ON avec configuration, migration, keyring ou dépendance obligatoire partielle échoue
      au boot/admission et ne se déguise jamais en `null/null`.
- [ ] Seul un provider/transport/mode présent dans l'allowlist serveur certifiée peut négocier `1`.
- [ ] Version, hash de capability et version de release flag sont dans l'INSERT de la lease avant
      provider/bootstrap ; le release flag autoritaire a été relu dans cette transaction.
- [ ] Une lease V1 activée mais non acquittée conserve la courte deadline de réception ; aucun
      heartbeat ne la prolonge. Le reçu valide l'étend une seule fois au TTL actif et son rejeu ne
      prolonge rien.
- [ ] Une réponse de reçu perdue après commit déclenche exactement un rejeu avec la même capability ;
      le TTL de réservation couvre le bootstrap, les deux tentatives bornées et une marge explicite.
- [ ] La preuve renvoyée par l'adapter atteste exactement le hash/version insérés, reste séparée
      de la lease et est corrélée au secret en mémoire avant provider ; toute divergence libère la
      lease et n'émet aucune capability.
- [ ] Le quartet de capability est immuable après cet INSERT : une lease historique entièrement
      `NULL` ne peut jamais être promue en V1 par `UPDATE`, et une lease V1 ne peut changer ni
      version, ni horodatage, ni hash, ni version de flag.
- [ ] Une décision ON est liée au même `principalBindingHash` que la réservation ; une preuve d'un
      autre principal est refusée.
- [ ] Tout writer global/kill-switch/override verrouille la ligne parente et incrémente sa version
      atomiquement ; un changement concurrent fait échouer l'admission candidate avant INSERT et
      aucune décision ON périmée n'est rétrogradée.
- [ ] Le repository runtime est read-only ; seuls les scripts opérateur allowlistés persistent avec
      parité les overrides `user`/`cabinet` en create/update/delete, et le trigger de suppression
      cabinet incrémente/audite aussi la ligne parente.
- [ ] La revalidation admission passe uniquement par la fonction `SECURITY DEFINER` possédée par
      un rôle `NOLOGIN`, `search_path=pg_catalog`, références qualifiées et sans SQL dynamique ;
      aucune lecture large n'est accordée au runtime, les rôles Supabase publics sont révoqués et
      les tests d'escalade/search-path échouent fermés.
- [ ] Réponse N+1 absente/discordante, timeout ou 5xx n'ouvrent jamais micro/uplink et ne basculent
      jamais vers legacy/Mistral ; la racine conserve le résultat fatal
      `agent_mission_negotiation_failed` et seul `null/null` explicite autorise l'historique.
- [ ] Côté mobile, abort, background, hangup, logout et changement d'identité disposent le handle
      avant tout `await`.
- [ ] Côté serveur, HTTP, sideband, kill-switch, heartbeat, hard cap et shutdown passent
      atomiquement la lease à `reaping` avant l'appel externe ; le provider reçoit uniquement
      l'identité du claim durable, la complétion exige son `reaperToken`, et toute capability de
      cette lease est refusée dès le claim.
- [ ] Les tests croisés OpenAI/Mistral prouvent qu'aucune clé ni aucun appel du provider secondaire
      n'est requis ou déclenché.

### Autorité et transaction

- [ ] Le runtime compose l'autorité durable à la place du provider disabled.
- [ ] Sans secret canonique, hash exact et lease V1 active unique : zéro requête
      Mission/draft/event.
- [ ] Sans reçu durable de bootstrap : `get/start/cancel/screen-ack` sont tous refusés avant la
      moindre requête Mission/draft/event.
- [ ] Le reçu valide, son rejeu exact, mauvaise capability, cross-tenant, ambiguïté, expiration,
      état `reaping` et la course reçu/reaper ont des résultats binaires, sans choix silencieux ni
      double autorité.
- [ ] `reserved`, `bound`, `reaping`, expirée, mauvais tenant et autre owner du même tenant sont
      refusés.
- [ ] Deux admissions concurrentes sous anciennes/nouvelles versions HMAC convergent vers une seule
      lease active grâce au `pg_advisory_xact_lock` transactionnel stable et au même ordre de lignes
      que les mutations ; une ambiguïté résiduelle est refusée sans choix silencieux.
- [ ] Le nouvel INSERT utilise seulement le binding courant, tandis que lease existante, replay de
      `sessionId` et quotas utilisateur agrègent courant+historiques sans reset lors d'une rotation.
- [ ] Hangup, contexte et confirmation retrouvent une lease créée sous un hash historique ; zéro
      ou plusieurs correspondances échouent fermées sans choisir silencieusement.
- [ ] Un hangup reçu avant `reserve` committe les fences courant+historiques avant de répondre ;
      l'INSERT applicatif et un writer N-1 sont ensuite refusés, sans lease, événement de quota,
      capacité consommée ni appel provider survivant.
- [ ] Un retry de hangup ne prolonge pas le fence ; sa purge est bornée, tenantée et reflétée dans
      l'annuaire reaper, sans persister le `principalBindingHash`.
- [ ] Chaque lecture/mutation revalide la lease dans la même UoW.
- [ ] Le GET est `REPEATABLE READ READ ONLY`, sans verrou d'écriture ; toute mutation verrouille
      toutes les leases candidates par ordre canonique, filtre les seules actives/vivantes avant le
      test d'unicité, puis compare le hash en temps constant.
- [ ] Le secret n'est ni persisté côté mobile, ni loggé, ni placé dans métriques/traces/crash
      reports ; seul son hash serveur est durable. Une redaction de défense masque en plus tout
      motif canonique `bam1_…` qui atteindrait malgré tout logs ou scrubbing télémétrique.
- [ ] Les audits `agent_mission.*` ne contiennent aucun identifiant brut ; leurs références
      tenant/owner/mission sont des pseudonymes HMAC namespace-isolés issus du keyring Mission.
- [ ] Le DTO mobile/React n'expose jamais le secret ; `HttpBobClient` le pose/efface en mémoire,
      ajoute le header lui-même et refuse localement une méthode Mission sans capability.

### ACK

- [ ] Contexte non appliqué, owner lease sideband expirée, epoch périmé, payload non canonique,
      digest recalculé discordant, écran ou draft périmé n'écrivent rien.
- [ ] Le happy path écrit exactement une révision, un event corrélé et une binding exacte.
- [ ] L'event porte `actor=system`, `turnId=null` et toutes les corrélations, sans contenu métier.
- [ ] Replay exact n'écrit rien ; collision de commande échoue.
- [ ] Les fautes injectées prouvent le rollback total.

### PostgreSQL et migration

- [ ] Expand puis validate séparés, timeouts bornés et listes CHECK générées.
- [ ] Le writer N-1 exact fonctionne sous les triggers/contraintes de chaque état intermédiaire,
      avant et après validate.
- [ ] La colonne de reçu nullable reste compatible N-1 ; son trigger autorise uniquement
      `NULL → timestamp DB` sur V1 et refuse remplacement, effacement ou reçu historique.
- [ ] Le writer N-1 insère une lease sans fence et échoue avec un fence vivant exact ; FORCE RLS
      empêche lecture/écriture inter-tenant et les rôles Data API ne possèdent aucun droit.
- [ ] Le premier cutover ferme et draine `closed|0` avant migrate ; une reprise partielle ne saute
      jamais ce drain ; `postdeploy` refuse toute migration locale en attente et n'appelle jamais
      `prisma migrate deploy`.
- [ ] Le binaire N boote sous tout snapshot durable `closed` valide afin de laisser drainer N-1 et
      permettre un changement de bindings ; `tracking`, panne et `active` divergent refusent le
      boot, tandis qu'une réservation reste refusée jusqu'au passage `active` exact.
- [ ] La phase est toujours explicite ; la réouverture n'arrive que par `postdeploy`, après preuve
      d'une réplique, readiness du SHA/environnement exacts et
      `realtimeAdmissionCancellationFence=v1` avec `agentMissionBootstrapReceipt=v1` sur le binaire
      déployé.
- [ ] `boundAt = reservedAt` est prouvé ; le writer N-1 et une négociation `null/null` laissent les
      quatre colonnes Mission à `NULL`.
- [ ] RLS/ACL/inter-tenant/deux owners passent sur PostgreSQL 17 avec rôle runtime
      non-superuser, non-owner, sans `BYPASSRLS`.
- [ ] Le registre fingerprint est append-only, sans secret ni accès table runtime ; le stage
      privilégié refuse sous verrou exclusif tout event retenu sans binding avant son premier
      INSERT, puis lie exactement version et matériau, tandis que readiness et writers prennent le
      verrou partagé. Le floor monotone accepte au plus N/N+1 et son retire exige `closed|0` sous
      verrou. Même version + autre secret, rollback de version, version retenue sans binding,
      matériau réutilisé, ancien writer après retire et retrait d'une version encore retenue
      échouent fermés.
- [ ] Le cycle réel PostgreSQL prouve `[N,N] → [N,N+1] → [N+1,N+1]`, un writer partagé concurrent
      commité avant le snapshot du stage au moyen de barrières observables et du verrou advisory
      exact — aucun `sleep` arbitraire ne tient lieu de preuve —, le trigger `VOLATILE`, puis
      `writerEnabled=true → false → true → false`. Le premier OFF exige `closed|0`, son retry déjà
      désactivé n'exige plus de drain, et tous les writers sont refusés pendant l'état désactivé.
- [ ] La fonction de readiness est réellement appelée via `DATABASE_URL` par le rôle runtime ;
      sa sortie est bornée et canonique, ses ACL exactes n'accordent `EXECUTE` qu'au propriétaire
      et au runtime, et l'inventaire RLS exact ne contient aucune policy permissive inattendue.
- [ ] La fonction writer-guard `SECURITY DEFINER` possède une ACL exacte : seul son owner peut
      l'exécuter. Le provisionneur révoque aussi tout grantee arbitraire hérité d'une release
      antérieure ; runtime, Data API et rôle empoisonné échouent tous fermés.
- [ ] Les memberships de `bob_app`, `anon`, `authenticated` et `service_role` sont vérifiées par
      fermeture transitive `MEMBER|SET`, pas seulement contre les owners connus : tout rôle
      intermédiaire atteignable, même non-owner, fait échouer le certificat.
- [ ] ACL/memberships et opérations post-transfert passent sous owner explicite ; aucune exposition
      implicite `anon`, `authenticated` ou `service_role` ne subsiste. Le fichier de release
      `rls.sql` complet est réellement rejoué après transfert vers un owner de schéma exact, par un
      déployeur `CREATEROLE` non-superuser qui ne possède plus les tables, puis FORCE RLS et
      l'absence d'ownership du déployeur sont certifiées.
- [ ] Le train SQL et les certifications sont rejoués sur Supabase staging avec déployeur
      non-superuser avant fusion.
- [ ] Le premier run depuis un staging N-1 accepte seulement le couple
      `migration flag non terminée + flag absent`, exige le flag canonique OFF juste après
      `predeploy`, et son cleanup reste vert si l'échec survient avant toute migration sans
      masquer un schéma partiellement appliqué.
- [ ] Le bootstrap keyspace accepte seulement M1-A entièrement absent ou M1-A `expand+validate`
      entièrement appliqué avec tables mission/event vides ; tout objet readiness partiel, toute
      lignée contradictoire et toute donnée mission/event préexistante échouent fermés.

### Livraison

- [ ] Tests ciblés core/API/Prisma/client/mobile verts.
- [ ] Typecheck, lint, suites globales et builds API/mobile verts depuis checkout propre.
- [ ] Review adversariale correctness/sécurité, architecture/parité et UX/accessibilité ;
      tous P0/P1 corrigés.
- [ ] Les quatre familles de métriques de §8.3 utilisent exactement leurs labels bornés, avec défaut
      explicite et sans contenu ; elles n'affirment pas que O5/SLO appareil est certifié.
- [ ] L'image auditeur épingle et vérifie source+modèle, tourne non-root, n'expose aucun domaine
      public ni route de mutation, ne possède aucune clé provider/tenant et ne persiste ni audio ni
      transcript.
- [ ] Le health réel, les refus auth/route/taille et le round-trip OpenAI TTS → Whisper privé →
      canoniseur sont prouvés depuis staging sur les deployment IDs exacts avant le smoke M1-B.
- [ ] Le compte technique staging est issu du provisioning normal, possède une société ouverte et
      un abonnement DB actif autorisant `voice_live`; son préflight authentifié OpenAI WebRTC
      s'exécute avant toute installation, build ou mutation/déploiement et rend une erreur bornée
      sans PII lorsque cette précondition dérive.
- [ ] Une fixture fidèle au WAV OpenAI réel (`RIFF=0xffffffff`, `data=0xffffffff`) est
      matérialisée avec les deux tailles finies exactes avant audit ; les échantillons sont
      byte-identiques et toutes les formes ambiguës, troncatures détectables au transport ou
      structurellement, ou multi-`data` sont refusées.
- [ ] Une seule PR, CI complète verte, puis fenêtre staging de §8.1 contre-signée : smoke positif
      bootstrap→reçu durable→start→screen-ACK, preuve DB, drain zéro, override/master/keyring remis
      à OFF/absents, puis fusion.
- [ ] Après certification, aucune variable/ligne de release flag persistante, promesse publique ou
      production n'est activée ; la fenêtre staging interne est tracée avec début, fin et acteur.

## 10. Definition of Done

M1-B passe de `specified` à `certified` uniquement si toutes les cases de la section 9 sont
cochées avec des preuves reproductibles liées au SHA exact, dont le smoke staging positif puis le
retour OFF. Sans ce smoke, le statut maximal est `implemented`. L'existence du code ou un typecheck
vert ne suffisent pas. O4 reste `implemented partiellement` tant que M1-C n'a pas livré le parcours
mobile devis jusqu'à `awaiting_lines`. O5 reste partiel tant que la preuve device/SLO n'existe pas.

### 10.1 Preuves locales du statut `implemented`

État vérifié avant gel du SHA candidat :

- Core : 197 fichiers / 2 298 tests, typecheck, lint et artefact de production certifié ;
- API Client : 23 fichiers / 447 tests, typecheck, lint et artefact de production certifié ;
- API : 252 fichiers Vitest / 2 444 tests réussis (325 scénarios opt-in ignorés hors de leur
  environnement), 403 tests de contrats release, typecheck, lint et artefact de production
  certifié ;
- Mobile : 123 fichiers / 1 285 tests et typecheck ;
- PostgreSQL 17 réel : 43 scénarios AgentMission, dont writer N-1, runtime non-superuser,
  RLS/ACL exactes et course reçu/reaper ;
- PostgreSQL 17 réel, train complet de 123 migrations : owner-split de type Supabase certifié avec
  déployeur non-superuser, propriétaire exact `bob_rls_schema_owner_cert` et helpers Cabinet
  `SECURITY DEFINER` effectivement sondés sous ce même propriétaire ;
- la CI du SHA candidat sépare volontairement la preuve AgentMission sur PostgreSQL 17 et la preuve
  owner-split de type Supabase sur PostgreSQL 16 ;
- review adversariale : retry après réponse ACK perdue, budget TTL des deux tentatives et course
  PostgreSQL réelle corrigés puis rejoués ;
- `git diff --check` et syntaxe de chaque script shell modifié : verts.

Ces preuves ne promeuvent pas le lot à `certified`. Restent obligatoires sur le SHA figé : checkout
propre, CI complète, rejeu Supabase staging avec déployeur non-superuser, contre-signature de la
fenêtre interne, smoke positif de §8.1 puis preuve du retour intégral à OFF.
