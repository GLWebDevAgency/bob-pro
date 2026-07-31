-- Bob AgentMission M2-A-3 — annulation de ligne sans décision, expand writer N-1.
-- Le flag bob.agent_missions.quote.m2a doit rester exactement OFF.

BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '120s';

DO $bob_m2a3_expand_release_flags_owner$
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
        MESSAGE = 'AGENT_MISSION_M2A3_EXPAND_RELEASE_FLAGS_OWNER_UNAVAILABLE';
    END IF;
    EXECUTE pg_catalog.format('SET LOCAL ROLE %I', owner_name);
  END IF;

  IF current_user::pg_catalog.regrole <> owner_oid THEN
    RAISE EXCEPTION USING
      ERRCODE = '42501',
      MESSAGE = 'AGENT_MISSION_M2A3_EXPAND_RELEASE_FLAGS_OWNER_NOT_ASSUMED';
  END IF;
END;
$bob_m2a3_expand_release_flags_owner$;

ALTER TABLE public.release_flags NO FORCE ROW LEVEL SECURITY;

DO $bob_m2a3_expand_release_flag_exact$
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
      MESSAGE = 'AGENT_MISSION_M2A3_EXPAND_FLAG_NOT_EXACTLY_OFF';
  END IF;
END;
$bob_m2a3_expand_release_flag_exact$;

ALTER TABLE public.release_flags ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.release_flags FORCE ROW LEVEL SECURITY;
RESET ROLE;

DO $bob_m2a3_expand_events_owner$
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
        MESSAGE = 'AGENT_MISSION_M2A3_EXPAND_EVENTS_OWNER_UNAVAILABLE';
    END IF;
    EXECUTE pg_catalog.format('SET LOCAL ROLE %I', owner_name);
  END IF;

  IF current_user::pg_catalog.regrole <> owner_oid THEN
    RAISE EXCEPTION USING
      ERRCODE = '42501',
      MESSAGE = 'AGENT_MISSION_M2A3_EXPAND_EVENTS_OWNER_NOT_ASSUMED';
  END IF;
END;
$bob_m2a3_expand_events_owner$;

ALTER TABLE public.agent_mission_events
  ADD CONSTRAINT agent_mission_events_data_m2a3_check CHECK ((
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
        AND (
          (
            "data" -> 'choiceId' = 'null'::JSONB
            AND "data" -> 'choiceSetHash' = 'null'::JSONB
          )
          OR (
            "data" ->> 'choiceId' ~ '^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$'
            AND jsonb_typeof("data" -> 'choiceSetHash') = 'string'
            AND "data" ->> 'choiceSetHash' ~ '^[a-f0-9]{64}$'
          )
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
  ) IS TRUE) NOT VALID;
RESET ROLE;

COMMIT;
