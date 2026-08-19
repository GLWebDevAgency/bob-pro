-- Jarvis U1-d — le CHECK de trace admet le kind customer_contact@1.
--
-- POURQUOI UNE MIGRATION NEUVE : la liste vit dans un bloc GENERATED de la migration
-- 20260801050000 (regeneree par scripts/generate-realtime-voice-trace-migration-values.mjs
-- pour satisfaire le gate anti-derive), mais une migration DEJA APPLIQUEE n'est jamais
-- rejouee : sans ce fichier, staging et production garderaient l'ancienne contrainte et
-- REJETTERAIENT toute trace vocale du nouveau vertical. La regeneration synchronise la
-- source ; c'est ICI que les bases existantes recoivent le changement.

BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

DO $bob_jarvis_trace_kind_owner$
DECLARE
  schema_owner_oid OID;
  schema_owner_name TEXT;
BEGIN
  -- Schema partiel (certains harnais de certification ne montent pas les traces) :
  -- l'absence de la table n'est pas une erreur, la migration devient un no-op.
  SELECT relation.relowner, pg_catalog.pg_get_userbyid(relation.relowner)
    INTO schema_owner_oid, schema_owner_name
    FROM pg_catalog.pg_class AS relation
    JOIN pg_catalog.pg_namespace AS namespace
      ON namespace.oid = relation.relnamespace
   WHERE namespace.nspname = 'public'
     AND relation.relname = 'realtime_voice_traces'
     AND relation.relkind IN ('r', 'p');

  IF schema_owner_oid IS NULL THEN
    RETURN;
  END IF;

  IF current_user::pg_catalog.regrole <> schema_owner_oid THEN
    IF schema_owner_name IS NULL
       OR NOT pg_catalog.pg_has_role(session_user, schema_owner_oid, 'SET') THEN
      RAISE EXCEPTION USING
        ERRCODE = '42501',
        MESSAGE = 'JARVIS_TRACE_KIND_SCHEMA_OWNER_UNAVAILABLE';
    END IF;
    EXECUTE pg_catalog.format('SET LOCAL ROLE %I', schema_owner_name);
  END IF;

  IF current_user::pg_catalog.regrole <> schema_owner_oid THEN
    RAISE EXCEPTION USING
      ERRCODE = '42501',
      MESSAGE = 'JARVIS_TRACE_KIND_SCHEMA_OWNER_NOT_ASSUMED';
  END IF;
END;
$bob_jarvis_trace_kind_owner$;

-- Le predicat historique est preserve a l'identique ; SEULE la liste des kinds change.
-- Reconstruction ciblee : on retire l'ancienne contrainte de forme du planner et on la
-- repose avec la liste complete (source unique : MISSION_KIND_IDS de @bob/core).
DO $bob_jarvis_trace_kind_swap$
DECLARE
  definition TEXT;
BEGIN
  SELECT pg_catalog.pg_get_constraintdef(constraint_row.oid)
    INTO definition
    FROM pg_catalog.pg_constraint AS constraint_row
    JOIN pg_catalog.pg_class AS relation ON relation.oid = constraint_row.conrelid
    JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = relation.relnamespace
   WHERE namespace.nspname = 'public'
     AND relation.relname = 'realtime_voice_traces'
     AND constraint_row.conname = 'realtime_voice_trace_planner_shape_check';

  -- Contrainte absente : rien a etendre (schema partiel), jamais une erreur.
  IF definition IS NULL THEN
    RETURN;
  END IF;

  -- Idempotence : si la liste porte deja le kind, la migration ne fait rien.
  IF position('customer_contact@1' IN definition) > 0 THEN
    RETURN;
  END IF;

  -- PostgreSQL normalise un IN a un seul element en EGALITE SIMPLE : la definition lue
  -- porte donc « = 'quote_creation@1'::text » et non une liste. On remplace cette egalite
  -- par un = ANY(ARRAY[...]) qui admet les deux kinds — jamais une substitution naive qui
  -- produirait un record (bug reproduit en local avant tout push).
  IF position('''quote_creation@1''' IN definition) = 0 THEN
    RAISE EXCEPTION USING
      ERRCODE = '42804',
      MESSAGE = 'JARVIS_TRACE_KIND_ANCHOR_MISSING';
  END IF;

  definition := replace(
    definition,
    '= ''quote_creation@1''::text',
    '= ANY (ARRAY[''quote_creation@1''::text, ''customer_contact@1''::text])'
  );
  definition := replace(
    definition,
    'IN (''quote_creation@1''::text)',
    'IN (''quote_creation@1''::text, ''customer_contact@1''::text)'
  );

  IF position('customer_contact@1' IN definition) = 0 THEN
    RAISE EXCEPTION USING
      ERRCODE = '42804',
      MESSAGE = 'JARVIS_TRACE_KIND_REWRITE_FAILED';
  END IF;

  EXECUTE 'ALTER TABLE public.realtime_voice_traces DROP CONSTRAINT realtime_voice_trace_planner_shape_check';
  EXECUTE pg_catalog.format(
    'ALTER TABLE public.realtime_voice_traces ADD CONSTRAINT realtime_voice_trace_planner_shape_check %s',
    definition
  );
END;
$bob_jarvis_trace_kind_swap$;

COMMIT;
