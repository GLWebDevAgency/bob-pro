\set ON_ERROR_STOP on

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';
SELECT pg_catalog.set_config('app.release_runtime_role', :'app_role', true);

-- Le déployeur Supabase n'est pas superuser. Après un transfert d'ownership, toute ACL doit être
-- appliquée sous SET ROLE du propriétaire exact ; un rôle inaccessible fait échouer le train.
DO $agent_mission_grant_inventory$
DECLARE
  inaccessible_objects TEXT;
  runtime_role_name TEXT := current_setting('app.release_runtime_role', true);
BEGIN
  IF runtime_role_name IS NULL OR pg_catalog.to_regrole(runtime_role_name) IS NULL THEN
    RAISE EXCEPTION 'AGENT_MISSION_RUNTIME_ROLE_MISSING:%', runtime_role_name;
  END IF;

  IF (
    SELECT count(*)
      FROM pg_catalog.pg_class AS relation
      JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = relation.relnamespace
     WHERE namespace.nspname = 'public'
       AND relation.relkind IN ('r', 'p')
       AND relation.relname IN (
         'agent_missions',
         'agent_mission_events',
         'agent_mission_quote_line_work',
         'realtime_admission_cancellation_fences',
         'release_flags',
         'release_flag_subjects',
         'release_flag_audit_events',
         'agent_mission_fingerprint_key_version_floors',
         'agent_mission_fingerprint_key_bindings'
       )
  ) <> 9 THEN
    RAISE EXCEPTION 'AGENT_MISSION_RUNTIME_TABLE_INVENTORY_DRIFT';
  END IF;

  IF (
    SELECT count(*)
      FROM pg_catalog.pg_proc AS function
      JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = function.pronamespace
     WHERE namespace.nspname = 'public'
       AND function.proname IN (
         'guard_agent_mission_mutation_v1',
         'guard_quote_draft_agent_mission_v1',
         'guard_agent_mission_quote_line_work_v1',
         'reject_agent_mission_event_mutation_v1',
         'guard_agent_mission_event_append_v1',
         'require_agent_mission_event_v1',
         'guard_realtime_agent_mission_capability_immutable_v1',
         'guard_realtime_agent_mission_bootstrap_receipt_v1',
         'guard_realtime_admission_cancellation_fence_v1',
         'sync_realtime_admission_cancellation_schedule_v1',
         'revalidate_agent_mission_release_flag_v1',
         'guard_agent_mission_fingerprint_key_floor_v1',
         'guard_agent_mission_fingerprint_key_binding_immutable_v1',
         'guard_agent_mission_fingerprint_key_binding_present_v1',
         'agent_mission_fingerprint_key_readiness'
       )
       AND (
         function.pronargs = 0
         OR (
           function.proname = 'revalidate_agent_mission_release_flag_v1'
           AND function.pronargs = 3
         )
         OR (
           function.proname = 'agent_mission_fingerprint_key_readiness'
           AND function.pronargs = 1
         )
       )
  ) <> 15 THEN
    RAISE EXCEPTION 'AGENT_MISSION_RUNTIME_FUNCTION_INVENTORY_DRIFT';
  END IF;

  SELECT pg_catalog.string_agg(object_name, ', ' ORDER BY object_name)
    INTO inaccessible_objects
    FROM (
      SELECT pg_catalog.format('table %I.%I', namespace.nspname, relation.relname) AS object_name,
             relation.relowner AS owner_oid
        FROM pg_catalog.pg_class AS relation
        JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = relation.relnamespace
       WHERE namespace.nspname = 'public'
         AND relation.relname IN (
           'agent_missions',
           'agent_mission_events',
           'agent_mission_quote_line_work',
           'realtime_admission_cancellation_fences',
           'release_flags',
           'release_flag_subjects',
           'release_flag_audit_events',
           'agent_mission_fingerprint_key_version_floors',
           'agent_mission_fingerprint_key_bindings'
         )
         AND relation.relkind IN ('r', 'p')
      UNION ALL
      SELECT pg_catalog.format('function %s', function.oid::pg_catalog.regprocedure),
             function.proowner
        FROM pg_catalog.pg_proc AS function
        JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = function.pronamespace
       WHERE namespace.nspname = 'public'
         AND function.proname IN (
           'guard_agent_mission_mutation_v1',
           'guard_quote_draft_agent_mission_v1',
           'guard_agent_mission_quote_line_work_v1',
           'reject_agent_mission_event_mutation_v1',
           'guard_agent_mission_event_append_v1',
           'require_agent_mission_event_v1',
           'guard_realtime_agent_mission_capability_immutable_v1',
           'guard_realtime_agent_mission_bootstrap_receipt_v1',
           'guard_realtime_admission_cancellation_fence_v1',
           'sync_realtime_admission_cancellation_schedule_v1',
           'revalidate_agent_mission_release_flag_v1',
           'guard_agent_mission_fingerprint_key_floor_v1',
           'guard_agent_mission_fingerprint_key_binding_immutable_v1',
           'guard_agent_mission_fingerprint_key_binding_present_v1',
           'agent_mission_fingerprint_key_readiness'
         )
         AND (
           function.pronargs = 0
           OR (
             function.proname = 'revalidate_agent_mission_release_flag_v1'
             AND function.pronargs = 3
           )
           OR (
             function.proname = 'agent_mission_fingerprint_key_readiness'
             AND function.pronargs = 1
           )
         )
    ) AS object_owner(object_name, owner_oid)
   WHERE owner_oid <> (SELECT oid FROM pg_catalog.pg_roles WHERE rolname = current_user)
     AND NOT pg_catalog.pg_has_role(current_user, owner_oid, 'SET');

  IF inaccessible_objects IS NOT NULL THEN
    RAISE EXCEPTION 'AGENT_MISSION_OWNER_SET_ROLE_REQUIRED:%', inaccessible_objects;
  END IF;
END;
$agent_mission_grant_inventory$;

WITH desired_acl(relation_name, granted_privileges, revoked_privileges) AS (
  VALUES
    (
      'agent_missions'::TEXT,
      'SELECT, INSERT, UPDATE'::TEXT,
      'DELETE, TRUNCATE, REFERENCES, TRIGGER'::TEXT
    ),
    (
      'agent_mission_events'::TEXT,
      'SELECT, INSERT'::TEXT,
      'UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER'::TEXT
    ),
    (
      'agent_mission_quote_line_work'::TEXT,
      'SELECT, INSERT, UPDATE, DELETE'::TEXT,
      'TRUNCATE, REFERENCES, TRIGGER'::TEXT
    ),
    (
      'realtime_admission_cancellation_fences'::TEXT,
      'SELECT, INSERT, DELETE'::TEXT,
      'UPDATE, TRUNCATE, REFERENCES, TRIGGER'::TEXT
    ),
    (
      'release_flags'::TEXT,
      'SELECT'::TEXT,
      'INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER'::TEXT
    ),
    (
      'release_flag_subjects'::TEXT,
      'SELECT'::TEXT,
      'INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER'::TEXT
    )
)
SELECT pg_catalog.format(
  'SET ROLE %I; REVOKE ALL PRIVILEGES ON TABLE public.%I FROM %I; GRANT %s ON TABLE public.%I TO %I; REVOKE %s ON TABLE public.%I FROM %I; RESET ROLE;',
  owner.rolname,
  desired_acl.relation_name,
  :'app_role',
  desired_acl.granted_privileges,
  desired_acl.relation_name,
  :'app_role',
  desired_acl.revoked_privileges,
  desired_acl.relation_name,
  :'app_role'
)
  FROM desired_acl
  JOIN pg_catalog.pg_class AS relation ON relation.relname = desired_acl.relation_name
  JOIN pg_catalog.pg_namespace AS namespace
    ON namespace.oid = relation.relnamespace
   AND namespace.nspname = 'public'
  JOIN pg_catalog.pg_roles AS owner ON owner.oid = relation.relowner
 ORDER BY desired_acl.relation_name
\gexec

-- REVOKE table-level ne retire pas un ancien GRANT de colonne. On nettoie donc chaque attribut
-- sous le même propriétaire avant de certifier les privilèges effectifs (y compris hérités).
SELECT pg_catalog.format(
  'SET ROLE %I; REVOKE SELECT (%I), INSERT (%I), UPDATE (%I), REFERENCES (%I) ON TABLE public.%I FROM %I; RESET ROLE;',
  owner.rolname,
  attribute.attname,
  attribute.attname,
  attribute.attname,
  attribute.attname,
  relation.relname,
  :'app_role'
)
  FROM pg_catalog.pg_class AS relation
  JOIN pg_catalog.pg_namespace AS namespace
    ON namespace.oid = relation.relnamespace
   AND namespace.nspname = 'public'
  JOIN pg_catalog.pg_roles AS owner ON owner.oid = relation.relowner
  JOIN pg_catalog.pg_attribute AS attribute
    ON attribute.attrelid = relation.oid
   AND attribute.attnum > 0
   AND NOT attribute.attisdropped
 WHERE relation.relname IN (
   'agent_missions',
   'agent_mission_events',
   'agent_mission_quote_line_work',
   'realtime_admission_cancellation_fences',
   'release_flags',
   'release_flag_subjects',
   'release_flag_audit_events',
   'agent_mission_fingerprint_key_version_floors',
   'agent_mission_fingerprint_key_bindings'
 )
 ORDER BY relation.relname, attribute.attnum
\gexec

SELECT pg_catalog.format(
  'SET ROLE %I; REVOKE ALL PRIVILEGES ON TABLE public.%I FROM %I; RESET ROLE;',
  owner.rolname,
  relation.relname,
  :'app_role'
)
  FROM pg_catalog.pg_class AS relation
  JOIN pg_catalog.pg_namespace AS namespace
    ON namespace.oid = relation.relnamespace
   AND namespace.nspname = 'public'
  JOIN pg_catalog.pg_roles AS owner ON owner.oid = relation.relowner
 WHERE relation.relname IN (
   'release_flag_audit_events',
   'agent_mission_fingerprint_key_version_floors',
   'agent_mission_fingerprint_key_bindings'
 )
   AND relation.relkind IN ('r', 'p')
\gexec

SELECT pg_catalog.format(
  'SET ROLE %I; REVOKE ALL PRIVILEGES ON FUNCTION %s FROM %I; RESET ROLE;',
  owner.rolname,
  function.oid::pg_catalog.regprocedure,
  :'app_role'
)
  FROM pg_catalog.pg_proc AS function
  JOIN pg_catalog.pg_namespace AS namespace
    ON namespace.oid = function.pronamespace
   AND namespace.nspname = 'public'
  JOIN pg_catalog.pg_roles AS owner ON owner.oid = function.proowner
 WHERE function.proname IN (
   'guard_agent_mission_mutation_v1',
   'guard_quote_draft_agent_mission_v1',
   'guard_agent_mission_quote_line_work_v1',
   'reject_agent_mission_event_mutation_v1',
   'guard_agent_mission_event_append_v1',
   'require_agent_mission_event_v1',
   'guard_realtime_agent_mission_capability_immutable_v1',
   'guard_realtime_agent_mission_bootstrap_receipt_v1',
   'guard_realtime_admission_cancellation_fence_v1',
   'sync_realtime_admission_cancellation_schedule_v1',
   'revalidate_agent_mission_release_flag_v1',
   'guard_agent_mission_fingerprint_key_floor_v1',
   'guard_agent_mission_fingerprint_key_binding_immutable_v1',
   'guard_agent_mission_fingerprint_key_binding_present_v1',
   'agent_mission_fingerprint_key_readiness'
 )
   AND (
     function.pronargs = 0
     OR (
       function.proname = 'revalidate_agent_mission_release_flag_v1'
       AND function.pronargs = 3
     )
     OR (
       function.proname = 'agent_mission_fingerprint_key_readiness'
       AND function.pronargs = 1
     )
   )
 ORDER BY function.proname
\gexec

SELECT pg_catalog.format(
  'SET ROLE %I; GRANT EXECUTE ON FUNCTION %s TO %I; RESET ROLE;',
  owner.rolname,
  function.oid::pg_catalog.regprocedure,
  :'app_role'
)
  FROM pg_catalog.pg_proc AS function
  JOIN pg_catalog.pg_namespace AS namespace
    ON namespace.oid = function.pronamespace
   AND namespace.nspname = 'public'
  JOIN pg_catalog.pg_roles AS owner ON owner.oid = function.proowner
 WHERE (
   function.proname = 'revalidate_agent_mission_release_flag_v1'
   AND function.pronargs = 3
 ) OR (
   function.proname = 'agent_mission_fingerprint_key_readiness'
   AND function.pronargs = 1
 )
\gexec
