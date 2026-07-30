-- Bob AgentMission M2-A-2 — détails et confirmation de ligne, expand writer N-1.
-- Le flag bob.agent_missions.quote.m2a doit rester exactement OFF.

BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '120s';

DO $bob_m2a2_expand_release_flags_owner$
DECLARE
  owner_oid OID;
  owner_name TEXT;
BEGIN
  SELECT relation.relowner, pg_catalog.pg_get_userbyid(relation.relowner)
    INTO STRICT owner_oid, owner_name
    FROM pg_catalog.pg_class AS relation
    JOIN pg_catalog.pg_namespace AS namespace
      ON namespace.oid = relation.relnamespace
   WHERE namespace.nspname = 'public'
     AND relation.relname = 'release_flags'
     AND relation.relkind IN ('r', 'p');

  IF current_user::pg_catalog.regrole <> owner_oid THEN
    IF owner_name IS NULL
       OR NOT pg_catalog.pg_has_role(session_user, owner_oid, 'SET') THEN
      RAISE EXCEPTION USING
        ERRCODE = '42501',
        MESSAGE = 'AGENT_MISSION_M2A2_EXPAND_RELEASE_FLAGS_OWNER_UNAVAILABLE';
    END IF;
    EXECUTE pg_catalog.format('SET LOCAL ROLE %I', owner_name);
  END IF;

  IF current_user::pg_catalog.regrole <> owner_oid THEN
    RAISE EXCEPTION USING
      ERRCODE = '42501',
      MESSAGE = 'AGENT_MISSION_M2A2_EXPAND_RELEASE_FLAGS_OWNER_NOT_ASSUMED';
  END IF;
END;
$bob_m2a2_expand_release_flags_owner$;

ALTER TABLE public.release_flags NO FORCE ROW LEVEL SECURITY;

DO $bob_m2a2_expand_release_flag_exact$
BEGIN
  IF (
    SELECT pg_catalog.count(*)
      FROM public.release_flags AS flag
     WHERE flag.key = 'bob.agent_missions.quote.m2a'
  ) <> 3
  OR EXISTS (
    SELECT 1
      FROM public.release_flags AS flag
     WHERE flag.key = 'bob.agent_missions.quote.m2a'
       AND (
         flag.environment::TEXT NOT IN ('development', 'staging', 'production')
         OR flag.enabled
         OR flag."killSwitch"
         OR flag.version <> 1
       )
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'AGENT_MISSION_M2A2_EXPAND_FLAG_NOT_EXACTLY_OFF';
  END IF;
END;
$bob_m2a2_expand_release_flag_exact$;

ALTER TABLE public.release_flags ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.release_flags FORCE ROW LEVEL SECURITY;
RESET ROLE;

DO $bob_m2a2_missions_owner$
DECLARE
  owner_oid OID;
  owner_name TEXT;
BEGIN
  SELECT relation.relowner, pg_catalog.pg_get_userbyid(relation.relowner)
    INTO STRICT owner_oid, owner_name
    FROM pg_catalog.pg_class AS relation
    JOIN pg_catalog.pg_namespace AS namespace
      ON namespace.oid = relation.relnamespace
   WHERE namespace.nspname = 'public'
     AND relation.relname = 'agent_missions'
     AND relation.relkind IN ('r', 'p');

  IF current_user::pg_catalog.regrole <> owner_oid THEN
    IF owner_name IS NULL
       OR NOT pg_catalog.pg_has_role(session_user, owner_oid, 'SET') THEN
      RAISE EXCEPTION USING
        ERRCODE = '42501',
        MESSAGE = 'AGENT_MISSION_M2A2_MISSIONS_OWNER_UNAVAILABLE';
    END IF;
    EXECUTE pg_catalog.format('SET LOCAL ROLE %I', owner_name);
  END IF;

  IF current_user::pg_catalog.regrole <> owner_oid THEN
    RAISE EXCEPTION USING
      ERRCODE = '42501',
      MESSAGE = 'AGENT_MISSION_M2A2_MISSIONS_OWNER_NOT_ASSUMED';
  END IF;
END;
$bob_m2a2_missions_owner$;

ALTER TABLE public.agent_missions
  ADD CONSTRAINT agent_missions_phase_m2a2_check CHECK (
  "phase" IN (
    -- BEGIN GENERATED QUOTE_CREATION_MISSION_PHASES
    'awaiting_draft_decision',
    'awaiting_draft_discard_confirmation',
    'awaiting_quote_screen',
    'awaiting_customer',
    'awaiting_customer_choice',
    'awaiting_lines',
    'awaiting_catalogue_choice',
    'awaiting_line_details',
    'awaiting_line_confirmation'
    -- END GENERATED QUOTE_CREATION_MISSION_PHASES
  )
  AND (
    "protocolVersion" = 2
    OR "phase" NOT IN (
      'awaiting_catalogue_choice',
      'awaiting_line_details',
      'awaiting_line_confirmation'
    )
  )
) NOT VALID,
  ADD CONSTRAINT agent_missions_payload_closed_shape_m2a2_check CHECK ((
    (
      (
        NOT ("payload" ? 'stagedCustomerResolution')
        AND "payload" - ARRAY[
          -- BEGIN GENERATED M1C_QUOTE_MISSION_LEGACY_PAYLOAD_KEYS
          'schema',
          'version',
          'draft',
          'decision'
          -- END GENERATED M1C_QUOTE_MISSION_LEGACY_PAYLOAD_KEYS
        ] = '{}'::JSONB
      )
      OR (
        "payload" ? 'stagedCustomerResolution'
        AND "payload" - ARRAY[
          -- BEGIN GENERATED M1C_QUOTE_MISSION_PAYLOAD_KEYS
          'schema',
          'version',
          'draft',
          'decision',
          'stagedCustomerResolution'
          -- END GENERATED M1C_QUOTE_MISSION_PAYLOAD_KEYS
        ] = '{}'::JSONB
        AND (
          "payload" -> 'stagedCustomerResolution' = 'null'::JSONB
          OR (
            jsonb_typeof("payload" -> 'stagedCustomerResolution') = 'object'
            AND "payload" #>> '{stagedCustomerResolution,kind}' IN (
              -- BEGIN GENERATED QUOTE_MISSION_STAGED_CUSTOMER_RESOLUTION_KINDS
              'none',
              'too_many',
              'exact',
              'choices'
              -- END GENERATED QUOTE_MISSION_STAGED_CUSTOMER_RESOLUTION_KINDS
            )
            AND (
              (
                "payload" #>> '{stagedCustomerResolution,kind}' IN ('none', 'too_many')
                AND ("payload" -> 'stagedCustomerResolution') ?& ARRAY[
                  -- BEGIN GENERATED QUOTE_MISSION_STAGED_CUSTOMER_RESOLUTION_KIND_ONLY_KEYS
                  'kind'
                  -- END GENERATED QUOTE_MISSION_STAGED_CUSTOMER_RESOLUTION_KIND_ONLY_KEYS
                ]
                AND ("payload" -> 'stagedCustomerResolution') - ARRAY[
                  -- BEGIN GENERATED QUOTE_MISSION_STAGED_CUSTOMER_RESOLUTION_KIND_ONLY_KEYS
                  'kind'
                  -- END GENERATED QUOTE_MISSION_STAGED_CUSTOMER_RESOLUTION_KIND_ONLY_KEYS
                ] = '{}'::JSONB
              )
              OR (
                "payload" #>> '{stagedCustomerResolution,kind}' = 'exact'
                AND ("payload" -> 'stagedCustomerResolution') ?& ARRAY[
                  -- BEGIN GENERATED QUOTE_MISSION_STAGED_CUSTOMER_RESOLUTION_EXACT_KEYS
                  'kind',
                  'customerId'
                  -- END GENERATED QUOTE_MISSION_STAGED_CUSTOMER_RESOLUTION_EXACT_KEYS
                ]
                AND ("payload" -> 'stagedCustomerResolution') - ARRAY[
                  -- BEGIN GENERATED QUOTE_MISSION_STAGED_CUSTOMER_RESOLUTION_EXACT_KEYS
                  'kind',
                  'customerId'
                  -- END GENERATED QUOTE_MISSION_STAGED_CUSTOMER_RESOLUTION_EXACT_KEYS
                ] = '{}'::JSONB
                AND jsonb_typeof("payload" #> '{stagedCustomerResolution,customerId}') = 'string'
                AND length("payload" #>> '{stagedCustomerResolution,customerId}')
                  BETWEEN 1 AND 200
                AND "payload" #>> '{stagedCustomerResolution,customerId}'
                  = btrim("payload" #>> '{stagedCustomerResolution,customerId}')
                AND "payload" #>> '{stagedCustomerResolution,customerId}'
                  !~ '[[:cntrl:]]'
              )
              OR (
                "payload" #>> '{stagedCustomerResolution,kind}' = 'choices'
                AND ("payload" -> 'stagedCustomerResolution') ?& ARRAY[
                  -- BEGIN GENERATED QUOTE_MISSION_STAGED_CUSTOMER_RESOLUTION_CHOICES_KEYS
                  'kind',
                  'decisionId',
                  'candidates'
                  -- END GENERATED QUOTE_MISSION_STAGED_CUSTOMER_RESOLUTION_CHOICES_KEYS
                ]
                AND ("payload" -> 'stagedCustomerResolution') - ARRAY[
                  -- BEGIN GENERATED QUOTE_MISSION_STAGED_CUSTOMER_RESOLUTION_CHOICES_KEYS
                  'kind',
                  'decisionId',
                  'candidates'
                  -- END GENERATED QUOTE_MISSION_STAGED_CUSTOMER_RESOLUTION_CHOICES_KEYS
                ] = '{}'::JSONB
                AND "payload" #>> '{stagedCustomerResolution,decisionId}'
                  ~ '^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$'
                AND jsonb_typeof("payload" #> '{stagedCustomerResolution,candidates}') = 'array'
                AND jsonb_array_length(
                  "payload" #> '{stagedCustomerResolution,candidates}'
                ) BETWEEN 1 AND 5
                AND
                -- BEGIN GENERATED M1C_QUOTE_MISSION_STAGED_CUSTOMER_CANDIDATE_CHECKS
                (
                  jsonb_array_length(
                    "payload" #> '{stagedCustomerResolution,candidates}'
                  ) <= 0
                  OR (
                    jsonb_typeof("payload" #> '{stagedCustomerResolution,candidates,0}') = 'object'
                    AND ("payload" #> '{stagedCustomerResolution,candidates,0}') ?& ARRAY[
                      'choiceId',
                      'customerId'
                    ]
                    AND ("payload" #> '{stagedCustomerResolution,candidates,0}') - ARRAY[
                      'choiceId',
                      'customerId'
                    ] = '{}'::JSONB
                    AND ("payload" #> '{stagedCustomerResolution,candidates,0}') ->> 'choiceId'
                      ~ '^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$'
                    AND jsonb_typeof(("payload" #> '{stagedCustomerResolution,candidates,0}') -> 'customerId') = 'string'
                    AND length(("payload" #> '{stagedCustomerResolution,candidates,0}') ->> 'customerId') BETWEEN 1 AND 200
                    AND ("payload" #> '{stagedCustomerResolution,candidates,0}') ->> 'customerId'
                      = btrim(("payload" #> '{stagedCustomerResolution,candidates,0}') ->> 'customerId')
                    AND ("payload" #> '{stagedCustomerResolution,candidates,0}') ->> 'customerId' !~ '[[:cntrl:]]'
                  )
                )
                AND (
                  jsonb_array_length(
                    "payload" #> '{stagedCustomerResolution,candidates}'
                  ) <= 1
                  OR (
                    jsonb_typeof("payload" #> '{stagedCustomerResolution,candidates,1}') = 'object'
                    AND ("payload" #> '{stagedCustomerResolution,candidates,1}') ?& ARRAY[
                      'choiceId',
                      'customerId'
                    ]
                    AND ("payload" #> '{stagedCustomerResolution,candidates,1}') - ARRAY[
                      'choiceId',
                      'customerId'
                    ] = '{}'::JSONB
                    AND ("payload" #> '{stagedCustomerResolution,candidates,1}') ->> 'choiceId'
                      ~ '^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$'
                    AND jsonb_typeof(("payload" #> '{stagedCustomerResolution,candidates,1}') -> 'customerId') = 'string'
                    AND length(("payload" #> '{stagedCustomerResolution,candidates,1}') ->> 'customerId') BETWEEN 1 AND 200
                    AND ("payload" #> '{stagedCustomerResolution,candidates,1}') ->> 'customerId'
                      = btrim(("payload" #> '{stagedCustomerResolution,candidates,1}') ->> 'customerId')
                    AND ("payload" #> '{stagedCustomerResolution,candidates,1}') ->> 'customerId' !~ '[[:cntrl:]]'
                  )
                )
                AND (
                  jsonb_array_length(
                    "payload" #> '{stagedCustomerResolution,candidates}'
                  ) <= 2
                  OR (
                    jsonb_typeof("payload" #> '{stagedCustomerResolution,candidates,2}') = 'object'
                    AND ("payload" #> '{stagedCustomerResolution,candidates,2}') ?& ARRAY[
                      'choiceId',
                      'customerId'
                    ]
                    AND ("payload" #> '{stagedCustomerResolution,candidates,2}') - ARRAY[
                      'choiceId',
                      'customerId'
                    ] = '{}'::JSONB
                    AND ("payload" #> '{stagedCustomerResolution,candidates,2}') ->> 'choiceId'
                      ~ '^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$'
                    AND jsonb_typeof(("payload" #> '{stagedCustomerResolution,candidates,2}') -> 'customerId') = 'string'
                    AND length(("payload" #> '{stagedCustomerResolution,candidates,2}') ->> 'customerId') BETWEEN 1 AND 200
                    AND ("payload" #> '{stagedCustomerResolution,candidates,2}') ->> 'customerId'
                      = btrim(("payload" #> '{stagedCustomerResolution,candidates,2}') ->> 'customerId')
                    AND ("payload" #> '{stagedCustomerResolution,candidates,2}') ->> 'customerId' !~ '[[:cntrl:]]'
                  )
                )
                AND (
                  jsonb_array_length(
                    "payload" #> '{stagedCustomerResolution,candidates}'
                  ) <= 3
                  OR (
                    jsonb_typeof("payload" #> '{stagedCustomerResolution,candidates,3}') = 'object'
                    AND ("payload" #> '{stagedCustomerResolution,candidates,3}') ?& ARRAY[
                      'choiceId',
                      'customerId'
                    ]
                    AND ("payload" #> '{stagedCustomerResolution,candidates,3}') - ARRAY[
                      'choiceId',
                      'customerId'
                    ] = '{}'::JSONB
                    AND ("payload" #> '{stagedCustomerResolution,candidates,3}') ->> 'choiceId'
                      ~ '^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$'
                    AND jsonb_typeof(("payload" #> '{stagedCustomerResolution,candidates,3}') -> 'customerId') = 'string'
                    AND length(("payload" #> '{stagedCustomerResolution,candidates,3}') ->> 'customerId') BETWEEN 1 AND 200
                    AND ("payload" #> '{stagedCustomerResolution,candidates,3}') ->> 'customerId'
                      = btrim(("payload" #> '{stagedCustomerResolution,candidates,3}') ->> 'customerId')
                    AND ("payload" #> '{stagedCustomerResolution,candidates,3}') ->> 'customerId' !~ '[[:cntrl:]]'
                  )
                )
                AND (
                  jsonb_array_length(
                    "payload" #> '{stagedCustomerResolution,candidates}'
                  ) <= 4
                  OR (
                    jsonb_typeof("payload" #> '{stagedCustomerResolution,candidates,4}') = 'object'
                    AND ("payload" #> '{stagedCustomerResolution,candidates,4}') ?& ARRAY[
                      'choiceId',
                      'customerId'
                    ]
                    AND ("payload" #> '{stagedCustomerResolution,candidates,4}') - ARRAY[
                      'choiceId',
                      'customerId'
                    ] = '{}'::JSONB
                    AND ("payload" #> '{stagedCustomerResolution,candidates,4}') ->> 'choiceId'
                      ~ '^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$'
                    AND jsonb_typeof(("payload" #> '{stagedCustomerResolution,candidates,4}') -> 'customerId') = 'string'
                    AND length(("payload" #> '{stagedCustomerResolution,candidates,4}') ->> 'customerId') BETWEEN 1 AND 200
                    AND ("payload" #> '{stagedCustomerResolution,candidates,4}') ->> 'customerId'
                      = btrim(("payload" #> '{stagedCustomerResolution,candidates,4}') ->> 'customerId')
                    AND ("payload" #> '{stagedCustomerResolution,candidates,4}') ->> 'customerId' !~ '[[:cntrl:]]'
                  )
                )
                AND (
                  jsonb_array_length(
                    "payload" #> '{stagedCustomerResolution,candidates}'
                  ) <= 1
                  OR (
                    "payload" #>> '{stagedCustomerResolution,candidates,0,choiceId}'
                      <> "payload" #>> '{stagedCustomerResolution,candidates,1,choiceId}'
                    AND
                    "payload" #>> '{stagedCustomerResolution,candidates,0,customerId}'
                      <> "payload" #>> '{stagedCustomerResolution,candidates,1,customerId}'
                  )
                )
                AND (
                  jsonb_array_length(
                    "payload" #> '{stagedCustomerResolution,candidates}'
                  ) <= 2
                  OR (
                    "payload" #>> '{stagedCustomerResolution,candidates,0,choiceId}'
                      <> "payload" #>> '{stagedCustomerResolution,candidates,2,choiceId}'
                    AND
                    "payload" #>> '{stagedCustomerResolution,candidates,0,customerId}'
                      <> "payload" #>> '{stagedCustomerResolution,candidates,2,customerId}'
                  )
                )
                AND (
                  jsonb_array_length(
                    "payload" #> '{stagedCustomerResolution,candidates}'
                  ) <= 3
                  OR (
                    "payload" #>> '{stagedCustomerResolution,candidates,0,choiceId}'
                      <> "payload" #>> '{stagedCustomerResolution,candidates,3,choiceId}'
                    AND
                    "payload" #>> '{stagedCustomerResolution,candidates,0,customerId}'
                      <> "payload" #>> '{stagedCustomerResolution,candidates,3,customerId}'
                  )
                )
                AND (
                  jsonb_array_length(
                    "payload" #> '{stagedCustomerResolution,candidates}'
                  ) <= 4
                  OR (
                    "payload" #>> '{stagedCustomerResolution,candidates,0,choiceId}'
                      <> "payload" #>> '{stagedCustomerResolution,candidates,4,choiceId}'
                    AND
                    "payload" #>> '{stagedCustomerResolution,candidates,0,customerId}'
                      <> "payload" #>> '{stagedCustomerResolution,candidates,4,customerId}'
                  )
                )
                AND (
                  jsonb_array_length(
                    "payload" #> '{stagedCustomerResolution,candidates}'
                  ) <= 2
                  OR (
                    "payload" #>> '{stagedCustomerResolution,candidates,1,choiceId}'
                      <> "payload" #>> '{stagedCustomerResolution,candidates,2,choiceId}'
                    AND
                    "payload" #>> '{stagedCustomerResolution,candidates,1,customerId}'
                      <> "payload" #>> '{stagedCustomerResolution,candidates,2,customerId}'
                  )
                )
                AND (
                  jsonb_array_length(
                    "payload" #> '{stagedCustomerResolution,candidates}'
                  ) <= 3
                  OR (
                    "payload" #>> '{stagedCustomerResolution,candidates,1,choiceId}'
                      <> "payload" #>> '{stagedCustomerResolution,candidates,3,choiceId}'
                    AND
                    "payload" #>> '{stagedCustomerResolution,candidates,1,customerId}'
                      <> "payload" #>> '{stagedCustomerResolution,candidates,3,customerId}'
                  )
                )
                AND (
                  jsonb_array_length(
                    "payload" #> '{stagedCustomerResolution,candidates}'
                  ) <= 4
                  OR (
                    "payload" #>> '{stagedCustomerResolution,candidates,1,choiceId}'
                      <> "payload" #>> '{stagedCustomerResolution,candidates,4,choiceId}'
                    AND
                    "payload" #>> '{stagedCustomerResolution,candidates,1,customerId}'
                      <> "payload" #>> '{stagedCustomerResolution,candidates,4,customerId}'
                  )
                )
                AND (
                  jsonb_array_length(
                    "payload" #> '{stagedCustomerResolution,candidates}'
                  ) <= 3
                  OR (
                    "payload" #>> '{stagedCustomerResolution,candidates,2,choiceId}'
                      <> "payload" #>> '{stagedCustomerResolution,candidates,3,choiceId}'
                    AND
                    "payload" #>> '{stagedCustomerResolution,candidates,2,customerId}'
                      <> "payload" #>> '{stagedCustomerResolution,candidates,3,customerId}'
                  )
                )
                AND (
                  jsonb_array_length(
                    "payload" #> '{stagedCustomerResolution,candidates}'
                  ) <= 4
                  OR (
                    "payload" #>> '{stagedCustomerResolution,candidates,2,choiceId}'
                      <> "payload" #>> '{stagedCustomerResolution,candidates,4,choiceId}'
                    AND
                    "payload" #>> '{stagedCustomerResolution,candidates,2,customerId}'
                      <> "payload" #>> '{stagedCustomerResolution,candidates,4,customerId}'
                  )
                )
                AND (
                  jsonb_array_length(
                    "payload" #> '{stagedCustomerResolution,candidates}'
                  ) <= 4
                  OR (
                    "payload" #>> '{stagedCustomerResolution,candidates,3,choiceId}'
                      <> "payload" #>> '{stagedCustomerResolution,candidates,4,choiceId}'
                    AND
                    "payload" #>> '{stagedCustomerResolution,candidates,3,customerId}'
                      <> "payload" #>> '{stagedCustomerResolution,candidates,4,customerId}'
                  )
                )
                -- END GENERATED M1C_QUOTE_MISSION_STAGED_CUSTOMER_CANDIDATE_CHECKS
              )
            )
          )
        )
      )
    )
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
          'customer',
          'catalogue',
          'line_confirmation'
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
          OR (
            "protocolVersion" = 2
            AND "payload" -> 'decision' ->> 'kind' = 'catalogue'
            AND "payload" -> 'decision' ?& ARRAY[
              -- BEGIN GENERATED QUOTE_MISSION_CATALOGUE_DECISION_KEYS
              'kind',
              'decisionId',
              'choiceSetRevision',
              'pendingLineId',
              'expectedDraft',
              'expectedWorkRevision',
              'candidates',
              'freeLineChoiceId',
              'choiceSetHash'
              -- END GENERATED QUOTE_MISSION_CATALOGUE_DECISION_KEYS
            ]
            AND ("payload" -> 'decision') - ARRAY[
              -- BEGIN GENERATED QUOTE_MISSION_CATALOGUE_DECISION_KEYS
              'kind',
              'decisionId',
              'choiceSetRevision',
              'pendingLineId',
              'expectedDraft',
              'expectedWorkRevision',
              'candidates',
              'freeLineChoiceId',
              'choiceSetHash'
              -- END GENERATED QUOTE_MISSION_CATALOGUE_DECISION_KEYS
            ] = '{}'::JSONB
            AND "payload" #>> '{decision,pendingLineId}'
              ~ '^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$'
            AND jsonb_typeof("payload" #> '{decision,expectedDraft}') = 'object'
            AND ("payload" #> '{decision,expectedDraft}') ?& ARRAY[
              -- BEGIN GENERATED QUOTE_MISSION_DRAFT_REFERENCE_KEYS
              'sessionId',
              'slotRevision',
              'contentRevision'
              -- END GENERATED QUOTE_MISSION_DRAFT_REFERENCE_KEYS
            ]
            AND ("payload" #> '{decision,expectedDraft}') - ARRAY[
              -- BEGIN GENERATED QUOTE_MISSION_DRAFT_REFERENCE_KEYS
              'sessionId',
              'slotRevision',
              'contentRevision'
              -- END GENERATED QUOTE_MISSION_DRAFT_REFERENCE_KEYS
            ] = '{}'::JSONB
            AND jsonb_typeof("payload" #> '{decision,expectedDraft,sessionId}') = 'string'
            AND char_length("payload" #>> '{decision,expectedDraft,sessionId}')
              BETWEEN 1 AND 200
            AND "payload" #>> '{decision,expectedDraft,sessionId}'
              = btrim("payload" #>> '{decision,expectedDraft,sessionId}')
            AND "payload" #>> '{decision,expectedDraft,sessionId}' !~ '[[:cntrl:]]'
            AND jsonb_typeof("payload" #> '{decision,expectedDraft,slotRevision}') = 'number'
            AND ("payload" #>> '{decision,expectedDraft,slotRevision}')::NUMERIC
              BETWEEN 1 AND 2147483647
            AND ("payload" #>> '{decision,expectedDraft,slotRevision}')::NUMERIC
              = trunc(("payload" #>> '{decision,expectedDraft,slotRevision}')::NUMERIC)
            AND jsonb_typeof("payload" #> '{decision,expectedDraft,contentRevision}') = 'number'
            AND ("payload" #>> '{decision,expectedDraft,contentRevision}')::NUMERIC
              BETWEEN 0 AND 2147483647
            AND ("payload" #>> '{decision,expectedDraft,contentRevision}')::NUMERIC
              = trunc(("payload" #>> '{decision,expectedDraft,contentRevision}')::NUMERIC)
            AND jsonb_typeof("payload" #> '{decision,expectedWorkRevision}') = 'number'
            AND ("payload" #>> '{decision,expectedWorkRevision}')::NUMERIC
              BETWEEN 1 AND 2147483647
            AND ("payload" #>> '{decision,expectedWorkRevision}')::NUMERIC
              = trunc(("payload" #>> '{decision,expectedWorkRevision}')::NUMERIC)
            AND jsonb_typeof("payload" #> '{decision,candidates}') = 'array'
            AND jsonb_array_length("payload" #> '{decision,candidates}')
              BETWEEN 1 AND 5
            AND "payload" #>> '{decision,freeLineChoiceId}'
              ~ '^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$'
            AND
            -- BEGIN GENERATED M2A1_QUOTE_MISSION_CATALOGUE_CANDIDATE_CHECKS
            (
              jsonb_array_length("payload" #> '{decision,candidates}') <= 0
              OR (
                jsonb_typeof("payload" #> '{decision,candidates,0}') = 'object'
                AND ("payload" #> '{decision,candidates,0}') ?& ARRAY[
                  'choiceId',
                  'catalogueItemId',
                  'expectedCatalogueRevision'
                ]
                AND ("payload" #> '{decision,candidates,0}') - ARRAY[
                  'choiceId',
                  'catalogueItemId',
                  'expectedCatalogueRevision'
                ] = '{}'::JSONB
                AND ("payload" #> '{decision,candidates,0}') ->> 'choiceId'
                  ~ '^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$'
                AND jsonb_typeof(("payload" #> '{decision,candidates,0}') -> 'catalogueItemId') = 'string'
                AND char_length(("payload" #> '{decision,candidates,0}') ->> 'catalogueItemId') BETWEEN 1 AND 128
                AND ("payload" #> '{decision,candidates,0}') ->> 'catalogueItemId' ~ '^[A-Za-z0-9-]+$'
                AND jsonb_typeof(("payload" #> '{decision,candidates,0}') -> 'expectedCatalogueRevision') = 'number'
                AND (("payload" #> '{decision,candidates,0}') ->> 'expectedCatalogueRevision')::NUMERIC
                  BETWEEN 1 AND 2147483647
                AND (("payload" #> '{decision,candidates,0}') ->> 'expectedCatalogueRevision')::NUMERIC
                  = trunc((("payload" #> '{decision,candidates,0}') ->> 'expectedCatalogueRevision')::NUMERIC)
              )
            )
            AND (
              jsonb_array_length("payload" #> '{decision,candidates}') <= 1
              OR (
                jsonb_typeof("payload" #> '{decision,candidates,1}') = 'object'
                AND ("payload" #> '{decision,candidates,1}') ?& ARRAY[
                  'choiceId',
                  'catalogueItemId',
                  'expectedCatalogueRevision'
                ]
                AND ("payload" #> '{decision,candidates,1}') - ARRAY[
                  'choiceId',
                  'catalogueItemId',
                  'expectedCatalogueRevision'
                ] = '{}'::JSONB
                AND ("payload" #> '{decision,candidates,1}') ->> 'choiceId'
                  ~ '^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$'
                AND jsonb_typeof(("payload" #> '{decision,candidates,1}') -> 'catalogueItemId') = 'string'
                AND char_length(("payload" #> '{decision,candidates,1}') ->> 'catalogueItemId') BETWEEN 1 AND 128
                AND ("payload" #> '{decision,candidates,1}') ->> 'catalogueItemId' ~ '^[A-Za-z0-9-]+$'
                AND jsonb_typeof(("payload" #> '{decision,candidates,1}') -> 'expectedCatalogueRevision') = 'number'
                AND (("payload" #> '{decision,candidates,1}') ->> 'expectedCatalogueRevision')::NUMERIC
                  BETWEEN 1 AND 2147483647
                AND (("payload" #> '{decision,candidates,1}') ->> 'expectedCatalogueRevision')::NUMERIC
                  = trunc((("payload" #> '{decision,candidates,1}') ->> 'expectedCatalogueRevision')::NUMERIC)
              )
            )
            AND (
              jsonb_array_length("payload" #> '{decision,candidates}') <= 2
              OR (
                jsonb_typeof("payload" #> '{decision,candidates,2}') = 'object'
                AND ("payload" #> '{decision,candidates,2}') ?& ARRAY[
                  'choiceId',
                  'catalogueItemId',
                  'expectedCatalogueRevision'
                ]
                AND ("payload" #> '{decision,candidates,2}') - ARRAY[
                  'choiceId',
                  'catalogueItemId',
                  'expectedCatalogueRevision'
                ] = '{}'::JSONB
                AND ("payload" #> '{decision,candidates,2}') ->> 'choiceId'
                  ~ '^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$'
                AND jsonb_typeof(("payload" #> '{decision,candidates,2}') -> 'catalogueItemId') = 'string'
                AND char_length(("payload" #> '{decision,candidates,2}') ->> 'catalogueItemId') BETWEEN 1 AND 128
                AND ("payload" #> '{decision,candidates,2}') ->> 'catalogueItemId' ~ '^[A-Za-z0-9-]+$'
                AND jsonb_typeof(("payload" #> '{decision,candidates,2}') -> 'expectedCatalogueRevision') = 'number'
                AND (("payload" #> '{decision,candidates,2}') ->> 'expectedCatalogueRevision')::NUMERIC
                  BETWEEN 1 AND 2147483647
                AND (("payload" #> '{decision,candidates,2}') ->> 'expectedCatalogueRevision')::NUMERIC
                  = trunc((("payload" #> '{decision,candidates,2}') ->> 'expectedCatalogueRevision')::NUMERIC)
              )
            )
            AND (
              jsonb_array_length("payload" #> '{decision,candidates}') <= 3
              OR (
                jsonb_typeof("payload" #> '{decision,candidates,3}') = 'object'
                AND ("payload" #> '{decision,candidates,3}') ?& ARRAY[
                  'choiceId',
                  'catalogueItemId',
                  'expectedCatalogueRevision'
                ]
                AND ("payload" #> '{decision,candidates,3}') - ARRAY[
                  'choiceId',
                  'catalogueItemId',
                  'expectedCatalogueRevision'
                ] = '{}'::JSONB
                AND ("payload" #> '{decision,candidates,3}') ->> 'choiceId'
                  ~ '^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$'
                AND jsonb_typeof(("payload" #> '{decision,candidates,3}') -> 'catalogueItemId') = 'string'
                AND char_length(("payload" #> '{decision,candidates,3}') ->> 'catalogueItemId') BETWEEN 1 AND 128
                AND ("payload" #> '{decision,candidates,3}') ->> 'catalogueItemId' ~ '^[A-Za-z0-9-]+$'
                AND jsonb_typeof(("payload" #> '{decision,candidates,3}') -> 'expectedCatalogueRevision') = 'number'
                AND (("payload" #> '{decision,candidates,3}') ->> 'expectedCatalogueRevision')::NUMERIC
                  BETWEEN 1 AND 2147483647
                AND (("payload" #> '{decision,candidates,3}') ->> 'expectedCatalogueRevision')::NUMERIC
                  = trunc((("payload" #> '{decision,candidates,3}') ->> 'expectedCatalogueRevision')::NUMERIC)
              )
            )
            AND (
              jsonb_array_length("payload" #> '{decision,candidates}') <= 4
              OR (
                jsonb_typeof("payload" #> '{decision,candidates,4}') = 'object'
                AND ("payload" #> '{decision,candidates,4}') ?& ARRAY[
                  'choiceId',
                  'catalogueItemId',
                  'expectedCatalogueRevision'
                ]
                AND ("payload" #> '{decision,candidates,4}') - ARRAY[
                  'choiceId',
                  'catalogueItemId',
                  'expectedCatalogueRevision'
                ] = '{}'::JSONB
                AND ("payload" #> '{decision,candidates,4}') ->> 'choiceId'
                  ~ '^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$'
                AND jsonb_typeof(("payload" #> '{decision,candidates,4}') -> 'catalogueItemId') = 'string'
                AND char_length(("payload" #> '{decision,candidates,4}') ->> 'catalogueItemId') BETWEEN 1 AND 128
                AND ("payload" #> '{decision,candidates,4}') ->> 'catalogueItemId' ~ '^[A-Za-z0-9-]+$'
                AND jsonb_typeof(("payload" #> '{decision,candidates,4}') -> 'expectedCatalogueRevision') = 'number'
                AND (("payload" #> '{decision,candidates,4}') ->> 'expectedCatalogueRevision')::NUMERIC
                  BETWEEN 1 AND 2147483647
                AND (("payload" #> '{decision,candidates,4}') ->> 'expectedCatalogueRevision')::NUMERIC
                  = trunc((("payload" #> '{decision,candidates,4}') ->> 'expectedCatalogueRevision')::NUMERIC)
              )
            )
            AND (
              jsonb_array_length("payload" #> '{decision,candidates}') <= 1
              OR (
                "payload" #>> '{decision,candidates,0,choiceId}'
                  <> "payload" #>> '{decision,candidates,1,choiceId}'
                AND
                "payload" #>> '{decision,candidates,0,catalogueItemId}'
                  <> "payload" #>> '{decision,candidates,1,catalogueItemId}'
              )
            )
            AND (
              jsonb_array_length("payload" #> '{decision,candidates}') <= 2
              OR (
                "payload" #>> '{decision,candidates,0,choiceId}'
                  <> "payload" #>> '{decision,candidates,2,choiceId}'
                AND
                "payload" #>> '{decision,candidates,0,catalogueItemId}'
                  <> "payload" #>> '{decision,candidates,2,catalogueItemId}'
              )
            )
            AND (
              jsonb_array_length("payload" #> '{decision,candidates}') <= 3
              OR (
                "payload" #>> '{decision,candidates,0,choiceId}'
                  <> "payload" #>> '{decision,candidates,3,choiceId}'
                AND
                "payload" #>> '{decision,candidates,0,catalogueItemId}'
                  <> "payload" #>> '{decision,candidates,3,catalogueItemId}'
              )
            )
            AND (
              jsonb_array_length("payload" #> '{decision,candidates}') <= 4
              OR (
                "payload" #>> '{decision,candidates,0,choiceId}'
                  <> "payload" #>> '{decision,candidates,4,choiceId}'
                AND
                "payload" #>> '{decision,candidates,0,catalogueItemId}'
                  <> "payload" #>> '{decision,candidates,4,catalogueItemId}'
              )
            )
            AND (
              jsonb_array_length("payload" #> '{decision,candidates}') <= 2
              OR (
                "payload" #>> '{decision,candidates,1,choiceId}'
                  <> "payload" #>> '{decision,candidates,2,choiceId}'
                AND
                "payload" #>> '{decision,candidates,1,catalogueItemId}'
                  <> "payload" #>> '{decision,candidates,2,catalogueItemId}'
              )
            )
            AND (
              jsonb_array_length("payload" #> '{decision,candidates}') <= 3
              OR (
                "payload" #>> '{decision,candidates,1,choiceId}'
                  <> "payload" #>> '{decision,candidates,3,choiceId}'
                AND
                "payload" #>> '{decision,candidates,1,catalogueItemId}'
                  <> "payload" #>> '{decision,candidates,3,catalogueItemId}'
              )
            )
            AND (
              jsonb_array_length("payload" #> '{decision,candidates}') <= 4
              OR (
                "payload" #>> '{decision,candidates,1,choiceId}'
                  <> "payload" #>> '{decision,candidates,4,choiceId}'
                AND
                "payload" #>> '{decision,candidates,1,catalogueItemId}'
                  <> "payload" #>> '{decision,candidates,4,catalogueItemId}'
              )
            )
            AND (
              jsonb_array_length("payload" #> '{decision,candidates}') <= 3
              OR (
                "payload" #>> '{decision,candidates,2,choiceId}'
                  <> "payload" #>> '{decision,candidates,3,choiceId}'
                AND
                "payload" #>> '{decision,candidates,2,catalogueItemId}'
                  <> "payload" #>> '{decision,candidates,3,catalogueItemId}'
              )
            )
            AND (
              jsonb_array_length("payload" #> '{decision,candidates}') <= 4
              OR (
                "payload" #>> '{decision,candidates,2,choiceId}'
                  <> "payload" #>> '{decision,candidates,4,choiceId}'
                AND
                "payload" #>> '{decision,candidates,2,catalogueItemId}'
                  <> "payload" #>> '{decision,candidates,4,catalogueItemId}'
              )
            )
            AND (
              jsonb_array_length("payload" #> '{decision,candidates}') <= 4
              OR (
                "payload" #>> '{decision,candidates,3,choiceId}'
                  <> "payload" #>> '{decision,candidates,4,choiceId}'
                AND
                "payload" #>> '{decision,candidates,3,catalogueItemId}'
                  <> "payload" #>> '{decision,candidates,4,catalogueItemId}'
              )
            )
            AND (
              jsonb_array_length("payload" #> '{decision,candidates}') <= 0
              OR "payload" #>> '{decision,freeLineChoiceId}'
                <> "payload" #>> '{decision,candidates,0,choiceId}'
            )
            AND (
              jsonb_array_length("payload" #> '{decision,candidates}') <= 1
              OR "payload" #>> '{decision,freeLineChoiceId}'
                <> "payload" #>> '{decision,candidates,1,choiceId}'
            )
            AND (
              jsonb_array_length("payload" #> '{decision,candidates}') <= 2
              OR "payload" #>> '{decision,freeLineChoiceId}'
                <> "payload" #>> '{decision,candidates,2,choiceId}'
            )
            AND (
              jsonb_array_length("payload" #> '{decision,candidates}') <= 3
              OR "payload" #>> '{decision,freeLineChoiceId}'
                <> "payload" #>> '{decision,candidates,3,choiceId}'
            )
            AND (
              jsonb_array_length("payload" #> '{decision,candidates}') <= 4
              OR "payload" #>> '{decision,freeLineChoiceId}'
                <> "payload" #>> '{decision,candidates,4,choiceId}'
            )
            -- END GENERATED M2A1_QUOTE_MISSION_CATALOGUE_CANDIDATE_CHECKS
          )
          OR (
            "protocolVersion" = 2
            AND "payload" -> 'decision' ->> 'kind' = 'line_confirmation'
            AND "payload" -> 'decision' ?& ARRAY[
              -- BEGIN GENERATED QUOTE_MISSION_LINE_CONFIRMATION_DECISION_KEYS
              'kind',
              'decisionId',
              'choiceSetRevision',
              'pendingLineId',
              'proposalId',
              'proposalRevision',
              'expectedDraft',
              'expectedWorkRevision',
              'expectedCatalogue',
              'expectedVatContextDigest',
              'diffHash',
              'choices',
              'choiceSetHash'
              -- END GENERATED QUOTE_MISSION_LINE_CONFIRMATION_DECISION_KEYS
            ]
            AND ("payload" -> 'decision') - ARRAY[
              -- BEGIN GENERATED QUOTE_MISSION_LINE_CONFIRMATION_DECISION_KEYS
              'kind',
              'decisionId',
              'choiceSetRevision',
              'pendingLineId',
              'proposalId',
              'proposalRevision',
              'expectedDraft',
              'expectedWorkRevision',
              'expectedCatalogue',
              'expectedVatContextDigest',
              'diffHash',
              'choices',
              'choiceSetHash'
              -- END GENERATED QUOTE_MISSION_LINE_CONFIRMATION_DECISION_KEYS
            ] = '{}'::JSONB
            AND "payload" #>> '{decision,decisionId}' ~ '^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$'
            AND "payload" #>> '{decision,pendingLineId}' ~ '^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$'
            AND "payload" #>> '{decision,proposalId}' ~ '^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$'
            AND jsonb_typeof("payload" #> '{decision,choiceSetRevision}') = 'number'
            AND ("payload" #>> '{decision,choiceSetRevision}')::NUMERIC BETWEEN 1 AND 2147483647
            AND ("payload" #>> '{decision,choiceSetRevision}')::NUMERIC = trunc(("payload" #>> '{decision,choiceSetRevision}')::NUMERIC)
            AND ("payload" #>> '{decision,choiceSetRevision}')::NUMERIC
              <= "revision"
            AND jsonb_typeof("payload" #> '{decision,expectedWorkRevision}') = 'number'
            AND ("payload" #>> '{decision,expectedWorkRevision}')::NUMERIC BETWEEN 1 AND 2147483647
            AND ("payload" #>> '{decision,expectedWorkRevision}')::NUMERIC = trunc(("payload" #>> '{decision,expectedWorkRevision}')::NUMERIC)
            AND jsonb_typeof("payload" #> '{decision,proposalRevision}') = 'number'
            AND "payload" #>> '{decision,proposalRevision}' = '1'
            AND ("payload" #> '{decision,expectedDraft}') ?& ARRAY[
              -- BEGIN GENERATED QUOTE_MISSION_DRAFT_REFERENCE_KEYS
              'sessionId',
              'slotRevision',
              'contentRevision'
              -- END GENERATED QUOTE_MISSION_DRAFT_REFERENCE_KEYS
            ]
            AND ("payload" #> '{decision,expectedDraft}') - ARRAY[
              -- BEGIN GENERATED QUOTE_MISSION_DRAFT_REFERENCE_KEYS
              'sessionId',
              'slotRevision',
              'contentRevision'
              -- END GENERATED QUOTE_MISSION_DRAFT_REFERENCE_KEYS
            ] = '{}'::JSONB
            AND "payload" #> '{decision,expectedDraft}' = "payload" -> 'draft'
            AND (
              "payload" #> '{decision,expectedCatalogue}' = 'null'::JSONB
              OR (
                jsonb_typeof("payload" #> '{decision,expectedCatalogue}') = 'object'
                AND ("payload" #> '{decision,expectedCatalogue}') ?& ARRAY[
                  -- BEGIN GENERATED QUOTE_MISSION_EXPECTED_CATALOGUE_KEYS
                  'itemId',
                  'revision'
                  -- END GENERATED QUOTE_MISSION_EXPECTED_CATALOGUE_KEYS
                ]
                AND ("payload" #> '{decision,expectedCatalogue}') - ARRAY[
                  -- BEGIN GENERATED QUOTE_MISSION_EXPECTED_CATALOGUE_KEYS
                  'itemId',
                  'revision'
                  -- END GENERATED QUOTE_MISSION_EXPECTED_CATALOGUE_KEYS
                ] = '{}'::JSONB
                AND jsonb_typeof("payload" #> '{decision,expectedCatalogue,itemId}')
                  = 'string'
                AND "payload" #>> '{decision,expectedCatalogue,itemId}'
                  ~ '^[A-Za-z0-9-]{1,128}$'
                AND jsonb_typeof("payload" #> '{decision,expectedCatalogue,revision}') = 'number'
            AND ("payload" #>> '{decision,expectedCatalogue,revision}')::NUMERIC BETWEEN 1 AND 2147483647
            AND ("payload" #>> '{decision,expectedCatalogue,revision}')::NUMERIC = trunc(("payload" #>> '{decision,expectedCatalogue,revision}')::NUMERIC)
              )
            )
            AND jsonb_typeof("payload" #> '{decision,expectedVatContextDigest}')
              = 'string'
            AND "payload" #>> '{decision,expectedVatContextDigest}'
              ~ '^[a-f0-9]{64}$'
            AND jsonb_typeof("payload" #> '{decision,diffHash}') = 'string'
            AND "payload" #>> '{decision,diffHash}' ~ '^[a-f0-9]{64}$'
            AND "payload" #>> '{decision,choiceSetHash}' ~ '^[a-f0-9]{64}$'
            AND jsonb_typeof("payload" #> '{decision,choices}') = 'array'
            AND jsonb_array_length("payload" #> '{decision,choices}') = 3
            AND jsonb_typeof("payload" #> '{decision,choices,0}') = 'object'
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
            AND "payload" #>> '{decision,choices,0,choiceId}' ~ '^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$'
            AND "payload" #>> '{decision,choices,0,action}' = 'confirm_line'
            AND jsonb_typeof("payload" #> '{decision,choices,1}') = 'object'
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
            AND "payload" #>> '{decision,choices,1,choiceId}' ~ '^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$'
            AND "payload" #>> '{decision,choices,1,action}' = 'edit_line'
            AND jsonb_typeof("payload" #> '{decision,choices,2}') = 'object'
            AND ("payload" #> '{decision,choices,2}') ?& ARRAY[
              -- BEGIN GENERATED QUOTE_MISSION_ACTION_CHOICE_KEYS
              'choiceId',
              'action'
              -- END GENERATED QUOTE_MISSION_ACTION_CHOICE_KEYS
            ]
            AND ("payload" #> '{decision,choices,2}') - ARRAY[
              -- BEGIN GENERATED QUOTE_MISSION_ACTION_CHOICE_KEYS
              'choiceId',
              'action'
              -- END GENERATED QUOTE_MISSION_ACTION_CHOICE_KEYS
            ] = '{}'::JSONB
            AND "payload" #>> '{decision,choices,2,choiceId}' ~ '^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$'
            AND "payload" #>> '{decision,choices,2,action}' = 'cancel_line'
            AND "payload" #>> '{decision,choices,0,choiceId}'
              <> "payload" #>> '{decision,choices,1,choiceId}'
            AND "payload" #>> '{decision,choices,0,choiceId}'
              <> "payload" #>> '{decision,choices,2,choiceId}'
            AND "payload" #>> '{decision,choices,1,choiceId}'
              <> "payload" #>> '{decision,choices,2,choiceId}'
          )
        )
      )
    )
  ) IS TRUE) NOT VALID,
  ADD CONSTRAINT agent_missions_phase_payload_m2a2_check CHECK (((
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
    OR (
      "protocolVersion" = 2
      AND "phase" = 'awaiting_catalogue_choice'
      AND jsonb_typeof("payload" -> 'draft') = 'object'
      AND "payload" -> 'decision' ->> 'kind' = 'catalogue'
      AND jsonb_typeof("currentBinding") = 'object'
    )
    OR (
      "protocolVersion" = 2
      AND "phase" = 'awaiting_line_details'
      AND jsonb_typeof("payload" -> 'draft') = 'object'
      AND "payload" -> 'decision' = 'null'::JSONB
      AND jsonb_typeof("currentBinding") = 'object'
    )
    OR (
      "protocolVersion" = 2
      AND "phase" = 'awaiting_line_confirmation'
      AND jsonb_typeof("payload" -> 'draft') = 'object'
      AND "payload" -> 'decision' ->> 'kind' = 'line_confirmation'
      AND jsonb_typeof("currentBinding") = 'object'
    )
  )
  AND (
    NOT ("payload" ? 'stagedCustomerResolution')
    OR "payload" -> 'stagedCustomerResolution' = 'null'::JSONB
    OR "phase" NOT IN (
      -- BEGIN GENERATED QUOTE_MISSION_STAGED_CUSTOMER_RESOLUTION_FORBIDDEN_PHASES
      'awaiting_customer_choice',
      'awaiting_lines',
      'awaiting_catalogue_choice',
      'awaiting_line_details',
      'awaiting_line_confirmation'
      -- END GENERATED QUOTE_MISSION_STAGED_CUSTOMER_RESOLUTION_FORBIDDEN_PHASES
    )
  )
) IS TRUE) NOT VALID;
RESET ROLE;

DO $bob_m2a2_events_owner$
DECLARE
  owner_oid OID;
  owner_name TEXT;
BEGIN
  SELECT relation.relowner, pg_catalog.pg_get_userbyid(relation.relowner)
    INTO STRICT owner_oid, owner_name
    FROM pg_catalog.pg_class AS relation
    JOIN pg_catalog.pg_namespace AS namespace
      ON namespace.oid = relation.relnamespace
   WHERE namespace.nspname = 'public'
     AND relation.relname = 'agent_mission_events'
     AND relation.relkind IN ('r', 'p');

  IF current_user::pg_catalog.regrole <> owner_oid THEN
    IF owner_name IS NULL
       OR NOT pg_catalog.pg_has_role(session_user, owner_oid, 'SET') THEN
      RAISE EXCEPTION USING
        ERRCODE = '42501',
        MESSAGE = 'AGENT_MISSION_M2A2_EVENTS_OWNER_UNAVAILABLE';
    END IF;
    EXECUTE pg_catalog.format('SET LOCAL ROLE %I', owner_name);
  END IF;

  IF current_user::pg_catalog.regrole <> owner_oid THEN
    RAISE EXCEPTION USING
      ERRCODE = '42501',
      MESSAGE = 'AGENT_MISSION_M2A2_EVENTS_OWNER_NOT_ASSUMED';
  END IF;

  IF NOT pg_catalog.has_schema_privilege(current_user, 'public', 'CREATE') THEN
    RAISE EXCEPTION USING
      ERRCODE = '42501',
      MESSAGE = 'AGENT_MISSION_M2A2_EVENTS_SCHEMA_CREATE_REQUIRED';
  END IF;
END;
$bob_m2a2_events_owner$;

ALTER TABLE public.agent_mission_events
  ADD CONSTRAINT agent_mission_events_type_m2a2_check CHECK ("eventType" IN (
    -- BEGIN GENERATED AGENT_MISSION_EVENT_TYPES
    'mission_started',
    'mission_joined',
    'draft_resume_selected',
    'draft_discard_requested',
    'draft_discard_cancelled',
    'draft_discard_confirmed',
    'customer_resolution_staged',
    'screen_acknowledged',
    'customer_not_found',
    'customer_choice_presented',
    'customer_selected',
    'decision_invalidated',
    'line_candidates_staged',
    'catalogue_not_found',
    'catalogue_choices_presented',
    'catalogue_choice_selected',
    'line_fact_patched',
    'line_details_requested',
    'line_proposal_presented',
    'line_proposal_rejected',
    'line_confirmed',
    'line_cancelled',
    'mission_cancelled',
    'mission_expired'
    -- END GENERATED AGENT_MISSION_EVENT_TYPES
  )) NOT VALID,
  ADD CONSTRAINT agent_mission_events_envelope_m2a2_check CHECK (
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
        "eventType" IN (
          -- BEGIN GENERATED AGENT_MISSION_CORRELATION_USER_EVENT_TYPES
          'mission_started',
          'mission_joined',
          'draft_resume_selected',
          'draft_discard_requested',
          'draft_discard_cancelled',
          'draft_discard_confirmed',
          'customer_resolution_staged',
          'customer_not_found',
          'customer_choice_presented',
          'customer_selected',
          'decision_invalidated',
          'line_candidates_staged',
          'catalogue_choice_selected',
          'line_fact_patched',
          'line_proposal_rejected',
          'line_confirmed',
          'line_cancelled',
          'mission_cancelled'
          -- END GENERATED AGENT_MISSION_CORRELATION_USER_EVENT_TYPES
        )
        AND "actor" IN (
          -- BEGIN GENERATED AGENT_MISSION_USER_ACTORS
          'user_voice',
          'user_tap'
          -- END GENERATED AGENT_MISSION_USER_ACTORS
        )
        AND "commandId"::TEXT
          ~ '^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$'
      )
      OR (
        "eventType" IN (
          -- BEGIN GENERATED AGENT_MISSION_CORRELATION_SCREEN_ACK_EVENT_TYPES
          'screen_acknowledged'
          -- END GENERATED AGENT_MISSION_CORRELATION_SCREEN_ACK_EVENT_TYPES
        )
        AND "actor" = 'system'
        AND (
          "commandId"::TEXT
            ~ '^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$'
          OR "commandId"::TEXT
            ~ '^[a-f0-9]{8}-[a-f0-9]{4}-8[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$'
        )
      )
      OR (
        "eventType" IN (
          -- BEGIN GENERATED AGENT_MISSION_SYSTEM_CONTINUATION_EVENT_TYPES
          'customer_not_found',
          'customer_choice_presented',
          'customer_selected',
          'catalogue_not_found',
          'catalogue_choices_presented',
          'line_details_requested',
          'line_proposal_presented'
          -- END GENERATED AGENT_MISSION_SYSTEM_CONTINUATION_EVENT_TYPES
        )
        AND "actor" = 'system'
        AND "commandId"::TEXT
          ~ '^[a-f0-9]{8}-[a-f0-9]{4}-8[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$'
      )
      OR (
        "eventType" IN (
          -- BEGIN GENERATED AGENT_MISSION_CORRELATION_SYSTEM_EVENT_TYPES
          'mission_expired',
          'catalogue_not_found',
          'catalogue_choices_presented',
          'line_details_requested',
          'line_proposal_presented'
          -- END GENERATED AGENT_MISSION_CORRELATION_SYSTEM_EVENT_TYPES
        )
        AND "actor" = 'system'
        AND "commandId"::TEXT
          ~ '^[a-f0-9]{8}-[a-f0-9]{4}-8[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$'
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
  ) NOT VALID,
  ADD CONSTRAINT agent_mission_events_data_m2a2_check CHECK ((
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
          'awaiting_lines',
          'awaiting_catalogue_choice',
          'awaiting_line_details',
          'awaiting_line_confirmation'
          -- END GENERATED AGENT_MISSION_SCREEN_ACK_NEXT_PHASES
        )
      )
      OR (
        "eventType" = 'customer_resolution_staged'
        AND "data" ?& ARRAY[
          -- BEGIN GENERATED AGENT_MISSION_EVENT_STAGED_RESOLUTION_DATA_KEYS
          'kind',
          'result',
          'observedCandidateCount'
          -- END GENERATED AGENT_MISSION_EVENT_STAGED_RESOLUTION_DATA_KEYS
        ]
        AND "data" - ARRAY[
          -- BEGIN GENERATED AGENT_MISSION_EVENT_STAGED_RESOLUTION_DATA_KEYS
          'kind',
          'result',
          'observedCandidateCount'
          -- END GENERATED AGENT_MISSION_EVENT_STAGED_RESOLUTION_DATA_KEYS
        ] = '{}'::JSONB
        AND "data" ->> 'result' IN (
          -- BEGIN GENERATED AGENT_MISSION_STAGED_CUSTOMER_RESOLUTION_RESULTS
          'none',
          'too_many',
          'exact',
          'choices'
          -- END GENERATED AGENT_MISSION_STAGED_CUSTOMER_RESOLUTION_RESULTS
        )
        AND jsonb_typeof("data" -> 'observedCandidateCount') = 'number'
        AND ("data" ->> 'observedCandidateCount')::NUMERIC
          = trunc(("data" ->> 'observedCandidateCount')::NUMERIC)
        AND (
          ("data" ->> 'result' = 'none'
            AND ("data" ->> 'observedCandidateCount')::NUMERIC = 0)
          OR ("data" ->> 'result' = 'too_many'
            AND ("data" ->> 'observedCandidateCount')::NUMERIC = 6)
          OR ("data" ->> 'result' = 'exact'
            AND ("data" ->> 'observedCandidateCount')::NUMERIC = 1)
          OR ("data" ->> 'result' = 'choices'
            AND ("data" ->> 'observedCandidateCount')::NUMERIC BETWEEN 1 AND 5)
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
        "eventType" = 'line_candidates_staged'
        AND "data" ?& ARRAY[
          -- BEGIN GENERATED AGENT_MISSION_EVENT_LINE_STAGED_DATA_KEYS
          'kind',
          'stagedCount',
          'firstQueueOrdinal',
          'lastQueueOrdinal'
          -- END GENERATED AGENT_MISSION_EVENT_LINE_STAGED_DATA_KEYS
        ]
        AND "data" - ARRAY[
          -- BEGIN GENERATED AGENT_MISSION_EVENT_LINE_STAGED_DATA_KEYS
          'kind',
          'stagedCount',
          'firstQueueOrdinal',
          'lastQueueOrdinal'
          -- END GENERATED AGENT_MISSION_EVENT_LINE_STAGED_DATA_KEYS
        ] = '{}'::JSONB
        AND jsonb_typeof("data" -> 'stagedCount') = 'number'
        AND ("data" ->> 'stagedCount')::NUMERIC
          BETWEEN 1 AND 20
        AND ("data" ->> 'stagedCount')::NUMERIC
          = trunc(("data" ->> 'stagedCount')::NUMERIC)
        AND jsonb_typeof("data" -> 'firstQueueOrdinal') = 'number'
        AND ("data" ->> 'firstQueueOrdinal')::NUMERIC
          BETWEEN 1 AND 2147483647
        AND ("data" ->> 'firstQueueOrdinal')::NUMERIC
          = trunc(("data" ->> 'firstQueueOrdinal')::NUMERIC)
        AND jsonb_typeof("data" -> 'lastQueueOrdinal') = 'number'
        AND ("data" ->> 'lastQueueOrdinal')::NUMERIC
          BETWEEN 1 AND 2147483647
        AND ("data" ->> 'lastQueueOrdinal')::NUMERIC
          = trunc(("data" ->> 'lastQueueOrdinal')::NUMERIC)
        AND ("data" ->> 'lastQueueOrdinal')::NUMERIC
          - ("data" ->> 'firstQueueOrdinal')::NUMERIC + 1
          = ("data" ->> 'stagedCount')::NUMERIC
      )
      OR (
        "eventType" = 'catalogue_not_found'
        AND "data" ?& ARRAY[
          -- BEGIN GENERATED AGENT_MISSION_EVENT_CATALOGUE_NOT_FOUND_DATA_KEYS
          'kind',
          'pendingLineId',
          'workRevisionAfter',
          'result'
          -- END GENERATED AGENT_MISSION_EVENT_CATALOGUE_NOT_FOUND_DATA_KEYS
        ]
        AND "data" - ARRAY[
          -- BEGIN GENERATED AGENT_MISSION_EVENT_CATALOGUE_NOT_FOUND_DATA_KEYS
          'kind',
          'pendingLineId',
          'workRevisionAfter',
          'result'
          -- END GENERATED AGENT_MISSION_EVENT_CATALOGUE_NOT_FOUND_DATA_KEYS
        ] = '{}'::JSONB
        AND "data" ->> 'pendingLineId'
          ~ '^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$'
        AND jsonb_typeof("data" -> 'workRevisionAfter') = 'number'
        AND ("data" ->> 'workRevisionAfter')::NUMERIC
          BETWEEN 1 AND 2147483647
        AND ("data" ->> 'workRevisionAfter')::NUMERIC
          = trunc(("data" ->> 'workRevisionAfter')::NUMERIC)
        AND "data" ->> 'result' = 'none'
      )
      OR (
        "eventType" = 'catalogue_choices_presented'
        AND "data" ?& ARRAY[
          -- BEGIN GENERATED AGENT_MISSION_EVENT_CATALOGUE_PRESENTED_DATA_KEYS
          'kind',
          'pendingLineId',
          'expectedWorkRevision',
          'candidateCount',
          'choiceSetHash'
          -- END GENERATED AGENT_MISSION_EVENT_CATALOGUE_PRESENTED_DATA_KEYS
        ]
        AND "data" - ARRAY[
          -- BEGIN GENERATED AGENT_MISSION_EVENT_CATALOGUE_PRESENTED_DATA_KEYS
          'kind',
          'pendingLineId',
          'expectedWorkRevision',
          'candidateCount',
          'choiceSetHash'
          -- END GENERATED AGENT_MISSION_EVENT_CATALOGUE_PRESENTED_DATA_KEYS
        ] = '{}'::JSONB
        AND "data" ->> 'pendingLineId'
          ~ '^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$'
        AND jsonb_typeof("data" -> 'expectedWorkRevision') = 'number'
        AND ("data" ->> 'expectedWorkRevision')::NUMERIC
          BETWEEN 1 AND 2147483647
        AND ("data" ->> 'expectedWorkRevision')::NUMERIC
          = trunc(("data" ->> 'expectedWorkRevision')::NUMERIC)
        AND jsonb_typeof("data" -> 'candidateCount') = 'number'
        AND ("data" ->> 'candidateCount')::NUMERIC
          BETWEEN 1 AND 5
        AND ("data" ->> 'candidateCount')::NUMERIC
          = trunc(("data" ->> 'candidateCount')::NUMERIC)
        AND "data" ->> 'choiceSetHash' ~ '^[a-f0-9]{64}$'
      )
      OR (
        "eventType" = 'catalogue_choice_selected'
        AND "data" ?& ARRAY[
          -- BEGIN GENERATED AGENT_MISSION_EVENT_CATALOGUE_SELECTED_DATA_KEYS
          'kind',
          'pendingLineId',
          'workRevisionAfter',
          'resolution',
          'choiceId',
          'choiceSetHash'
          -- END GENERATED AGENT_MISSION_EVENT_CATALOGUE_SELECTED_DATA_KEYS
        ]
        AND "data" - ARRAY[
          -- BEGIN GENERATED AGENT_MISSION_EVENT_CATALOGUE_SELECTED_DATA_KEYS
          'kind',
          'pendingLineId',
          'workRevisionAfter',
          'resolution',
          'choiceId',
          'choiceSetHash'
          -- END GENERATED AGENT_MISSION_EVENT_CATALOGUE_SELECTED_DATA_KEYS
        ] = '{}'::JSONB
        AND "data" ->> 'pendingLineId'
          ~ '^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$'
        AND jsonb_typeof("data" -> 'workRevisionAfter') = 'number'
        AND ("data" ->> 'workRevisionAfter')::NUMERIC
          BETWEEN 1 AND 2147483647
        AND ("data" ->> 'workRevisionAfter')::NUMERIC
          = trunc(("data" ->> 'workRevisionAfter')::NUMERIC)
        AND "data" ->> 'resolution' IN ('free', 'selected')
        AND "data" ->> 'choiceId'
          ~ '^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$'
        AND "data" ->> 'choiceSetHash' ~ '^[a-f0-9]{64}$'
      )
      OR (
        "eventType" = 'line_fact_patched'
        AND "data" ->> 'kind' = 'line_fact_patched'
        AND "data" ?& ARRAY[
          -- BEGIN GENERATED AGENT_MISSION_EVENT_LINE_FACT_PATCHED_DATA_KEYS
          'kind',
          'pendingLineId',
          'field',
          'workRevisionAfter'
          -- END GENERATED AGENT_MISSION_EVENT_LINE_FACT_PATCHED_DATA_KEYS
        ]
        AND "data" - ARRAY[
          -- BEGIN GENERATED AGENT_MISSION_EVENT_LINE_FACT_PATCHED_DATA_KEYS
          'kind',
          'pendingLineId',
          'field',
          'workRevisionAfter'
          -- END GENERATED AGENT_MISSION_EVENT_LINE_FACT_PATCHED_DATA_KEYS
        ] = '{}'::JSONB
        AND "data" ->> 'pendingLineId' ~ '^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$'
        AND "data" ->> 'field' IN (
          -- BEGIN GENERATED AGENT_MISSION_QUOTE_LINE_REQUIRED_FACTS
          'service_reference',
          'category',
          'quantity',
          'unit',
          'unit_price',
          'vat_rate',
          'housing_older_than_2y',
          'energy_renovation'
          -- END GENERATED AGENT_MISSION_QUOTE_LINE_REQUIRED_FACTS
        )
        AND jsonb_typeof("data" -> 'workRevisionAfter') = 'number'
        AND ("data" ->> 'workRevisionAfter')::NUMERIC BETWEEN 1 AND 2147483647
        AND ("data" ->> 'workRevisionAfter')::NUMERIC = trunc(("data" ->> 'workRevisionAfter')::NUMERIC)
      )
      OR (
        "eventType" = 'line_details_requested'
        AND "data" ->> 'kind' = 'line_details_requested'
        AND "data" ?& ARRAY[
          -- BEGIN GENERATED AGENT_MISSION_EVENT_LINE_DETAILS_REQUESTED_DATA_KEYS
          'kind',
          'pendingLineId',
          'requiredFact',
          'workRevisionAfter'
          -- END GENERATED AGENT_MISSION_EVENT_LINE_DETAILS_REQUESTED_DATA_KEYS
        ]
        AND "data" - ARRAY[
          -- BEGIN GENERATED AGENT_MISSION_EVENT_LINE_DETAILS_REQUESTED_DATA_KEYS
          'kind',
          'pendingLineId',
          'requiredFact',
          'workRevisionAfter'
          -- END GENERATED AGENT_MISSION_EVENT_LINE_DETAILS_REQUESTED_DATA_KEYS
        ] = '{}'::JSONB
        AND "data" ->> 'pendingLineId' ~ '^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$'
        AND (
          "data" -> 'requiredFact' = 'null'::JSONB
          OR "data" ->> 'requiredFact' IN (
            -- BEGIN GENERATED AGENT_MISSION_QUOTE_LINE_REQUIRED_FACTS
            'service_reference',
            'category',
            'quantity',
            'unit',
            'unit_price',
            'vat_rate',
            'housing_older_than_2y',
            'energy_renovation'
            -- END GENERATED AGENT_MISSION_QUOTE_LINE_REQUIRED_FACTS
          )
        )
        AND jsonb_typeof("data" -> 'workRevisionAfter') = 'number'
        AND ("data" ->> 'workRevisionAfter')::NUMERIC BETWEEN 1 AND 2147483647
        AND ("data" ->> 'workRevisionAfter')::NUMERIC = trunc(("data" ->> 'workRevisionAfter')::NUMERIC)
      )
      OR (
        "eventType" = 'line_proposal_presented'
        AND "data" ->> 'kind' = 'line_proposal_presented'
        AND "data" ?& ARRAY[
          -- BEGIN GENERATED AGENT_MISSION_EVENT_LINE_PROPOSAL_PRESENTED_DATA_KEYS
          'kind',
          'pendingLineId',
          'proposalId',
          'proposalRevision',
          'expectedWorkRevision',
          'diffHash',
          'choiceSetHash'
          -- END GENERATED AGENT_MISSION_EVENT_LINE_PROPOSAL_PRESENTED_DATA_KEYS
        ]
        AND "data" - ARRAY[
          -- BEGIN GENERATED AGENT_MISSION_EVENT_LINE_PROPOSAL_PRESENTED_DATA_KEYS
          'kind',
          'pendingLineId',
          'proposalId',
          'proposalRevision',
          'expectedWorkRevision',
          'diffHash',
          'choiceSetHash'
          -- END GENERATED AGENT_MISSION_EVENT_LINE_PROPOSAL_PRESENTED_DATA_KEYS
        ] = '{}'::JSONB
        AND "data" ->> 'pendingLineId' ~ '^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$'
        AND "data" ->> 'proposalId' ~ '^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$'
        AND jsonb_typeof("data" -> 'proposalRevision') = 'number'
        AND "data" ->> 'proposalRevision' = '1'
        AND jsonb_typeof("data" -> 'expectedWorkRevision') = 'number'
        AND ("data" ->> 'expectedWorkRevision')::NUMERIC BETWEEN 1 AND 2147483647
        AND ("data" ->> 'expectedWorkRevision')::NUMERIC = trunc(("data" ->> 'expectedWorkRevision')::NUMERIC)
        AND jsonb_typeof("data" -> 'diffHash') = 'string'
        AND "data" ->> 'diffHash' ~ '^[a-f0-9]{64}$'
        AND jsonb_typeof("data" -> 'choiceSetHash') = 'string'
        AND "data" ->> 'choiceSetHash' ~ '^[a-f0-9]{64}$'
      )
      OR (
        "eventType" = 'line_proposal_rejected'
        AND "data" ->> 'kind' = 'line_proposal_rejected'
        AND "data" ?& ARRAY[
          -- BEGIN GENERATED AGENT_MISSION_EVENT_LINE_PROPOSAL_REJECTED_DATA_KEYS
          'kind',
          'pendingLineId',
          'proposalId',
          'workRevisionAfter',
          'choiceId',
          'choiceSetHash'
          -- END GENERATED AGENT_MISSION_EVENT_LINE_PROPOSAL_REJECTED_DATA_KEYS
        ]
        AND "data" - ARRAY[
          -- BEGIN GENERATED AGENT_MISSION_EVENT_LINE_PROPOSAL_REJECTED_DATA_KEYS
          'kind',
          'pendingLineId',
          'proposalId',
          'workRevisionAfter',
          'choiceId',
          'choiceSetHash'
          -- END GENERATED AGENT_MISSION_EVENT_LINE_PROPOSAL_REJECTED_DATA_KEYS
        ] = '{}'::JSONB
        AND "data" ->> 'pendingLineId' ~ '^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$'
        AND "data" ->> 'proposalId' ~ '^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$'
        AND jsonb_typeof("data" -> 'workRevisionAfter') = 'number'
        AND ("data" ->> 'workRevisionAfter')::NUMERIC BETWEEN 1 AND 2147483647
        AND ("data" ->> 'workRevisionAfter')::NUMERIC = trunc(("data" ->> 'workRevisionAfter')::NUMERIC)
        AND "data" ->> 'choiceId' ~ '^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$'
        AND jsonb_typeof("data" -> 'choiceSetHash') = 'string'
        AND "data" ->> 'choiceSetHash' ~ '^[a-f0-9]{64}$'
      )
      OR (
        "eventType" = 'line_confirmed'
        AND "data" ->> 'kind' = 'line_confirmed'
        AND "data" ?& ARRAY[
          -- BEGIN GENERATED AGENT_MISSION_EVENT_LINE_CONFIRMED_DATA_KEYS
          'kind',
          'pendingLineId',
          'proposalId',
          'proposalRevision',
          'expectedWorkRevision',
          'choiceId',
          'choiceSetHash',
          'diffHash'
          -- END GENERATED AGENT_MISSION_EVENT_LINE_CONFIRMED_DATA_KEYS
        ]
        AND "data" - ARRAY[
          -- BEGIN GENERATED AGENT_MISSION_EVENT_LINE_CONFIRMED_DATA_KEYS
          'kind',
          'pendingLineId',
          'proposalId',
          'proposalRevision',
          'expectedWorkRevision',
          'choiceId',
          'choiceSetHash',
          'diffHash'
          -- END GENERATED AGENT_MISSION_EVENT_LINE_CONFIRMED_DATA_KEYS
        ] = '{}'::JSONB
        AND "data" ->> 'pendingLineId' ~ '^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$'
        AND "data" ->> 'proposalId' ~ '^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$'
        AND jsonb_typeof("data" -> 'proposalRevision') = 'number'
        AND "data" ->> 'proposalRevision' = '1'
        AND jsonb_typeof("data" -> 'expectedWorkRevision') = 'number'
        AND ("data" ->> 'expectedWorkRevision')::NUMERIC BETWEEN 1 AND 2147483647
        AND ("data" ->> 'expectedWorkRevision')::NUMERIC = trunc(("data" ->> 'expectedWorkRevision')::NUMERIC)
        AND "data" ->> 'choiceId' ~ '^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$'
        AND jsonb_typeof("data" -> 'choiceSetHash') = 'string'
        AND "data" ->> 'choiceSetHash' ~ '^[a-f0-9]{64}$'
        AND jsonb_typeof("data" -> 'diffHash') = 'string'
        AND "data" ->> 'diffHash' ~ '^[a-f0-9]{64}$'
      )
      OR (
        "eventType" = 'line_cancelled'
        AND "data" ->> 'kind' = 'line_cancelled'
        AND "data" ?& ARRAY[
          -- BEGIN GENERATED AGENT_MISSION_EVENT_LINE_CANCELLED_DATA_KEYS
          'kind',
          'pendingLineId',
          'expectedWorkRevision',
          'choiceId',
          'choiceSetHash'
          -- END GENERATED AGENT_MISSION_EVENT_LINE_CANCELLED_DATA_KEYS
        ]
        AND "data" - ARRAY[
          -- BEGIN GENERATED AGENT_MISSION_EVENT_LINE_CANCELLED_DATA_KEYS
          'kind',
          'pendingLineId',
          'expectedWorkRevision',
          'choiceId',
          'choiceSetHash'
          -- END GENERATED AGENT_MISSION_EVENT_LINE_CANCELLED_DATA_KEYS
        ] = '{}'::JSONB
        AND "data" ->> 'pendingLineId' ~ '^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$'
        AND jsonb_typeof("data" -> 'expectedWorkRevision') = 'number'
        AND ("data" ->> 'expectedWorkRevision')::NUMERIC BETWEEN 1 AND 2147483647
        AND ("data" ->> 'expectedWorkRevision')::NUMERIC = trunc(("data" ->> 'expectedWorkRevision')::NUMERIC)
        AND "data" ->> 'choiceId' ~ '^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$'
        AND jsonb_typeof("data" -> 'choiceSetHash') = 'string'
        AND "data" ->> 'choiceSetHash' ~ '^[a-f0-9]{64}$'
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
  ) IS TRUE) NOT VALID,
  ADD CONSTRAINT agent_mission_events_correlation_m2a2_check CHECK ((
    (
      "eventType" IN (
        -- BEGIN GENERATED AGENT_MISSION_CORRELATION_SYSTEM_EVENT_TYPES
        'mission_expired',
        'catalogue_not_found',
        'catalogue_choices_presented',
        'line_details_requested',
        'line_proposal_presented'
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
        -- BEGIN GENERATED AGENT_MISSION_SYSTEM_CONTINUATION_EVENT_TYPES
        'customer_not_found',
        'customer_choice_presented',
        'customer_selected',
        'catalogue_not_found',
        'catalogue_choices_presented',
        'line_details_requested',
        'line_proposal_presented'
        -- END GENERATED AGENT_MISSION_SYSTEM_CONTINUATION_EVENT_TYPES
      )
      AND "actor" = 'system'
      AND "realtimeSessionId" IS NOT NULL
      AND "turnId" IS NULL
      AND "contextRevision" BETWEEN 1 AND 2147483647
      AND "contextDigest"::TEXT ~ '^[a-f0-9]{64}$'
      AND (
        "eventType" <> 'customer_selected'
        OR "data" ->> 'source' = 'exact_match'
      )
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
        'customer_resolution_staged',
        'customer_not_found',
        'customer_choice_presented',
        'customer_selected',
        'decision_invalidated',
        'line_candidates_staged',
        'catalogue_choice_selected',
        'line_fact_patched',
        'line_proposal_rejected',
        'line_confirmed',
        'line_cancelled',
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
        "eventType" <> 'customer_selected'
        OR "data" ->> 'source' <> 'screen_selection'
        OR "actor" = 'user_tap'
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
  ) IS TRUE) NOT VALID,
  ADD CONSTRAINT agent_mission_events_draft_effect_m2a2_check CHECK ((
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
        'customer_resolution_staged',
        'screen_acknowledged',
        'customer_not_found',
        'customer_choice_presented',
        'decision_invalidated',
        'line_candidates_staged',
        'catalogue_not_found',
        'catalogue_choices_presented',
        'catalogue_choice_selected',
        'line_fact_patched',
        'line_details_requested',
        'line_proposal_presented',
        'line_proposal_rejected',
        'line_cancelled',
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
    OR (
      "eventType" IN (
        -- BEGIN GENERATED AGENT_MISSION_DRAFT_ADVANCE_LINE_EVENT_TYPES
        'line_confirmed'
        -- END GENERATED AGENT_MISSION_DRAFT_ADVANCE_LINE_EVENT_TYPES
      )
      AND "draftSlotRevisionBefore" BETWEEN 1 AND 2147483646
      AND "draftSlotRevisionAfter" = "draftSlotRevisionBefore" + 1
      AND "draftContentRevisionBefore" BETWEEN 0 AND 2147483646
      AND "draftContentRevisionAfter" = "draftContentRevisionBefore" + 1
    )
  ) IS TRUE) NOT VALID;

CREATE FUNCTION public.guard_agent_mission_event_append_v3()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $agent_mission_event_append_v3$
DECLARE
  current_mission_revision INTEGER;
  current_mission_protocol SMALLINT;
  current_mission_updated_at TIMESTAMPTZ;
BEGIN
  SELECT mission."revision", mission."protocolVersion", mission."updatedAt"
    INTO current_mission_revision, current_mission_protocol, current_mission_updated_at
    FROM public.agent_missions AS mission
   WHERE mission."id" = NEW."missionId"
     AND mission."companyId" = NEW."companyId"
     AND mission."ownerUserId" = NEW."ownerUserId";
  IF NOT FOUND THEN
    RAISE EXCEPTION 'AGENT_MISSION_EVENT_MISSION_NOT_VISIBLE'
      USING ERRCODE = '23503';
  END IF;
  IF NEW."eventType" IN (
    -- BEGIN GENERATED AGENT_MISSION_M2A_EVENT_TYPES
    'line_candidates_staged',
    'catalogue_not_found',
    'catalogue_choices_presented',
    'catalogue_choice_selected',
    'line_fact_patched',
    'line_details_requested',
    'line_proposal_presented',
    'line_proposal_rejected',
    'line_confirmed',
    'line_cancelled'
    -- END GENERATED AGENT_MISSION_M2A_EVENT_TYPES
  ) AND current_mission_protocol <> 2 THEN
    RAISE EXCEPTION 'AGENT_MISSION_M2A_EVENT_PROTOCOL_REQUIRED'
      USING ERRCODE = '23514';
  END IF;
  IF current_mission_revision <> NEW."missionRevisionAfter"
     OR current_mission_updated_at <> NEW."occurredAt" THEN
    RAISE EXCEPTION 'AGENT_MISSION_EVENT_REVISION_MISMATCH'
      USING ERRCODE = '23514';
  END IF;
  IF NEW."missionRevisionAfter" = 1 THEN
    IF EXISTS (
      SELECT 1 FROM public.agent_mission_events AS previous
       WHERE previous."missionId" = NEW."missionId"
    ) THEN
      RAISE EXCEPTION 'AGENT_MISSION_EVENT_PREDECESSOR_INVALID'
        USING ERRCODE = '23514';
    END IF;
  ELSIF NOT EXISTS (
    SELECT 1 FROM public.agent_mission_events AS previous
     WHERE previous."missionId" = NEW."missionId"
       AND previous."sequence" = NEW."missionRevisionBefore"
       AND previous."missionRevisionAfter" = NEW."missionRevisionBefore"
  ) THEN
    RAISE EXCEPTION 'AGENT_MISSION_EVENT_PREDECESSOR_MISSING'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$agent_mission_event_append_v3$;
DROP TRIGGER agent_mission_events_append_guard_v2 ON public.agent_mission_events;
CREATE TRIGGER agent_mission_events_append_guard_v3
BEFORE INSERT ON public.agent_mission_events
FOR EACH ROW EXECUTE FUNCTION public.guard_agent_mission_event_append_v3();
REVOKE ALL PRIVILEGES ON FUNCTION public.guard_agent_mission_event_append_v3() FROM PUBLIC;
DO $bob_m2a2_events_function_acl$
DECLARE
  exposed_role TEXT;
BEGIN
  FOREACH exposed_role IN ARRAY ARRAY['anon', 'authenticated', 'service_role'] LOOP
    IF EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = exposed_role) THEN
      EXECUTE pg_catalog.format(
        'REVOKE ALL PRIVILEGES ON FUNCTION public.%I() FROM %I',
        'guard_agent_mission_event_append_v3',
        exposed_role
      );
    END IF;
  END LOOP;
END;
$bob_m2a2_events_function_acl$;
RESET ROLE;

DO $bob_m2a2_line_work_owner$
DECLARE
  owner_oid OID;
  owner_name TEXT;
BEGIN
  SELECT relation.relowner, pg_catalog.pg_get_userbyid(relation.relowner)
    INTO STRICT owner_oid, owner_name
    FROM pg_catalog.pg_class AS relation
    JOIN pg_catalog.pg_namespace AS namespace
      ON namespace.oid = relation.relnamespace
   WHERE namespace.nspname = 'public'
     AND relation.relname = 'agent_mission_quote_line_work'
     AND relation.relkind IN ('r', 'p');

  IF current_user::pg_catalog.regrole <> owner_oid THEN
    IF owner_name IS NULL
       OR NOT pg_catalog.pg_has_role(session_user, owner_oid, 'SET') THEN
      RAISE EXCEPTION USING
        ERRCODE = '42501',
        MESSAGE = 'AGENT_MISSION_M2A2_LINE_WORK_OWNER_UNAVAILABLE';
    END IF;
    EXECUTE pg_catalog.format('SET LOCAL ROLE %I', owner_name);
  END IF;

  IF current_user::pg_catalog.regrole <> owner_oid THEN
    RAISE EXCEPTION USING
      ERRCODE = '42501',
      MESSAGE = 'AGENT_MISSION_M2A2_LINE_WORK_OWNER_NOT_ASSUMED';
  END IF;

  IF NOT pg_catalog.has_schema_privilege(current_user, 'public', 'CREATE') THEN
    RAISE EXCEPTION USING
      ERRCODE = '42501',
      MESSAGE = 'AGENT_MISSION_M2A2_LINE_WORK_SCHEMA_CREATE_REQUIRED';
  END IF;
END;
$bob_m2a2_line_work_owner$;

ALTER TABLE public.agent_mission_quote_line_work
  ADD COLUMN "catalogueCategoryOverrideConfirmed" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "catalogueUnitOverrideConfirmed" BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE public.agent_mission_quote_line_work
  ADD CONSTRAINT agent_mission_quote_line_work_state_coherence_m2a2_check CHECK ((
  (("catalogueResolution" = 'selected')
    = ("catalogueItemId" IS NOT NULL AND "expectedCatalogueRevision" IS NOT NULL))
  AND ("catalogueResolution" = 'selected'
    OR ("catalogueItemId" IS NULL AND "expectedCatalogueRevision" IS NULL))
  AND (("unitPriceCents" IS NULL) = ("priceBasis" IS NULL))
  AND (
    ("proposalId" IS NULL AND "proposalRevision" IS NULL AND "proposalDiffHash" IS NULL)
    OR ("proposalId" IS NOT NULL AND "proposalRevision" IS NOT NULL
      AND "proposalDiffHash" IS NOT NULL)
  )
  AND (
    ("state" = 'queued' AND "requiredFact" IS NULL
      AND "proposalId" IS NULL)
    OR ("state" = 'awaiting_catalogue_choice'
      AND "serviceReference" IS NOT NULL
      AND "requiredFact" IS NULL
      AND "catalogueResolution" = 'pending'
      AND "catalogueItemId" IS NULL
      AND "expectedCatalogueRevision" IS NULL
      AND "proposalId" IS NULL)
    OR ("state" = 'awaiting_details'
      AND (
        ("requiredFact" IS NULL AND "catalogueResolution" <> 'pending')
        OR ("requiredFact" IS NOT NULL AND (
          "catalogueResolution" <> 'pending'
          OR "requiredFact" = 'service_reference'
        ))
      )
      AND "proposalId" IS NULL)
    OR ("state" = 'awaiting_confirmation'
      AND "serviceReference" IS NOT NULL
      AND "category" IS NOT NULL
      AND "quantityMilli" IS NOT NULL
      AND "unit" IS NOT NULL
      AND "unitPriceCents" IS NOT NULL
      AND "requestedVatRate" IS NOT NULL
      AND "priceBasis" = 'per_unit'
      AND "requiredFact" IS NULL
      AND "catalogueResolution" <> 'pending'
      AND "proposalId" IS NOT NULL)
  )
) IS TRUE) NOT VALID,
  ADD CONSTRAINT agent_mission_quote_line_work_catalogue_override_m2a2_check CHECK ((
  (
    "catalogueResolution" = 'selected'
    OR (
      NOT "catalogueCategoryOverrideConfirmed"
      AND NOT "catalogueUnitOverrideConfirmed"
    )
  )
  AND (NOT "catalogueCategoryOverrideConfirmed" OR "category" IS NOT NULL)
  AND (NOT "catalogueUnitOverrideConfirmed" OR "unit" IS NOT NULL)
) IS TRUE) NOT VALID;

CREATE FUNCTION public.guard_agent_mission_quote_line_work_v3()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $agent_mission_quote_line_work_v3$
DECLARE
  row_value public.agent_mission_quote_line_work;
  parent_protocol SMALLINT;
  expected_mission_id TEXT :=
    nullif(current_setting('app.current_agent_mission_id', true), '');
BEGIN
  IF TG_OP = 'DELETE' AND pg_trigger_depth() > 1 THEN RETURN OLD; END IF;
  row_value := CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
  IF expected_mission_id IS NULL
     OR expected_mission_id <> row_value."missionId"::TEXT THEN
    RAISE EXCEPTION 'AGENT_MISSION_QUOTE_LINE_CAPABILITY_REQUIRED'
      USING ERRCODE = '42501';
  END IF;
  IF TG_OP = 'UPDATE' AND (
    OLD."id" IS DISTINCT FROM NEW."id"
    OR OLD."companyId" IS DISTINCT FROM NEW."companyId"
    OR OLD."ownerUserId" IS DISTINCT FROM NEW."ownerUserId"
    OR OLD."missionId" IS DISTINCT FROM NEW."missionId"
    OR OLD."ordinal" IS DISTINCT FROM NEW."ordinal"
    OR OLD."origin" IS DISTINCT FROM NEW."origin"
    OR OLD."createdAt" IS DISTINCT FROM NEW."createdAt"
    OR NEW."revision" <> OLD."revision" + 1
  ) THEN
    RAISE EXCEPTION 'AGENT_MISSION_QUOTE_LINE_IDENTITY_OR_REVISION_INVALID'
      USING ERRCODE = '23514';
  END IF;
  IF TG_OP = 'UPDATE'
     AND OLD."serviceReference" IS DISTINCT FROM NEW."serviceReference"
     AND (
       NEW."catalogueResolution" <> 'pending'
       OR NEW."catalogueItemId" IS NOT NULL
       OR NEW."expectedCatalogueRevision" IS NOT NULL
       OR NEW."catalogueCategoryOverrideConfirmed"
       OR NEW."catalogueUnitOverrideConfirmed"
       OR NEW."proposalId" IS NOT NULL
     ) THEN
    RAISE EXCEPTION 'AGENT_MISSION_QUOTE_LINE_REFERENCE_RESET_REQUIRED'
      USING ERRCODE = '23514';
  END IF;
  IF TG_OP = 'UPDATE'
     AND (
       OLD."catalogueResolution" IS DISTINCT FROM NEW."catalogueResolution"
       OR OLD."catalogueItemId" IS DISTINCT FROM NEW."catalogueItemId"
       OR OLD."expectedCatalogueRevision" IS DISTINCT FROM NEW."expectedCatalogueRevision"
     )
     AND (
       NEW."catalogueCategoryOverrideConfirmed"
       OR NEW."catalogueUnitOverrideConfirmed"
       OR NEW."proposalId" IS NOT NULL
     ) THEN
    RAISE EXCEPTION 'AGENT_MISSION_QUOTE_LINE_CATALOGUE_RESET_REQUIRED'
      USING ERRCODE = '23514';
  END IF;
  IF TG_OP = 'UPDATE'
     AND OLD."proposalId" IS NOT NULL
     AND OLD."proposalId" IS NOT DISTINCT FROM NEW."proposalId"
     AND (
       OLD."serviceReference" IS DISTINCT FROM NEW."serviceReference"
       OR OLD."category" IS DISTINCT FROM NEW."category"
       OR OLD."quantityMilli" IS DISTINCT FROM NEW."quantityMilli"
       OR OLD."unit" IS DISTINCT FROM NEW."unit"
       OR OLD."unitPriceCents" IS DISTINCT FROM NEW."unitPriceCents"
       OR OLD."requestedVatRate" IS DISTINCT FROM NEW."requestedVatRate"
       OR OLD."priceBasis" IS DISTINCT FROM NEW."priceBasis"
       OR OLD."housingOlderThan2y" IS DISTINCT FROM NEW."housingOlderThan2y"
       OR OLD."energyRenovation" IS DISTINCT FROM NEW."energyRenovation"
       OR OLD."catalogueItemId" IS DISTINCT FROM NEW."catalogueItemId"
       OR OLD."expectedCatalogueRevision" IS DISTINCT FROM NEW."expectedCatalogueRevision"
       OR OLD."catalogueCategoryOverrideConfirmed"
          IS DISTINCT FROM NEW."catalogueCategoryOverrideConfirmed"
       OR OLD."catalogueUnitOverrideConfirmed"
          IS DISTINCT FROM NEW."catalogueUnitOverrideConfirmed"
       OR OLD."proposalRevision" IS DISTINCT FROM NEW."proposalRevision"
       OR OLD."proposalDiffHash" IS DISTINCT FROM NEW."proposalDiffHash"
     ) THEN
    RAISE EXCEPTION 'AGENT_MISSION_QUOTE_LINE_PROPOSAL_RESET_REQUIRED'
      USING ERRCODE = '23514';
  END IF;
  SELECT mission."protocolVersion" INTO parent_protocol
    FROM public.agent_missions AS mission
   WHERE mission."id" = row_value."missionId"
     AND mission."companyId" = row_value."companyId"
     AND mission."ownerUserId" = row_value."ownerUserId"
     AND mission."kind" = 'quote_creation'
     AND mission."status" = 'active';
  IF NOT FOUND OR parent_protocol <> 2 THEN
    RAISE EXCEPTION 'AGENT_MISSION_QUOTE_LINE_ACTIVE_M2A_PARENT_REQUIRED'
      USING ERRCODE = '23503';
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END;
$agent_mission_quote_line_work_v3$;
DROP TRIGGER agent_mission_quote_line_work_guard_v2
  ON public.agent_mission_quote_line_work;
CREATE TRIGGER agent_mission_quote_line_work_guard_v3
BEFORE INSERT OR UPDATE OR DELETE ON public.agent_mission_quote_line_work
FOR EACH ROW EXECUTE FUNCTION public.guard_agent_mission_quote_line_work_v3();
REVOKE ALL PRIVILEGES ON FUNCTION public.guard_agent_mission_quote_line_work_v3() FROM PUBLIC;
DO $bob_m2a2_line_work_function_acl$
DECLARE
  exposed_role TEXT;
BEGIN
  FOREACH exposed_role IN ARRAY ARRAY['anon', 'authenticated', 'service_role'] LOOP
    IF EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = exposed_role) THEN
      EXECUTE pg_catalog.format(
        'REVOKE ALL PRIVILEGES ON FUNCTION public.%I() FROM %I',
        'guard_agent_mission_quote_line_work_v3',
        exposed_role
      );
    END IF;
  END LOOP;
END;
$bob_m2a2_line_work_function_acl$;
RESET ROLE;

COMMIT;
