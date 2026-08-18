# SPEC U1-a — Expand du noyau durable : AgentMission → JarvisRun (lot U1, tranche a)

- **Date** : 2026-08-18 · **Auteur** : Claude (bâton fondateur du 18/08) · **Contre-lecture GPT** : attendue au retour, non bloquante.
- **Parent normatif** : [SPEC_JARVIS_UNIVERSEL_ORCHESTRATION_20260817.md](SPEC_JARVIS_UNIVERSEL_ORCHESTRATION_20260817.md) §5 (modèle durable), §17 étape 4 (transformation en place, expand/validate, writer N-1, **jamais de paire de tables parallèle**).
- **Périmètre de CETTE tranche** : uniquement l'**expand additif** du stockage + la table neuve `jarvis_work_items` + preuves writer N-1. Aucun renommage (réservé au cutover §17.1), aucun gateway, aucun reducer (tranches U1-b/c), aucun changement de comportement des writers existants.

## 1. Constat d'assise (cartographie du 18/08, workflow wf_5c931a40)

`agent_missions` possède déjà les mécanismes que §5 exige : snapshot CAS par `revision`, journal append-only avec unicité `(companyId, ownerUserId, commandId)` et `(missionId, sequence)`, fingerprint HMAC versionné, transaction d'écriture unique (`runQuoteCreationOwner` : advisory locks owner/kind, capability realtime in-tx), RLS FORCE, convention expand/validate déjà exécutée sur ces tables (20260726*, 20260727*, 20260729*). La transformation est donc une **extension**, pas une réécriture.

## 2. Mapping colonne par colonne (cible §5.1)

| §5.1 `JarvisRun` | `agent_missions` aujourd'hui | Décision U1-a |
|---|---|---|
| `id`, `companyId` | `id`, `companyId` | inchangés |
| `createdBy` | `ownerUserId` | **mappé au domaine** (pas de colonne redondante) ; la sémantique multi-collaborateur viendra avec FD-07 post-V1 |
| `kind` | `kind` (CHECK épinglé `quote_creation`) | CHECK élargi : `kind IN ('quote_creation','single_business_action','customer_contact')` — NOT VALID puis VALIDATE ; le writer N-1 n'écrit que `quote_creation`, un CHECK plus large est sûr |
| `definitionVersion` | `protocolVersion` (SmallInt 1\|2) | **nouvelle colonne** `definition_version int NULL` ; pour les lignes existantes, la projection déterministe du cutover posera `definitionVersion = protocolVersion` ; d'ici là NULL = legacy |
| `status` | `status` ∈ {active, cancelled, expired} | CHECK élargi à l'union **legacy ∪ §5.1** : {active, cancelled, expired} ∪ {waiting_user, waiting_screen, waiting_external, retry_due, parked, cancelling, completed, failed_terminal, quarantined} ; mapping de lecture : `expired` = terminal legacy (le domaine JarvisRun ne l'émettra jamais) |
| `revision` | `revision` | inchangé — la sémantique `sequence = revisionAfter` du journal est conservée (risque n°3 de la carto) |
| `stateVersion` / `state` | `payloadVersion` / `payload` | **réutilisés tels quels** — renommage au cutover uniquement (le nom vit dans du SQL brut et des HMAC) |
| `nextWakeAt` | absent | **nouvelle colonne** `next_wake_at timestamptz NULL` + index partiel `(next_wake_at) WHERE next_wake_at IS NOT NULL` — uniquement un index de scan (§5.1 : le scanner soumet une commande de wake, ne mute jamais) |
| `terminalAt`, `createdAt`, `updatedAt` | présents | inchangés |

**Reçu de commande — portée** : §5.2 exige l'unicité `(companyId, runId, commandId)`. L'existant est `(companyId, ownerUserId, commandId)`. Décision : **index unique partiel additif** `(company_id, mission_id, command_id) WHERE mission_id IS NOT NULL` sur `agent_mission_events`, en COEXISTENCE avec l'unique owner-scope (plus strict, conservé pour writer N-1). Le retrait de l'ancien unique est une affaire de cutover, tracée au manifeste §17.

## 3. `jarvis_work_items` — table neuve (pas d'équivalent legacy)

Seule création de table du lot : l'outbox d'orchestration §5.3 n'existe pas. Elle **ne duplique aucune outbox métier** : elle référence le job canonique retourné (`notification_jobs`, `document_archive_jobs`, …) via `submitted_job_ref` et l'observe.

```sql
CREATE TABLE jarvis_work_items (
  id                uuid PRIMARY KEY,
  company_id        text NOT NULL REFERENCES companies(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  run_id            uuid NOT NULL,
  owner_user_id     uuid NOT NULL,
  effect_id         uuid NOT NULL,
  action_id         text NOT NULL,
  action_version    int  NOT NULL,
  authorization_source jsonb NOT NULL,          -- union fermée §5.3 (confirmation|mandateGrant|certifiedSystemRule)
  acting_principal_id  uuid NOT NULL,
  target_digest     char(64),
  payload_ref       jsonb,                       -- références purpose-specific, jamais le contenu sensible
  submitted_job_ref jsonb,                       -- ID du reçu/job de l'outbox canonique après soumission
  execute_by        timestamptz NOT NULL,
  status            text NOT NULL DEFAULT 'prepared',
  attempts          int  NOT NULL DEFAULT 0,
  next_attempt_at   timestamptz,
  lease_owner       text,
  lease_token       uuid,
  lease_fence       bigint NOT NULL DEFAULT 0,   -- incrémenté à chaque claim ; seul le détenteur du fence courant écrit
  lease_expires_at  timestamptz,
  authorized_at     timestamptz,
  authorization_digest char(64),
  result_digest     char(64),
  signal_applied_at timestamptz,
  created_at        timestamptz NOT NULL,
  updated_at        timestamptz NOT NULL,
  CONSTRAINT jarvis_work_items_effect_key UNIQUE (company_id, effect_id),
  CONSTRAINT jarvis_work_items_run_fk FOREIGN KEY (run_id, company_id, owner_user_id)
    REFERENCES agent_missions(id, company_id, owner_user_id) ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT jarvis_work_items_status_check CHECK (status IN
    ('prepared','leased','authorized','retry_due','succeeded','failed_terminal','outcome_unknown','cancelling','cancelled'))
);
```

Index : `(company_id, status, next_attempt_at)` (dispatch dû), `(run_id)` (relecture par run), `(signal_applied_at) WHERE signal_applied_at IS NULL AND result_digest IS NOT NULL` (redelivery level-triggered §5.3).

Choix structurants :
- **FK composite vers `agent_missions`** : au cutover, le `ON UPDATE CASCADE` suit le renommage ; la table étant nommée `jarvis_work_items` d'emblée, elle ne figure au manifeste §17 que pour sa FK.
- `ON DELETE RESTRICT` : un run ne disparaît jamais sous ses effets (même doctrine que les events).
- `lease_fence bigint` : le fencing §5.3 (« Un autre worker peut le reprendre uniquement par CAS du fence ») — le `lease_token` identifie, le fence ordonne.
- `authorized` = point de non-retour : la transition `leased -> authorized` et l'annulation concourent sur la même ligne via le même fence (une seule transition conditionnelle gagne) — preuve exigée en U1-c.
- RLS : mêmes policies tenant que `agent_missions` (FORCE, GUC `app.current_company_id`/`app.current_user_id`), `bob_app` sans DELETE (statuts terminaux, purge par rétention future).

## 4. Ce que cette tranche NE fait PAS (et pourquoi)

- **Pas de renommage** (`agent_missions` → `jarvis_runs`, `payload` → `state`) : les noms vivent dans du SQL brut (6+ fichiers), des clés d'advisory lock, des préfixes HMAC (`amr1_`), des policies RLS, des scripts de cert et des métriques (`bob_agent_mission_*`) — c'est le manifeste de migration hashé du cutover §17.1 qui les traite, en une fois, avec preuve.
- **Pas de gateway ni reducer** : U1-b (domaine core : statuts fermés, `single_business_action_v1`, `customer_contact_v1`) puis U1-c (admission §5.2 en étendant `runQuoteCreationOwner`, courses PostgreSQL §19.2). Le flux actuel multi-transactions (mutation → continuation → présentation) reste intact tant que U1-c n'a pas absorbé la continuation dans le contrat d'admission.
- **Pas de writer des nouvelles colonnes** : `definition_version`, `next_wake_at` et `jarvis_work_items` restent inertes jusqu'à U1-b/c. L'expand est prouvé inoffensif pour le writer N-1 (tests §5).

## 5. Preuves de cette tranche (gate de merge)

1. Insert « forme writer N-1 » (sans les nouvelles colonnes) sur `agent_missions` : accepté, valeurs NULL.
2. CHECK élargi : `kind='quote_creation'` et les 3 statuts legacy passent ; un kind inconnu échoue.
3. `jarvis_work_items` : unicité `(company_id, effect_id)` prouvée par violation ; FK composite prouvée (insert orphelin refusé) ; RESTRICT prouvé (delete de mission avec work item refusé).
4. RLS : cross-tenant refusé sur `jarvis_work_items` avec le rôle applicatif non-superuser.
5. Index unique partiel `(company_id, mission_id, command_id)` : doublon même-run refusé, même commandId sur deux runs distincts accepté (le trigger d'unicité owner reste plus strict pour le writer N-1 — prouvé non régressé).
6. `prisma migrate diff` propre, `tsc` + tests complets du paquet api verts.
