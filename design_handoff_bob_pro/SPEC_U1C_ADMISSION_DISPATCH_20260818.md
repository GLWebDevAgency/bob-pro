# SPEC U1-c — Admission §5.2 et dispatch §5.3 : le moteur rencontre PostgreSQL

- **Date** : 2026-08-18 · **Auteur** : Claude (bâton fondateur) · **Méthode** : panel 3 architectes
  - juge (wf_60bea099) — ossature « extension-uow » 35/40, **les 12 greffes du juge intégrées**
    (dont l'obligatoire : ordre d'écriture imposé par `guard_agent_mission_event_append_v3`).
    Contre-lecture GPT attendue au retour, non bloquante.
- **Parents** : spec Jarvis §5.2/§5.3/§5.4/§5.6/§15/§19.2 ·
  [SPEC_U1_NOYAU_DURABLE_20260818.md](SPEC_U1_NOYAU_DURABLE_20260818.md) (stockage) ·
  [SPEC_U1B_DOMAINE_CORE_20260818.md](SPEC_U1B_DOMAINE_CORE_20260818.md) (domaine).
- **Périmètre** : port d'admission + extension de `PrismaAgentMissionUnitOfWork` (jamais un second
  UoW, §17) + repository/worker de dispatch + migrations CHECK kind-conditionnels + preuves
  PostgreSQL. **Pas de gateway HTTP/realtime public** (callers réels = U1-d).

## 1. Découverte bloquante réglée par la tranche

Les CHECK « quote-shaped » posés sur `agent_missions` (phase/payload) et `agent_mission_events`
(type/envelope/data/corrélation — 20260730110200) sont **inconditionnels** : toute ligne Jarvis
serait rejetée. La tranche les rend **conditionnels au kind** (`kind = 'quote_creation'` pour les
branches historiques ; branches Jarvis en blocs GENERATED dont la **source unique est les exports
des définitions U1-b** — event types, clés de data, clés de state — vérifiée en étendant
`jarvis-vocabulary-sync.test.ts`, jamais un second test). NOT VALID → VALIDATE séparé, élévation
propriétaire par le bloc DO du patron U1-a.

## 2. LA transaction d'admission (contrat normatif)

`runJarvisAdmission` sur `PrismaAgentMissionUnitOfWork` — miroir de `runQuoteCreationOwner`
(mêmes `withIsolatedOwner`, timeouts, `mapForegroundTransactionFailure`). Ordre :

1. timeouts locaux 5 s/10 s ; 2. `lockOpenCompanyForMissionWrite` (FOR SHARE) ;
2. advisory `owner-foreground.v2` (inchangé — un run Jarvis actif et un devis actif s'excluent,
   backstop SQL `one_active_owner_key`) ; 4. advisory `owner-kind.v1` + kind (clé généralisée,
   octets identiques pour le legacy) ; 5. principal : `resolveAgentMissionAuthority` in-tx ;
3. catalogue pur (action existe, non `closed`, kill switch admission) ;
4. **reçu** : lookup `(companyId, ownerUserId, commandId)` — même runId + même fingerprint ⇒
   **replay zéro-write** (avec la greffe « replay qui heal » : si `signalAppliedAt` est resté NULL,
   le re-stamp se fait dans la même transaction) ; fingerprint divergent ⇒ `command_conflict` ;
5. `setMissionContext(runId)` + FOR UPDATE du run ; absent + `expectedRevision=0` ⇒ **seed**
   `{revision:0, state:null}` jamais persisté tel quel (convention U1-b) ;
6. `effectId`s générés par le SERVEUR (`randomUUID` × `maxOpenWorkItems`) → contexte §5.4 ;
7. `reduceJarvisRun` pur — refus typés sans write ; quarantaine ⇒ CAS `quarantined` + événement
   système ; **cancel run-scope : les work items non autorisés du run passent `cancelled` avec
   résultat no-effect DANS la même transaction** (greffe), jamais un balayage asynchrone ;
8. **écritures dans l'ordre du garde SQL** (greffe obligatoire) : a) CAS/INSERT du run
   (`updatedAt = occurredAt`) ; b) append de l'événement (`sequence = revisionAfter`, HMAC,
   uniques owner N-1 **et** run) ; c) INSERT des work items 1:1 des intents (`prepared`,
   fence 0).

`runJarvisSystemAdmission` (§5.6, greffe « contrat système dans le type du port ») : acteur
système, `commandId` **déterministe** `deriveJarvisSystemCommandId(runId, effectId, observation)`
(UUIDv8 versionné, vecteurs figés — nouveau module core `jarvis-command-id.ts`) ; société fermée
ADMISE pour signal/observation ; kill switches jamais opposés au signal ; intents sortants
interdits. `readJarvisStateless` : READ ONLY RepeatableRead, zéro verrou, zéro write.

## 3. Dispatch §5.3

`jarvis-work-items.persistence.ts` (patron `notification-jobs.ts`) : `claimDue` (un UPDATE CAS :
`prepared|retry_due` dû → `leased`, fence+1, token neuf), `authorize` (`leased→authorized` WHERE
token+fence, `authorizedAt`+digest ensemble — CHECK U1-a), `storeResult` immuable fencé,
`listPendingSignals` (index partiel U1-a), réconciliation stale par `effectId`.

`jarvis-work-item-dispatch.service.ts` (calque `notification-delivery.service.ts`, @Cron) :
claim court → **revalidation 2ᵉ tx en liste fermée** (greffe) : tenant ouvert,
`actingPrincipalId = ownerUserId`, source `confirmation` seule (fail-closed U1), `executeBy ≥`
horloge base, kill switch dispatch, action au manifeste, `targetDigest` recalculé ; cancel gagné
avant `authorized` ⇒ résultat no-effect → **`JarvisEffectExecutor` par `actionId@version`**
(greffe : registre statique au-dessus de l'outbox canonique — en U1-c l'unique exécuteur enfile
`notification_jobs`, dedupeKey `jarvis:{effectId}:v1` ; la vérité externe reste dans l'outbox) →
résultat immuable → signal via `runJarvisSystemAdmission` → redelivery level-triggered.

**RLS** : évaluer D'ABORD l'option zéro-amendement (greffe) — directory SECURITY DEFINER (précédent
reaper) rendant les coordonnées, claim sous les GUC de la ligne via les policies U1-a INCHANGÉES ;
la policy dédiée `app.jarvis_dispatch_v1` n'arrive que si la preuve échoue. Preuve négative
explicite : le mécanisme n'ouvre ni la mutation d'`agent_missions` ni l'INSERT de
`jarvis_work_items`.

## 4. Backstop de premier plan (greffe)

`agent_missions_one_active_owner_key` (WHERE `status='active'`) laisse coexister un run Jarvis
`waiting_user` et un devis actif : l'index partiel est élargi aux statuts **non-libérants** de
§5.1 (actifs + `waiting_user`/`waiting_screen`/`retry_due` — les libérants `waiting_external`/
`parked`/`cancelling` et les terminaux restent hors backstop). Migration additive, writer N-1
re-prouvé.

## 5. Preuves de la tranche (§19.2, gates de merge)

Admission : crash avant commit ⇒ zéro ligne / après ⇒ postimage complète ; replay même commandId ⇒
même reçu (et re-stamp du signal si NULL) ; collision fingerprint ; deux admissions concurrentes
CAS (2 connexions, `Promise.all`) ⇒ une gagne, `stale_revision` ; **portée de reçu par run —
la preuve déplacée d'U1-a** ; seed + `foreground_busy` ; quarantaine sans effet. Dispatch : claim
incrémente le fence ; lease expirée reprise par CAS, worker stale sans écriture ; `authorized`
jamais re-`prepared` ; cancel vs authorize même ligne ⇒ un gagnant ; résultat sans signal
redélivré, appliqué UNE fois ; même `effectId` ⇒ même job outbox ; RLS dispatch fail-closed.
Harnais durci (greffe) : `pg_signal_backend` à l'auditeur + `pg_terminate_backend` pour les kills
pendant COMMIT ; vieillissement des leases par UPDATE auditeur. Insertion dans la séquence de
`certify-agent-missions-local.sh` (leçon U1-a : liste énumérée + invocation vitest).

## 6. Non-objectifs

Gateway HTTP/realtime public (U1-d), exécuteurs d'effets autres que `notification_jobs`,
mandats (`mandate_grant` — post-V1 FD-05), absorption des commandes interactives quote (cutover),
tout renommage.
