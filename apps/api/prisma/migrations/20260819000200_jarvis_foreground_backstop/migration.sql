-- Jarvis U1-c — backstop de premier plan élargi (SPEC_U1C §4, greffe du panel).
--
-- L'index partiel K2 (20260729110000, WHERE status = 'active') laisse coexister un
-- run Jarvis `waiting_user` et un devis actif : il est élargi aux statuts NON
-- LIBÉRANTS de §5.1 — un run qui attend l'utilisateur ou l'écran, ou dont le retry
-- est dû, TIENT le premier plan. Les libérants (`waiting_external`, `parked`,
-- `cancelling`), les terminaux et `quarantined` (§5.5 : gelé, il ne doit jamais
-- bloquer le premier plan de son owner) restent hors backstop.
--
-- DROP + CREATE dans UNE transaction : aucune fenêtre sans backstop. Writer N-1 :
-- il n'écrit que active/cancelled/expired — sur son sous-ensemble le prédicat
-- élargi est identique à l'ancien (les preuves writer N-1 de la certification
-- rejouent VERT après cette migration). Aucune ligne historique ne porte un statut
-- §5.1 (CHECK U1-a posé avant tout writer jarvis) : la construction ne peut pas
-- échouer sur l'existant. Violation à l'admission = refus typé foreground_busy
-- (mapping existant), jamais une erreur brute.

BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

-- Même élévation contrôlée que l'expand (contrat Supabase non-superuser).
DO $bob_jarvis_u1c_backstop_owner$
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
        MESSAGE = 'JARVIS_U1C_BACKSTOP_SCHEMA_OWNER_UNAVAILABLE';
    END IF;
    EXECUTE pg_catalog.format('SET LOCAL ROLE %I', schema_owner_name);
  END IF;

  IF current_user::pg_catalog.regrole <> schema_owner_oid THEN
    RAISE EXCEPTION USING
      ERRCODE = '42501',
      MESSAGE = 'JARVIS_U1C_BACKSTOP_SCHEMA_OWNER_NOT_ASSUMED';
  END IF;
END;
$bob_jarvis_u1c_backstop_owner$;

DROP INDEX public.agent_missions_one_active_owner_key;

CREATE UNIQUE INDEX agent_missions_one_active_owner_key
  ON public.agent_missions ("companyId", "ownerUserId")
  WHERE "status" IN (
    -- BEGIN GENERATED JARVIS_FOREGROUND_HOLDING_STATUSES (§5.1 : non-libérants, hors terminaux et quarantined)
    'active',
    'waiting_user',
    'waiting_screen',
    'retry_due'
    -- END GENERATED JARVIS_FOREGROUND_HOLDING_STATUSES
  );

COMMIT;
