# SPEC — Voice Trace Realtime V2 souverain sur staging

**Objectif canonique :** `O5 — Voice Trace rend la qualité pilotable`
**Train :** `O5-REALTIME-TRACE-V2`
**État initial :** `specified`
**Environnement autorisé :** `staging` uniquement
**Décision fondateur source :** conversation du 31/07/2026 — enregistrer en preview/staging la
transcription finale, le chemin de décision et le résultat de Bob Live afin de comprendre chaque
comportement. La production reste inchangée.

## 1. Problème

`VOICE_TRACE_ENABLED` observe uniquement le chemin HTTP historique
`/voice/transcribe -> /ai/ask -> /voice/synthesize`. GPT Realtime/M2-A V2 traverse le sideband
WebRTC et ne l'appelle jamais. Activer le flag historique donnerait donc une fausse impression
d'observabilité : le tour « Je souhaite créer un nouveau client » resterait invisible.

Le nouveau chemin doit permettre de répondre en une lecture :

1. le bootstrap provider, le sideband et le contexte étaient-ils prêts ;
2. quelle chaîne finale exacte a été acceptée puis remise au cerveau unique ;
3. quelle autorité sémantique et quels intents validés ont été retenus ;
4. quel résultat canonique et quel contrôle ont été produits ;
5. la réponse a-t-elle été préparée, acquittée par le mobile, interrompue ou abandonnée ;
6. où la latence ou l'erreur s'est-elle produite.

## 2. Portée et non-objectifs

### Inclus

- flag séparé `VOICE_TRACE_REALTIME_V2_ENABLED`, dormant par défaut et refusé au boot hors
  `CABINET_RELEASE_ENV=staging` ;
- allowlist obligatoire `VOICE_TRACE_REALTIME_V2_SUBJECTS` de couples
  `<companyId>:<userId>` : un compte non explicitement autorisé ne produit aucune trace ;
- événements append-only corrélés par `traceAttemptId`, le vrai `sessionHandle`, `ownerEpoch`,
  `eventOrdinal` et le vrai `turnId` ;
- branchement du bootstrap OpenAI Realtime, du sideband, du planificateur sémantique unique, du
  résultat agent, de la publication vocale, de l'ACK mobile et du barge-in ;
- transcript final utilisateur et réponse canonique Bob chiffrés applicativement avant PostgreSQL ;
- RLS forcée, scoping tenant + utilisateur, idempotence, rétention maximale 30 jours, purge globale
  bornée et effacement à la clôture du compte ;
- signal de transparence dans le contrat de session et l'overlay preview avant que Bob passe en
  état d'écoute ;
- lecteur opérateur staging local, TTY-only, session obligatoire, lecture verbatim explicite et
  accès durablement audité sans exposer le contenu dans Railway/Sentry/GitHub Actions ;
- opérateur ON/OFF staging exact-SHA avec reçu et preuve que production est inchangée ;
- tests empêchant transcript, réponse, audio, payload fournisseur ou secret d'entrer dans les logs,
  Sentry, métriques ou artefacts GitHub.

### Exclus de ce train

- activation production ;
- Mistral/Voxtral Realtime ;
- stockage d'audio brut ou de paquets provider ;
- dashboard fondateur/mobile et recherche plein texte ;
- correction du kind `customer_creation` : cette tranche révèle son parcours réel mais ne maquille
  pas le diagnostic en correction fonctionnelle ;
- certification acoustique sur appareil physique et SLO p50/p95. Le canary serveur s'arrête
  honnêtement à `turn_speech_ready` s'il ne télécharge, vérifie, joue puis acquitte pas réellement
  l'audio. Seul un ACK mobile durable produit `turn_speech_delivered`.

## 3. Invariants

### 3.1 Une seule vérité conversationnelle

Le traceur observe. Il ne planifie, ne corrige, ne rejoue et n'autorise rien. Une panne du traceur
ne modifie jamais la décision métier ni la parole de Bob. Le LLM reste l'unique compréhension ; les
use cases et missions restent l'unique autorité d'effet.

### 3.2 Consentement de test et destination

- Le flag seul ne suffit pas : seul un couple tenant/utilisateur présent dans l'allowlist est tracé.
- La réponse de bootstrap expose `diagnosticTrace: { enabled: true, retentionDays: 30,
purpose: 'staging_quality' }` uniquement au sujet autorisé. Le mobile preview l'affiche avant
  l'écoute ; le contrat production ne peut jamais annoncer ce mode.
- Le registre des traitements, la DPIA IA et la politique de confidentialité décrivent ce traitement
  de test. La base légale n'est pas inventée : toute formulation qui l'exigerait reste marquée
  `[BLOQUÉ FONDATEUR : validation DPO/base légale avant une activation hors comptes internes]`.
- `transcript` n'est accepté que pour `turn_transcript_final`; `canonicalReply` seulement pour
  `turn_agent_result`. Les deux sont chiffrés AES-256-GCM avec version de clé avant persistance.
- Le digest d'idempotence est un HMAC avec clé dérivée par HKDF et séparation de domaine depuis la
  même racine versionnée. `eventDigestKeyVersion` est stocké sur chaque ligne ; toutes les versions
  encore référencées en base doivent rester présentes au boot, même après rotation de la version
  courante.
- Le texte stocké est exactement la chaîne finale de provider après le nettoyage de sécurité déjà
  appliqué par le sideband et remise au planner. Le traceur n'effectue aucune nouvelle normalisation
  sémantique susceptible de masquer une erreur STT.
- Aucun texte vocal n'entre dans un log, une métrique, Sentry, un reçu CI ou une erreur. L'identité
  brute du tenant reste en base pour RLS ; les signaux externes n'exposent que classe fermée et durée.

### 3.3 Schéma fermé, jamais de payload libre

Il n'existe aucun champ `facts`, `toolArgs`, `metadata` ou `Record<string, unknown>`. Les seules
colonnes optionnelles de diagnostic sont typées et bornées : `provider`, `transport`,
`speechDelivery`, `plannerDisposition`, `plannerAuthority`, `plannerModel`, `missionKind`,
`runKind`, `stage`, `outcome`, `failureClass`, `interruptionReason`, `contextRevision`,
`contextDigest`, `durationMs`, plus les enveloppes chiffrées du transcript et de la réponse.

Ne sont jamais acceptés : labels métier, projections d'écran, audio, SDP/RTP, URL/storage key,
payload provider, prompt, historique, headers, tokens, capabilities, HMAC, stack ou message libre
d'exception.

### 3.4 Journal append-only ordonné

Chaque tentative reçoit un `traceAttemptId` UUID avant l'appel provider. Après admission, elle est
liée une seule fois au vrai `sessionHandle`; après acquisition sideband, à `ownerEpoch`.
`eventOrdinal` est alloué synchroniquement et croît strictement dans la tentative, avant la file
asynchrone. La clé unique est `(companyId, traceAttemptId, eventOrdinal)` ; `ownerEpoch` et `turnId`
restent des fences vérifiables.

- avant acquisition owner, `ownerEpoch=0` est permis uniquement aux événements bootstrap/provider ;
- après `session_ready`, `ownerEpoch >= 1` est obligatoire ;
- même clé + même digest HMAC = succès rejoué ; même clé + digest différent = corruption signalée ;
- `UPDATE` et `TRUNCATE` sont interdits ;
- `DELETE` est réservé au reaper pour une ligne expirée ou à l'effacement utilisateur explicite ;
- un événement inconnu ou incohérent est refusé, jamais stocké partiellement ;
- l'écriture est hors chemin critique dans une file bornée. Cinq échecs consécutifs ouvrent un
  disjoncteur et créent un incident sans contenu sensible ; la voix continue.

### 3.5 Événements normatifs

| Événement                  | Preuve                                                                                                                                |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `session_bootstrap_failed` | échec après identité authentifiée, avec étape et classe fermées                                                                       |
| `session_ready`            | sideband et owner acquis, transport/provider/modèle/livraison connus                                                                  |
| `context_applied`          | révision et digest du contexte réellement appliqués                                                                                   |
| `turn_transcript_final`    | chaîne finale exacte remise au cerveau                                                                                                |
| `turn_semantic_plan`       | mission/global/hors-périmètre/rejet, durée et intents fermés ; modèle effectif uniquement quand le planner en a réellement produit un |
| `turn_agent_result`        | statut, kind, contrôle éventuel et réponse canonique chiffrée                                                                         |
| `turn_speech_ready`        | artefact audité ou dispatcher natif prêt, avec durée de rendu                                                                         |
| `turn_speech_delivered`    | ACK mobile durable accepté, jamais un simple `response.done`                                                                          |
| `turn_interrupted`         | barge-in, contexte, supersession, annulation ou fin de session                                                                        |
| `provider_failed`          | étape et classe provider fermées, sans payload fournisseur                                                                            |
| `security_rejected`        | garde fermée déclenchée, sans donnée contrôlée par le provider                                                                        |
| `session_closed`           | raison terminale unique                                                                                                               |

Une durée ou réussite absente reste `NULL`/absente : jamais `0` ni succès inventé.

## 4. Flags, clé et garde de boot

Le bloc est atomique :

- `VOICE_TRACE_REALTIME_V2_ENABLED` ;
- `VOICE_TRACE_REALTIME_V2_SUBJECTS` ;
- `VOICE_TRACE_REALTIME_V2_ENCRYPTION_KEYRING` ;
- `VOICE_TRACE_REALTIME_V2_ENCRYPTION_CURRENT_VERSION`.

Quand le flag est faux/absent, les trois variables associées doivent être absentes et le runtime
n'alloue ni file, ni map, ni ligne. Quand il est vrai, elles sont toutes obligatoires, validées au
boot et l'allowlist doit contenir au moins un couple sans doublon.

`true` est accepté seulement si :

- `CABINET_RELEASE_ENV=staging` ;
- `BOB_LIVE_ENABLED=true` et `BOB_LIVE_PROVIDER=openai` ;
- `BOB_AGENT_MISSIONS_QUOTE_V1_ENABLED=true` et
  `BOB_AGENT_MISSIONS_QUOTE_M2A_ENABLED=true` ;
- le keyring HMAC AgentMission existant est complet ;
- `VOICE_TRACE_ENABLED=false`, afin de ne pas confondre deux traceurs.

Toute configuration partielle ou hors staging échoue au boot avec le nom du bloc, sans valeur.
Le flag est absent de production et ne peut pas être rendu vrai par défaut.

## 5. PostgreSQL, RLS, rétention et droits des personnes

- migration expand-only avec `SET LOCAL lock_timeout` et `statement_timeout` ;
- table `realtime_voice_trace_events` liée à `companies`, indexée par
  tenant/utilisateur/temps, tenant/session/ordre et expiration/identifiant ;
- table append-only `realtime_voice_trace_access_audits`, sans contenu vocal, pour chaque lecture
  verbatim (`requestId`, acteur DB non contrôlable, ticket, raison, session, nombre de lignes,
  horodatage), conservée 90 jours puis purgée par la même autorité bornée ;
- `ENABLE ROW LEVEL SECURITY` + `FORCE ROW LEVEL SECURITY` dès la migration ;
- policies tenant + utilisateur, et certification avec rôle runtime non-superuser ;
- révocation explicite de `PUBLIC`, `anon`, `authenticated`, `service_role`, plus refus de
  `UPDATE`/`TRUNCATE` au runtime ;
- `ingestedAt` et `retentionExpiresAt = ingestedAt + interval '720 hours'` sont écrasés par un trigger
  base ; l'appelant ne peut fournir aucune date de rétention. `occurredAt` est borné entre 24 h dans
  le passé et 5 min dans le futur par rapport à `ingestedAt`. Les 30/90 jours sont exprimés en
  720/2160 heures absolues afin qu'un changement heure d'été/hiver ne dépasse jamais le plafond ;
- les ciphertexts sont bornés en octets, leur enveloppe `vN` doit correspondre exactement à
  `encryptionKeyVersion`, et l'AAD AES lie id, tenant, sujet, tentative, session, owner, ordinal,
  tour, événement, horodatage et type de champ ;
- purge globale bornée par index, `FOR UPDATE SKIP LOCKED`, rôle NOLOGIN minimal et fonction dédiée
  qui ne peut supprimer que des lignes expirées. Une page entièrement tentée est acquittée ; une
  panne laisse les lignes dues, redécouvertes au sweep suivant ;
- clôture de compte : les traces non légales de l'utilisateur sont supprimées dans la transaction
  de clôture avant la suppression Supabase ; les pièces légales des autres tables restent intactes ;
- export/accès : index `(companyId,userId,occurredAt)` et procédure opérateur tenantée. Aucune
  lecture globale `--last` n'existe ; `--session-handle`, acteur et raison sont obligatoires ;
- sauvegardes/PITR : le délai résiduel éventuel après effacement est documenté, jamais présenté
  comme une suppression physique instantanée de toutes les sauvegardes ;
- test writer N-1 : le véritable repository V1 écrit sous ses triggers finaux sur le schéma N.

Trois autorités NOLOGIN incompatibles sont séparées : `maintenance` possède uniquement
effacement/purge/inspection et jamais les ciphertexts ; `key_readiness` ne voit que les deux
versions de clé ; `reader` possède l'unique RPC lecture+audit et n'est jamais exécutable par le
runtime ou la Data API. Le runtime a seulement INSERT par colonnes, SELECT des six colonnes de
lookup/digest et EXECUTE des RPC maintenance/readiness ; il n'a ni SELECT table, ni DELETE direct,
ni capacité `SET ROLE`.

Toutes les listes de CHECK fermées, y compris providers, transports, livraison, raisons, mission
kinds et sous-types, sont générées depuis la source TypeScript par un parseur strict sans `eval` et
protégées contre la dérive SQL avant toute mutation de release.

## 6. Opérateur staging

Un opérateur manuel unique, routé par le trampoline `railway-api.yml` déjà enregistré sur `main` et
sous le mutex `railway-api-staging` existant, certifie le SHA exact de l'unique PR avant merge :

1. exige `main` et un SHA de 40 caractères déjà livré normalement sur staging ;
2. prouve zéro migration en attente, RLS/ACL/immutabilité, ainsi que le keyring M2-A complet ;
3. capture l'état production sans y écrire ;
4. mute atomiquement uniquement le bloc VoiceTrace et ses marqueurs d'ownership ;
5. reconstruit depuis un checkout détaché propre du SHA exact avec les variables Railway courantes
   (`railway up`) ; il n'appelle jamais `deploymentRedeploy` ;
6. prouve readiness, mono-réplique et source exacte ;
7. exécute un canary non-PII. Sans vraie lecture+ACK, il certifie `turn_speech_ready`, pas
   `turn_speech_delivered` ;
8. vérifie en base la séquence attendue puis purge le canary ;
9. archive un reçu non-PII (`SHA`, deployment, migrations, flag, compteurs, cleanup, production
   inchangée) ;
10. en échec, retire d'abord tout le bloc VoiceTrace puis rebuild exact-source OFF avec les
    variables courantes.

Le lecteur de diagnostic refuse production, CI et stdin/stdout non-TTY. Le contenu n'apparaît
qu'après `--include-content` explicite ; sa sortie n'est jamais archivée par le workflow.

## 7. Critères d'acceptation binaires

- [ ] Flag absent/faux : zéro état mémoire, zéro ligne et zéro coût observable.
- [ ] Bloc partiel, flag vrai hors staging ou sans GPT Realtime/M2-A/keyring complet : boot refusé.
- [ ] Sujet absent de l'allowlist : aucune trace et aucun indicateur mensonger dans le mobile.
- [ ] Un tour canary produit transcript, plan, résultat et speech ready dans l'ordre, sous un même
      `traceAttemptId/sessionHandle/ownerEpoch/turnId` ; delivered exige un vrai ACK mobile.
- [ ] Un barge-in produit `turn_interrupted` et jamais un faux `turn_speech_delivered`.
- [ ] Un échec bootstrap/provider/sécurité/planification/publication porte étape et classe fermées.
- [ ] Aucun test ne retrouve transcript/réponse dans AppLogger, Sentry, métriques ou reçu.
- [ ] Replay identique = une ligne ; replay divergent = incident de corruption.
- [ ] RLS interdit lecture/écriture cross-tenant et cross-user sur PostgreSQL non-superuser réel.
- [ ] UPDATE/TRUNCATE impossibles ; purge uniquement expirée ; clôture efface seulement le sujet.
- [ ] Le lecteur TTY exige session+acteur+raison et produit un audit non verbal durable.
- [ ] Le mobile preview annonce le traitement avant l'écoute ; production ne peut pas l'annoncer.
- [ ] Migration, writer N-1 réel, Prisma, typecheck, lint, build et tests ciblés sont verts.
- [ ] Workflow OFF → ON → OFF → ON vert sur staging exact-SHA ; production inchangée avant/après.

## 8. Definition of Done

Le lot passe de `specified` à `implemented` uniquement quand le code est réellement appelé par le
bootstrap, le sideband, le planner et l'ACK Realtime. Il passe à `certified` uniquement avec :

- checkout propre et commit atomique ;
- suites ciblées + API/mobile complètes + build ;
- certifications PostgreSQL non-superuser puis Supabase staging ;
- review adversariale correctness/sécurité/architecture/confidentialité sans P0/P1 ;
- contre-signature Claude + GPT avant changement de la matrice de flags ;
- PR unique mergée ;
- release staging normale du SHA exact ;
- drill OFF → ON → OFF → ON avec reçu ;
- production prouvée inchangée.

La QA « Je souhaite créer un nouveau client » sur iPhone et Android et les SLO device restent
explicitement ouverts : ils ne sont pas maquillés en succès par un canary texte ou un smoke WebRTC
silencieux.
