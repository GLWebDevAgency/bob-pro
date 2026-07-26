# Bob AgentMission M1-B — capability Realtime durable et ACK écran

> Statut : `specified`
>
> Objectif parent : O4 — mission continue
>
> Base : `origin/main@f2e7343c`
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
4. chaque route Mission revalide, dans sa propre transaction métier, la possession et la lease
   active du principal dérivé côté serveur ;
5. l'ACK `/devis/new` lie atomiquement mission, contexte sideband appliqué et brouillon réel.

Le résultat n'est pas encore le devis vocal complet. Il rend la prochaine tranche M1-C possible
sans ouvrir une faille d'autorité ni fabriquer un état local.

## 2. Résultat binaire

Une requête authentifiée ne peut lire ou muter une mission devis que si le serveur retrouve
**exactement une** lease Bob Live active du même principal, négociée en protocole mission V1 lors
de son admission et dont le hash correspond au secret de possession présenté. Un ACK écran accepté
produit exactement une nouvelle révision Mission, un event `screen_acknowledged` corrélé et une
liaison au contexte/draft autoritaires, ou ne produit rien.

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
- secret conservé uniquement en mémoire volatile mobile, jamais dans AsyncStorage, SecureStore,
  SQLite, logs, métriques, traces, analytics ou crash reports ;
- secret présenté dans `X-Bob-Agent-Mission-Capability` sur chaque route Mission.

Le décodeur `HttpBobClient` est la seule frontière mobile qui voit le secret wire. Il l'encapsule
immédiatement dans un handle de session opaque, non sérialisable, dont le champ privé ajoute
lui-même le header aux méthodes Mission et dont `dispose()` efface la référence. Ni le DTO remis à
React ni les transports n'exposent une chaîne de secret. Le transport transfère ce handle une seule
fois au `RealtimeSessionController`, qui en devient l'unique propriétaire et le dispose avant tout
`await` sur erreur, abort, fallback, background, hangup, logout ou changement d'identité. Une
méthode appelée après dispose échoue localement avant réseau. Les clients local/in-memory de test
implémentent le même contrat mais ne fabriquent jamais de capability.

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
preuve. Lors d'une admission, le serveur prend d'abord un advisory lock tenanté sur
`principalBindingHash`, stable et indépendant des versions HMAC, via
`pg_advisory_xact_lock` **dans la transaction**. Il verrouille ensuite toutes les lignes candidates
par ordre `subjectHash, sessionId` avant de décider ou d'insérer ; le verrou stable protège aussi
**l'absence** de ligne, donc deux admissions concurrentes ancien/nouveau HMAC convergent vers une
seule lease active. L'input distingue le binding HMAC courant, seul autorisé pour un nouvel
`INSERT`, de la liste courant+historiques. Recherche de lease, replay de `sessionId` et quotas
utilisateur minute/heure agrègent toute cette liste : une rotation ne remet ni la session active ni
les quotas à zéro.

Lors d'une requête HTTP, l'UoW lit/verrouille d'abord toutes les leases correspondant aux hashes
candidats **sans filtrer par capability**, puis exige exactement une lease V1 active et vivante.
Seulement ensuite, elle compare en temps constant son hash stocké au hash de la capability
présentée. Zéro ou plusieurs leases, ou un hash différent, échouent fermés avant tout accès
Mission.

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

| Requête | Réponse | Effet |
| --- | --- | --- |
| champ omis | réponse historique sans les deux clés | mobile N inchangé |
| `agentMissionProtocolVersion: null` | version `null`, capability `null` | parcours historique explicitement négocié |
| `agentMissionProtocolVersion: 1` | `1` + secret si éligible, sinon deux `null` | capability durable ou parcours historique explicite |

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
   `agentMissionProtocolVersion=1`, binding exact non nul et release flag versionné ;
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
- réponse N+1 absente, mal formée, inconnue, timeout ou 5xx : résultat racine
  `fail_closed(agent_mission_negotiation_failed)`, non reconnectable et sans repli legacy/Mistral ;
- background, hangup, logout ou changement d'identité : le controller mobile dispose synchroniquement le
  handle **avant tout `await`**, puis termine/libère la session ;
- le reaper passe la lease à `reaping` sous claim possédé avant tout appel externe ; une capability
  liée à une lease `reaping`, terminée ou expirée est refusée ;
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
  n'est pas prouvé ; le release flag OFF est le mécanisme normal de fermeture des admissions ;
- secret dédié, distinct de sujet/preuve/usage/contrôle/audit Bob Live ;
- une version retirée mais encore référencée par un event fait échouer la readiness ;
- aucune valeur réelle n'est committée ;
- **[BLOQUÉ FONDATEUR : keyring HMAC AgentMission de production et destination de secrets
  approuvée]** ;
- **[BLOQUÉ FONDATEUR : identité exacte du compte interne autorisé pour le smoke staging]** ;
- **[BLOQUÉ FONDATEUR : autorisation explicite, datée et rattachée à son canal, de modifier la
  ligne correspondante dans `MATRICE_FLAGS_V1.md`]** ;
- le blocage n'empêche pas d'implémenter ni de tester le chemin OFF et les tests avec secrets
  éphémères ; sans smoke staging positif, le statut maximal reste `implemented`.

### 8.1 Fenêtre de certification staging et rollback exact

La certification positive est une opération bornée sur le SHA candidat :

1. consigner SHA, environnement, acteur, heure de début et identité DB du déployeur
   non-superuser ;
2. générer hors logs un secret staging éphémère, le poser réellement dans le secret store staging,
   vérifier sa présence sans l'afficher, activer le master staging et déployer le SHA exact ;
3. garder le flag global OFF ; créer/activer uniquement l'override du compte interne après
   autorisation fondateur datée+canal et contre-signature Claude+GPT de la ligne exacte dans
   `MATRICE_FLAGS_V1.md`, puis enregistrer sa version ;
4. exécuter bootstrap V1 → start → contexte sideband appliqué → `screen-ACK`, puis vérifier les
   lignes DB et événements attendus sous RLS avec le rôle runtime ;
5. désactiver/retirer l'override, incrémenter la version parente, terminer la lease de test et
   prouver zéro lease V1 active ;
6. remettre le master à OFF, retirer les deux variables de keyring, redéployer le même SHA et
   vérifier que la négociation V1 ne peut plus être admise ;
7. consigner heure de fin, acteur, résultats et incident éventuel. Un échec déclenche immédiatement
   les étapes 5–6 ; il ne laisse jamais un override ou secret staging actif.

La matrice n'est modifiée ni interprétée comme une décision fondateur par l'auteur seul. Toute
contre-signature manquante bloque seulement la fenêtre positive, jamais l'implémentation.

### 8.2 Métrologie bornée

Les noms et labels autorisés sont fermés :

- `bob_agent_mission_negotiations_total{requested,outcome,provider,transport}` avec
  `requested=omitted|null|v1|unknown`, `outcome=historical|accepted|refused|error`,
  `provider=openai|mistral|unknown`, `transport=webrtc|mistral_pcm|unknown` ;
- `bob_agent_mission_capability_rejections_total{operation,reason}` avec
  `operation=get|start|cancel|screen_ack` et
  `reason=missing|malformed|not_found|ambiguous|expired|state|hash_mismatch` ;
- `bob_agent_mission_screen_ack_total{outcome}` avec
  `outcome=accepted|replayed|conflict|context_stale|draft_stale|unavailable`.

Tout champ source vide ou inconnu devient explicitement `unknown` quand ce label l'autorise ; il ne
produit jamais une chaîne vide. Aucun label ne porte tenant, utilisateur, session, mission,
commande, contenu, secret ou hash.

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
- [ ] Côté serveur, le reaper passe atomiquement la lease à `reaping` avant l'appel externe ; toute
      capability de cette lease est ensuite refusée.
- [ ] Les tests croisés OpenAI/Mistral prouvent qu'aucune clé ni aucun appel du provider secondaire
      n'est requis ou déclenché.

### Autorité et transaction

- [ ] Le runtime compose l'autorité durable à la place du provider disabled.
- [ ] Sans secret canonique, hash exact et lease V1 active unique : zéro requête
      Mission/draft/event.
- [ ] `reserved`, `bound`, `reaping`, expirée, mauvais tenant et autre owner du même tenant sont
      refusés.
- [ ] Deux admissions concurrentes sous anciennes/nouvelles versions HMAC convergent vers une seule
      lease active grâce au `pg_advisory_xact_lock` transactionnel stable et au même ordre de lignes
      que les mutations ; une ambiguïté résiduelle est refusée sans choix silencieux.
- [ ] Le nouvel INSERT utilise seulement le binding courant, tandis que lease existante, replay de
      `sessionId` et quotas utilisateur agrègent courant+historiques sans reset lors d'une rotation.
- [ ] Chaque lecture/mutation revalide la lease dans la même UoW.
- [ ] Le GET est `REPEATABLE READ READ ONLY`, sans verrou d'écriture ; toute mutation verrouille
      toutes les leases candidates par ordre canonique, filtre les seules actives/vivantes avant le
      test d'unicité, puis compare le hash en temps constant.
- [ ] Le secret n'est ni persisté côté mobile, ni loggé, ni placé dans métriques/traces/crash
      reports ; seul son hash serveur est durable.
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
- [ ] `boundAt = reservedAt` est prouvé ; le writer N-1 et une négociation `null/null` laissent les
      quatre colonnes Mission à `NULL`.
- [ ] RLS/ACL/inter-tenant/deux owners passent sur PostgreSQL 17 avec rôle runtime
      non-superuser, non-owner, sans `BYPASSRLS`.
- [ ] ACL/memberships et opérations post-transfert passent sous owner explicite ; aucune exposition
      implicite `anon`, `authenticated` ou `service_role` ne subsiste.
- [ ] Le train SQL et les certifications sont rejoués sur Supabase staging avec déployeur
      non-superuser avant fusion.

### Livraison

- [ ] Tests ciblés core/API/Prisma/client/mobile verts.
- [ ] Typecheck, lint, suites globales et builds API/mobile verts depuis checkout propre.
- [ ] Review adversariale correctness/sécurité, architecture/parité et UX/accessibilité ;
      tous P0/P1 corrigés.
- [ ] Les trois familles de métriques de §8.2 utilisent exactement leurs labels bornés, avec défaut
      explicite et sans contenu ; elles n'affirment pas que O5/SLO appareil est certifié.
- [ ] Une seule PR, CI complète verte, puis fenêtre staging de §8.1 contre-signée : smoke positif
      bootstrap→start→screen-ACK, preuve DB, drain zéro, override/master/keyring remis à OFF/absents,
      puis fusion.
- [ ] Après certification, aucune variable/ligne de release flag persistante, promesse publique ou
      production n'est activée ; la fenêtre staging interne est tracée avec début, fin et acteur.

## 10. Definition of Done

M1-B passe de `specified` à `certified` uniquement si toutes les cases de la section 9 sont
cochées avec des preuves reproductibles liées au SHA exact, dont le smoke staging positif puis le
retour OFF. Sans ce smoke, le statut maximal est `implemented`. L'existence du code ou un typecheck
vert ne suffisent pas. O4 reste `implemented partiellement` tant que M1-C n'a pas livré le parcours
mobile devis jusqu'à `awaiting_lines`. O5 reste partiel tant que la preuve device/SLO n'existe pas.
