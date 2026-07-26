-- Bob AgentMission M1-A — autorité durable expand-first.
-- Aucun transcript, nom client, montant ni texte LLM n'entre dans ces tables.
-- Le marqueur nullable du brouillon conserve le contrat exact du writer N-1 tant qu'il vaut NULL.

BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

CREATE TABLE public.agent_missions (
  "id" UUID NOT NULL,
  "companyId" TEXT NOT NULL,
  "ownerUserId" TEXT NOT NULL,
  "kind" TEXT NOT NULL,
  "status" TEXT NOT NULL,
  "phase" TEXT NOT NULL,
  "revision" INTEGER NOT NULL,
  "payloadVersion" INTEGER NOT NULL,
  "payload" JSONB NOT NULL,
  "currentBinding" JSONB,
  "idleExpiresAt" TIMESTAMPTZ(6) NOT NULL,
  "hardExpiresAt" TIMESTAMPTZ(6) NOT NULL,
  "terminalAt" TIMESTAMPTZ(6),
  "retentionExpiresAt" TIMESTAMPTZ(6) NOT NULL,
  "createdAt" TIMESTAMPTZ(6) NOT NULL,
  "updatedAt" TIMESTAMPTZ(6) NOT NULL,
  CONSTRAINT agent_missions_pkey PRIMARY KEY ("id"),
  CONSTRAINT agent_missions_owner_binding_key UNIQUE ("id", "companyId", "ownerUserId"),
  CONSTRAINT agent_missions_company_fkey
    FOREIGN KEY ("companyId") REFERENCES public.companies("id")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT agent_missions_owner_identifier_check CHECK (
    length("ownerUserId") BETWEEN 1 AND 200
    AND "ownerUserId" = btrim("ownerUserId")
    AND "ownerUserId" !~ '[[:cntrl:]]'
  ),
  CONSTRAINT agent_missions_kind_check CHECK ("kind" = 'quote_creation'),
  CONSTRAINT agent_missions_status_check CHECK ("status" IN (
    -- BEGIN GENERATED AGENT_MISSION_STATUSES
    'active',
    'cancelled',
    'expired'
    -- END GENERATED AGENT_MISSION_STATUSES
  )),
  CONSTRAINT agent_missions_phase_check CHECK ("phase" IN (
    -- BEGIN GENERATED QUOTE_CREATION_MISSION_PHASES
    'awaiting_draft_decision',
    'awaiting_draft_discard_confirmation',
    'awaiting_quote_screen',
    'awaiting_customer',
    'awaiting_customer_choice',
    'awaiting_lines'
    -- END GENERATED QUOTE_CREATION_MISSION_PHASES
  )),
  CONSTRAINT agent_missions_revision_check
    CHECK ("revision" BETWEEN 1 AND 2147483647),
  CONSTRAINT agent_missions_payload_check CHECK (
    "payloadVersion" = 1
    AND jsonb_typeof("payload") = 'object'
    AND "payload" ?& ARRAY[
      -- BEGIN GENERATED QUOTE_MISSION_PAYLOAD_KEYS
      'schema',
      'version',
      'draft',
      'decision'
      -- END GENERATED QUOTE_MISSION_PAYLOAD_KEYS
    ]
    AND "payload" @> '{"schema":"bob.agent-mission.quote-creation","version":1}'::JSONB
    AND octet_length("payload"::TEXT) <= 65536
  ),
  CONSTRAINT agent_missions_payload_closed_shape_check CHECK ((
    "payload" - ARRAY[
      -- BEGIN GENERATED QUOTE_MISSION_PAYLOAD_KEYS
      'schema',
      'version',
      'draft',
      'decision'
      -- END GENERATED QUOTE_MISSION_PAYLOAD_KEYS
    ] = '{}'::JSONB
    AND (
      "payload" -> 'draft' = 'null'::JSONB
      OR (
        jsonb_typeof("payload" -> 'draft') = 'object'
        AND "payload" -> 'draft' ?& ARRAY[
          -- BEGIN GENERATED QUOTE_MISSION_DRAFT_REFERENCE_KEYS
          'sessionId',
          'slotRevision',
          'contentRevision'
          -- END GENERATED QUOTE_MISSION_DRAFT_REFERENCE_KEYS
        ]
        AND ("payload" -> 'draft') - ARRAY[
          -- BEGIN GENERATED QUOTE_MISSION_DRAFT_REFERENCE_KEYS
          'sessionId',
          'slotRevision',
          'contentRevision'
          -- END GENERATED QUOTE_MISSION_DRAFT_REFERENCE_KEYS
        ] = '{}'::JSONB
        AND jsonb_typeof("payload" #> '{draft,sessionId}') = 'string'
        AND length("payload" #>> '{draft,sessionId}') BETWEEN 1 AND 200
        AND "payload" #>> '{draft,sessionId}'
          = btrim("payload" #>> '{draft,sessionId}')
        AND "payload" #>> '{draft,sessionId}' !~ '[[:cntrl:]]'
        AND jsonb_typeof("payload" #> '{draft,slotRevision}') = 'number'
        AND ("payload" #>> '{draft,slotRevision}')::NUMERIC
          BETWEEN 1 AND 2147483647
        AND ("payload" #>> '{draft,slotRevision}')::NUMERIC
          = trunc(("payload" #>> '{draft,slotRevision}')::NUMERIC)
        AND jsonb_typeof("payload" #> '{draft,contentRevision}') = 'number'
        AND ("payload" #>> '{draft,contentRevision}')::NUMERIC
          BETWEEN 0 AND 2147483647
        AND ("payload" #>> '{draft,contentRevision}')::NUMERIC
          = trunc(("payload" #>> '{draft,contentRevision}')::NUMERIC)
      )
    )
    AND (
      "payload" -> 'decision' = 'null'::JSONB
      OR (
        jsonb_typeof("payload" -> 'decision') = 'object'
        AND "payload" -> 'decision' ->> 'kind' IN (
          -- BEGIN GENERATED QUOTE_MISSION_DECISION_KINDS
          'existing_draft',
          'confirm_draft_discard',
          'customer'
          -- END GENERATED QUOTE_MISSION_DECISION_KINDS
        )
        AND jsonb_typeof("payload" #> '{decision,decisionId}') = 'string'
        AND "payload" #>> '{decision,decisionId}'
          ~ '^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$'
        AND jsonb_typeof("payload" #> '{decision,choiceSetRevision}') = 'number'
        AND ("payload" #>> '{decision,choiceSetRevision}')::NUMERIC
          BETWEEN 1 AND "revision"
        AND ("payload" #>> '{decision,choiceSetRevision}')::NUMERIC
          = trunc(("payload" #>> '{decision,choiceSetRevision}')::NUMERIC)
        AND jsonb_typeof("payload" #> '{decision,choiceSetHash}') = 'string'
        AND "payload" #>> '{decision,choiceSetHash}' ~ '^[a-f0-9]{64}$'
        AND (
          (
            "payload" -> 'decision' ->> 'kind' IN (
              'existing_draft',
              'confirm_draft_discard'
            )
            AND "payload" -> 'decision' ?& ARRAY[
              -- BEGIN GENERATED QUOTE_MISSION_DRAFT_DECISION_KEYS
              'kind',
              'decisionId',
              'choiceSetRevision',
              'expectedDraftSessionId',
              'expectedDraftSlotRevision',
              'expectedDraftContentRevision',
              'choices',
              'choiceSetHash'
              -- END GENERATED QUOTE_MISSION_DRAFT_DECISION_KEYS
            ]
            AND ("payload" -> 'decision') - ARRAY[
              -- BEGIN GENERATED QUOTE_MISSION_DRAFT_DECISION_KEYS
              'kind',
              'decisionId',
              'choiceSetRevision',
              'expectedDraftSessionId',
              'expectedDraftSlotRevision',
              'expectedDraftContentRevision',
              'choices',
              'choiceSetHash'
              -- END GENERATED QUOTE_MISSION_DRAFT_DECISION_KEYS
            ] = '{}'::JSONB
            AND jsonb_typeof("payload" #> '{decision,expectedDraftSessionId}')
              = 'string'
            AND length("payload" #>> '{decision,expectedDraftSessionId}')
              BETWEEN 1 AND 200
            AND "payload" #>> '{decision,expectedDraftSessionId}'
              = btrim("payload" #>> '{decision,expectedDraftSessionId}')
            AND "payload" #>> '{decision,expectedDraftSessionId}' !~ '[[:cntrl:]]'
            AND jsonb_typeof("payload" #> '{decision,expectedDraftSlotRevision}')
              = 'number'
            AND ("payload" #>> '{decision,expectedDraftSlotRevision}')::NUMERIC
              BETWEEN 1 AND 2147483647
            AND ("payload" #>> '{decision,expectedDraftSlotRevision}')::NUMERIC
              = trunc(("payload" #>> '{decision,expectedDraftSlotRevision}')::NUMERIC)
            AND jsonb_typeof("payload" #> '{decision,expectedDraftContentRevision}')
              = 'number'
            AND ("payload" #>> '{decision,expectedDraftContentRevision}')::NUMERIC
              BETWEEN 0 AND 2147483647
            AND ("payload" #>> '{decision,expectedDraftContentRevision}')::NUMERIC
              = trunc(("payload" #>> '{decision,expectedDraftContentRevision}')::NUMERIC)
            AND jsonb_typeof("payload" #> '{decision,choices}') = 'array'
            AND jsonb_array_length("payload" #> '{decision,choices}') = 2
            AND ("payload" #> '{decision,choices,0}') ?& ARRAY[
              -- BEGIN GENERATED QUOTE_MISSION_ACTION_CHOICE_KEYS
              'choiceId',
              'action'
              -- END GENERATED QUOTE_MISSION_ACTION_CHOICE_KEYS
            ]
            AND ("payload" #> '{decision,choices,0}') - ARRAY[
              -- BEGIN GENERATED QUOTE_MISSION_ACTION_CHOICE_KEYS
              'choiceId',
              'action'
              -- END GENERATED QUOTE_MISSION_ACTION_CHOICE_KEYS
            ] = '{}'::JSONB
            AND ("payload" #> '{decision,choices,1}') ?& ARRAY[
              -- BEGIN GENERATED QUOTE_MISSION_ACTION_CHOICE_KEYS
              'choiceId',
              'action'
              -- END GENERATED QUOTE_MISSION_ACTION_CHOICE_KEYS
            ]
            AND ("payload" #> '{decision,choices,1}') - ARRAY[
              -- BEGIN GENERATED QUOTE_MISSION_ACTION_CHOICE_KEYS
              'choiceId',
              'action'
              -- END GENERATED QUOTE_MISSION_ACTION_CHOICE_KEYS
            ] = '{}'::JSONB
            AND "payload" #>> '{decision,choices,0,choiceId}'
              ~ '^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$'
            AND "payload" #>> '{decision,choices,1,choiceId}'
              ~ '^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$'
            AND (
              (
                "payload" -> 'decision' ->> 'kind' = 'existing_draft'
                AND "payload" #>> '{decision,choices,0,action}' =
                  -- BEGIN GENERATED QUOTE_MISSION_EXISTING_DRAFT_FIRST_ACTION
                  'resume_existing'
                  -- END GENERATED QUOTE_MISSION_EXISTING_DRAFT_FIRST_ACTION
                AND "payload" #>> '{decision,choices,1,action}' =
                  -- BEGIN GENERATED QUOTE_MISSION_EXISTING_DRAFT_SECOND_ACTION
                  'request_discard'
                  -- END GENERATED QUOTE_MISSION_EXISTING_DRAFT_SECOND_ACTION
              )
              OR (
                "payload" -> 'decision' ->> 'kind' = 'confirm_draft_discard'
                AND "payload" #>> '{decision,choices,0,action}' =
                  -- BEGIN GENERATED QUOTE_MISSION_CONFIRM_DISCARD_FIRST_ACTION
                  'confirm_discard'
                  -- END GENERATED QUOTE_MISSION_CONFIRM_DISCARD_FIRST_ACTION
                AND "payload" #>> '{decision,choices,1,action}' =
                  -- BEGIN GENERATED QUOTE_MISSION_CONFIRM_DISCARD_SECOND_ACTION
                  'keep_existing'
                  -- END GENERATED QUOTE_MISSION_CONFIRM_DISCARD_SECOND_ACTION
              )
            )
          )
          OR (
            "payload" -> 'decision' ->> 'kind' = 'customer'
            AND "payload" -> 'decision' ?& ARRAY[
              -- BEGIN GENERATED QUOTE_MISSION_CUSTOMER_DECISION_KEYS
              'kind',
              'decisionId',
              'choiceSetRevision',
              'candidates',
              'choiceSetHash'
              -- END GENERATED QUOTE_MISSION_CUSTOMER_DECISION_KEYS
            ]
            AND ("payload" -> 'decision') - ARRAY[
              -- BEGIN GENERATED QUOTE_MISSION_CUSTOMER_DECISION_KEYS
              'kind',
              'decisionId',
              'choiceSetRevision',
              'candidates',
              'choiceSetHash'
              -- END GENERATED QUOTE_MISSION_CUSTOMER_DECISION_KEYS
            ] = '{}'::JSONB
            AND jsonb_typeof("payload" #> '{decision,candidates}') = 'array'
            AND jsonb_array_length("payload" #> '{decision,candidates}') BETWEEN 1 AND 5
            AND
            -- BEGIN GENERATED QUOTE_MISSION_CUSTOMER_CANDIDATE_CHECKS
            (
              jsonb_array_length("payload" #> '{decision,candidates}') <= 0
              OR (
                jsonb_typeof("payload" #> '{decision,candidates,0}') = 'object'
                AND ("payload" #> '{decision,candidates,0}') ?& ARRAY[
                  'choiceId',
                  'customerId'
                ]
                AND ("payload" #> '{decision,candidates,0}') - ARRAY[
                  'choiceId',
                  'customerId'
                ] = '{}'::JSONB
                AND ("payload" #> '{decision,candidates,0}') ->> 'choiceId'
                  ~ '^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$'
                AND jsonb_typeof(("payload" #> '{decision,candidates,0}') -> 'customerId') = 'string'
                AND length(("payload" #> '{decision,candidates,0}') ->> 'customerId') BETWEEN 1 AND 200
                AND ("payload" #> '{decision,candidates,0}') ->> 'customerId'
                  = btrim(("payload" #> '{decision,candidates,0}') ->> 'customerId')
                AND ("payload" #> '{decision,candidates,0}') ->> 'customerId' !~ '[[:cntrl:]]'
              )
            )
            AND (
              jsonb_array_length("payload" #> '{decision,candidates}') <= 1
              OR (
                jsonb_typeof("payload" #> '{decision,candidates,1}') = 'object'
                AND ("payload" #> '{decision,candidates,1}') ?& ARRAY[
                  'choiceId',
                  'customerId'
                ]
                AND ("payload" #> '{decision,candidates,1}') - ARRAY[
                  'choiceId',
                  'customerId'
                ] = '{}'::JSONB
                AND ("payload" #> '{decision,candidates,1}') ->> 'choiceId'
                  ~ '^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$'
                AND jsonb_typeof(("payload" #> '{decision,candidates,1}') -> 'customerId') = 'string'
                AND length(("payload" #> '{decision,candidates,1}') ->> 'customerId') BETWEEN 1 AND 200
                AND ("payload" #> '{decision,candidates,1}') ->> 'customerId'
                  = btrim(("payload" #> '{decision,candidates,1}') ->> 'customerId')
                AND ("payload" #> '{decision,candidates,1}') ->> 'customerId' !~ '[[:cntrl:]]'
              )
            )
            AND (
              jsonb_array_length("payload" #> '{decision,candidates}') <= 2
              OR (
                jsonb_typeof("payload" #> '{decision,candidates,2}') = 'object'
                AND ("payload" #> '{decision,candidates,2}') ?& ARRAY[
                  'choiceId',
                  'customerId'
                ]
                AND ("payload" #> '{decision,candidates,2}') - ARRAY[
                  'choiceId',
                  'customerId'
                ] = '{}'::JSONB
                AND ("payload" #> '{decision,candidates,2}') ->> 'choiceId'
                  ~ '^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$'
                AND jsonb_typeof(("payload" #> '{decision,candidates,2}') -> 'customerId') = 'string'
                AND length(("payload" #> '{decision,candidates,2}') ->> 'customerId') BETWEEN 1 AND 200
                AND ("payload" #> '{decision,candidates,2}') ->> 'customerId'
                  = btrim(("payload" #> '{decision,candidates,2}') ->> 'customerId')
                AND ("payload" #> '{decision,candidates,2}') ->> 'customerId' !~ '[[:cntrl:]]'
              )
            )
            AND (
              jsonb_array_length("payload" #> '{decision,candidates}') <= 3
              OR (
                jsonb_typeof("payload" #> '{decision,candidates,3}') = 'object'
                AND ("payload" #> '{decision,candidates,3}') ?& ARRAY[
                  'choiceId',
                  'customerId'
                ]
                AND ("payload" #> '{decision,candidates,3}') - ARRAY[
                  'choiceId',
                  'customerId'
                ] = '{}'::JSONB
                AND ("payload" #> '{decision,candidates,3}') ->> 'choiceId'
                  ~ '^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$'
                AND jsonb_typeof(("payload" #> '{decision,candidates,3}') -> 'customerId') = 'string'
                AND length(("payload" #> '{decision,candidates,3}') ->> 'customerId') BETWEEN 1 AND 200
                AND ("payload" #> '{decision,candidates,3}') ->> 'customerId'
                  = btrim(("payload" #> '{decision,candidates,3}') ->> 'customerId')
                AND ("payload" #> '{decision,candidates,3}') ->> 'customerId' !~ '[[:cntrl:]]'
              )
            )
            AND (
              jsonb_array_length("payload" #> '{decision,candidates}') <= 4
              OR (
                jsonb_typeof("payload" #> '{decision,candidates,4}') = 'object'
                AND ("payload" #> '{decision,candidates,4}') ?& ARRAY[
                  'choiceId',
                  'customerId'
                ]
                AND ("payload" #> '{decision,candidates,4}') - ARRAY[
                  'choiceId',
                  'customerId'
                ] = '{}'::JSONB
                AND ("payload" #> '{decision,candidates,4}') ->> 'choiceId'
                  ~ '^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$'
                AND jsonb_typeof(("payload" #> '{decision,candidates,4}') -> 'customerId') = 'string'
                AND length(("payload" #> '{decision,candidates,4}') ->> 'customerId') BETWEEN 1 AND 200
                AND ("payload" #> '{decision,candidates,4}') ->> 'customerId'
                  = btrim(("payload" #> '{decision,candidates,4}') ->> 'customerId')
                AND ("payload" #> '{decision,candidates,4}') ->> 'customerId' !~ '[[:cntrl:]]'
              )
            )
            -- END GENERATED QUOTE_MISSION_CUSTOMER_CANDIDATE_CHECKS
          )
        )
      )
    )
  ) IS TRUE),
  CONSTRAINT agent_missions_binding_shape_check CHECK (
    "currentBinding" IS NULL OR (
      jsonb_typeof("currentBinding") = 'object'
      AND "currentBinding" ?& ARRAY[
        -- BEGIN GENERATED AGENT_MISSION_CONTEXT_BINDING_KEYS
        'realtimeSessionId',
        'contextRevision',
        'contextDigest',
        'screenName',
        'screenInstanceId',
        'acknowledgedAt'
        -- END GENERATED AGENT_MISSION_CONTEXT_BINDING_KEYS
      ]
      AND "currentBinding" - ARRAY[
        -- BEGIN GENERATED AGENT_MISSION_CONTEXT_BINDING_KEYS
        'realtimeSessionId',
        'contextRevision',
        'contextDigest',
        'screenName',
        'screenInstanceId',
        'acknowledgedAt'
        -- END GENERATED AGENT_MISSION_CONTEXT_BINDING_KEYS
      ] = '{}'::JSONB
      AND "currentBinding" ->> 'realtimeSessionId'
        ~ '^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$'
      AND jsonb_typeof("currentBinding" -> 'contextRevision') = 'number'
      AND ("currentBinding" ->> 'contextRevision')::NUMERIC
        BETWEEN 1 AND 2147483647
      AND ("currentBinding" ->> 'contextRevision')::NUMERIC
        = trunc(("currentBinding" ->> 'contextRevision')::NUMERIC)
      AND "currentBinding" ->> 'contextDigest' ~ '^[a-f0-9]{64}$'
      AND "currentBinding" ->> 'screenName' IN (
        -- BEGIN GENERATED AGENT_MISSION_CONTEXT_SCREEN_NAMES
        '/devis/new'
        -- END GENERATED AGENT_MISSION_CONTEXT_SCREEN_NAMES
      )
      AND jsonb_typeof("currentBinding" -> 'screenInstanceId') = 'string'
      AND length("currentBinding" ->> 'screenInstanceId') BETWEEN 1 AND 160
      AND "currentBinding" ->> 'screenInstanceId'
        = btrim("currentBinding" ->> 'screenInstanceId')
      AND "currentBinding" ->> 'screenInstanceId' !~ '[[:cntrl:]]'
      AND "currentBinding" ->> 'acknowledgedAt'
        ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$'
      AND isfinite(("currentBinding" ->> 'acknowledgedAt')::TIMESTAMPTZ)
    )
  ),
  CONSTRAINT agent_missions_phase_payload_check CHECK ((
    (
      "phase" = 'awaiting_draft_decision'
      AND "payload" -> 'draft' = 'null'::JSONB
      AND "payload" -> 'decision' ->> 'kind' = 'existing_draft'
      AND "currentBinding" IS NULL
    )
    OR (
      "phase" = 'awaiting_draft_discard_confirmation'
      AND "payload" -> 'draft' = 'null'::JSONB
      AND "payload" -> 'decision' ->> 'kind' = 'confirm_draft_discard'
      AND "currentBinding" IS NULL
    )
    OR (
      "phase" = 'awaiting_quote_screen'
      AND jsonb_typeof("payload" -> 'draft') = 'object'
      AND "payload" -> 'decision' = 'null'::JSONB
      AND "currentBinding" IS NULL
    )
    OR (
      "phase" = 'awaiting_customer'
      AND jsonb_typeof("payload" -> 'draft') = 'object'
      AND "payload" -> 'decision' = 'null'::JSONB
      AND jsonb_typeof("currentBinding") = 'object'
    )
    OR (
      "phase" = 'awaiting_customer_choice'
      AND jsonb_typeof("payload" -> 'draft') = 'object'
      AND "payload" -> 'decision' ->> 'kind' = 'customer'
      AND jsonb_typeof("currentBinding") = 'object'
    )
    OR (
      "phase" = 'awaiting_lines'
      AND jsonb_typeof("payload" -> 'draft') = 'object'
      AND "payload" -> 'decision' = 'null'::JSONB
      AND jsonb_typeof("currentBinding") = 'object'
    )
  ) IS TRUE),
  CONSTRAINT agent_missions_finite_timestamps_check CHECK (
    isfinite("createdAt")
    AND isfinite("updatedAt")
    AND isfinite("idleExpiresAt")
    AND isfinite("hardExpiresAt")
    AND isfinite("retentionExpiresAt")
    AND ("terminalAt" IS NULL OR isfinite("terminalAt"))
  ),
  CONSTRAINT agent_missions_timestamps_check CHECK (
    "updatedAt" >= "createdAt"
    AND "hardExpiresAt" = "createdAt" + INTERVAL '168 hours'
    AND "idleExpiresAt" > "createdAt"
    AND "idleExpiresAt" <= "hardExpiresAt"
    AND (
      (
        "status" = 'active'
        AND "terminalAt" IS NULL
        AND "updatedAt" < "idleExpiresAt"
        AND "updatedAt" < "hardExpiresAt"
        AND "idleExpiresAt" = LEAST(
          "updatedAt" + INTERVAL '24 hours',
          "hardExpiresAt"
        )
        AND "retentionExpiresAt" = "hardExpiresAt" + INTERVAL '2160 hours'
      )
      OR (
        "status" = 'cancelled'
        AND "terminalAt" IS NOT NULL
        AND "updatedAt" = "terminalAt"
        AND "terminalAt" < "idleExpiresAt"
        AND "terminalAt" < "hardExpiresAt"
        AND "retentionExpiresAt" = "terminalAt" + INTERVAL '2160 hours'
      )
      OR (
        "status" = 'expired'
        AND "terminalAt" IS NOT NULL
        AND "updatedAt" = "terminalAt"
        AND "terminalAt" >= LEAST("idleExpiresAt", "hardExpiresAt")
        AND "retentionExpiresAt" = "terminalAt" + INTERVAL '2160 hours'
      )
    )
  )
);

CREATE UNIQUE INDEX agent_missions_one_active_owner_kind_key
  ON public.agent_missions ("companyId", "ownerUserId", "kind")
  WHERE "status" = 'active';
CREATE INDEX agent_missions_owner_status_idx
  ON public.agent_missions ("companyId", "ownerUserId", "kind", "status");
CREATE INDEX agent_missions_retention_idx
  ON public.agent_missions ("retentionExpiresAt");

CREATE TABLE public.agent_mission_events (
  "id" UUID NOT NULL,
  "companyId" TEXT NOT NULL,
  "ownerUserId" TEXT NOT NULL,
  "missionId" UUID NOT NULL,
  "sequence" INTEGER NOT NULL,
  "eventType" TEXT NOT NULL,
  "eventVersion" INTEGER NOT NULL,
  "actor" TEXT NOT NULL,
  "commandId" UUID NOT NULL,
  "requestFingerprintHmac" CHAR(64) NOT NULL,
  "fingerprintKeyVersion" INTEGER NOT NULL,
  "fingerprintCanonicalizationVersion" INTEGER NOT NULL,
  "missionRevisionBefore" INTEGER NOT NULL,
  "missionRevisionAfter" INTEGER NOT NULL,
  "draftSlotRevisionBefore" INTEGER,
  "draftSlotRevisionAfter" INTEGER,
  "draftContentRevisionBefore" INTEGER,
  "draftContentRevisionAfter" INTEGER,
  "realtimeSessionId" UUID,
  "turnId" UUID,
  "contextRevision" INTEGER,
  "contextDigest" CHAR(64),
  "data" JSONB NOT NULL,
  "occurredAt" TIMESTAMPTZ(6) NOT NULL,
  "retentionExpiresAt" TIMESTAMPTZ(6) NOT NULL,
  CONSTRAINT agent_mission_events_pkey PRIMARY KEY ("id"),
  CONSTRAINT agent_mission_events_owner_command_key
    UNIQUE ("companyId", "ownerUserId", "commandId"),
  CONSTRAINT agent_mission_events_sequence_key UNIQUE ("missionId", "sequence"),
  CONSTRAINT agent_mission_events_mission_owner_fkey
    FOREIGN KEY ("missionId", "companyId", "ownerUserId")
    REFERENCES public.agent_missions("id", "companyId", "ownerUserId")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT agent_mission_events_company_fkey
    FOREIGN KEY ("companyId") REFERENCES public.companies("id")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT agent_mission_events_owner_identifier_check CHECK (
    length("ownerUserId") BETWEEN 1 AND 200
    AND "ownerUserId" = btrim("ownerUserId")
    AND "ownerUserId" !~ '[[:cntrl:]]'
  ),
  CONSTRAINT agent_mission_events_type_check CHECK ("eventType" IN (
    -- BEGIN GENERATED AGENT_MISSION_EVENT_TYPES
    'mission_started',
    'mission_joined',
    'draft_resume_selected',
    'draft_discard_requested',
    'draft_discard_cancelled',
    'draft_discard_confirmed',
    'screen_acknowledged',
    'customer_not_found',
    'customer_choice_presented',
    'customer_selected',
    'decision_invalidated',
    'mission_cancelled',
    'mission_expired'
    -- END GENERATED AGENT_MISSION_EVENT_TYPES
  )),
  CONSTRAINT agent_mission_events_envelope_check CHECK (
    "eventVersion" = 1
    AND "actor" IN (
      -- BEGIN GENERATED AGENT_MISSION_ACTORS
      'user_voice',
      'user_tap',
      'system'
      -- END GENERATED AGENT_MISSION_ACTORS
    )
    AND (
      (
        "actor" IN (
          -- BEGIN GENERATED AGENT_MISSION_USER_ACTORS
          'user_voice',
          'user_tap'
          -- END GENERATED AGENT_MISSION_USER_ACTORS
        )
        AND "commandId"::TEXT ~ '^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$'
      )
      OR (
        "actor" IN (
          -- BEGIN GENERATED AGENT_MISSION_SYSTEM_ACTORS
          'system'
          -- END GENERATED AGENT_MISSION_SYSTEM_ACTORS
        )
        AND "commandId"::TEXT ~ '^[a-f0-9]{8}-[a-f0-9]{4}-8[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$'
      )
    )
    AND "requestFingerprintHmac"::TEXT ~ '^[a-f0-9]{64}$'
    AND "fingerprintKeyVersion" BETWEEN 1 AND 2147483647
    AND "fingerprintCanonicalizationVersion" = 1
    AND "sequence" = "missionRevisionAfter"
    AND (
      (
        "eventType" IN (
          -- BEGIN GENERATED AGENT_MISSION_DRAFT_START_EVENT_TYPES
          'mission_started'
          -- END GENERATED AGENT_MISSION_DRAFT_START_EVENT_TYPES
        )
        AND "missionRevisionBefore" = 0
        AND "missionRevisionAfter" = 1
      )
      OR (
        "eventType" NOT IN (
          -- BEGIN GENERATED AGENT_MISSION_DRAFT_START_EVENT_TYPES
          'mission_started'
          -- END GENERATED AGENT_MISSION_DRAFT_START_EVENT_TYPES
        )
        AND "missionRevisionBefore" BETWEEN 1 AND 2147483646
        AND "missionRevisionAfter" = "missionRevisionBefore" + 1
      )
    )
  ),
  CONSTRAINT agent_mission_events_draft_revision_check CHECK (
    ("draftSlotRevisionBefore" IS NULL) = ("draftContentRevisionBefore" IS NULL)
    AND ("draftSlotRevisionAfter" IS NULL) = ("draftContentRevisionAfter" IS NULL)
    AND (
      "draftSlotRevisionBefore" IS NULL
      OR "draftSlotRevisionBefore" BETWEEN 1 AND 2147483647
    )
    AND (
      "draftSlotRevisionAfter" IS NULL
      OR "draftSlotRevisionAfter" BETWEEN 1 AND 2147483647
    )
    AND (
      "draftContentRevisionBefore" IS NULL
      OR "draftContentRevisionBefore" BETWEEN 0 AND 2147483647
    )
    AND (
      "draftContentRevisionAfter" IS NULL
      OR "draftContentRevisionAfter" BETWEEN 0 AND 2147483647
    )
  ),
  CONSTRAINT agent_mission_events_data_check CHECK ((
    jsonb_typeof("data") = 'object'
    AND "data" ->> 'kind' = "eventType"
    AND (
      (
        "eventType" = 'mission_started'
        AND "data" ?& ARRAY[
          -- BEGIN GENERATED AGENT_MISSION_EVENT_START_DATA_KEYS
          'kind',
          'startOutcome'
          -- END GENERATED AGENT_MISSION_EVENT_START_DATA_KEYS
        ]
        AND "data" - ARRAY[
          -- BEGIN GENERATED AGENT_MISSION_EVENT_START_DATA_KEYS
          'kind',
          'startOutcome'
          -- END GENERATED AGENT_MISSION_EVENT_START_DATA_KEYS
        ] = '{}'::JSONB
        AND "data" ->> 'startOutcome' IN (
          -- BEGIN GENERATED AGENT_MISSION_START_OUTCOMES
          'no_slot',
          'empty_slot_adopted',
          'draft_conflict'
          -- END GENERATED AGENT_MISSION_START_OUTCOMES
        )
      )
      OR (
        "eventType" IN (
          -- BEGIN GENERATED AGENT_MISSION_KIND_ONLY_EVENT_TYPES
          'mission_joined',
          'draft_resume_selected',
          'draft_discard_requested',
          'draft_discard_cancelled',
          'draft_discard_confirmed'
          -- END GENERATED AGENT_MISSION_KIND_ONLY_EVENT_TYPES
        )
        AND "data" ?& ARRAY[
          -- BEGIN GENERATED AGENT_MISSION_EVENT_KIND_ONLY_DATA_KEYS
          'kind'
          -- END GENERATED AGENT_MISSION_EVENT_KIND_ONLY_DATA_KEYS
        ]
        AND "data" - ARRAY[
          -- BEGIN GENERATED AGENT_MISSION_EVENT_KIND_ONLY_DATA_KEYS
          'kind'
          -- END GENERATED AGENT_MISSION_EVENT_KIND_ONLY_DATA_KEYS
        ] = '{}'::JSONB
      )
      OR (
        "eventType" = 'screen_acknowledged'
        AND "data" ?& ARRAY[
          -- BEGIN GENERATED AGENT_MISSION_EVENT_NEXT_PHASE_DATA_KEYS
          'kind',
          'nextPhase'
          -- END GENERATED AGENT_MISSION_EVENT_NEXT_PHASE_DATA_KEYS
        ]
        AND "data" - ARRAY[
          -- BEGIN GENERATED AGENT_MISSION_EVENT_NEXT_PHASE_DATA_KEYS
          'kind',
          'nextPhase'
          -- END GENERATED AGENT_MISSION_EVENT_NEXT_PHASE_DATA_KEYS
        ] = '{}'::JSONB
        AND "data" ->> 'nextPhase' IN (
          -- BEGIN GENERATED AGENT_MISSION_SCREEN_ACK_NEXT_PHASES
          'awaiting_customer',
          'awaiting_customer_choice',
          'awaiting_lines'
          -- END GENERATED AGENT_MISSION_SCREEN_ACK_NEXT_PHASES
        )
      )
      OR (
        "eventType" = 'customer_not_found'
        AND "data" ?& ARRAY[
          -- BEGIN GENERATED AGENT_MISSION_EVENT_RESULT_DATA_KEYS
          'kind',
          'result'
          -- END GENERATED AGENT_MISSION_EVENT_RESULT_DATA_KEYS
        ]
        AND "data" - ARRAY[
          -- BEGIN GENERATED AGENT_MISSION_EVENT_RESULT_DATA_KEYS
          'kind',
          'result'
          -- END GENERATED AGENT_MISSION_EVENT_RESULT_DATA_KEYS
        ] = '{}'::JSONB
        AND "data" ->> 'result' IN (
          -- BEGIN GENERATED AGENT_MISSION_CUSTOMER_NOT_FOUND_RESULTS
          'none',
          'too_many'
          -- END GENERATED AGENT_MISSION_CUSTOMER_NOT_FOUND_RESULTS
        )
      )
      OR (
        "eventType" = 'customer_choice_presented'
        AND "data" ?& ARRAY[
          -- BEGIN GENERATED AGENT_MISSION_EVENT_CHOICE_PRESENTED_DATA_KEYS
          'kind',
          'candidateCount',
          'choiceSetHash'
          -- END GENERATED AGENT_MISSION_EVENT_CHOICE_PRESENTED_DATA_KEYS
        ]
        AND "data" - ARRAY[
          -- BEGIN GENERATED AGENT_MISSION_EVENT_CHOICE_PRESENTED_DATA_KEYS
          'kind',
          'candidateCount',
          'choiceSetHash'
          -- END GENERATED AGENT_MISSION_EVENT_CHOICE_PRESENTED_DATA_KEYS
        ] = '{}'::JSONB
        AND jsonb_typeof("data" -> 'candidateCount') = 'number'
        AND ("data" ->> 'candidateCount')::NUMERIC BETWEEN 1 AND 5
        AND ("data" ->> 'candidateCount')::NUMERIC
          = trunc(("data" ->> 'candidateCount')::NUMERIC)
        AND "data" ->> 'choiceSetHash' ~ '^[a-f0-9]{64}$'
      )
      OR (
        "eventType" = 'customer_selected'
        AND "data" ?& ARRAY[
          -- BEGIN GENERATED AGENT_MISSION_EVENT_CUSTOMER_SELECTED_DATA_KEYS
          'kind',
          'customerId',
          'source',
          'choiceId',
          'choiceSetHash'
          -- END GENERATED AGENT_MISSION_EVENT_CUSTOMER_SELECTED_DATA_KEYS
        ]
        AND "data" - ARRAY[
          -- BEGIN GENERATED AGENT_MISSION_EVENT_CUSTOMER_SELECTED_DATA_KEYS
          'kind',
          'customerId',
          'source',
          'choiceId',
          'choiceSetHash'
          -- END GENERATED AGENT_MISSION_EVENT_CUSTOMER_SELECTED_DATA_KEYS
        ] = '{}'::JSONB
        AND jsonb_typeof("data" -> 'customerId') = 'string'
        AND length("data" ->> 'customerId') BETWEEN 1 AND 200
        AND "data" ->> 'customerId' = btrim("data" ->> 'customerId')
        AND "data" ->> 'customerId' !~ '[[:cntrl:]]'
        AND "data" ->> 'source' IN (
          -- BEGIN GENERATED AGENT_MISSION_CUSTOMER_SELECTION_SOURCES
          'exact_match',
          'presented_choice',
          'screen_selection'
          -- END GENERATED AGENT_MISSION_CUSTOMER_SELECTION_SOURCES
        )
        AND (
          (
            "data" ->> 'source' = 'presented_choice'
            AND "data" ->> 'choiceId'
              ~ '^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$'
            AND "data" ->> 'choiceSetHash' ~ '^[a-f0-9]{64}$'
          )
          OR (
            "data" ->> 'source' <> 'presented_choice'
            AND "data" -> 'choiceId' = 'null'::JSONB
            AND "data" -> 'choiceSetHash' = 'null'::JSONB
          )
        )
      )
      OR (
        "eventType" = 'decision_invalidated'
        AND "data" ?& ARRAY[
          -- BEGIN GENERATED AGENT_MISSION_EVENT_REASON_DATA_KEYS
          'kind',
          'reason'
          -- END GENERATED AGENT_MISSION_EVENT_REASON_DATA_KEYS
        ]
        AND "data" - ARRAY[
          -- BEGIN GENERATED AGENT_MISSION_EVENT_REASON_DATA_KEYS
          'kind',
          'reason'
          -- END GENERATED AGENT_MISSION_EVENT_REASON_DATA_KEYS
        ] = '{}'::JSONB
        AND "data" ->> 'reason' IN (
          -- BEGIN GENERATED AGENT_MISSION_DECISION_INVALIDATION_REASONS
          'candidate_unavailable',
          'draft_changed',
          'choice_set_stale'
          -- END GENERATED AGENT_MISSION_DECISION_INVALIDATION_REASONS
        )
      )
      OR (
        "eventType" = 'mission_cancelled'
        AND "data" ?& ARRAY[
          -- BEGIN GENERATED AGENT_MISSION_EVENT_REASON_DATA_KEYS
          'kind',
          'reason'
          -- END GENERATED AGENT_MISSION_EVENT_REASON_DATA_KEYS
        ]
        AND "data" - ARRAY[
          -- BEGIN GENERATED AGENT_MISSION_EVENT_REASON_DATA_KEYS
          'kind',
          'reason'
          -- END GENERATED AGENT_MISSION_EVENT_REASON_DATA_KEYS
        ] = '{}'::JSONB
        AND "data" ->> 'reason' IN (
          -- BEGIN GENERATED AGENT_MISSION_CANCELLATION_REASONS
          'user_cancelled',
          'manual_handoff'
          -- END GENERATED AGENT_MISSION_CANCELLATION_REASONS
        )
      )
      OR (
        "eventType" = 'mission_expired'
        AND "data" ?& ARRAY[
          -- BEGIN GENERATED AGENT_MISSION_EVENT_REASON_DATA_KEYS
          'kind',
          'reason'
          -- END GENERATED AGENT_MISSION_EVENT_REASON_DATA_KEYS
        ]
        AND "data" - ARRAY[
          -- BEGIN GENERATED AGENT_MISSION_EVENT_REASON_DATA_KEYS
          'kind',
          'reason'
          -- END GENERATED AGENT_MISSION_EVENT_REASON_DATA_KEYS
        ] = '{}'::JSONB
        AND "data" ->> 'reason' IN (
          -- BEGIN GENERATED AGENT_MISSION_EXPIRY_REASONS
          'idle_ttl',
          'hard_ttl'
          -- END GENERATED AGENT_MISSION_EXPIRY_REASONS
        )
      )
    )
    AND octet_length("data"::TEXT) <= 32768
  ) IS TRUE),
  CONSTRAINT agent_mission_events_correlation_check CHECK ((
    (
      "eventType" IN (
        -- BEGIN GENERATED AGENT_MISSION_CORRELATION_SYSTEM_EVENT_TYPES
        'mission_expired'
        -- END GENERATED AGENT_MISSION_CORRELATION_SYSTEM_EVENT_TYPES
      )
      AND "actor" IN (
        -- BEGIN GENERATED AGENT_MISSION_SYSTEM_ACTORS
        'system'
        -- END GENERATED AGENT_MISSION_SYSTEM_ACTORS
      )
      AND "realtimeSessionId" IS NULL
      AND "turnId" IS NULL
      AND "contextRevision" IS NULL
      AND "contextDigest" IS NULL
    )
    OR (
      "eventType" IN (
        -- BEGIN GENERATED AGENT_MISSION_CORRELATION_SCREEN_ACK_EVENT_TYPES
        'screen_acknowledged'
        -- END GENERATED AGENT_MISSION_CORRELATION_SCREEN_ACK_EVENT_TYPES
      )
      AND "actor" IN (
        -- BEGIN GENERATED AGENT_MISSION_SYSTEM_ACTORS
        'system'
        -- END GENERATED AGENT_MISSION_SYSTEM_ACTORS
      )
      AND "realtimeSessionId" IS NOT NULL
      AND "turnId" IS NULL
      AND "contextRevision" BETWEEN 1 AND 2147483647
      AND "contextDigest"::TEXT ~ '^[a-f0-9]{64}$'
    )
    OR (
      "eventType" IN (
        -- BEGIN GENERATED AGENT_MISSION_CORRELATION_USER_EVENT_TYPES
        'mission_started',
        'mission_joined',
        'draft_resume_selected',
        'draft_discard_requested',
        'draft_discard_cancelled',
        'draft_discard_confirmed',
        'customer_not_found',
        'customer_choice_presented',
        'customer_selected',
        'decision_invalidated',
        'mission_cancelled'
        -- END GENERATED AGENT_MISSION_CORRELATION_USER_EVENT_TYPES
      )
      AND "actor" IN (
        -- BEGIN GENERATED AGENT_MISSION_USER_ACTORS
        'user_voice',
        'user_tap'
        -- END GENERATED AGENT_MISSION_USER_ACTORS
      )
      AND (
        (
          "actor" IN (
            -- BEGIN GENERATED AGENT_MISSION_VOICE_ACTORS
            'user_voice'
            -- END GENERATED AGENT_MISSION_VOICE_ACTORS
          )
          AND "realtimeSessionId" IS NOT NULL
          AND "turnId" IS NOT NULL
          AND "contextRevision" BETWEEN 1 AND 2147483647
          AND "contextDigest"::TEXT ~ '^[a-f0-9]{64}$'
        )
        OR (
          "actor" IN (
            -- BEGIN GENERATED AGENT_MISSION_TAP_ACTORS
            'user_tap'
            -- END GENERATED AGENT_MISSION_TAP_ACTORS
          )
          AND "turnId" IS NULL
          AND (
            (
              "realtimeSessionId" IS NULL
              AND "contextRevision" IS NULL
              AND "contextDigest" IS NULL
            )
            OR (
              "realtimeSessionId" IS NOT NULL
              AND "contextRevision" BETWEEN 1 AND 2147483647
              AND "contextDigest"::TEXT ~ '^[a-f0-9]{64}$'
            )
          )
        )
      )
    )
  ) IS TRUE),
  CONSTRAINT agent_mission_events_draft_effect_check CHECK ((
    (
      "eventType" IN (
        -- BEGIN GENERATED AGENT_MISSION_DRAFT_START_EVENT_TYPES
        'mission_started'
        -- END GENERATED AGENT_MISSION_DRAFT_START_EVENT_TYPES
      )
      AND (
        (
          "data" ->> 'startOutcome' IN (
            -- BEGIN GENERATED AGENT_MISSION_START_NEW_SLOT_OUTCOMES
            'no_slot'
            -- END GENERATED AGENT_MISSION_START_NEW_SLOT_OUTCOMES
          )
          AND "draftSlotRevisionBefore" IS NULL
          AND "draftContentRevisionBefore" IS NULL
          AND "draftSlotRevisionAfter" = 1
          AND "draftContentRevisionAfter" = 0
        )
        OR (
          "data" ->> 'startOutcome' IN (
            -- BEGIN GENERATED AGENT_MISSION_START_EXISTING_SLOT_OUTCOMES
            'empty_slot_adopted',
            'draft_conflict'
            -- END GENERATED AGENT_MISSION_START_EXISTING_SLOT_OUTCOMES
          )
          AND "draftSlotRevisionBefore" = "draftSlotRevisionAfter"
          AND "draftContentRevisionBefore" = "draftContentRevisionAfter"
        )
      )
    )
    OR (
      "eventType" IN (
        -- BEGIN GENERATED AGENT_MISSION_DRAFT_NO_OP_EVENT_TYPES
        'mission_joined',
        'draft_resume_selected',
        'draft_discard_requested',
        'draft_discard_cancelled',
        'screen_acknowledged',
        'customer_not_found',
        'customer_choice_presented',
        'decision_invalidated',
        'mission_cancelled',
        'mission_expired'
        -- END GENERATED AGENT_MISSION_DRAFT_NO_OP_EVENT_TYPES
      )
      AND "draftSlotRevisionBefore" = "draftSlotRevisionAfter"
      AND "draftContentRevisionBefore" = "draftContentRevisionAfter"
    )
    OR (
      "eventType" IN (
        -- BEGIN GENERATED AGENT_MISSION_DRAFT_REPLACE_EVENT_TYPES
        'draft_discard_confirmed'
        -- END GENERATED AGENT_MISSION_DRAFT_REPLACE_EVENT_TYPES
      )
      AND "draftSlotRevisionBefore" BETWEEN 1 AND 2147483646
      AND "draftSlotRevisionAfter" = "draftSlotRevisionBefore" + 1
      AND "draftContentRevisionBefore" IS NOT NULL
      AND "draftContentRevisionAfter" = 0
    )
    OR (
      "eventType" IN (
        -- BEGIN GENERATED AGENT_MISSION_DRAFT_ADVANCE_CUSTOMER_EVENT_TYPES
        'customer_selected'
        -- END GENERATED AGENT_MISSION_DRAFT_ADVANCE_CUSTOMER_EVENT_TYPES
      )
      AND "draftSlotRevisionBefore" BETWEEN 1 AND 2147483646
      AND "draftSlotRevisionAfter" = "draftSlotRevisionBefore" + 1
      AND "draftContentRevisionBefore" BETWEEN 0 AND 2147483646
      AND "draftContentRevisionAfter" = "draftContentRevisionBefore" + 1
    )
  ) IS TRUE),
  CONSTRAINT agent_mission_events_timestamps_check CHECK (
    isfinite("occurredAt")
    AND isfinite("retentionExpiresAt")
    AND "retentionExpiresAt" = "occurredAt" + INTERVAL '2160 hours'
  )
);

CREATE INDEX agent_mission_events_owner_timeline_idx
  ON public.agent_mission_events (
    "companyId",
    "ownerUserId",
    "missionId",
    "occurredAt"
  );
CREATE INDEX agent_mission_events_retention_idx
  ON public.agent_mission_events ("retentionExpiresAt");

ALTER TABLE public.quote_draft_slots
  ADD COLUMN "agentMissionId" UUID;

CREATE UNIQUE INDEX quote_draft_slots_agent_mission_owner_key
  ON public.quote_draft_slots ("agentMissionId", "companyId", "ownerUserId");

-- Compatibilité N-1 : aucune ligne historique n'est modifiée. La validation est volontairement
-- séparée dans 20260726020000_agent_missions_validate.
ALTER TABLE public.quote_draft_slots
  ADD CONSTRAINT quote_draft_slots_agent_mission_owner_fkey
  FOREIGN KEY ("agentMissionId", "companyId", "ownerUserId")
  REFERENCES public.agent_missions("id", "companyId", "ownerUserId")
  ON DELETE RESTRICT ON UPDATE CASCADE
  NOT VALID;

CREATE FUNCTION public.guard_agent_mission_mutation_v1()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  expected_mission_id TEXT :=
    nullif(current_setting('app.current_agent_mission_id', true), '');
BEGIN
  IF expected_mission_id IS NULL OR expected_mission_id <> NEW."id"::TEXT THEN
    RAISE EXCEPTION 'AGENT_MISSION_CAPABILITY_REQUIRED'
      USING ERRCODE = '42501';
  END IF;
  IF TG_OP = 'UPDATE' AND (
    OLD."id" IS DISTINCT FROM NEW."id"
    OR OLD."companyId" IS DISTINCT FROM NEW."companyId"
    OR OLD."ownerUserId" IS DISTINCT FROM NEW."ownerUserId"
    OR OLD."kind" IS DISTINCT FROM NEW."kind"
    OR NEW."revision" <> OLD."revision" + 1
  ) THEN
    RAISE EXCEPTION 'AGENT_MISSION_IDENTITY_OR_REVISION_INVALID'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER agent_missions_mutation_guard_v1
BEFORE INSERT OR UPDATE ON public.agent_missions
FOR EACH ROW EXECUTE FUNCTION public.guard_agent_mission_mutation_v1();

CREATE FUNCTION public.guard_quote_draft_agent_mission_v1()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  expected_mission_id TEXT :=
    nullif(current_setting('app.current_agent_mission_id', true), '');
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD."agentMissionId" IS NOT NULL THEN
      RAISE EXCEPTION 'QUOTE_DRAFT_OWNED_DELETE_FORBIDDEN'
        USING ERRCODE = '42501';
    END IF;
    RETURN OLD;
  END IF;

  IF TG_OP = 'UPDATE' AND OLD."agentMissionId" IS NOT NULL AND (
    expected_mission_id IS NULL
    OR expected_mission_id <> OLD."agentMissionId"::TEXT
  ) THEN
    RAISE EXCEPTION 'QUOTE_DRAFT_AGENT_MISSION_CAPABILITY_REQUIRED'
      USING ERRCODE = '42501';
  END IF;

  IF NEW."agentMissionId" IS NOT NULL AND (
    expected_mission_id IS NULL
    OR expected_mission_id <> NEW."agentMissionId"::TEXT
  ) THEN
    RAISE EXCEPTION 'QUOTE_DRAFT_AGENT_MISSION_CAPABILITY_REQUIRED'
      USING ERRCODE = '42501';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER quote_draft_agent_mission_guard_v1
BEFORE INSERT OR UPDATE OR DELETE ON public.quote_draft_slots
FOR EACH ROW EXECUTE FUNCTION public.guard_quote_draft_agent_mission_v1();

CREATE FUNCTION public.reject_agent_mission_event_mutation_v1()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  RAISE EXCEPTION 'AGENT_MISSION_EVENT_IMMUTABLE'
    USING ERRCODE = '42501';
END;
$$;

CREATE TRIGGER agent_mission_events_immutable_v1
BEFORE UPDATE OR DELETE OR TRUNCATE ON public.agent_mission_events
FOR EACH STATEMENT EXECUTE FUNCTION public.reject_agent_mission_event_mutation_v1();

CREATE FUNCTION public.guard_agent_mission_event_append_v1()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  current_mission_revision INTEGER;
  current_mission_updated_at TIMESTAMPTZ;
BEGIN
  SELECT mission."revision", mission."updatedAt"
    INTO current_mission_revision, current_mission_updated_at
    FROM public.agent_missions AS mission
   WHERE mission."id" = NEW."missionId"
     AND mission."companyId" = NEW."companyId"
     AND mission."ownerUserId" = NEW."ownerUserId";

  IF NOT FOUND THEN
    RAISE EXCEPTION 'AGENT_MISSION_EVENT_MISSION_NOT_VISIBLE'
      USING ERRCODE = '23503';
  END IF;
  IF current_mission_revision <> NEW."missionRevisionAfter"
     OR current_mission_updated_at <> NEW."occurredAt" THEN
    RAISE EXCEPTION 'AGENT_MISSION_EVENT_REVISION_MISMATCH'
      USING ERRCODE = '23514';
  END IF;
  IF NEW."missionRevisionAfter" = 1 THEN
    IF EXISTS (
      SELECT 1
        FROM public.agent_mission_events AS previous
       WHERE previous."missionId" = NEW."missionId"
    ) THEN
      RAISE EXCEPTION 'AGENT_MISSION_EVENT_PREDECESSOR_INVALID'
        USING ERRCODE = '23514';
    END IF;
  ELSIF NOT EXISTS (
    SELECT 1
      FROM public.agent_mission_events AS previous
     WHERE previous."missionId" = NEW."missionId"
       AND previous."sequence" = NEW."missionRevisionBefore"
       AND previous."missionRevisionAfter" = NEW."missionRevisionBefore"
  ) THEN
    RAISE EXCEPTION 'AGENT_MISSION_EVENT_PREDECESSOR_MISSING'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER agent_mission_events_append_guard_v1
BEFORE INSERT ON public.agent_mission_events
FOR EACH ROW EXECUTE FUNCTION public.guard_agent_mission_event_append_v1();

CREATE FUNCTION public.require_agent_mission_event_v1()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM public.agent_mission_events AS event
     WHERE event."missionId" = NEW."id"
       AND event."companyId" = NEW."companyId"
       AND event."ownerUserId" = NEW."ownerUserId"
       AND event."sequence" = NEW."revision"
       AND event."missionRevisionAfter" = NEW."revision"
       AND event."occurredAt" = NEW."updatedAt"
  ) THEN
    RAISE EXCEPTION 'AGENT_MISSION_EVENT_REQUIRED'
      USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER agent_missions_event_required_v1
AFTER INSERT OR UPDATE ON public.agent_missions
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION public.require_agent_mission_event_v1();

ALTER TABLE public.agent_missions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.agent_missions FORCE ROW LEVEL SECURITY;
ALTER TABLE public.agent_mission_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.agent_mission_events FORCE ROW LEVEL SECURITY;

CREATE POLICY agent_missions_owner_select
  ON public.agent_missions
  FOR SELECT
  USING (
    "companyId" = current_setting('app.current_company_id', true)
    AND "ownerUserId" = nullif(current_setting('app.current_user_id', true), '')
  );
CREATE POLICY agent_missions_owner_insert
  ON public.agent_missions
  FOR INSERT
  WITH CHECK (
    "companyId" = current_setting('app.current_company_id', true)
    AND "ownerUserId" = nullif(current_setting('app.current_user_id', true), '')
    AND "id"::TEXT = nullif(current_setting('app.current_agent_mission_id', true), '')
  );
CREATE POLICY agent_missions_owner_update
  ON public.agent_missions
  FOR UPDATE
  USING (
    "companyId" = current_setting('app.current_company_id', true)
    AND "ownerUserId" = nullif(current_setting('app.current_user_id', true), '')
    AND "id"::TEXT = nullif(current_setting('app.current_agent_mission_id', true), '')
  )
  WITH CHECK (
    "companyId" = current_setting('app.current_company_id', true)
    AND "ownerUserId" = nullif(current_setting('app.current_user_id', true), '')
    AND "id"::TEXT = nullif(current_setting('app.current_agent_mission_id', true), '')
  );

CREATE POLICY agent_mission_events_owner_select
  ON public.agent_mission_events
  FOR SELECT
  USING (
    "companyId" = current_setting('app.current_company_id', true)
    AND "ownerUserId" = nullif(current_setting('app.current_user_id', true), '')
  );
CREATE POLICY agent_mission_events_owner_insert
  ON public.agent_mission_events
  FOR INSERT
  WITH CHECK (
    "companyId" = current_setting('app.current_company_id', true)
    AND "ownerUserId" = nullif(current_setting('app.current_user_id', true), '')
    AND "missionId"::TEXT = nullif(current_setting('app.current_agent_mission_id', true), '')
  );

REVOKE ALL ON TABLE public.agent_missions FROM PUBLIC;
REVOKE ALL ON TABLE public.agent_mission_events FROM PUBLIC;
REVOKE ALL ON FUNCTION public.guard_agent_mission_mutation_v1() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.guard_quote_draft_agent_mission_v1() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.reject_agent_mission_event_mutation_v1() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.guard_agent_mission_event_append_v1() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.require_agent_mission_event_v1() FROM PUBLIC;

DO $$
DECLARE
  exposed_role TEXT;
BEGIN
  FOREACH exposed_role IN ARRAY ARRAY['anon', 'authenticated', 'service_role']::TEXT[] LOOP
    IF pg_catalog.to_regrole(exposed_role) IS NOT NULL THEN
      EXECUTE pg_catalog.format(
        'REVOKE ALL PRIVILEGES ON TABLE public.agent_missions FROM %I',
        exposed_role
      );
      EXECUTE pg_catalog.format(
        'REVOKE ALL PRIVILEGES ON TABLE public.agent_mission_events FROM %I',
        exposed_role
      );
      EXECUTE pg_catalog.format(
        'REVOKE ALL PRIVILEGES ON FUNCTION public.guard_agent_mission_mutation_v1() FROM %I',
        exposed_role
      );
      EXECUTE pg_catalog.format(
        'REVOKE ALL PRIVILEGES ON FUNCTION public.guard_quote_draft_agent_mission_v1() FROM %I',
        exposed_role
      );
      EXECUTE pg_catalog.format(
        'REVOKE ALL PRIVILEGES ON FUNCTION public.reject_agent_mission_event_mutation_v1() FROM %I',
        exposed_role
      );
      EXECUTE pg_catalog.format(
        'REVOKE ALL PRIVILEGES ON FUNCTION public.guard_agent_mission_event_append_v1() FROM %I',
        exposed_role
      );
      EXECUTE pg_catalog.format(
        'REVOKE ALL PRIVILEGES ON FUNCTION public.require_agent_mission_event_v1() FROM %I',
        exposed_role
      );
    END IF;
  END LOOP;
END;
$$;

COMMENT ON TABLE public.agent_missions IS
  'Mission métier Bob provider-neutral; aucun transcript, nom client, montant ou texte LLM.';
COMMENT ON TABLE public.agent_mission_events IS
  'Journal append-only borné des transitions AgentMission; data est une union fermée. retentionExpiresAt ne constitue jamais à elle seule une autorité de suppression: le journal reste bloqué tant que sa mission existe ou que sa rétention demeure due.';
COMMENT ON COLUMN public.quote_draft_slots."agentMissionId" IS
  'NULL pour writer N-1; UUID exact de la mission qui possède temporairement le slot.';

COMMIT;
