\set ON_ERROR_STOP on

-- Une colonne ajoutée à une table déjà grantée hérite immédiatement du privilège table-level.
-- Le replay canonique referme donc les rôles Data API et leurs éventuels ACL de colonnes.
SELECT pg_catalog.format(
  'SET LOCAL ROLE %I; REVOKE ALL PRIVILEGES ON TABLE public.realtime_session_leases FROM PUBLIC; RESET ROLE;',
  owner.rolname
)
  FROM pg_catalog.pg_class AS relation
  JOIN pg_catalog.pg_roles AS owner ON owner.oid = relation.relowner
 WHERE relation.oid = 'public.realtime_session_leases'::pg_catalog.regclass
\gexec

SELECT pg_catalog.format(
  'SET LOCAL ROLE %I; REVOKE ALL PRIVILEGES ON TABLE public.realtime_session_leases FROM %I; RESET ROLE;',
  owner.rolname,
  exposed_role.rolname
)
  FROM pg_catalog.pg_class AS relation
  JOIN pg_catalog.pg_roles AS owner ON owner.oid = relation.relowner
 CROSS JOIN pg_catalog.pg_roles AS exposed_role
 WHERE relation.oid = 'public.realtime_session_leases'::pg_catalog.regclass
   AND exposed_role.rolname IN ('anon', 'authenticated', 'service_role')
\gexec

SELECT pg_catalog.format(
  'SET LOCAL ROLE %I; REVOKE SELECT (%I), INSERT (%I), UPDATE (%I), REFERENCES (%I) ON TABLE public.realtime_session_leases FROM %I; RESET ROLE;',
  owner.rolname,
  attribute.attname,
  attribute.attname,
  attribute.attname,
  attribute.attname,
  exposed_role.rolname
)
  FROM pg_catalog.pg_class AS relation
  JOIN pg_catalog.pg_roles AS owner ON owner.oid = relation.relowner
  JOIN pg_catalog.pg_attribute AS attribute
    ON attribute.attrelid = relation.oid
   AND attribute.attnum > 0
   AND NOT attribute.attisdropped
   AND attribute.attacl IS NOT NULL
 CROSS JOIN pg_catalog.pg_roles AS exposed_role
 WHERE relation.oid = 'public.realtime_session_leases'::pg_catalog.regclass
   AND exposed_role.rolname IN ('anon', 'authenticated', 'service_role')
 ORDER BY attribute.attnum, exposed_role.rolname
\gexec

-- Les fonctions trigger ne sont jamais des APIs. Le replay ferme le privilège EXECUTE par défaut
-- sous le propriétaire exact de la fonction.
SELECT pg_catalog.format(
  'SET LOCAL ROLE %I; REVOKE ALL PRIVILEGES ON FUNCTION %s FROM PUBLIC; RESET ROLE;',
  owner.rolname,
  function.oid::pg_catalog.regprocedure
)
  FROM pg_catalog.pg_proc AS function
  JOIN pg_catalog.pg_roles AS owner ON owner.oid = function.proowner
 WHERE function.oid =
   'public.guard_realtime_agent_mission_capability_immutable_v1()'::pg_catalog.regprocedure
\gexec

SELECT pg_catalog.format(
  'SET LOCAL ROLE %I; REVOKE ALL PRIVILEGES ON FUNCTION %s FROM %I; RESET ROLE;',
  owner.rolname,
  function.oid::pg_catalog.regprocedure,
  exposed_role.rolname
)
  FROM pg_catalog.pg_proc AS function
  JOIN pg_catalog.pg_roles AS owner ON owner.oid = function.proowner
 CROSS JOIN pg_catalog.pg_roles AS exposed_role
 WHERE function.oid =
   'public.guard_realtime_agent_mission_capability_immutable_v1()'::pg_catalog.regprocedure
   AND exposed_role.rolname IN ('anon', 'authenticated', 'service_role')
\gexec

SELECT pg_catalog.format(
  'SET LOCAL ROLE %I; DROP POLICY IF EXISTS release_flag_agent_mission_authority_select ON public.release_flags; CREATE POLICY release_flag_agent_mission_authority_select ON public.release_flags FOR SELECT USING (current_user = %L); DROP POLICY IF EXISTS release_flag_agent_mission_authority_lock ON public.release_flags; CREATE POLICY release_flag_agent_mission_authority_lock ON public.release_flags FOR UPDATE USING (current_user = %L) WITH CHECK (current_user = %L); RESET ROLE;',
  owner.rolname,
  'bob_agent_mission_release_flag_authority',
  'bob_agent_mission_release_flag_authority',
  'bob_agent_mission_release_flag_authority'
)
  FROM pg_catalog.pg_class AS relation
  JOIN pg_catalog.pg_roles AS owner ON owner.oid = relation.relowner
 WHERE relation.oid = 'public.release_flags'::pg_catalog.regclass
\gexec

-- Après la première release, le helper appartient à l'autorité NOLOGIN. Toute ACL est rejouée
-- sous son owner exact ; le déployeur Supabase non-superuser ne peut pas la modifier directement.
DO $agent_mission_release_flag_function_owner$
BEGIN
  IF EXISTS (
    SELECT 1
      FROM pg_catalog.pg_proc AS function
     WHERE function.oid =
       'public.revalidate_agent_mission_release_flag_v1(text,text,integer)'::pg_catalog.regprocedure
       AND function.proowner <> (
         SELECT role.oid
           FROM pg_catalog.pg_roles AS role
          WHERE role.rolname = current_user
       )
       AND NOT pg_catalog.pg_has_role(current_user, function.proowner, 'SET')
  ) THEN
    RAISE EXCEPTION
      'AgentMission release flag authority function has an inaccessible owner';
  END IF;
END;
$agent_mission_release_flag_function_owner$;

SELECT pg_catalog.format(
  'SET LOCAL ROLE %I; REVOKE ALL PRIVILEGES ON FUNCTION %s FROM PUBLIC; RESET ROLE;',
  owner.rolname,
  function.oid::pg_catalog.regprocedure
)
  FROM pg_catalog.pg_proc AS function
  JOIN pg_catalog.pg_roles AS owner ON owner.oid = function.proowner
 WHERE function.oid =
   'public.revalidate_agent_mission_release_flag_v1(text,text,integer)'::pg_catalog.regprocedure
\gexec

SELECT pg_catalog.format(
  'SET LOCAL ROLE %I; REVOKE ALL PRIVILEGES ON FUNCTION %s FROM %I; RESET ROLE;',
  owner.rolname,
  function.oid::pg_catalog.regprocedure,
  exposed_role.rolname
)
  FROM pg_catalog.pg_proc AS function
  JOIN pg_catalog.pg_roles AS owner ON owner.oid = function.proowner
 CROSS JOIN pg_catalog.pg_roles AS exposed_role
 WHERE function.oid =
   'public.revalidate_agent_mission_release_flag_v1(text,text,integer)'::pg_catalog.regprocedure
   AND exposed_role.rolname IN ('anon', 'authenticated', 'service_role')
\gexec

-- Le trigger de suppression cabinet est SECURITY DEFINER : son ACL est rejouée avec la même
-- discipline propriétaire que le helper d'admission, y compris après un transfert d'ownership.
SELECT pg_catalog.format(
  'SET LOCAL ROLE %I; REVOKE ALL PRIVILEGES ON FUNCTION %s FROM PUBLIC; RESET ROLE;',
  owner.rolname,
  function.oid::pg_catalog.regprocedure
)
  FROM pg_catalog.pg_proc AS function
  JOIN pg_catalog.pg_roles AS owner ON owner.oid = function.proowner
 WHERE function.oid =
   'public.cabinet_delete_release_flag_subjects()'::pg_catalog.regprocedure
\gexec

SELECT pg_catalog.format(
  'SET LOCAL ROLE %I; REVOKE ALL PRIVILEGES ON FUNCTION %s FROM %I; RESET ROLE;',
  owner.rolname,
  function.oid::pg_catalog.regprocedure,
  exposed_role.rolname
)
  FROM pg_catalog.pg_proc AS function
  JOIN pg_catalog.pg_roles AS owner ON owner.oid = function.proowner
 CROSS JOIN pg_catalog.pg_roles AS exposed_role
 WHERE function.oid =
   'public.cabinet_delete_release_flag_subjects()'::pg_catalog.regprocedure
   AND exposed_role.rolname IN ('anon', 'authenticated', 'service_role')
\gexec
