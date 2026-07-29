-- Bob AgentMission M1-C — élargissement compatible N-1 des unions mission/événement.
-- Le flag M1-C reste OFF jusqu’au cutover validé et au drainage des writers N-1.

BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

ALTER TABLE public.agent_missions
  ADD CONSTRAINT agent_missions_payload_m1c_check CHECK (
    "payloadVersion" = 1
    AND jsonb_typeof("payload") = 'object'
    AND "payload" ?& ARRAY[
      -- BEGIN GENERATED M1C_QUOTE_MISSION_REQUIRED_LEGACY_PAYLOAD_KEYS
      'schema',
      'version',
      'draft',
      'decision'
      -- END GENERATED M1C_QUOTE_MISSION_REQUIRED_LEGACY_PAYLOAD_KEYS
    ]
    AND "payload" @> '{"schema":"bob.agent-mission.quote-creation","version":1}'::JSONB
    AND octet_length("payload"::TEXT) <= 65536
  ) NOT VALID,
  ADD CONSTRAINT agent_missions_payload_closed_shape_m1c_check CHECK ((
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
  ) IS TRUE) NOT VALID,
  ADD CONSTRAINT agent_missions_phase_payload_m1c_check CHECK (((
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
  )
  AND (
    NOT ("payload" ? 'stagedCustomerResolution')
    OR "payload" -> 'stagedCustomerResolution' = 'null'::JSONB
    OR "phase" NOT IN ('awaiting_customer_choice', 'awaiting_lines')
  )
) IS TRUE) NOT VALID;

ALTER TABLE public.agent_mission_events
  ADD CONSTRAINT agent_mission_events_type_m1c_check CHECK ("eventType" IN (
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
    'mission_cancelled',
    'mission_expired'
    -- END GENERATED AGENT_MISSION_EVENT_TYPES
  )) NOT VALID,
  ADD CONSTRAINT agent_mission_events_envelope_m1c_check CHECK (
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
          'customer_selected'
          -- END GENERATED AGENT_MISSION_SYSTEM_CONTINUATION_EVENT_TYPES
        )
        AND "actor" = 'system'
        AND "commandId"::TEXT
          ~ '^[a-f0-9]{8}-[a-f0-9]{4}-8[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$'
      )
      OR (
        "eventType" IN (
          -- BEGIN GENERATED AGENT_MISSION_CORRELATION_SYSTEM_EVENT_TYPES
          'mission_expired'
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
  ADD CONSTRAINT agent_mission_events_data_m1c_check CHECK ((
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
  ADD CONSTRAINT agent_mission_events_correlation_m1c_check CHECK ((
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
        -- BEGIN GENERATED AGENT_MISSION_SYSTEM_CONTINUATION_EVENT_TYPES
        'customer_not_found',
        'customer_choice_presented',
        'customer_selected'
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
  ADD CONSTRAINT agent_mission_events_draft_effect_m1c_check CHECK ((
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
  ) IS TRUE) NOT VALID;

COMMIT;
