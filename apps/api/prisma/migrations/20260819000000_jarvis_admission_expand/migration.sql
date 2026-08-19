-- Jarvis U1-c — expand : CHECK quote-shaped rendus conditionnels au kind
-- (SPEC_U1C_ADMISSION_DISPATCH_20260818 §1, spec Jarvis §4.4/§5.1/§5.2/§5.5).
--
-- Découverte bloquante réglée ici : les CHECK historiques d'agent_missions
-- (protocol/phase/payload/closed-shape/phase-payload/timestamps) et
-- d'agent_mission_events (type/envelope/data/correlation/draft-effect) sont
-- inconditionnels — toute ligne Jarvis serait rejetée. Chaque contrainte devient
--   (kind = 'quote_creation' AND <prédicat historique VERBATIM>)
--   OR (kind IN ('single_business_action','customer_contact') AND <branche jarvis>)
-- La branche quote est extraite à l'octet près de l'état vivant (m1c/m2a1/m2a2/m2a3
-- après les RENAME des cutovers) : le writer N-1 est indistinguable avant/après.
-- Côté événements la table n'a pas de colonne kind : le discriminant est le
-- vocabulaire (listes legacy et jarvis disjointes) ; pour une ligne jarvis chaque
-- prédicat historique vaut FALSE (jamais NULL), l'ancien comportement est intact.
--
-- Branches jarvis en blocs GENERATED — source unique : les exports des définitions
-- U1-b (packages/core/src/domain/agent/definitions/*.ts, jarvis-run.ts), verrouillés
-- par apps/api/src/persistence/prisma/jarvis-vocabulary-sync.test.ts (§4.4).
--
-- Contraintes volontairement inchangées (kind-neutres, sûres pour jarvis) :
-- missions owner_identifier/kind/status (union U1-a)/revision/binding_shape (NULL
-- admis)/finite_timestamps/definition_version ; events owner_identifier/
-- draft_revision (paires NULL admises)/timestamps.
-- Triggers volontairement inchangés : guard_agent_mission_event_append_v3 ne
-- contraint PAS le vocabulaire (protocole exigé sur le seul sous-ensemble M2A,
-- disjoint du vocabulaire jarvis ; puis revision = revisionAfter, updatedAt =
-- occurredAt, chaînage du prédécesseur) — il impose seulement l'ordre d'écriture
-- CAS-puis-événement à l'admission U1-c, exactement la greffe obligatoire du
-- panel ; guard_agent_mission_mutation_v2 (GUC mission + revision + 1) et
-- require_agent_mission_event_v1 s'appliquent tels quels au writer jarvis.
--
-- NOT VALID partout : le VALIDATE vit dans 20260819000100 (convention U1-a).

BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

-- Contrat Supabase : le deployer non-superuser assume le propriétaire du schéma
-- (même patron que 20260818200000_jarvis_run_expand).
DO $bob_jarvis_u1c_owner$
DECLARE
  schema_owner_oid OID;
  schema_owner_name TEXT;
BEGIN
  SELECT relation.relowner, pg_catalog.pg_get_userbyid(relation.relowner)
    INTO STRICT schema_owner_oid, schema_owner_name
    FROM pg_catalog.pg_class AS relation
    JOIN pg_catalog.pg_namespace AS namespace
      ON namespace.oid = relation.relnamespace
   WHERE namespace.nspname = 'public'
     AND relation.relname = 'agent_missions'
     AND relation.relkind IN ('r', 'p');

  IF current_user::pg_catalog.regrole <> schema_owner_oid THEN
    IF schema_owner_name IS NULL
       OR NOT pg_catalog.pg_has_role(session_user, schema_owner_oid, 'SET') THEN
      RAISE EXCEPTION USING
        ERRCODE = '42501',
        MESSAGE = 'JARVIS_U1C_SCHEMA_OWNER_UNAVAILABLE';
    END IF;
    EXECUTE pg_catalog.format('SET LOCAL ROLE %I', schema_owner_name);
  END IF;

  IF current_user::pg_catalog.regrole <> schema_owner_oid THEN
    RAISE EXCEPTION USING
      ERRCODE = '42501',
      MESSAGE = 'JARVIS_U1C_SCHEMA_OWNER_NOT_ASSUMED';
  END IF;
END;
$bob_jarvis_u1c_owner$;

-- ---------------------------------------------------------------------------
-- 1. agent_missions — branche quote VERBATIM, branche jarvis par kind
-- ---------------------------------------------------------------------------

-- protocolVersion : la branche jarvis l'aligne sur definitionVersion (blueprint
-- U1-c) et ferme les versions admises par kind — toute nouvelle version de
-- définition passe d'abord par une migration (doctrine §4.4).
ALTER TABLE public.agent_missions
  DROP CONSTRAINT agent_missions_protocol_check;
ALTER TABLE public.agent_missions
  ADD CONSTRAINT agent_missions_protocol_check CHECK ((
    "kind" = 'quote_creation'
    AND (
  "protocolVersion" IN (
    -- BEGIN GENERATED AGENT_MISSION_PROTOCOL_VERSIONS
    1,
    2
    -- END GENERATED AGENT_MISSION_PROTOCOL_VERSIONS
  )
)
  )
  OR (
    -- kinds U1-b (JARVIS_RUN_KINDS moins quote_creation)
    "kind" IN ('single_business_action', 'customer_contact')
    AND (
      "definitionVersion" IS NOT NULL
      AND "protocolVersion" = "definitionVersion"
      AND (
        (
          "kind" = 'customer_contact'
          AND "definitionVersion" IN (
            -- BEGIN GENERATED JARVIS_CC_DEFINITION_VERSIONS (CUSTOMER_CONTACT_DEFINITION_VERSION)
            '1'
            -- END GENERATED JARVIS_CC_DEFINITION_VERSIONS
          )
        )
        OR (
          "kind" = 'single_business_action'
          AND "definitionVersion" IN (
            -- BEGIN GENERATED JARVIS_SBA_DEFINITION_VERSIONS (SINGLE_BUSINESS_ACTION_DEFINITION_VERSION)
            '1'
            -- END GENERATED JARVIS_SBA_DEFINITION_VERSIONS
          )
        )
      )
    ) IS TRUE
  )) NOT VALID;

-- phase : la branche jarvis n'admet que les phases exportées par la définition
-- du kind (source unique U1-b).
ALTER TABLE public.agent_missions
  DROP CONSTRAINT agent_missions_phase_check;
ALTER TABLE public.agent_missions
  ADD CONSTRAINT agent_missions_phase_check CHECK ((
    "kind" = 'quote_creation'
    AND (
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
)
  )
  OR (
    -- kinds U1-b (JARVIS_RUN_KINDS moins quote_creation)
    "kind" IN ('single_business_action', 'customer_contact')
    AND (
      (
        "kind" = 'customer_contact'
        AND "phase" IN (
          -- BEGIN GENERATED CUSTOMER_CONTACT_MISSION_PHASES (CUSTOMER_CONTACT_PHASES, U1-b)
          'resolving_customer',
          'awaiting_duplicate_review',
          'preparing_proposal',
          'awaiting_confirmation',
          'committing',
          'awaiting_receipt',
          'cancelling',
          'completed',
          'cancelled',
          'failed'
          -- END GENERATED CUSTOMER_CONTACT_MISSION_PHASES
        )
      )
      OR (
        "kind" = 'single_business_action'
        AND "phase" IN (
          -- BEGIN GENERATED SINGLE_BUSINESS_ACTION_MISSION_PHASES (SINGLE_BUSINESS_ACTION_PHASES, U1-b)
          'preparing',
          'awaiting_confirmation',
          'committing',
          'awaiting_receipt',
          'cancelling',
          'completed',
          'failed_terminal',
          'cancelled'
          -- END GENERATED SINGLE_BUSINESS_ACTION_MISSION_PHASES
        )
      )
    ) IS TRUE
  )) NOT VALID;

-- payload : côté jarvis le payload EST le state du run (§5.1) — enveloppe
-- schema/version présente, taille bornée ; le schéma exact par kind est fermé
-- par payload_closed_shape ci-dessous.
ALTER TABLE public.agent_missions
  DROP CONSTRAINT agent_missions_payload_check;
ALTER TABLE public.agent_missions
  ADD CONSTRAINT agent_missions_payload_check CHECK ((
    "kind" = 'quote_creation'
    AND (
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
  )
  )
  OR (
    -- kinds U1-b (JARVIS_RUN_KINDS moins quote_creation)
    "kind" IN ('single_business_action', 'customer_contact')
    AND (
      jsonb_typeof("payload") = 'object'
      AND "payload" ?& ARRAY[
        -- BEGIN GENERATED JARVIS_STATE_ENVELOPE_KEYS (spec §5.1 : enveloppe minimale du state)
        'schema',
        'version'
        -- END GENERATED JARVIS_STATE_ENVELOPE_KEYS
      ]
      AND jsonb_typeof("payload" -> 'schema') = 'string'
      AND jsonb_typeof("payload" -> 'version') = 'number'
      AND octet_length("payload"::TEXT) <= (
        -- BEGIN GENERATED JARVIS_MAX_STATE_BYTES (limits.maxStateBytes des définitions U1-b)
        '65536'
        -- END GENERATED JARVIS_MAX_STATE_BYTES
      )::INTEGER
    ) IS TRUE
  )) NOT VALID;

-- closed shape : schéma bob.jarvis-run.* et version de state épinglés par kind ;
-- payloadVersion = stateVersion. La forme profonde du state reste l'affaire du
-- parse fermé des définitions U1-b (exact-keys côté domaine).
ALTER TABLE public.agent_missions
  DROP CONSTRAINT agent_missions_payload_closed_shape_check;
ALTER TABLE public.agent_missions
  ADD CONSTRAINT agent_missions_payload_closed_shape_check CHECK ((
    "kind" = 'quote_creation'
    AND ((
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
  ) IS TRUE)
  )
  OR (
    -- kinds U1-b (JARVIS_RUN_KINDS moins quote_creation)
    "kind" IN ('single_business_action', 'customer_contact')
    AND (
      (
        "kind" = 'customer_contact'
        AND "payload" ->> 'schema' IN (
          -- BEGIN GENERATED JARVIS_CC_STATE_SCHEMA (CUSTOMER_CONTACT_STATE_SCHEMA)
          'bob.jarvis-run.customer-contact'
          -- END GENERATED JARVIS_CC_STATE_SCHEMA
        )
        AND "payload" -> 'version' = (
          -- BEGIN GENERATED JARVIS_CC_STATE_VERSION (CUSTOMER_CONTACT_STATE_VERSION)
          '1'
          -- END GENERATED JARVIS_CC_STATE_VERSION
        )::JSONB
        AND "payloadVersion" = (
          -- BEGIN GENERATED JARVIS_CC_STATE_VERSION (CUSTOMER_CONTACT_STATE_VERSION)
          '1'
          -- END GENERATED JARVIS_CC_STATE_VERSION
        )::INTEGER
      )
      OR (
        "kind" = 'single_business_action'
        AND "payload" ->> 'schema' IN (
          -- BEGIN GENERATED JARVIS_SBA_STATE_SCHEMA (SINGLE_BUSINESS_ACTION_STATE_SCHEMA)
          'bob.jarvis-run.single-business-action'
          -- END GENERATED JARVIS_SBA_STATE_SCHEMA
        )
        AND "payload" -> 'version' = (
          -- BEGIN GENERATED JARVIS_SBA_STATE_VERSION (SINGLE_BUSINESS_ACTION_STATE_VERSION)
          '1'
          -- END GENERATED JARVIS_SBA_STATE_VERSION
        )::JSONB
        AND "payloadVersion" = (
          -- BEGIN GENERATED JARVIS_SBA_STATE_VERSION (SINGLE_BUSINESS_ACTION_STATE_VERSION)
          '1'
          -- END GENERATED JARVIS_SBA_STATE_VERSION
        )::INTEGER
      )
    ) IS TRUE
  )) NOT VALID;

-- cohérence phase/payload : la colonne phase reflète state.phase ; le binding
-- d'écran est un concept quote, toujours NULL côté jarvis.
ALTER TABLE public.agent_missions
  DROP CONSTRAINT agent_missions_phase_payload_check;
ALTER TABLE public.agent_missions
  ADD CONSTRAINT agent_missions_phase_payload_check CHECK ((
    "kind" = 'quote_creation'
    AND (((
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
) IS TRUE)
  )
  OR (
    -- kinds U1-b (JARVIS_RUN_KINDS moins quote_creation)
    "kind" IN ('single_business_action', 'customer_contact')
    AND (
      "payload" ->> 'phase' = "phase"
      AND "currentBinding" IS NULL
    ) IS TRUE
  )) NOT VALID;

-- timestamps : la branche quote encode la doctrine TTL du writer N-1 (24 h/168 h)
-- et ses trois statuts ; la branche jarvis encode la cohérence structurelle §5.1
-- (terminalAt ⇔ statut terminal, updatedAt = terminalAt) sans figer les TTL —
-- idleTtlMs/hardTtlMs appartiennent aux limits des définitions.
ALTER TABLE public.agent_missions
  DROP CONSTRAINT agent_missions_timestamps_check;
ALTER TABLE public.agent_missions
  ADD CONSTRAINT agent_missions_timestamps_check CHECK ((
    "kind" = 'quote_creation'
    AND (
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
  )
  OR (
    -- kinds U1-b (JARVIS_RUN_KINDS moins quote_creation)
    "kind" IN ('single_business_action', 'customer_contact')
    AND (
      "updatedAt" >= "createdAt"
      AND "idleExpiresAt" > "createdAt"
      AND "idleExpiresAt" <= "hardExpiresAt"
      AND "retentionExpiresAt" >= "hardExpiresAt"
      AND (
        (
          "status" IN (
            -- BEGIN GENERATED JARVIS_RUN_TERMINAL_STATUSES (jarvis-run.ts §5.1 — ordre trié)
            'cancelled',
            'completed',
            'failed_terminal'
            -- END GENERATED JARVIS_RUN_TERMINAL_STATUSES
          )
          AND "terminalAt" IS NOT NULL
          AND "updatedAt" = "terminalAt"
        )
        OR (
          "status" NOT IN (
            -- BEGIN GENERATED JARVIS_RUN_TERMINAL_STATUSES (jarvis-run.ts §5.1 — ordre trié)
            'cancelled',
            'completed',
            'failed_terminal'
            -- END GENERATED JARVIS_RUN_TERMINAL_STATUSES
          )
          AND "terminalAt" IS NULL
        )
      )
    ) IS TRUE
  )) NOT VALID;

-- ---------------------------------------------------------------------------
-- 2. agent_mission_events — discriminant vocabulaire (pas de colonne kind)
-- ---------------------------------------------------------------------------

-- type : union disjointe legacy ∪ jarvis — le vocabulaire jarvis vient des
-- définitions U1-b (cc_*/sba_*) plus l'événement système de quarantaine §5.5.
ALTER TABLE public.agent_mission_events
  DROP CONSTRAINT agent_mission_events_type_check;
ALTER TABLE public.agent_mission_events
  ADD CONSTRAINT agent_mission_events_type_check CHECK (
    ("eventType" IN (
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
  ))
    OR (
      "eventType" IN (
        -- BEGIN GENERATED JARVIS_EVENT_TYPES (cc_* + sba_* U1-b, run_quarantined §5.5 — ordre trié)
        'cc_cancel_requested',
        'cc_confirm_replayed',
        'cc_confirmation_consumed',
        'cc_customer_resolution_recorded',
        'cc_duplicate_resolution_chosen',
        'cc_effect_failed',
        'cc_effect_receipt_recorded',
        'cc_effect_receipt_replayed',
        'cc_effect_submitted',
        'cc_proposal_expired',
        'cc_proposal_invalidated',
        'cc_proposal_presented',
        'cc_proposal_rejected',
        'cc_proposal_staged',
        'cc_run_cancelled',
        'cc_run_started',
        'cc_target_mutation_recorded',
        'cc_wake_noop',
        'run_quarantined',
        'sba_confirmed',
        'sba_effect_failed',
        'sba_effect_receipt_deduplicated',
        'sba_effect_submitted',
        'sba_effect_succeeded',
        'sba_presentation_acknowledged',
        'sba_proposal_expired',
        'sba_proposal_invalidated',
        'sba_proposal_rejected',
        'sba_proposal_staged',
        'sba_run_cancelled',
        'sba_run_cancelling',
        'sba_wake_ignored'
        -- END GENERATED JARVIS_EVENT_TYPES
      )
    )
  ) NOT VALID;

-- envelope : mêmes invariants HMAC/acteur/commandId (v4 user, v8 système) que la
-- branche quote ; la règle de départ est générique (before ⩾ 0, +1 strict) car le
-- premier événement dépend de la définition, pas d'un type unique.
ALTER TABLE public.agent_mission_events
  DROP CONSTRAINT agent_mission_events_envelope_check;
ALTER TABLE public.agent_mission_events
  ADD CONSTRAINT agent_mission_events_envelope_check CHECK (
    (
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
  )
    OR (
      "eventType" IN (
        -- BEGIN GENERATED JARVIS_EVENT_TYPES (cc_* + sba_* U1-b, run_quarantined §5.5 — ordre trié)
        'cc_cancel_requested',
        'cc_confirm_replayed',
        'cc_confirmation_consumed',
        'cc_customer_resolution_recorded',
        'cc_duplicate_resolution_chosen',
        'cc_effect_failed',
        'cc_effect_receipt_recorded',
        'cc_effect_receipt_replayed',
        'cc_effect_submitted',
        'cc_proposal_expired',
        'cc_proposal_invalidated',
        'cc_proposal_presented',
        'cc_proposal_rejected',
        'cc_proposal_staged',
        'cc_run_cancelled',
        'cc_run_started',
        'cc_target_mutation_recorded',
        'cc_wake_noop',
        'run_quarantined',
        'sba_confirmed',
        'sba_effect_failed',
        'sba_effect_receipt_deduplicated',
        'sba_effect_submitted',
        'sba_effect_succeeded',
        'sba_presentation_acknowledged',
        'sba_proposal_expired',
        'sba_proposal_invalidated',
        'sba_proposal_rejected',
        'sba_proposal_staged',
        'sba_run_cancelled',
        'sba_run_cancelling',
        'sba_wake_ignored'
        -- END GENERATED JARVIS_EVENT_TYPES
      )
      AND "eventVersion" = 1
      -- miroir des blocs AGENT_MISSION_ACTORS / USER / SYSTEM de la branche quote
      AND (
        (
          "actor" IN ('user_voice', 'user_tap')
          AND "commandId"::TEXT
            ~ '^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$'
        )
        OR (
          "actor" = 'system'
          AND "commandId"::TEXT
            ~ '^[a-f0-9]{8}-[a-f0-9]{4}-8[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$'
        )
      )
      AND "requestFingerprintHmac"::TEXT ~ '^[a-f0-9]{64}$'
      AND "fingerprintKeyVersion" BETWEEN 1 AND 2147483647
      AND "fingerprintCanonicalizationVersion" = 1
      AND "sequence" = "missionRevisionAfter"
      -- §5.2 : before >= 0 (le seed revision 0 n'est jamais persisté, le premier
      -- événement d'un run part donc de 0) ; toujours exactement +1, jamais de trou.
      AND "missionRevisionBefore" BETWEEN 0 AND 2147483646
      AND "missionRevisionAfter" = "missionRevisionBefore" + 1
    )
  ) NOT VALID;

ALTER TABLE public.agent_mission_events
  DROP CONSTRAINT agent_mission_events_data_check;
ALTER TABLE public.agent_mission_events
  ADD CONSTRAINT agent_mission_events_data_check CHECK (
    ((
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
  ) IS TRUE)
    OR (
      "eventType" IN (
        -- BEGIN GENERATED JARVIS_EVENT_TYPES (cc_* + sba_* U1-b, run_quarantined §5.5 — ordre trié)
        'cc_cancel_requested',
        'cc_confirm_replayed',
        'cc_confirmation_consumed',
        'cc_customer_resolution_recorded',
        'cc_duplicate_resolution_chosen',
        'cc_effect_failed',
        'cc_effect_receipt_recorded',
        'cc_effect_receipt_replayed',
        'cc_effect_submitted',
        'cc_proposal_expired',
        'cc_proposal_invalidated',
        'cc_proposal_presented',
        'cc_proposal_rejected',
        'cc_proposal_staged',
        'cc_run_cancelled',
        'cc_run_started',
        'cc_target_mutation_recorded',
        'cc_wake_noop',
        'run_quarantined',
        'sba_confirmed',
        'sba_effect_failed',
        'sba_effect_receipt_deduplicated',
        'sba_effect_submitted',
        'sba_effect_succeeded',
        'sba_presentation_acknowledged',
        'sba_proposal_expired',
        'sba_proposal_invalidated',
        'sba_proposal_rejected',
        'sba_proposal_staged',
        'sba_run_cancelled',
        'sba_run_cancelling',
        'sba_wake_ignored'
        -- END GENERATED JARVIS_EVENT_TYPES
      )
      AND jsonb_typeof("data") = 'object'
      AND "data" ->> 'kind' = "eventType"
      -- même borne de taille que le state §5.1 ; les clefs par type restent
      -- l'affaire du parse fermé des définitions U1-b (source unique @bob/core).
      AND octet_length("data"::TEXT) <= (
        -- BEGIN GENERATED JARVIS_MAX_STATE_BYTES (limits.maxStateBytes des définitions U1-b)
        '65536'
        -- END GENERATED JARVIS_MAX_STATE_BYTES
      )::INTEGER
    )
  ) NOT VALID;

ALTER TABLE public.agent_mission_events
  DROP CONSTRAINT agent_mission_events_correlation_check;
ALTER TABLE public.agent_mission_events
  ADD CONSTRAINT agent_mission_events_correlation_check CHECK (
    ((
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
  ) IS TRUE)
    OR (
      "eventType" IN (
        -- BEGIN GENERATED JARVIS_EVENT_TYPES (cc_* + sba_* U1-b, run_quarantined §5.5 — ordre trié)
        'cc_cancel_requested',
        'cc_confirm_replayed',
        'cc_confirmation_consumed',
        'cc_customer_resolution_recorded',
        'cc_duplicate_resolution_chosen',
        'cc_effect_failed',
        'cc_effect_receipt_recorded',
        'cc_effect_receipt_replayed',
        'cc_effect_submitted',
        'cc_proposal_expired',
        'cc_proposal_invalidated',
        'cc_proposal_presented',
        'cc_proposal_rejected',
        'cc_proposal_staged',
        'cc_run_cancelled',
        'cc_run_started',
        'cc_target_mutation_recorded',
        'cc_wake_noop',
        'run_quarantined',
        'sba_confirmed',
        'sba_effect_failed',
        'sba_effect_receipt_deduplicated',
        'sba_effect_submitted',
        'sba_effect_succeeded',
        'sba_presentation_acknowledged',
        'sba_proposal_expired',
        'sba_proposal_invalidated',
        'sba_proposal_rejected',
        'sba_proposal_staged',
        'sba_run_cancelled',
        'sba_run_cancelling',
        'sba_wake_ignored'
        -- END GENERATED JARVIS_EVENT_TYPES
      )
      -- mêmes formes de corrélation par acteur que la branche quote (voix = session
      -- + tour + contexte ; tap = contexte optionnel ; système = aucune corrélation).
      AND (
        (
          "actor" = 'user_voice'
          AND "realtimeSessionId" IS NOT NULL
          AND "turnId" IS NOT NULL
          AND "contextRevision" BETWEEN 1 AND 2147483647
          AND "contextDigest"::TEXT ~ '^[a-f0-9]{64}$'
        )
        OR (
          "actor" = 'user_tap'
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
        OR (
          "actor" = 'system'
          AND "realtimeSessionId" IS NULL
          AND "turnId" IS NULL
          AND "contextRevision" IS NULL
          AND "contextDigest" IS NULL
        )
      )
    )
  ) NOT VALID;

ALTER TABLE public.agent_mission_events
  DROP CONSTRAINT agent_mission_events_draft_effect_check;
ALTER TABLE public.agent_mission_events
  ADD CONSTRAINT agent_mission_events_draft_effect_check CHECK (
    ((
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
  ) IS TRUE)
    OR (
      "eventType" IN (
        -- BEGIN GENERATED JARVIS_EVENT_TYPES (cc_* + sba_* U1-b, run_quarantined §5.5 — ordre trié)
        'cc_cancel_requested',
        'cc_confirm_replayed',
        'cc_confirmation_consumed',
        'cc_customer_resolution_recorded',
        'cc_duplicate_resolution_chosen',
        'cc_effect_failed',
        'cc_effect_receipt_recorded',
        'cc_effect_receipt_replayed',
        'cc_effect_submitted',
        'cc_proposal_expired',
        'cc_proposal_invalidated',
        'cc_proposal_presented',
        'cc_proposal_rejected',
        'cc_proposal_staged',
        'cc_run_cancelled',
        'cc_run_started',
        'cc_target_mutation_recorded',
        'cc_wake_noop',
        'run_quarantined',
        'sba_confirmed',
        'sba_effect_failed',
        'sba_effect_receipt_deduplicated',
        'sba_effect_submitted',
        'sba_effect_succeeded',
        'sba_presentation_acknowledged',
        'sba_proposal_expired',
        'sba_proposal_invalidated',
        'sba_proposal_rejected',
        'sba_proposal_staged',
        'sba_run_cancelled',
        'sba_run_cancelling',
        'sba_wake_ignored'
        -- END GENERATED JARVIS_EVENT_TYPES
      )
      -- les révisions de brouillon sont un concept quote : toujours NULL côté jarvis.
      AND "draftSlotRevisionBefore" IS NULL
      AND "draftSlotRevisionAfter" IS NULL
      AND "draftContentRevisionBefore" IS NULL
      AND "draftContentRevisionAfter" IS NULL
    )
  ) NOT VALID;

COMMIT;
