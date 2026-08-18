-- Jarvis U1-a — expand du noyau durable (SPEC_U1_NOYAU_DURABLE_20260818, spec Jarvis §5/§17 étape 4).
-- Transformation EN PLACE : colonnes additives nullable sur agent_missions (contrat writer N-1
-- exact conservé), élargissement des CHECK kind/status vers l'union legacy ∪ §5.1, portée de
-- reçu par run sur agent_mission_events, et table neuve jarvis_work_items (outbox
-- d'orchestration §5.3 — aucun équivalent legacy, aucune duplication d'outbox métier).
-- Aucun renommage : réservé au manifeste de cutover §17.1.

BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

-- 1. Colonnes additives JarvisRun (inertes jusqu'à U1-b/c ; le writer N-1 les omet).
ALTER TABLE public.agent_missions
  ADD COLUMN "definitionVersion" INTEGER,
  ADD COLUMN "nextWakeAt" TIMESTAMPTZ(6);

ALTER TABLE public.agent_missions
  ADD CONSTRAINT agent_missions_definition_version_check
  CHECK (
    "definitionVersion" IS NULL
    OR "definitionVersion" BETWEEN 1 AND 2147483647
  )
  NOT VALID;

-- nextWakeAt est UNIQUEMENT un index de scan (§5.1) : le scanner soumet une commande
-- de wake idempotente, il ne mute jamais le run.
CREATE INDEX agent_missions_next_wake_idx
  ON public.agent_missions ("nextWakeAt")
  WHERE "nextWakeAt" IS NOT NULL;

-- 2. Élargissement des unions fermées : kind et status acceptent l'union legacy ∪ §5.1.
--    Le writer N-1 n'écrit que le sous-ensemble legacy — un CHECK plus large est sûr.
ALTER TABLE public.agent_missions
  DROP CONSTRAINT agent_missions_kind_check;
ALTER TABLE public.agent_missions
  ADD CONSTRAINT agent_missions_kind_check
  CHECK ("kind" IN (
    -- BEGIN GENERATED JARVIS_RUN_KINDS (legacy + U1)
    'quote_creation',
    'single_business_action',
    'customer_contact'
    -- END GENERATED JARVIS_RUN_KINDS
  ))
  NOT VALID;

ALTER TABLE public.agent_missions
  DROP CONSTRAINT agent_missions_status_check;
ALTER TABLE public.agent_missions
  ADD CONSTRAINT agent_missions_status_check
  CHECK ("status" IN (
    -- BEGIN GENERATED JARVIS_RUN_STATUSES (union legacy ∪ spec §5.1)
    'active',
    'cancelled',
    'expired',
    'waiting_user',
    'waiting_screen',
    'waiting_external',
    'retry_due',
    'parked',
    'cancelling',
    'completed',
    'failed_terminal',
    'quarantined'
    -- END GENERATED JARVIS_RUN_STATUSES
  ))
  NOT VALID;

-- 3. Portée de reçu par run (§5.2 : unicité (companyId, runId, commandId)).
--    Coexiste avec l'unique owner-scope plus strict du writer N-1 ; son retrait
--    éventuel appartient au manifeste de cutover.
CREATE UNIQUE INDEX agent_mission_events_run_command_key
  ON public.agent_mission_events ("companyId", "missionId", "commandId");

-- 4. Outbox d'orchestration jarvis_work_items (§5.3). Table neuve : elle RÉFÉRENCE
--    les outboxes métier canoniques (submitted_job_ref), ne les duplique jamais.
CREATE TABLE public.jarvis_work_items (
  "id" UUID NOT NULL,
  "companyId" TEXT NOT NULL,
  "runId" UUID NOT NULL,
  "ownerUserId" TEXT NOT NULL,
  "effectId" UUID NOT NULL,
  "actionId" TEXT NOT NULL,
  "actionVersion" INTEGER NOT NULL,
  "authorizationSource" JSONB NOT NULL,
  "actingPrincipalId" TEXT NOT NULL,
  "targetDigest" CHAR(64),
  "payloadRef" JSONB,
  "submittedJobRef" JSONB,
  "executeBy" TIMESTAMPTZ(6) NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'prepared',
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "nextAttemptAt" TIMESTAMPTZ(6),
  "leaseOwner" TEXT,
  "leaseToken" UUID,
  "leaseFence" BIGINT NOT NULL DEFAULT 0,
  "leaseExpiresAt" TIMESTAMPTZ(6),
  "authorizedAt" TIMESTAMPTZ(6),
  "authorizationDigest" CHAR(64),
  "resultDigest" CHAR(64),
  "signalAppliedAt" TIMESTAMPTZ(6),
  "createdAt" TIMESTAMPTZ(6) NOT NULL,
  "updatedAt" TIMESTAMPTZ(6) NOT NULL,
  CONSTRAINT jarvis_work_items_pkey PRIMARY KEY ("id"),
  CONSTRAINT jarvis_work_items_effect_key UNIQUE ("companyId", "effectId"),
  CONSTRAINT jarvis_work_items_company_fkey
    FOREIGN KEY ("companyId") REFERENCES public.companies("id")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  -- Un run ne disparaît jamais sous ses effets (même doctrine que les events).
  CONSTRAINT jarvis_work_items_run_fkey
    FOREIGN KEY ("runId", "companyId", "ownerUserId")
    REFERENCES public.agent_missions ("id", "companyId", "ownerUserId")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT jarvis_work_items_status_check CHECK ("status" IN (
    -- BEGIN GENERATED JARVIS_WORK_ITEM_STATUSES (spec §5.3)
    'prepared',
    'leased',
    'authorized',
    'retry_due',
    'succeeded',
    'failed_terminal',
    'outcome_unknown',
    'cancelling',
    'cancelled'
    -- END GENERATED JARVIS_WORK_ITEM_STATUSES
  )),
  CONSTRAINT jarvis_work_items_owner_identifier_check CHECK (
    length("ownerUserId") BETWEEN 1 AND 200
    AND "ownerUserId" = btrim("ownerUserId")
    AND "ownerUserId" !~ '[[:cntrl:]]'
  ),
  CONSTRAINT jarvis_work_items_attempts_check
    CHECK ("attempts" BETWEEN 0 AND 2147483647),
  CONSTRAINT jarvis_work_items_lease_fence_check
    CHECK ("leaseFence" >= 0),
  -- authorized = point de non-retour : l'horodatage et le digest arrivent ensemble.
  CONSTRAINT jarvis_work_items_authorization_shape_check CHECK (
    ("authorizedAt" IS NULL) = ("authorizationDigest" IS NULL)
  )
);

CREATE INDEX jarvis_work_items_dispatch_idx
  ON public.jarvis_work_items ("companyId", "status", "nextAttemptAt");
CREATE INDEX jarvis_work_items_run_idx
  ON public.jarvis_work_items ("runId");
-- Redelivery level-triggered (§5.3) : résultat persisté dont le signal n'est pas appliqué.
CREATE INDEX jarvis_work_items_pending_signal_idx
  ON public.jarvis_work_items ("companyId", "updatedAt")
  WHERE "signalAppliedAt" IS NULL AND "resultDigest" IS NOT NULL;

-- 5. RLS : même doctrine owner-scoped que agent_missions (FORCE + GUC) ; les écritures
--    sont épinglées au run courant via app.current_agent_mission_id (fail-closed : le
--    worker de dispatch U1-c amendera ces policies avec sa propre preuve s'il lui faut
--    un droit de claim plus large). bob_app sans DELETE (terminaux + rétention).
ALTER TABLE public.jarvis_work_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.jarvis_work_items FORCE ROW LEVEL SECURITY;

CREATE POLICY jarvis_work_items_owner_select ON public.jarvis_work_items FOR SELECT
  USING (
    "companyId" = current_setting('app.current_company_id', true)
    AND "ownerUserId" = nullif(current_setting('app.current_user_id', true), '')
  );
CREATE POLICY jarvis_work_items_owner_insert ON public.jarvis_work_items FOR INSERT
  WITH CHECK (
    "companyId" = current_setting('app.current_company_id', true)
    AND "ownerUserId" = nullif(current_setting('app.current_user_id', true), '')
    AND "runId"::text = nullif(current_setting('app.current_agent_mission_id', true), '')
  );
CREATE POLICY jarvis_work_items_owner_update ON public.jarvis_work_items FOR UPDATE
  USING (
    "companyId" = current_setting('app.current_company_id', true)
    AND "ownerUserId" = nullif(current_setting('app.current_user_id', true), '')
    AND "runId"::text = nullif(current_setting('app.current_agent_mission_id', true), '')
  )
  WITH CHECK (
    "companyId" = current_setting('app.current_company_id', true)
    AND "ownerUserId" = nullif(current_setting('app.current_user_id', true), '')
    AND "runId"::text = nullif(current_setting('app.current_agent_mission_id', true), '')
  );

GRANT SELECT, INSERT, UPDATE ON public.jarvis_work_items TO bob_app;

COMMIT;
