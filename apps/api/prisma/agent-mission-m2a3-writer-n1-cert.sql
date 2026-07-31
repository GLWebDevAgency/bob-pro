\set ON_ERROR_STOP on

BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';
SELECT pg_catalog.set_config(
         'bob.cert.m2a3_state',
         :'state',
         TRUE
       ) AS configured_state
\gset

CREATE TEMP TABLE bob_m2a3_event_shape (
  "eventType" TEXT NOT NULL,
  "data" JSONB NOT NULL
) ON COMMIT DROP;

SELECT pg_catalog.format(
         'ALTER TABLE pg_temp.bob_m2a3_event_shape ADD CONSTRAINT %I %s',
         constraint_catalog.conname,
         pg_catalog.pg_get_constraintdef(constraint_catalog.oid, TRUE)
       )
  FROM pg_catalog.pg_constraint AS constraint_catalog
 WHERE constraint_catalog.conrelid =
       'public.agent_mission_events'::pg_catalog.regclass
   AND constraint_catalog.conname IN (
     'agent_mission_events_data_check',
     'agent_mission_events_data_m2a3_check'
   )
 ORDER BY constraint_catalog.conname
\gexec

CREATE TEMP TABLE bob_m2a3_writer_results (
  ordinal INTEGER PRIMARY KEY,
  shape TEXT NOT NULL,
  outcome TEXT NOT NULL CHECK (outcome IN ('accepted', 'rejected'))
) ON COMMIT DROP;

DO $bob_m2a3_writer_matrix$
DECLARE
  candidate RECORD;
  accepted BOOLEAN;
  expected TEXT;
  state_name TEXT := pg_catalog.current_setting('bob.cert.m2a3_state');
BEGIN
  IF state_name NOT IN ('S0', 'S1', 'S2', 'S3') THEN
    RAISE EXCEPTION 'AGENT_MISSION_M2A3_WRITER_STATE_INVALID';
  END IF;

  FOR candidate IN
    SELECT *
      FROM (
        VALUES
          (
            1,
            'sealed',
            pg_catalog.jsonb_build_object(
              'kind', 'line_cancelled',
              'pendingLineId', 'a0000000-0000-4000-8000-000000000001',
              'expectedWorkRevision', 1,
              'choiceId', 'a0000000-0000-4000-8000-000000000002',
              'choiceSetHash', pg_catalog.repeat('a', 64)
            )
          ),
          (
            2,
            'null_pair',
            pg_catalog.jsonb_build_object(
              'kind', 'line_cancelled',
              'pendingLineId', 'a0000000-0000-4000-8000-000000000001',
              'expectedWorkRevision', 1,
              'choiceId', 'null'::JSONB,
              'choiceSetHash', 'null'::JSONB
            )
          ),
          (
            3,
            'mixed_id_null',
            pg_catalog.jsonb_build_object(
              'kind', 'line_cancelled',
              'pendingLineId', 'a0000000-0000-4000-8000-000000000001',
              'expectedWorkRevision', 1,
              'choiceId', 'a0000000-0000-4000-8000-000000000002',
              'choiceSetHash', 'null'::JSONB
            )
          ),
          (
            4,
            'mixed_null_hash',
            pg_catalog.jsonb_build_object(
              'kind', 'line_cancelled',
              'pendingLineId', 'a0000000-0000-4000-8000-000000000001',
              'expectedWorkRevision', 1,
              'choiceId', 'null'::JSONB,
              'choiceSetHash', pg_catalog.repeat('a', 64)
            )
          )
      ) AS fixtures(ordinal, shape, data)
  LOOP
    accepted := FALSE;
    BEGIN
      INSERT INTO pg_temp.bob_m2a3_event_shape ("eventType", "data")
      VALUES ('line_cancelled', candidate.data);
      accepted := TRUE;
      DELETE FROM pg_temp.bob_m2a3_event_shape;
    EXCEPTION WHEN check_violation THEN
      accepted := FALSE;
    END;

    expected := CASE
      WHEN candidate.shape = 'sealed' THEN 'accepted'
      WHEN candidate.shape = 'null_pair' AND state_name = 'S3' THEN 'accepted'
      ELSE 'rejected'
    END;
    IF (accepted AND expected <> 'accepted')
       OR (NOT accepted AND expected <> 'rejected') THEN
      RAISE EXCEPTION
        'AGENT_MISSION_M2A3_WRITER_MATRIX_DRIFT:%:%:%',
        state_name,
        candidate.shape,
        CASE WHEN accepted THEN 'accepted' ELSE 'rejected' END;
    END IF;
    INSERT INTO pg_temp.bob_m2a3_writer_results (ordinal, shape, outcome)
    VALUES (
      candidate.ordinal,
      candidate.shape,
      CASE WHEN accepted THEN 'accepted' ELSE 'rejected' END
    );
  END LOOP;
END;
$bob_m2a3_writer_matrix$;

SELECT pg_catalog.string_agg(shape || '=' || outcome, '|' ORDER BY ordinal)
  FROM pg_temp.bob_m2a3_writer_results;

ROLLBACK;
