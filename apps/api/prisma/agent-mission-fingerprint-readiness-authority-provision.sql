\set ON_ERROR_STOP on

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';
SELECT pg_catalog.set_config('app.release_runtime_role', :'app_role', true);

DO $agent_mission_fingerprint_readiness_inventory$
DECLARE
  object_owner OID;
BEGIN
  IF pg_catalog.to_regrole(current_setting('app.release_runtime_role', true)) IS NULL THEN
    RAISE EXCEPTION 'AgentMission fingerprint readiness runtime role is missing';
  END IF;
  IF pg_catalog.to_regrole('bob_agent_mission_fingerprint_readiness') IS NULL THEN
    RAISE EXCEPTION 'AgentMission fingerprint readiness authority role is missing';
  END IF;
  IF pg_catalog.to_regclass(
       'public.agent_mission_fingerprint_key_bindings'
     ) IS NULL THEN
    RAISE EXCEPTION 'AgentMission fingerprint key binding registry is missing';
  END IF;
  IF pg_catalog.to_regclass(
       'public.agent_mission_fingerprint_key_version_floors'
     ) IS NULL THEN
    RAISE EXCEPTION 'AgentMission fingerprint key writer floor is missing';
  END IF;
  FOREACH object_owner IN ARRAY ARRAY[
    (
      SELECT function.proowner
        FROM pg_catalog.pg_proc AS function
       WHERE function.oid =
         'public.agent_mission_fingerprint_key_readiness(integer[])'::pg_catalog.regprocedure
    ),
    (
      SELECT function.proowner
        FROM pg_catalog.pg_proc AS function
       WHERE function.oid =
         'public.guard_agent_mission_fingerprint_key_binding_present_v1()'::pg_catalog.regprocedure
    )
  ]::OID[] LOOP
    IF object_owner IS NULL OR (
      object_owner <> (
        SELECT role.oid FROM pg_catalog.pg_roles AS role WHERE role.rolname = current_user
      )
      AND object_owner <> 'bob_agent_mission_fingerprint_readiness'::pg_catalog.regrole
    ) THEN
      RAISE EXCEPTION 'AgentMission fingerprint readiness function has an unexpected owner';
    END IF;
  END LOOP;
END;
$agent_mission_fingerprint_readiness_inventory$;

-- CREATE est temporaire et sert uniquement au transfert d'ownership des deux fonctions.
SELECT pg_catalog.format(
  'SET LOCAL ROLE %I; GRANT USAGE, CREATE ON SCHEMA public TO bob_agent_mission_fingerprint_readiness; RESET ROLE;',
  owner.rolname
)
  FROM pg_catalog.pg_namespace AS namespace
  JOIN pg_catalog.pg_roles AS owner ON owner.oid = namespace.nspowner
 WHERE namespace.nspname = 'public'
\gexec

-- Zéro privilège table hérité sur le journal : l'autorité ne lit que la version de fingerprint.
SELECT pg_catalog.format(
  'SET LOCAL ROLE %I; REVOKE ALL PRIVILEGES ON TABLE public.agent_mission_events FROM bob_agent_mission_fingerprint_readiness; RESET ROLE;',
  owner.rolname
)
  FROM pg_catalog.pg_class AS relation
  JOIN pg_catalog.pg_roles AS owner ON owner.oid = relation.relowner
 WHERE relation.oid = 'public.agent_mission_events'::pg_catalog.regclass
\gexec

SELECT pg_catalog.format(
  'SET LOCAL ROLE %I; REVOKE SELECT (%I), INSERT (%I), UPDATE (%I), REFERENCES (%I) ON TABLE public.agent_mission_events FROM bob_agent_mission_fingerprint_readiness; RESET ROLE;',
  owner.rolname,
  attribute.attname,
  attribute.attname,
  attribute.attname,
  attribute.attname
)
  FROM pg_catalog.pg_class AS relation
  JOIN pg_catalog.pg_roles AS owner ON owner.oid = relation.relowner
  JOIN pg_catalog.pg_attribute AS attribute
    ON attribute.attrelid = relation.oid
   AND attribute.attnum > 0
   AND NOT attribute.attisdropped
 WHERE relation.oid = 'public.agent_mission_events'::pg_catalog.regclass
 ORDER BY attribute.attnum
\gexec

SELECT pg_catalog.format(
  'SET LOCAL ROLE %I; GRANT SELECT ("fingerprintKeyVersion") ON TABLE public.agent_mission_events TO bob_agent_mission_fingerprint_readiness; DROP POLICY IF EXISTS agent_mission_events_fingerprint_readiness_select ON public.agent_mission_events; CREATE POLICY agent_mission_events_fingerprint_readiness_select ON public.agent_mission_events FOR SELECT TO bob_agent_mission_fingerprint_readiness USING (true); RESET ROLE;',
  owner.rolname
)
  FROM pg_catalog.pg_class AS relation
  JOIN pg_catalog.pg_roles AS owner ON owner.oid = relation.relowner
 WHERE relation.oid = 'public.agent_mission_events'::pg_catalog.regclass
\gexec

-- Le registre ne contient aucun secret, mais seul le rôle NOLOGIN de readiness peut le lire.
SELECT pg_catalog.format(
  'SET LOCAL ROLE %I; REVOKE ALL PRIVILEGES ON TABLE public.agent_mission_fingerprint_key_version_floors FROM bob_agent_mission_fingerprint_readiness; GRANT SELECT ON TABLE public.agent_mission_fingerprint_key_version_floors TO bob_agent_mission_fingerprint_readiness; DROP POLICY IF EXISTS agent_mission_fingerprint_key_floor_readiness_select ON public.agent_mission_fingerprint_key_version_floors; CREATE POLICY agent_mission_fingerprint_key_floor_readiness_select ON public.agent_mission_fingerprint_key_version_floors FOR SELECT TO bob_agent_mission_fingerprint_readiness USING (true); RESET ROLE;',
  owner.rolname
)
  FROM pg_catalog.pg_class AS relation
  JOIN pg_catalog.pg_roles AS owner ON owner.oid = relation.relowner
 WHERE relation.oid =
   'public.agent_mission_fingerprint_key_version_floors'::pg_catalog.regclass
\gexec

SELECT pg_catalog.format(
  'SET LOCAL ROLE %I; REVOKE ALL PRIVILEGES ON TABLE public.agent_mission_fingerprint_key_bindings FROM bob_agent_mission_fingerprint_readiness; GRANT SELECT ON TABLE public.agent_mission_fingerprint_key_bindings TO bob_agent_mission_fingerprint_readiness; DROP POLICY IF EXISTS agent_mission_fingerprint_key_binding_readiness_select ON public.agent_mission_fingerprint_key_bindings; CREATE POLICY agent_mission_fingerprint_key_binding_readiness_select ON public.agent_mission_fingerprint_key_bindings FOR SELECT TO bob_agent_mission_fingerprint_readiness USING (true); RESET ROLE;',
  owner.rolname
)
  FROM pg_catalog.pg_class AS relation
  JOIN pg_catalog.pg_roles AS owner ON owner.oid = relation.relowner
 WHERE relation.oid =
   'public.agent_mission_fingerprint_key_bindings'::pg_catalog.regclass
\gexec

-- Un REVOKE table n'efface pas un ancien GRANT colonne PostgreSQL. Le rejeu nettoie donc chaque
-- colonne des deux registres sous son owner exact avant de conserver uniquement le SELECT table.
SELECT pg_catalog.format(
  'SET LOCAL ROLE %I; REVOKE SELECT (%I), INSERT (%I), UPDATE (%I), REFERENCES (%I) ON TABLE %s FROM bob_agent_mission_fingerprint_readiness; RESET ROLE;',
  owner.rolname,
  attribute.attname,
  attribute.attname,
  attribute.attname,
  attribute.attname,
  relation.oid::pg_catalog.regclass
)
  FROM pg_catalog.pg_class AS relation
  JOIN pg_catalog.pg_roles AS owner ON owner.oid = relation.relowner
  JOIN pg_catalog.pg_attribute AS attribute
    ON attribute.attrelid = relation.oid
   AND attribute.attnum > 0
   AND NOT attribute.attisdropped
 WHERE relation.oid IN (
   'public.agent_mission_fingerprint_key_version_floors'::pg_catalog.regclass,
   'public.agent_mission_fingerprint_key_bindings'::pg_catalog.regclass
 )
 ORDER BY relation.oid, attribute.attnum
\gexec

-- La table du journal appartient normalement au rôle de schéma, pas au déployeur DIRECT_URL.
-- L'index de readiness est donc créé sous ce propriétaire exact après l'expand. IF NOT EXISTS
-- rend le rejeu sûr ; le certificat fermé ci-dessous refuse néanmoins tout index homonyme dont
-- la forme, la méthode ou la colonne dériverait.
SELECT pg_catalog.format(
  'SET LOCAL ROLE %I; CREATE INDEX IF NOT EXISTS agent_mission_events_fingerprint_key_version_idx ON public.agent_mission_events ("fingerprintKeyVersion"); RESET ROLE;',
  owner.rolname
)
  FROM pg_catalog.pg_class AS relation
  JOIN pg_catalog.pg_roles AS owner ON owner.oid = relation.relowner
 WHERE relation.oid = 'public.agent_mission_events'::pg_catalog.regclass
\gexec

-- La table du journal peut déjà appartenir à bob_schema_owner. Le trigger est donc rejoué sous
-- SET ROLE de ce propriétaire exact. EXECUTE est accordé uniquement le temps de la création puis
-- révoqué avant la fin de la transaction.
SELECT pg_catalog.format(
  'SET LOCAL ROLE %I; GRANT EXECUTE ON FUNCTION %s TO %I; RESET ROLE;',
  function_owner.rolname,
  function.oid::pg_catalog.regprocedure,
  table_owner.rolname
)
  FROM pg_catalog.pg_proc AS function
  JOIN pg_catalog.pg_roles AS function_owner ON function_owner.oid = function.proowner
 CROSS JOIN pg_catalog.pg_class AS relation
  JOIN pg_catalog.pg_roles AS table_owner ON table_owner.oid = relation.relowner
 WHERE function.oid =
   'public.guard_agent_mission_fingerprint_key_binding_present_v1()'::pg_catalog.regprocedure
   AND relation.oid = 'public.agent_mission_events'::pg_catalog.regclass
   AND function.proowner <> relation.relowner
\gexec

SELECT pg_catalog.format(
  'SET LOCAL ROLE %I; DROP TRIGGER IF EXISTS agent_mission_events_00_fingerprint_key_binding_guard_v1 ON public.agent_mission_events; CREATE TRIGGER agent_mission_events_00_fingerprint_key_binding_guard_v1 BEFORE INSERT ON public.agent_mission_events FOR EACH ROW EXECUTE FUNCTION public.guard_agent_mission_fingerprint_key_binding_present_v1(); COMMENT ON TRIGGER agent_mission_events_00_fingerprint_key_binding_guard_v1 ON public.agent_mission_events IS %L; RESET ROLE;',
  owner.rolname,
  'Après stage, refuse une version hors floor ou sans binding HMAC AgentMission durable.'
)
  FROM pg_catalog.pg_class AS relation
  JOIN pg_catalog.pg_roles AS owner ON owner.oid = relation.relowner
 WHERE relation.oid = 'public.agent_mission_events'::pg_catalog.regclass
\gexec

SELECT pg_catalog.format(
  'SET LOCAL ROLE %I; REVOKE EXECUTE ON FUNCTION %s FROM %I; RESET ROLE;',
  function_owner.rolname,
  function.oid::pg_catalog.regprocedure,
  table_owner.rolname
)
  FROM pg_catalog.pg_proc AS function
  JOIN pg_catalog.pg_roles AS function_owner ON function_owner.oid = function.proowner
 CROSS JOIN pg_catalog.pg_class AS relation
  JOIN pg_catalog.pg_roles AS table_owner ON table_owner.oid = relation.relowner
 WHERE function.oid =
   'public.guard_agent_mission_fingerprint_key_binding_present_v1()'::pg_catalog.regprocedure
   AND relation.oid = 'public.agent_mission_events'::pg_catalog.regclass
   AND function.proowner <> relation.relowner
\gexec

SELECT pg_catalog.format(
  'ALTER FUNCTION %s OWNER TO bob_agent_mission_fingerprint_readiness',
  function.oid::pg_catalog.regprocedure
)
  FROM pg_catalog.pg_proc AS function
 WHERE function.oid IN (
   'public.agent_mission_fingerprint_key_readiness(integer[])'::pg_catalog.regprocedure,
   'public.guard_agent_mission_fingerprint_key_binding_present_v1()'::pg_catalog.regprocedure
 )
   AND function.proowner = (
     SELECT role.oid FROM pg_catalog.pg_roles AS role WHERE role.rolname = current_user
   )
 ORDER BY function.oid
\gexec

SET LOCAL ROLE bob_agent_mission_fingerprint_readiness;
-- L'ACL est une allowlist exacte, pas une liste de rôles connus à révoquer. Un ancien grantee
-- arbitraire sur le trigger SECURITY DEFINER pourrait sinon sonder les bindings ou maintenir le
-- verrou advisory partagé depuis sa propre table.
SELECT DISTINCT pg_catalog.format(
  'REVOKE ALL PRIVILEGES ON FUNCTION %s FROM %s CASCADE',
  function.oid::pg_catalog.regprocedure,
  CASE
    WHEN privilege.grantee = 0 THEN 'PUBLIC'
    ELSE pg_catalog.quote_ident(grantee.rolname)
  END
)
 FROM pg_catalog.pg_proc AS function
 CROSS JOIN LATERAL pg_catalog.aclexplode(
   coalesce(
     function.proacl,
     pg_catalog.acldefault('f', function.proowner)
   )
 ) AS privilege
  LEFT JOIN pg_catalog.pg_roles AS grantee
    ON grantee.oid = privilege.grantee
 WHERE function.oid IN (
   'public.agent_mission_fingerprint_key_readiness(integer[])'::pg_catalog.regprocedure,
   'public.guard_agent_mission_fingerprint_key_binding_present_v1()'::pg_catalog.regprocedure
 )
   AND privilege.grantee <> function.proowner
 ORDER BY 1
\gexec
REVOKE ALL PRIVILEGES
  ON FUNCTION public.agent_mission_fingerprint_key_readiness(INTEGER[])
  FROM PUBLIC;
REVOKE ALL PRIVILEGES
  ON FUNCTION public.guard_agent_mission_fingerprint_key_binding_present_v1()
  FROM PUBLIC;
SELECT pg_catalog.format(
  'REVOKE ALL PRIVILEGES ON FUNCTION public.agent_mission_fingerprint_key_readiness(INTEGER[]) FROM %I',
  role.rolname
)
  FROM pg_catalog.pg_roles AS role
 WHERE role.rolname IN ('anon', 'authenticated', 'service_role')
\gexec
SELECT pg_catalog.format(
  'REVOKE ALL PRIVILEGES ON FUNCTION public.guard_agent_mission_fingerprint_key_binding_present_v1() FROM %I',
  role.rolname
)
  FROM pg_catalog.pg_roles AS role
 WHERE role.rolname IN ('anon', 'authenticated', 'service_role')
\gexec
REVOKE ALL PRIVILEGES
  ON FUNCTION public.agent_mission_fingerprint_key_readiness(INTEGER[])
  FROM :"app_role";
REVOKE ALL PRIVILEGES
  ON FUNCTION public.guard_agent_mission_fingerprint_key_binding_present_v1()
  FROM :"app_role";
GRANT EXECUTE
  ON FUNCTION public.agent_mission_fingerprint_key_readiness(INTEGER[])
  TO :"app_role";
ALTER FUNCTION public.agent_mission_fingerprint_key_readiness(INTEGER[])
  SECURITY DEFINER;
ALTER FUNCTION public.agent_mission_fingerprint_key_readiness(INTEGER[])
  SET search_path = pg_catalog;
ALTER FUNCTION public.agent_mission_fingerprint_key_readiness(INTEGER[])
  SET row_security = on;
ALTER FUNCTION public.agent_mission_fingerprint_key_readiness(INTEGER[])
  SET lock_timeout = '1s';
ALTER FUNCTION public.agent_mission_fingerprint_key_readiness(INTEGER[])
  SET statement_timeout = '3s';
ALTER FUNCTION public.guard_agent_mission_fingerprint_key_binding_present_v1()
  SECURITY DEFINER;
ALTER FUNCTION public.guard_agent_mission_fingerprint_key_binding_present_v1()
  VOLATILE;
ALTER FUNCTION public.guard_agent_mission_fingerprint_key_binding_present_v1()
  SET search_path = pg_catalog;
ALTER FUNCTION public.guard_agent_mission_fingerprint_key_binding_present_v1()
  SET row_security = on;
ALTER FUNCTION public.guard_agent_mission_fingerprint_key_binding_present_v1()
  SET lock_timeout = '1s';
ALTER FUNCTION public.guard_agent_mission_fingerprint_key_binding_present_v1()
  SET statement_timeout = '3s';
RESET ROLE;

SELECT pg_catalog.format(
  'SET LOCAL ROLE %I; REVOKE CREATE ON SCHEMA public FROM bob_agent_mission_fingerprint_readiness; GRANT USAGE ON SCHEMA public TO bob_agent_mission_fingerprint_readiness; RESET ROLE;',
  owner.rolname
)
  FROM pg_catalog.pg_namespace AS namespace
  JOIN pg_catalog.pg_roles AS owner ON owner.oid = namespace.nspowner
 WHERE namespace.nspname = 'public'
\gexec

DO $agent_mission_fingerprint_readiness_certificate$
DECLARE
  app_role_name TEXT := current_setting('app.release_runtime_role', true);
  app_role_oid OID := pg_catalog.to_regrole(app_role_name);
  authority pg_catalog.pg_roles%ROWTYPE;
  helper pg_catalog.pg_proc%ROWTYPE;
  writer_guard pg_catalog.pg_proc%ROWTYPE;
  attribute_name TEXT;
BEGIN
  SELECT *
    INTO STRICT authority
    FROM pg_catalog.pg_roles
   WHERE rolname = 'bob_agent_mission_fingerprint_readiness';
  SELECT *
    INTO STRICT helper
    FROM pg_catalog.pg_proc AS function
   WHERE function.oid =
     'public.agent_mission_fingerprint_key_readiness(integer[])'::pg_catalog.regprocedure;
  SELECT *
    INTO STRICT writer_guard
    FROM pg_catalog.pg_proc AS function
   WHERE function.oid =
     'public.guard_agent_mission_fingerprint_key_binding_present_v1()'::pg_catalog.regprocedure;

  IF authority.rolsuper
     OR authority.rolbypassrls
     OR authority.rolcanlogin
     OR authority.rolinherit THEN
    RAISE EXCEPTION 'AgentMission fingerprint readiness role authority drift';
  END IF;
  IF pg_catalog.pg_has_role(app_role_oid, authority.oid, 'MEMBER')
     OR pg_catalog.pg_has_role(app_role_oid, authority.oid, 'SET') THEN
    RAISE EXCEPTION 'AgentMission runtime can assume fingerprint readiness authority';
  END IF;
  IF helper.proowner <> authority.oid
     OR NOT helper.prosecdef
     OR helper.provolatile <> 'v'
     OR helper.proconfig IS NULL
     OR NOT helper.proconfig @> ARRAY[
       'search_path=pg_catalog',
       'row_security=on',
       'lock_timeout=1s',
       'statement_timeout=3s'
     ]::TEXT[]
     OR writer_guard.proowner <> authority.oid
     OR NOT writer_guard.prosecdef
     OR writer_guard.provolatile <> 'v'
     OR writer_guard.proconfig IS NULL
     OR NOT writer_guard.proconfig @> ARRAY[
       'search_path=pg_catalog',
       'row_security=on',
       'lock_timeout=1s',
       'statement_timeout=3s'
     ]::TEXT[] THEN
    RAISE EXCEPTION 'AgentMission fingerprint readiness function authority drift';
  END IF;
  IF NOT EXISTS (
    SELECT 1
      FROM pg_catalog.pg_trigger AS trigger
     WHERE trigger.tgrelid = 'public.agent_mission_events'::pg_catalog.regclass
       AND trigger.tgname =
         'agent_mission_events_00_fingerprint_key_binding_guard_v1'
       AND NOT trigger.tgisinternal
       AND trigger.tgenabled = 'O'
       AND trigger.tgtype = 7
       AND trigger.tgfoid = writer_guard.oid
       AND trigger.tgconstraint = 0
       AND trigger.tgattr = ''::pg_catalog.int2vector
  ) THEN
    RAISE EXCEPTION 'AgentMission fingerprint writer trigger authority drift';
  END IF;
  IF NOT EXISTS (
    SELECT 1
      FROM pg_catalog.pg_index AS index
      JOIN pg_catalog.pg_class AS index_relation
        ON index_relation.oid = index.indexrelid
      JOIN pg_catalog.pg_am AS access_method
        ON access_method.oid = index_relation.relam
      JOIN pg_catalog.pg_attribute AS attribute
        ON attribute.attrelid = index.indrelid
       AND attribute.attname = 'fingerprintKeyVersion'
     WHERE index.indexrelid =
       'public.agent_mission_events_fingerprint_key_version_idx'::pg_catalog.regclass
       AND index.indrelid = 'public.agent_mission_events'::pg_catalog.regclass
       AND access_method.amname = 'btree'
       AND index.indisvalid
       AND index.indisready
       AND index.indislive
       AND NOT index.indisunique
       AND index.indnkeyatts = 1
       AND index.indnatts = 1
       AND index.indkey[0] = attribute.attnum
       AND index.indpred IS NULL
       AND index.indexprs IS NULL
  ) THEN
    RAISE EXCEPTION 'AgentMission fingerprint readiness index drift';
  END IF;
  IF NOT EXISTS (
    SELECT 1
      FROM pg_catalog.pg_attribute AS attribute
      JOIN pg_catalog.pg_attrdef AS default_value
        ON default_value.adrelid = attribute.attrelid
       AND default_value.adnum = attribute.attnum
     WHERE attribute.attrelid =
       'public.agent_mission_fingerprint_key_version_floors'::pg_catalog.regclass
       AND attribute.attname = 'writerEnabled'
       AND attribute.atttypid = 'pg_catalog.bool'::pg_catalog.regtype
       AND attribute.atttypmod = -1
       AND attribute.attnotnull
       AND attribute.atthasdef
       AND NOT attribute.attisdropped
       AND pg_catalog.pg_get_expr(
         default_value.adbin,
         default_value.adrelid,
         TRUE
       ) = 'true'
  ) THEN
    RAISE EXCEPTION 'AgentMission fingerprint writer lifecycle column drift';
  END IF;
  IF NOT pg_catalog.has_schema_privilege(authority.rolname, 'public', 'USAGE')
     OR pg_catalog.has_schema_privilege(authority.rolname, 'public', 'CREATE') THEN
    RAISE EXCEPTION 'AgentMission fingerprint readiness schema ACL drift';
  END IF;
  IF pg_catalog.has_table_privilege(
       authority.rolname,
       'public.agent_mission_events',
       'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER'
     )
     OR NOT pg_catalog.has_column_privilege(
       authority.rolname,
       'public.agent_mission_events',
       'fingerprintKeyVersion',
       'SELECT'
     ) THEN
    RAISE EXCEPTION 'AgentMission fingerprint readiness event ACL drift';
  END IF;
  FOR attribute_name IN
    SELECT attribute.attname
      FROM pg_catalog.pg_attribute AS attribute
     WHERE attribute.attrelid = 'public.agent_mission_events'::pg_catalog.regclass
       AND attribute.attnum > 0
       AND NOT attribute.attisdropped
  LOOP
    IF (
      attribute_name <> 'fingerprintKeyVersion'
      AND pg_catalog.has_column_privilege(
        authority.rolname,
        'public.agent_mission_events',
        attribute_name,
        'SELECT'
      )
    ) OR pg_catalog.has_column_privilege(
      authority.rolname,
      'public.agent_mission_events',
      attribute_name,
      'INSERT,UPDATE,REFERENCES'
    ) THEN
      RAISE EXCEPTION
        'AgentMission fingerprint readiness event column ACL drift on %',
        attribute_name;
    END IF;
  END LOOP;
  IF NOT pg_catalog.has_table_privilege(
       authority.rolname,
       'public.agent_mission_fingerprint_key_version_floors',
       'SELECT'
     )
     OR pg_catalog.has_table_privilege(
       authority.rolname,
       'public.agent_mission_fingerprint_key_version_floors',
       'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER'
     )
     OR NOT pg_catalog.has_table_privilege(
       authority.rolname,
       'public.agent_mission_fingerprint_key_bindings',
       'SELECT'
     )
     OR pg_catalog.has_table_privilege(
       authority.rolname,
       'public.agent_mission_fingerprint_key_bindings',
       'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER'
     )
     OR pg_catalog.has_any_column_privilege(
       authority.rolname,
       'public.agent_mission_fingerprint_key_version_floors',
       'INSERT,UPDATE,REFERENCES'
     )
     OR pg_catalog.has_any_column_privilege(
       authority.rolname,
       'public.agent_mission_fingerprint_key_bindings',
       'INSERT,UPDATE,REFERENCES'
     )
     OR EXISTS (
       SELECT 1
         FROM pg_catalog.pg_attribute AS attribute
        WHERE attribute.attrelid IN (
          'public.agent_mission_fingerprint_key_version_floors'::pg_catalog.regclass,
          'public.agent_mission_fingerprint_key_bindings'::pg_catalog.regclass
        )
          AND attribute.attnum > 0
          AND NOT attribute.attisdropped
          AND attribute.attacl IS NOT NULL
          AND EXISTS (
            SELECT 1
              FROM pg_catalog.aclexplode(attribute.attacl) AS privilege
             WHERE privilege.grantee = authority.oid
          )
     ) THEN
    RAISE EXCEPTION 'AgentMission fingerprint readiness binding ACL drift';
  END IF;
  IF pg_catalog.has_table_privilege(
       app_role_name,
       'public.agent_mission_fingerprint_key_version_floors',
       'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER'
     )
     OR pg_catalog.has_any_column_privilege(
       app_role_name,
       'public.agent_mission_fingerprint_key_version_floors',
       'SELECT,INSERT,UPDATE,REFERENCES'
     )
     OR pg_catalog.has_table_privilege(
       app_role_name,
       'public.agent_mission_fingerprint_key_bindings',
       'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER'
     )
     OR pg_catalog.has_any_column_privilege(
       app_role_name,
       'public.agent_mission_fingerprint_key_bindings',
       'SELECT,INSERT,UPDATE,REFERENCES'
     ) THEN
    RAISE EXCEPTION 'AgentMission runtime can access fingerprint key bindings directly';
  END IF;

  -- Inventaire fermé : toute policy supplémentaire, même permissive/PUBLIC, casse la release.
  IF (
    SELECT pg_catalog.count(*)
      FROM pg_catalog.pg_policy AS policy
     WHERE policy.polrelid =
       'public.agent_mission_fingerprint_key_version_floors'::pg_catalog.regclass
  ) <> 4
     OR NOT EXISTS (
       SELECT 1 FROM pg_catalog.pg_policy AS policy
        WHERE policy.polrelid =
          'public.agent_mission_fingerprint_key_version_floors'::pg_catalog.regclass
          AND policy.polname = 'agent_mission_fingerprint_key_floor_readiness_select'
          AND policy.polcmd = 'r'
          AND policy.polpermissive
          AND policy.polroles = ARRAY[authority.oid]::OID[]
          AND pg_catalog.pg_get_expr(policy.polqual, policy.polrelid, TRUE) = 'true'
          AND policy.polwithcheck IS NULL
     )
     OR NOT EXISTS (
       SELECT 1 FROM pg_catalog.pg_policy AS policy
        WHERE policy.polrelid =
          'public.agent_mission_fingerprint_key_version_floors'::pg_catalog.regclass
          AND policy.polname = 'agent_mission_fingerprint_key_floor_direct_select'
          AND policy.polcmd = 'r'
          AND policy.polpermissive
          AND policy.polroles = ARRAY[
            (
              SELECT relation.relowner
                FROM pg_catalog.pg_class AS relation
               WHERE relation.oid = policy.polrelid
            )
          ]::OID[]
          AND pg_catalog.pg_get_expr(policy.polqual, policy.polrelid, TRUE) = 'true'
          AND policy.polwithcheck IS NULL
     )
     OR NOT EXISTS (
       SELECT 1 FROM pg_catalog.pg_policy AS policy
        WHERE policy.polrelid =
          'public.agent_mission_fingerprint_key_version_floors'::pg_catalog.regclass
          AND policy.polname = 'agent_mission_fingerprint_key_floor_direct_insert'
          AND policy.polcmd = 'a'
          AND policy.polpermissive
          AND policy.polroles = ARRAY[
            (
              SELECT relation.relowner
                FROM pg_catalog.pg_class AS relation
               WHERE relation.oid = policy.polrelid
            )
          ]::OID[]
          AND policy.polqual IS NULL
          AND pg_catalog.pg_get_expr(policy.polwithcheck, policy.polrelid, TRUE) = 'true'
     )
     OR NOT EXISTS (
       SELECT 1 FROM pg_catalog.pg_policy AS policy
        WHERE policy.polrelid =
          'public.agent_mission_fingerprint_key_version_floors'::pg_catalog.regclass
          AND policy.polname = 'agent_mission_fingerprint_key_floor_direct_update'
          AND policy.polcmd = 'w'
          AND policy.polpermissive
          AND policy.polroles = ARRAY[
            (
              SELECT relation.relowner
                FROM pg_catalog.pg_class AS relation
               WHERE relation.oid = policy.polrelid
            )
          ]::OID[]
          AND pg_catalog.pg_get_expr(policy.polqual, policy.polrelid, TRUE) = 'true'
          AND pg_catalog.pg_get_expr(
            policy.polwithcheck,
            policy.polrelid,
            TRUE
          ) = 'true'
     ) THEN
    RAISE EXCEPTION 'AgentMission fingerprint floor RLS policy inventory drift';
  END IF;
  IF (
    SELECT pg_catalog.count(*)
      FROM pg_catalog.pg_policy AS policy
     WHERE policy.polrelid = 'public.agent_mission_events'::pg_catalog.regclass
  ) <> 3
     OR NOT EXISTS (
       SELECT 1 FROM pg_catalog.pg_policy AS policy
        WHERE policy.polrelid = 'public.agent_mission_events'::pg_catalog.regclass
          AND policy.polname = 'agent_mission_events_owner_select'
          AND policy.polcmd = 'r'
          AND policy.polpermissive
          AND policy.polroles = ARRAY[0]::OID[]
          AND policy.polwithcheck IS NULL
          AND pg_catalog.pg_get_expr(policy.polqual, policy.polrelid) =
            '(("companyId" = current_setting(''app.current_company_id''::text, true)) AND ("ownerUserId" = NULLIF(current_setting(''app.current_user_id''::text, true), ''''::text)))'
     )
     OR NOT EXISTS (
       SELECT 1 FROM pg_catalog.pg_policy AS policy
        WHERE policy.polrelid = 'public.agent_mission_events'::pg_catalog.regclass
          AND policy.polname = 'agent_mission_events_owner_insert'
          AND policy.polcmd = 'a'
          AND policy.polpermissive
          AND policy.polroles = ARRAY[0]::OID[]
          AND policy.polqual IS NULL
          AND pg_catalog.pg_get_expr(policy.polwithcheck, policy.polrelid) =
            '(("companyId" = current_setting(''app.current_company_id''::text, true)) AND ("ownerUserId" = NULLIF(current_setting(''app.current_user_id''::text, true), ''''::text)) AND (("missionId")::text = NULLIF(current_setting(''app.current_agent_mission_id''::text, true), ''''::text)))'
     )
     OR NOT EXISTS (
       SELECT 1 FROM pg_catalog.pg_policy AS policy
        WHERE policy.polrelid = 'public.agent_mission_events'::pg_catalog.regclass
          AND policy.polname = 'agent_mission_events_fingerprint_readiness_select'
          AND policy.polcmd = 'r'
          AND policy.polpermissive
          AND policy.polroles = ARRAY[authority.oid]::OID[]
          AND pg_catalog.pg_get_expr(policy.polqual, policy.polrelid, TRUE) = 'true'
          AND policy.polwithcheck IS NULL
     ) THEN
    RAISE EXCEPTION 'AgentMission event RLS policy inventory drift';
  END IF;
  IF (
    SELECT pg_catalog.count(*)
      FROM pg_catalog.pg_policy AS policy
     WHERE policy.polrelid =
       'public.agent_mission_fingerprint_key_bindings'::pg_catalog.regclass
  ) <> 3
     OR NOT EXISTS (
       SELECT 1 FROM pg_catalog.pg_policy AS policy
        WHERE policy.polrelid =
          'public.agent_mission_fingerprint_key_bindings'::pg_catalog.regclass
          AND policy.polname = 'agent_mission_fingerprint_key_binding_readiness_select'
          AND policy.polcmd = 'r'
          AND policy.polpermissive
          AND policy.polroles = ARRAY[authority.oid]::OID[]
          AND pg_catalog.pg_get_expr(policy.polqual, policy.polrelid, TRUE) = 'true'
          AND policy.polwithcheck IS NULL
     )
     OR NOT EXISTS (
       SELECT 1 FROM pg_catalog.pg_policy AS policy
        WHERE policy.polrelid =
          'public.agent_mission_fingerprint_key_bindings'::pg_catalog.regclass
          AND policy.polname = 'agent_mission_fingerprint_key_binding_direct_select'
          AND policy.polcmd = 'r'
          AND policy.polpermissive
          AND policy.polroles = ARRAY[
            (
              SELECT relation.relowner
                FROM pg_catalog.pg_class AS relation
               WHERE relation.oid = policy.polrelid
            )
          ]::OID[]
          AND pg_catalog.pg_get_expr(policy.polqual, policy.polrelid, TRUE) = 'true'
          AND policy.polwithcheck IS NULL
     )
     OR NOT EXISTS (
       SELECT 1 FROM pg_catalog.pg_policy AS policy
        WHERE policy.polrelid =
          'public.agent_mission_fingerprint_key_bindings'::pg_catalog.regclass
          AND policy.polname = 'agent_mission_fingerprint_key_binding_direct_insert'
          AND policy.polcmd = 'a'
          AND policy.polpermissive
          AND policy.polroles = ARRAY[
            (
              SELECT relation.relowner
                FROM pg_catalog.pg_class AS relation
               WHERE relation.oid = policy.polrelid
            )
          ]::OID[]
          AND policy.polqual IS NULL
          AND pg_catalog.pg_get_expr(policy.polwithcheck, policy.polrelid, TRUE) = 'true'
     ) THEN
    RAISE EXCEPTION 'AgentMission fingerprint binding RLS policy inventory drift';
  END IF;

  IF NOT pg_catalog.has_function_privilege(app_role_name, helper.oid, 'EXECUTE')
     OR pg_catalog.has_function_privilege(app_role_name, writer_guard.oid, 'EXECUTE')
     OR EXISTS (
       SELECT 1
         FROM pg_catalog.aclexplode(
           coalesce(
             writer_guard.proacl,
             pg_catalog.acldefault('f', writer_guard.proowner)
           )
         ) AS privilege
        WHERE privilege.privilege_type = 'EXECUTE'
          AND privilege.grantee <> authority.oid
     )
     OR EXISTS (
       SELECT 1
         FROM pg_catalog.aclexplode(
           coalesce(
             helper.proacl,
             pg_catalog.acldefault('f', helper.proowner)
           )
         ) AS privilege
        WHERE privilege.privilege_type = 'EXECUTE'
          AND privilege.grantee NOT IN (authority.oid, app_role_oid)
     )
     OR EXISTS (
       SELECT 1
         FROM pg_catalog.aclexplode(
           coalesce(
             helper.proacl,
             pg_catalog.acldefault('f', helper.proowner)
           )
         ) AS privilege
        WHERE privilege.privilege_type = 'EXECUTE'
          AND privilege.grantee = app_role_oid
          AND privilege.is_grantable
     ) THEN
    RAISE EXCEPTION 'AgentMission fingerprint readiness function ACL drift';
  END IF;
END;
$agent_mission_fingerprint_readiness_certificate$;
