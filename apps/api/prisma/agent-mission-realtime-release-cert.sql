\set ON_ERROR_STOP on

BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';
SELECT pg_catalog.set_config('search_path', 'pg_temp, public, pg_catalog', true);
SELECT pg_catalog.set_config(
  'app.agent_mission_cert_release_environment',
  :'release_env',
  true
);
SELECT pg_catalog.set_config(
  'app.agent_mission_cert_release_flag_version',
  :'release_flag_version',
  true
);
SELECT pg_catalog.set_config(
  'app.agent_mission_cert_release_flag_kill_switch',
  :'release_flag_kill_switch',
  true
);

SELECT current_user = :'app_role' AS agent_mission_realtime_runtime_role_matches
\gset
\if :agent_mission_realtime_runtime_role_matches
\else
  \quit 1
\endif

DO $agent_mission_realtime_release_certificate$
DECLARE
  runtime_role pg_catalog.pg_roles%ROWTYPE;
  authority pg_catalog.pg_roles%ROWTYPE;
  lease_relation pg_catalog.pg_class%ROWTYPE;
  cancellation_relation pg_catalog.pg_class%ROWTYPE;
  helper pg_catalog.pg_proc%ROWTYPE;
  capability_guard pg_catalog.pg_proc%ROWTYPE;
  cancellation_guard pg_catalog.pg_proc%ROWTYPE;
  cancellation_schedule_sync pg_catalog.pg_proc%ROWTYPE;
  capability_trigger pg_catalog.pg_trigger%ROWTYPE;
  cancellation_guard_trigger pg_catalog.pg_trigger%ROWTYPE;
  cancellation_schedule_trigger pg_catalog.pg_trigger%ROWTYPE;
  capability_attribute pg_catalog.pg_attribute%ROWTYPE;
  cancellation_attribute pg_catalog.pg_attribute%ROWTYPE;
  capability_constraint pg_catalog.pg_constraint%ROWTYPE;
  cancellation_constraint pg_catalog.pg_constraint%ROWTYPE;
  exposed_role TEXT;
  expected_attribute RECORD;
  lease_column TEXT;
  release_column TEXT;
  forbidden_privilege TEXT;
  release_relation TEXT;
  expected_release_environment TEXT :=
    pg_catalog.current_setting('app.agent_mission_cert_release_environment');
  expected_release_flag_version INTEGER :=
    pg_catalog.current_setting('app.agent_mission_cert_release_flag_version')::INTEGER;
  expected_release_flag_kill_switch BOOLEAN :=
    pg_catalog.current_setting('app.agent_mission_cert_release_flag_kill_switch')::BOOLEAN;
  wrong_lower_release_flag_version INTEGER;
  wrong_upper_release_flag_version INTEGER;
  exact_release_flag_revalidation BOOLEAN;
  required_privilege TEXT;
  expected_trigger_attributes SMALLINT[];
  actual_trigger_attributes SMALLINT[];
  constraint_definition TEXT;
BEGIN
  IF expected_release_environment NOT IN ('development', 'staging', 'production')
     OR expected_release_flag_version < 1 THEN
    RAISE EXCEPTION 'AgentMission release flag certificate input is invalid';
  END IF;
  wrong_lower_release_flag_version :=
    CASE
      WHEN expected_release_flag_version > 1
        THEN expected_release_flag_version - 1
      ELSE 0
    END;
  wrong_upper_release_flag_version :=
    CASE
      WHEN expected_release_flag_version < 2147483647
        THEN expected_release_flag_version + 1
      ELSE 0
    END;

  SELECT *
    INTO STRICT runtime_role
    FROM pg_catalog.pg_roles
   WHERE rolname = current_user;
  IF runtime_role.rolsuper OR runtime_role.rolbypassrls THEN
    RAISE EXCEPTION 'AgentMission realtime certificate requires a non-superuser runtime role';
  END IF;

  SELECT relation.*
    INTO STRICT lease_relation
    FROM pg_catalog.pg_class AS relation
    JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = relation.relnamespace
   WHERE namespace.nspname = 'public'
     AND relation.relname = 'realtime_session_leases'
     AND relation.relkind IN ('r', 'p');
  IF NOT lease_relation.relrowsecurity OR NOT lease_relation.relforcerowsecurity THEN
    RAISE EXCEPTION 'AgentMission realtime lease must keep ENABLE + FORCE RLS';
  END IF;

  SELECT relation.*
    INTO STRICT cancellation_relation
    FROM pg_catalog.pg_class AS relation
    JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = relation.relnamespace
   WHERE namespace.nspname = 'public'
     AND relation.relname = 'realtime_admission_cancellation_fences'
     AND relation.relkind IN ('r', 'p');
  IF NOT cancellation_relation.relrowsecurity
     OR NOT cancellation_relation.relforcerowsecurity THEN
    RAISE EXCEPTION 'Realtime cancellation fence must keep ENABLE + FORCE RLS';
  END IF;
  IF (
    SELECT pg_catalog.count(*)
      FROM pg_catalog.pg_policy AS policy
     WHERE policy.polrelid = cancellation_relation.oid
  ) <> 1 OR NOT EXISTS (
    SELECT 1
      FROM pg_catalog.pg_policy AS policy
     WHERE policy.polrelid = cancellation_relation.oid
       AND policy.polname = 'tenant_isolation'
       AND policy.polcmd = '*'
       AND policy.polpermissive
       AND policy.polroles = ARRAY[0]::OID[]
       AND pg_catalog.pg_get_expr(policy.polqual, policy.polrelid) =
         '("companyId" = current_setting(''app.current_company_id''::text, true))'
       AND pg_catalog.pg_get_expr(policy.polwithcheck, policy.polrelid) =
         '("companyId" = current_setting(''app.current_company_id''::text, true))'
  ) THEN
    RAISE EXCEPTION 'Realtime cancellation fence RLS policy drift';
  END IF;
  IF (
    SELECT pg_catalog.count(*)
      FROM pg_catalog.pg_attribute AS attribute
     WHERE attribute.attrelid = cancellation_relation.oid
       AND attribute.attnum > 0
       AND NOT attribute.attisdropped
  ) <> 5 THEN
    RAISE EXCEPTION 'Realtime cancellation fence column set drift';
  END IF;
  FOR expected_attribute IN
    SELECT *
      FROM (
        VALUES
          ('companyId'::TEXT, 'text'::pg_catalog.regtype::OID, -1),
          ('sessionId'::TEXT, 'uuid'::pg_catalog.regtype::OID, -1),
          ('subjectHash'::TEXT, 'character'::pg_catalog.regtype::OID, 68),
          (
            'cancelledAt'::TEXT,
            'timestamp with time zone'::pg_catalog.regtype::OID,
            6
          ),
          (
            'expiresAt'::TEXT,
            'timestamp with time zone'::pg_catalog.regtype::OID,
            6
          )
      ) AS expected(column_name, type_oid, type_modifier)
  LOOP
    SELECT *
      INTO STRICT cancellation_attribute
      FROM pg_catalog.pg_attribute AS attribute
     WHERE attribute.attrelid = cancellation_relation.oid
       AND attribute.attname = expected_attribute.column_name
       AND attribute.attnum > 0
       AND NOT attribute.attisdropped;
    IF cancellation_attribute.atttypid <> expected_attribute.type_oid
       OR cancellation_attribute.atttypmod <> expected_attribute.type_modifier
       OR NOT cancellation_attribute.attnotnull
       OR cancellation_attribute.atthasdef
       OR cancellation_attribute.attidentity <> ''
       OR cancellation_attribute.attgenerated <> '' THEN
      RAISE EXCEPTION
        'Realtime cancellation fence column definition drift: %',
        expected_attribute.column_name;
    END IF;
  END LOOP;

  SELECT *
    INTO STRICT cancellation_constraint
    FROM pg_catalog.pg_constraint AS constraint_row
   WHERE constraint_row.conrelid = cancellation_relation.oid
     AND constraint_row.conname =
       'realtime_admission_cancellation_fences_shape_check';
  constraint_definition :=
    pg_catalog.pg_get_constraintdef(cancellation_constraint.oid, TRUE);
  IF cancellation_constraint.contype <> 'c'
     OR NOT cancellation_constraint.convalidated
     OR constraint_definition <>
       'CHECK ("subjectHash" ~ ''^[a-f0-9]{64}$''::text AND isfinite("cancelledAt") AND isfinite("expiresAt") AND "expiresAt" = ("cancelledAt" + ''02:00:00''::interval))' THEN
    RAISE EXCEPTION
      'Realtime cancellation fence shape constraint drift: %',
      constraint_definition;
  END IF;

  SELECT *
    INTO STRICT cancellation_constraint
    FROM pg_catalog.pg_constraint AS constraint_row
   WHERE constraint_row.conrelid = cancellation_relation.oid
     AND constraint_row.conname =
       'realtime_admission_cancellation_fences_company_fkey';
  IF cancellation_constraint.contype <> 'f'
     OR NOT cancellation_constraint.convalidated
     OR cancellation_constraint.confrelid <> 'public.companies'::pg_catalog.regclass
     OR cancellation_constraint.conkey <> ARRAY[1]::SMALLINT[]
     OR cancellation_constraint.confkey <> ARRAY[1]::SMALLINT[]
     OR cancellation_constraint.confupdtype <> 'c'
     OR cancellation_constraint.confdeltype <> 'c'
     OR cancellation_constraint.confmatchtype <> 's'
     OR cancellation_constraint.condeferrable
     OR cancellation_constraint.condeferred THEN
    RAISE EXCEPTION 'Realtime cancellation fence company FK drift';
  END IF;

  SELECT *
    INTO STRICT cancellation_constraint
    FROM pg_catalog.pg_constraint AS constraint_row
   WHERE constraint_row.conrelid = cancellation_relation.oid
     AND constraint_row.conname =
       'realtime_admission_cancellation_fence_pkey';
  IF cancellation_constraint.contype <> 'p'
     OR NOT cancellation_constraint.convalidated
     OR cancellation_constraint.conkey <> ARRAY[1, 2, 3]::SMALLINT[]
     OR cancellation_constraint.condeferrable
     OR cancellation_constraint.condeferred
     OR pg_catalog.pg_get_constraintdef(cancellation_constraint.oid, TRUE) <>
       'PRIMARY KEY ("companyId", "sessionId", "subjectHash")' THEN
    RAISE EXCEPTION 'Realtime cancellation fence primary key drift';
  END IF;
  IF (
    SELECT pg_catalog.count(*)
      FROM pg_catalog.pg_constraint AS constraint_row
     WHERE constraint_row.conrelid = cancellation_relation.oid
  ) <> 3 THEN
    RAISE EXCEPTION 'Realtime cancellation fence constraint inventory drift';
  END IF;

  IF NOT EXISTS (
    SELECT 1
      FROM pg_catalog.pg_index AS index_row
      JOIN pg_catalog.pg_class AS index_relation
        ON index_relation.oid = index_row.indexrelid
     WHERE index_row.indrelid = cancellation_relation.oid
       AND index_relation.relname =
         'realtime_admission_cancellation_fences_tenant_expiry_idx'
       AND index_row.indisvalid
       AND index_row.indisready
       AND NOT index_row.indisunique
       AND index_row.indislive
       AND NOT index_row.indcheckxmin
       AND index_row.indnkeyatts = 4
       AND index_row.indnatts = 4
       AND index_row.indkey = '1 5 2 3'::pg_catalog.int2vector
       AND index_row.indpred IS NULL
       AND index_row.indexprs IS NULL
  ) THEN
    RAISE EXCEPTION 'Realtime cancellation fence expiry index drift';
  END IF;
  IF (
    SELECT pg_catalog.count(*)
      FROM pg_catalog.pg_index AS index_row
     WHERE index_row.indrelid = cancellation_relation.oid
  ) <> 2 THEN
    RAISE EXCEPTION 'Realtime cancellation fence index inventory drift';
  END IF;

  FOR expected_attribute IN
    SELECT *
      FROM (
        VALUES
          ('agentMissionProtocolVersion'::TEXT, 'integer'::pg_catalog.regtype::OID, -1),
          (
            'agentMissionProtocolBoundAt'::TEXT,
            'timestamp with time zone'::pg_catalog.regtype::OID,
            6
          ),
          ('agentMissionCapabilityHash'::TEXT, 'character'::pg_catalog.regtype::OID, 68),
          ('agentMissionReleaseFlagVersion'::TEXT, 'integer'::pg_catalog.regtype::OID, -1)
      ) AS expected(column_name, type_oid, type_modifier)
  LOOP
    SELECT *
      INTO STRICT capability_attribute
      FROM pg_catalog.pg_attribute AS attribute
     WHERE attribute.attrelid = lease_relation.oid
       AND attribute.attname = expected_attribute.column_name
       AND attribute.attnum > 0
       AND NOT attribute.attisdropped;
    IF capability_attribute.atttypid <> expected_attribute.type_oid
       OR capability_attribute.atttypmod <> expected_attribute.type_modifier
       OR capability_attribute.attnotnull
       OR capability_attribute.atthasdef
       OR capability_attribute.attidentity <> ''
       OR capability_attribute.attgenerated <> '' THEN
      RAISE EXCEPTION
        'AgentMission realtime lease column definition drift: %',
        expected_attribute.column_name;
    END IF;
  END LOOP;

  SELECT *
    INTO STRICT capability_constraint
    FROM pg_catalog.pg_constraint AS constraint_row
   WHERE constraint_row.conrelid = lease_relation.oid
     AND constraint_row.conname =
       'realtime_session_leases_agent_mission_capability_shape_check';
  IF capability_constraint.contype <> 'c'
     OR NOT capability_constraint.convalidated
     OR pg_catalog.pg_get_constraintdef(capability_constraint.oid, TRUE) <>
       'CHECK ((("agentMissionProtocolVersion" IS NULL) = ("agentMissionProtocolBoundAt" IS NULL) AND ("agentMissionProtocolVersion" IS NULL) = ("agentMissionCapabilityHash" IS NULL) AND ("agentMissionProtocolVersion" IS NULL) = ("agentMissionReleaseFlagVersion" IS NULL) AND ("agentMissionProtocolVersion" IS NULL OR "agentMissionProtocolVersion" = 1 AND isfinite("agentMissionProtocolBoundAt") AND "agentMissionProtocolBoundAt" = "reservedAt" AND "agentMissionCapabilityHash" ~ ''^[a-f0-9]{64}$''::text AND "agentMissionReleaseFlagVersion" >= 1 AND "agentMissionReleaseFlagVersion" <= 2147483647)) IS TRUE)' THEN
    RAISE EXCEPTION 'AgentMission realtime lease constraint definition drift';
  END IF;

  SELECT *
    INTO STRICT capability_guard
    FROM pg_catalog.pg_proc AS function
   WHERE function.oid =
     'public.guard_realtime_agent_mission_capability_immutable_v1()'::pg_catalog.regprocedure;
  IF capability_guard.prorettype <> 'pg_catalog.trigger'::pg_catalog.regtype
     OR capability_guard.prosecdef
     OR capability_guard.proconfig IS NULL
     OR NOT capability_guard.proconfig @> ARRAY[
       'search_path=pg_catalog, public'
     ]::TEXT[] THEN
    RAISE EXCEPTION 'AgentMission realtime capability immutability function drift';
  END IF;
  IF pg_catalog.has_function_privilege(current_user, capability_guard.oid, 'EXECUTE')
     OR EXISTS (
       SELECT 1
         FROM pg_catalog.aclexplode(
           COALESCE(
             capability_guard.proacl,
             pg_catalog.acldefault('f', capability_guard.proowner)
           )
         ) AS privilege
        WHERE privilege.grantee = 0
          AND privilege.privilege_type = 'EXECUTE'
     ) THEN
    RAISE EXCEPTION 'AgentMission realtime capability guard is directly executable';
  END IF;

  SELECT *
    INTO STRICT capability_trigger
    FROM pg_catalog.pg_trigger AS trigger_row
   WHERE trigger_row.tgrelid = lease_relation.oid
     AND trigger_row.tgname =
       'realtime_session_lease_agent_mission_capability_immutable_v1';
  SELECT pg_catalog.array_agg(attribute.attnum::SMALLINT ORDER BY attribute.attnum)
    INTO STRICT expected_trigger_attributes
    FROM pg_catalog.pg_attribute AS attribute
   WHERE attribute.attrelid = lease_relation.oid
     AND attribute.attname IN (
       'agentMissionProtocolVersion',
       'agentMissionProtocolBoundAt',
       'agentMissionCapabilityHash',
       'agentMissionReleaseFlagVersion'
     )
     AND attribute.attnum > 0
     AND NOT attribute.attisdropped;
  SELECT pg_catalog.array_agg(trigger_attribute.attribute_number ORDER BY
    trigger_attribute.attribute_number)
    INTO STRICT actual_trigger_attributes
    FROM pg_catalog.unnest(
      capability_trigger.tgattr::SMALLINT[]
    ) AS trigger_attribute(attribute_number);
  IF capability_trigger.tgfoid <> capability_guard.oid
     OR capability_trigger.tgtype <> 19
     OR capability_trigger.tgenabled <> 'O'
     OR capability_trigger.tgisinternal
     OR capability_trigger.tgconstraint <> 0
     OR expected_trigger_attributes IS DISTINCT FROM actual_trigger_attributes THEN
    RAISE EXCEPTION 'AgentMission realtime capability immutability trigger drift';
  END IF;

  SELECT *
    INTO STRICT cancellation_guard
    FROM pg_catalog.pg_proc AS function
   WHERE function.oid =
     'public.guard_realtime_admission_cancellation_fence_v1()'::pg_catalog.regprocedure;
  IF cancellation_guard.prorettype <> 'pg_catalog.trigger'::pg_catalog.regtype
     OR cancellation_guard.proowner <> cancellation_relation.relowner
     OR cancellation_guard.prosecdef
     OR cancellation_guard.proconfig IS DISTINCT FROM ARRAY[
       'search_path=pg_catalog',
       'row_security=on'
     ]::TEXT[]
     OR cancellation_guard.provolatile <> 'v'
     OR cancellation_guard.proparallel <> 'u'
     OR cancellation_guard.prokind <> 'f'
     OR cancellation_guard.proleakproof
     OR cancellation_guard.proisstrict
     OR cancellation_guard.pronargs <> 0
     OR cancellation_guard.pronargdefaults <> 0
     OR cancellation_guard.prolang <> (
       SELECT language.oid
         FROM pg_catalog.pg_language AS language
        WHERE language.lanname = 'plpgsql'
     )
     OR pg_catalog.md5(cancellation_guard.prosrc) <>
       'b1677a749a2d8bc31749bce45e2f99ac'
     OR EXISTS (
       SELECT 1
         FROM pg_catalog.aclexplode(
           COALESCE(
             cancellation_guard.proacl,
             pg_catalog.acldefault('f', cancellation_guard.proowner)
           )
         ) AS privilege
        WHERE privilege.grantee = 0
          AND privilege.privilege_type = 'EXECUTE'
     ) THEN
    RAISE EXCEPTION 'Realtime cancellation fence guard function drift';
  END IF;

  SELECT *
    INTO STRICT cancellation_schedule_sync
    FROM pg_catalog.pg_proc AS function
   WHERE function.oid =
     'public.sync_realtime_admission_cancellation_schedule_v1()'::pg_catalog.regprocedure;
  IF cancellation_schedule_sync.prorettype <> 'pg_catalog.trigger'::pg_catalog.regtype
     OR cancellation_schedule_sync.proowner <> cancellation_relation.relowner
     OR cancellation_schedule_sync.prosecdef
     OR cancellation_schedule_sync.proconfig IS DISTINCT FROM ARRAY[
       'search_path=pg_catalog',
       'row_security=on',
       'statement_timeout=4s',
       'lock_timeout=1s'
     ]::TEXT[]
     OR cancellation_schedule_sync.provolatile <> 'v'
     OR cancellation_schedule_sync.proparallel <> 'u'
     OR cancellation_schedule_sync.prokind <> 'f'
     OR cancellation_schedule_sync.proleakproof
     OR cancellation_schedule_sync.proisstrict
     OR cancellation_schedule_sync.pronargs <> 0
     OR cancellation_schedule_sync.pronargdefaults <> 0
     OR cancellation_schedule_sync.prolang <> (
       SELECT language.oid
         FROM pg_catalog.pg_language AS language
        WHERE language.lanname = 'plpgsql'
     )
     OR pg_catalog.md5(cancellation_schedule_sync.prosrc) <>
       '093d07ea90ee410669f5c5aab1fc131a'
     OR EXISTS (
       SELECT 1
         FROM pg_catalog.aclexplode(
           COALESCE(
             cancellation_schedule_sync.proacl,
             pg_catalog.acldefault('f', cancellation_schedule_sync.proowner)
           )
         ) AS privilege
        WHERE privilege.grantee = 0
          AND privilege.privilege_type = 'EXECUTE'
     ) THEN
    RAISE EXCEPTION 'Realtime cancellation schedule function drift';
  END IF;

  SELECT *
    INTO STRICT cancellation_guard_trigger
    FROM pg_catalog.pg_trigger AS trigger_row
   WHERE trigger_row.tgrelid = lease_relation.oid
     AND trigger_row.tgname =
       'realtime_session_lease_00_admission_cancellation_fence_guard';
  IF cancellation_guard_trigger.tgfoid <> cancellation_guard.oid
     OR cancellation_guard_trigger.tgtype <> 7
     OR cancellation_guard_trigger.tgenabled <> 'O'
     OR cancellation_guard_trigger.tgisinternal
     OR cancellation_guard_trigger.tgconstraint <> 0
     OR cancellation_guard_trigger.tgconstrrelid <> 0
     OR cancellation_guard_trigger.tgconstrindid <> 0
     OR cancellation_guard_trigger.tgdeferrable
     OR cancellation_guard_trigger.tginitdeferred
     OR cancellation_guard_trigger.tgparentid <> 0
     OR cancellation_guard_trigger.tgnargs <> 0
     OR pg_catalog.octet_length(cancellation_guard_trigger.tgargs) <> 0
     OR cancellation_guard_trigger.tgqual IS NOT NULL
     OR cancellation_guard_trigger.tgattr <> ''::pg_catalog.int2vector THEN
    RAISE EXCEPTION 'Realtime cancellation fence guard trigger drift';
  END IF;

  SELECT *
    INTO STRICT cancellation_schedule_trigger
    FROM pg_catalog.pg_trigger AS trigger_row
   WHERE trigger_row.tgrelid = cancellation_relation.oid
     AND trigger_row.tgname =
       'realtime_admission_cancellation_reaper_schedule_insert';
  IF cancellation_schedule_trigger.tgfoid <> cancellation_schedule_sync.oid
     OR cancellation_schedule_trigger.tgtype <> 4
     OR cancellation_schedule_trigger.tgenabled <> 'O'
     OR cancellation_schedule_trigger.tgisinternal
     OR cancellation_schedule_trigger.tgconstraint <> 0
     OR cancellation_schedule_trigger.tgoldtable IS NOT NULL
     OR cancellation_schedule_trigger.tgnewtable <> 'new_rows'
     OR cancellation_schedule_trigger.tgconstrrelid <> 0
     OR cancellation_schedule_trigger.tgconstrindid <> 0
     OR cancellation_schedule_trigger.tgdeferrable
     OR cancellation_schedule_trigger.tginitdeferred
     OR cancellation_schedule_trigger.tgparentid <> 0
     OR cancellation_schedule_trigger.tgnargs <> 0
     OR pg_catalog.octet_length(cancellation_schedule_trigger.tgargs) <> 0
     OR cancellation_schedule_trigger.tgqual IS NOT NULL
     OR cancellation_schedule_trigger.tgattr <> ''::pg_catalog.int2vector THEN
    RAISE EXCEPTION 'Realtime cancellation schedule trigger drift';
  END IF;
  IF (
    SELECT pg_catalog.count(*)
      FROM pg_catalog.pg_trigger AS trigger_row
     WHERE trigger_row.tgfoid IN (
       cancellation_guard.oid,
       cancellation_schedule_sync.oid
     )
       AND NOT trigger_row.tgisinternal
  ) <> 2 OR (
    SELECT pg_catalog.count(*)
      FROM pg_catalog.pg_trigger AS trigger_row
     WHERE trigger_row.tgrelid = cancellation_relation.oid
       AND NOT trigger_row.tgisinternal
  ) <> 1 THEN
    RAISE EXCEPTION 'Realtime cancellation trigger inventory drift';
  END IF;

  FOREACH required_privilege IN ARRAY ARRAY[
    'SELECT', 'INSERT', 'UPDATE', 'DELETE'
  ]::TEXT[] LOOP
    IF NOT pg_catalog.has_table_privilege(
      current_user,
      lease_relation.oid,
      required_privilege
    ) THEN
      RAISE EXCEPTION
        'AgentMission realtime runtime lease ACL missing %',
        required_privilege;
    END IF;
  END LOOP;
  IF pg_catalog.has_table_privilege(
       current_user,
       lease_relation.oid,
       'TRUNCATE,REFERENCES,TRIGGER'
     ) THEN
    RAISE EXCEPTION 'AgentMission realtime runtime lease ACL drift';
  END IF;

  FOREACH required_privilege IN ARRAY ARRAY['SELECT', 'INSERT', 'DELETE']::TEXT[] LOOP
    IF NOT pg_catalog.has_table_privilege(
      current_user,
      cancellation_relation.oid,
      required_privilege
    ) THEN
      RAISE EXCEPTION
        'Realtime cancellation fence runtime ACL missing %',
        required_privilege;
    END IF;
  END LOOP;
  IF pg_catalog.has_table_privilege(
       current_user,
       cancellation_relation.oid,
       'UPDATE,TRUNCATE,REFERENCES,TRIGGER,MAINTAIN'
     )
     OR pg_catalog.has_any_column_privilege(
       current_user,
       cancellation_relation.oid,
       'UPDATE,REFERENCES'
     )
     OR pg_catalog.has_function_privilege(
       current_user,
       cancellation_guard.oid,
       'EXECUTE'
     )
     OR pg_catalog.has_function_privilege(
       current_user,
       cancellation_schedule_sync.oid,
       'EXECUTE'
     ) THEN
    RAISE EXCEPTION 'Realtime cancellation fence runtime ACL drift';
  END IF;
  IF EXISTS (
    SELECT 1
      FROM pg_catalog.aclexplode(
        COALESCE(
          cancellation_relation.relacl,
          pg_catalog.acldefault('r', cancellation_relation.relowner)
        )
      ) AS privilege
     WHERE privilege.grantee <> cancellation_relation.relowner
       AND (
         privilege.grantee <> runtime_role.oid
         OR privilege.privilege_type NOT IN ('SELECT', 'INSERT', 'DELETE')
         OR privilege.is_grantable
         OR privilege.grantor <> cancellation_relation.relowner
       )
  ) OR EXISTS (
    SELECT 1
      FROM pg_catalog.pg_attribute AS attribute
     CROSS JOIN LATERAL pg_catalog.aclexplode(attribute.attacl) AS privilege
     WHERE attribute.attrelid = cancellation_relation.oid
       AND attribute.attnum > 0
       AND NOT attribute.attisdropped
       AND privilege.grantee <> cancellation_relation.relowner
  ) THEN
    RAISE EXCEPTION 'Realtime cancellation fence exact relation or column ACL drift';
  END IF;
  IF EXISTS (
    SELECT 1
      FROM pg_catalog.pg_proc AS function
     CROSS JOIN LATERAL pg_catalog.aclexplode(
       COALESCE(function.proacl, pg_catalog.acldefault('f', function.proowner))
     ) AS privilege
     WHERE function.oid IN (
       cancellation_guard.oid,
       cancellation_schedule_sync.oid
     )
       AND (
         privilege.grantee <> function.proowner
         OR privilege.privilege_type <> 'EXECUTE'
         OR privilege.is_grantable
         OR privilege.grantor <> function.proowner
       )
  ) THEN
    RAISE EXCEPTION 'Realtime cancellation trigger function exact ACL drift';
  END IF;

  FOREACH exposed_role IN ARRAY ARRAY['anon', 'authenticated', 'service_role']::TEXT[] LOOP
    IF pg_catalog.to_regrole(exposed_role) IS NOT NULL THEN
      IF pg_catalog.has_table_privilege(
           exposed_role,
           lease_relation.oid,
           'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER'
         )
         OR pg_catalog.has_any_column_privilege(
           exposed_role,
           lease_relation.oid,
           'SELECT,INSERT,UPDATE,REFERENCES'
         ) THEN
        RAISE EXCEPTION '% can access AgentMission realtime lease capability columns', exposed_role;
      END IF;
      IF pg_catalog.has_function_privilege(
        exposed_role,
        capability_guard.oid,
        'EXECUTE'
      ) THEN
        RAISE EXCEPTION '% can execute AgentMission realtime capability guard', exposed_role;
      END IF;
      IF pg_catalog.has_table_privilege(
           exposed_role,
           cancellation_relation.oid,
           'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER'
         )
         OR pg_catalog.has_any_column_privilege(
           exposed_role,
           cancellation_relation.oid,
           'SELECT,INSERT,UPDATE,REFERENCES'
         )
         OR pg_catalog.has_function_privilege(
           exposed_role,
           cancellation_guard.oid,
           'EXECUTE'
         )
         OR pg_catalog.has_function_privilege(
           exposed_role,
           cancellation_schedule_sync.oid,
           'EXECUTE'
         ) THEN
        RAISE EXCEPTION '% can access realtime cancellation authority', exposed_role;
      END IF;
    END IF;
  END LOOP;

  -- Le reaper Mistral historique ne reçoit que les deux colonnes requises par son protocole
  -- de nettoyage. En particulier, aucune capability AgentMission ne doit traverser ce rôle.
  IF pg_catalog.to_regrole('bob_mistral_bootstrap_reaper') IS NOT NULL THEN
    IF pg_catalog.has_table_privilege(
         'bob_mistral_bootstrap_reaper',
         lease_relation.oid,
         'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER'
       ) THEN
      RAISE EXCEPTION 'Mistral bootstrap reaper has table-level realtime lease access';
    END IF;

    FOR lease_column IN
      SELECT attribute.attname
        FROM pg_catalog.pg_attribute AS attribute
       WHERE attribute.attrelid = lease_relation.oid
         AND attribute.attnum > 0
         AND NOT attribute.attisdropped
    LOOP
      IF lease_column IN ('companyId', 'sessionId') THEN
        IF NOT pg_catalog.has_column_privilege(
             'bob_mistral_bootstrap_reaper',
             lease_relation.oid,
             lease_column,
             'SELECT'
           )
           OR pg_catalog.has_column_privilege(
             'bob_mistral_bootstrap_reaper',
             lease_relation.oid,
             lease_column,
             'INSERT,UPDATE,REFERENCES'
           ) THEN
          RAISE EXCEPTION
            'Mistral bootstrap reaper ACL drift on allowed lease column %',
            lease_column;
        END IF;
      ELSIF pg_catalog.has_column_privilege(
        'bob_mistral_bootstrap_reaper',
        lease_relation.oid,
        lease_column,
        'SELECT,INSERT,UPDATE,REFERENCES'
      ) THEN
        RAISE EXCEPTION
          'Mistral bootstrap reaper can access forbidden lease column %',
          lease_column;
      END IF;
    END LOOP;
    IF pg_catalog.has_table_privilege(
         'bob_mistral_bootstrap_reaper',
         cancellation_relation.oid,
         'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER'
       )
       OR pg_catalog.has_any_column_privilege(
         'bob_mistral_bootstrap_reaper',
         cancellation_relation.oid,
         'SELECT,INSERT,UPDATE,REFERENCES'
       ) THEN
      RAISE EXCEPTION 'Mistral bootstrap reaper can access realtime cancellation fences';
    END IF;
  END IF;

  -- Le rôle annuaire du reaper n'a aucune raison métier d'accéder aux sources tenantées.
  IF pg_catalog.to_regrole('bob_realtime_reaper_directory') IS NOT NULL
     AND (
       pg_catalog.has_table_privilege(
         'bob_realtime_reaper_directory',
         lease_relation.oid,
         'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER'
       )
       OR pg_catalog.has_any_column_privilege(
         'bob_realtime_reaper_directory',
         lease_relation.oid,
         'SELECT,INSERT,UPDATE,REFERENCES'
       )
       OR pg_catalog.has_table_privilege(
         'bob_realtime_reaper_directory',
         cancellation_relation.oid,
         'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER'
       )
       OR pg_catalog.has_any_column_privilege(
         'bob_realtime_reaper_directory',
         cancellation_relation.oid,
         'SELECT,INSERT,UPDATE,REFERENCES'
       )
     ) THEN
    RAISE EXCEPTION 'Realtime reaper directory role can access a tenant source';
  END IF;

  SELECT *
    INTO STRICT authority
    FROM pg_catalog.pg_roles
   WHERE rolname = 'bob_agent_mission_release_flag_authority';
  IF authority.rolcanlogin
     OR authority.rolsuper
     OR authority.rolcreatedb
     OR authority.rolcreaterole
     OR authority.rolinherit
     OR authority.rolreplication
     OR authority.rolbypassrls THEN
    RAISE EXCEPTION 'AgentMission release flag authority role privilege drift';
  END IF;
  IF NOT pg_catalog.has_schema_privilege(authority.rolname, 'public', 'USAGE')
     OR pg_catalog.has_schema_privilege(authority.rolname, 'public', 'CREATE') THEN
    RAISE EXCEPTION 'AgentMission release flag authority schema ACL drift';
  END IF;

  SELECT *
    INTO STRICT helper
    FROM pg_catalog.pg_proc AS function
   WHERE function.oid =
     'public.revalidate_agent_mission_release_flag_v1(text,text,integer)'::pg_catalog.regprocedure;
  IF helper.proowner <> authority.oid
     OR NOT helper.prosecdef
     OR helper.proconfig IS NULL
     OR NOT helper.proconfig @> ARRAY[
       'search_path=pg_catalog',
       'row_security=on',
       'lock_timeout=1s',
       'statement_timeout=3s'
     ]::TEXT[]
     OR helper.prosrc ~* '\mEXECUTE\M' THEN
    RAISE EXCEPTION 'AgentMission release flag helper definition drift';
  END IF;

  IF NOT pg_catalog.has_function_privilege(current_user, helper.oid, 'EXECUTE') THEN
    RAISE EXCEPTION 'AgentMission release flag helper is unavailable to runtime';
  END IF;
  IF NOT pg_catalog.has_table_privilege(
       authority.rolname,
       'public.release_flags',
       'SELECT'
     )
     OR NOT pg_catalog.has_column_privilege(
       authority.rolname,
       'public.release_flags',
       'id',
       'UPDATE'
     )
     OR pg_catalog.has_table_privilege(
       authority.rolname,
       'public.release_flags',
       'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER'
     )
     OR pg_catalog.has_table_privilege(
       authority.rolname,
       'public.release_flag_subjects',
       'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER'
     )
     OR pg_catalog.has_table_privilege(
       authority.rolname,
       'public.release_flag_audit_events',
       'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER'
     ) THEN
    RAISE EXCEPTION 'AgentMission release flag authority table ACL drift';
  END IF;
  FOR release_column IN
    SELECT attribute.attname
      FROM pg_catalog.pg_attribute AS attribute
     WHERE attribute.attrelid = 'public.release_flags'::pg_catalog.regclass
       AND attribute.attnum > 0
       AND NOT attribute.attisdropped
  LOOP
    IF (
      release_column = 'id'
      AND NOT pg_catalog.has_column_privilege(
        authority.rolname,
        'public.release_flags',
        release_column,
        'UPDATE'
      )
    ) OR (
      release_column <> 'id'
      AND pg_catalog.has_column_privilege(
        authority.rolname,
        'public.release_flags',
        release_column,
        'UPDATE'
      )
    ) OR pg_catalog.has_column_privilege(
      authority.rolname,
      'public.release_flags',
      release_column,
      'INSERT,REFERENCES'
    ) THEN
      RAISE EXCEPTION
        'AgentMission release flag authority column ACL drift on %',
        release_column;
    END IF;
  END LOOP;
  IF pg_catalog.has_any_column_privilege(
       authority.rolname,
       'public.release_flag_subjects',
       'SELECT,INSERT,UPDATE,REFERENCES'
     )
     OR pg_catalog.has_any_column_privilege(
       authority.rolname,
       'public.release_flag_audit_events',
       'SELECT,INSERT,UPDATE,REFERENCES'
     ) THEN
    RAISE EXCEPTION 'AgentMission release flag authority has forbidden column ACLs';
  END IF;

  FOREACH exposed_role IN ARRAY ARRAY['anon', 'authenticated', 'service_role']::TEXT[] LOOP
    IF pg_catalog.to_regrole(exposed_role) IS NOT NULL
       AND pg_catalog.has_function_privilege(exposed_role, helper.oid, 'EXECUTE') THEN
      RAISE EXCEPTION '% can execute AgentMission release flag helper', exposed_role;
    END IF;
  END LOOP;

  FOREACH forbidden_privilege IN ARRAY ARRAY[
    'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER'
  ]::TEXT[] LOOP
    IF pg_catalog.has_table_privilege(
         current_user,
         'public.release_flags',
         forbidden_privilege
       )
       OR pg_catalog.has_table_privilege(
         current_user,
         'public.release_flag_subjects',
         forbidden_privilege
       )
       OR pg_catalog.has_table_privilege(
         current_user,
         'public.release_flag_audit_events',
         forbidden_privilege
       ) THEN
      RAISE EXCEPTION
        'AgentMission runtime can mutate release flag state through %',
        forbidden_privilege;
    END IF;
  END LOOP;
  FOREACH release_relation IN ARRAY ARRAY[
    'release_flags',
    'release_flag_subjects',
    'release_flag_audit_events'
  ]::TEXT[] LOOP
    IF pg_catalog.has_any_column_privilege(
      current_user,
      pg_catalog.format('public.%I', release_relation),
      'INSERT,UPDATE,REFERENCES'
    ) THEN
      RAISE EXCEPTION
        'AgentMission runtime has a forbidden column ACL on %',
        release_relation;
    END IF;
  END LOOP;
  IF pg_catalog.has_any_column_privilege(
    current_user,
    'public.release_flag_audit_events',
    'SELECT'
  ) THEN
    RAISE EXCEPTION 'AgentMission runtime can read release flag audit columns';
  END IF;

  exact_release_flag_revalidation :=
    public.revalidate_agent_mission_release_flag_v1(
      'bob.agent_missions.quote.v1',
      expected_release_environment,
      expected_release_flag_version
    );
  IF exact_release_flag_revalidation IS DISTINCT FROM
       (NOT expected_release_flag_kill_switch) THEN
    RAISE EXCEPTION
      'AgentMission release flag exact state revalidation drift (kill switch: %)',
      expected_release_flag_kill_switch;
  END IF;
  IF public.revalidate_agent_mission_release_flag_v1(
       'bob.agent_missions.quote.v1',
       expected_release_environment,
       wrong_lower_release_flag_version
     )
     OR public.revalidate_agent_mission_release_flag_v1(
       'bob.agent_missions.quote.v1',
       expected_release_environment,
       wrong_upper_release_flag_version
     ) THEN
    RAISE EXCEPTION 'AgentMission release flag adjacent version was accepted';
  END IF;
  IF public.revalidate_agent_mission_release_flag_v1(
       'bob.agent_missions.invoice.v1',
       expected_release_environment,
       expected_release_flag_version
     ) THEN
    RAISE EXCEPTION 'AgentMission release flag wrong key was accepted';
  END IF;
END;
$agent_mission_realtime_release_certificate$;

ROLLBACK;
