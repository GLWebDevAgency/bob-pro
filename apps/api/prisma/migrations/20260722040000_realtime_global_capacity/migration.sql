-- Bob Live C2 — plafond global distribué, durable et fail-closed.
--
-- Le compteur est une projection transactionnelle exacte des leases physiques. Il compte les
-- états reserved/bound/active/reaping jusqu'à DELETE : une expiration non encore reapée réduit
-- volontairement la disponibilité au lieu d'autoriser une sur-admission fournisseur.

BEGIN;

-- Le verrou couvre le seed exact, la substitution de FK et l'installation des triggers. Aucune
-- écriture N-1 ne peut se glisser entre le count initial et l'autorité transactionnelle.
LOCK TABLE public.realtime_session_leases IN SHARE ROW EXCLUSIVE MODE;

CREATE TABLE public.realtime_global_capacity (
  id INTEGER PRIMARY KEY DEFAULT 1,
  mode TEXT NOT NULL DEFAULT 'tracking',
  "providerId" TEXT,
  "providerModel" TEXT,
  "globalMaxSessions" INTEGER,
  "providerMaxSessions" INTEGER,
  "configVersion" INTEGER,
  "retryAfterSeconds" INTEGER,
  "usedSessions" INTEGER NOT NULL,
  revision BIGINT NOT NULL DEFAULT 0,
  "activatedAt" TIMESTAMPTZ,
  "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT realtime_global_capacity_singleton_check CHECK (id = 1),
  CONSTRAINT realtime_global_capacity_mode_check CHECK (mode IN ('tracking', 'closed', 'active')),
  CONSTRAINT realtime_global_capacity_used_check CHECK ("usedSessions" >= 0),
  CONSTRAINT realtime_global_capacity_revision_check CHECK (revision >= 0),
  CONSTRAINT realtime_global_capacity_shape_check CHECK (
    (
      mode IN ('tracking', 'closed')
      AND "providerId" IS NULL
      AND "providerModel" IS NULL
      AND "globalMaxSessions" IS NULL
      AND "providerMaxSessions" IS NULL
      AND "configVersion" IS NULL
      AND "retryAfterSeconds" IS NULL
      AND "activatedAt" IS NULL
    )
    OR
    (
      mode IN ('closed', 'active')
      AND "providerId" IN ('openai', 'mistral')
      AND length("providerModel") BETWEEN 1 AND 100
      AND "globalMaxSessions" BETWEEN 1 AND 1000
      AND "providerMaxSessions" BETWEEN "globalMaxSessions" AND 10000
      AND "configVersion" BETWEEN 1 AND 2147483647
      AND "retryAfterSeconds" BETWEEN 1 AND 60
      AND "usedSessions" <= "globalMaxSessions"
      AND "activatedAt" IS NOT NULL
    )
  )
);

INSERT INTO public.realtime_global_capacity (id, mode, "usedSessions")
SELECT 1, 'tracking', count(*)::INTEGER
  FROM public.realtime_session_leases;

REVOKE ALL ON TABLE public.realtime_global_capacity FROM PUBLIC;
ALTER TABLE public.realtime_global_capacity ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.realtime_global_capacity FORCE ROW LEVEL SECURITY;
CREATE POLICY realtime_global_capacity_owner
  ON public.realtime_global_capacity
  FOR ALL
  USING (
    current_user = 'bob_realtime_capacity'
    OR current_user = pg_catalog.pg_get_userbyid((
      SELECT relation.relowner
        FROM pg_catalog.pg_class AS relation
       WHERE relation.oid = 'public.realtime_global_capacity'::regclass
    ))
  )
  WITH CHECK (
    current_user = 'bob_realtime_capacity'
    OR current_user = pg_catalog.pg_get_userbyid((
      SELECT relation.relowner
        FROM pg_catalog.pg_class AS relation
       WHERE relation.oid = 'public.realtime_global_capacity'::regclass
    ))
  );

CREATE FUNCTION public.sync_realtime_global_capacity_v1()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
SET row_security = on
SET statement_timeout = '4s'
SET lock_timeout = '1s'
AS $$
DECLARE
  capacity_owner NAME;
  changed_rows INTEGER;
  projected_rows INTEGER;
BEGIN
  SELECT pg_catalog.pg_get_userbyid(relation.relowner)
    INTO STRICT capacity_owner
    FROM pg_catalog.pg_class AS relation
   WHERE relation.oid = 'public.realtime_global_capacity'::regclass;
  IF current_user <> 'bob_realtime_capacity' AND current_user <> capacity_owner THEN
    RAISE EXCEPTION 'realtime capacity authority required' USING ERRCODE = '42501';
  END IF;
  IF TG_TABLE_SCHEMA <> 'public'
     OR TG_TABLE_NAME <> 'realtime_session_leases'
     OR TG_OP NOT IN ('INSERT', 'DELETE') THEN
    RAISE EXCEPTION 'realtime capacity trigger rejected' USING ERRCODE = '22023';
  END IF;

  IF TG_OP = 'INSERT' THEN
    SELECT count(*)::INTEGER INTO changed_rows FROM new_rows;
    IF changed_rows = 0 THEN RETURN NULL; END IF;
    UPDATE public.realtime_global_capacity
       SET "usedSessions" = "usedSessions" + changed_rows,
           revision = revision + 1,
           "updatedAt" = clock_timestamp()
     WHERE id = 1
       AND (
         mode = 'tracking'
         OR (
           mode = 'active'
           AND "usedSessions" + changed_rows <= "globalMaxSessions"
         )
       );
    GET DIAGNOSTICS projected_rows = ROW_COUNT;
    IF projected_rows <> 1 THEN
      RAISE EXCEPTION 'realtime global capacity unavailable' USING ERRCODE = '55000';
    END IF;
    RETURN NULL;
  END IF;

  SELECT count(*)::INTEGER INTO changed_rows FROM old_rows;
  IF changed_rows = 0 THEN RETURN NULL; END IF;
  UPDATE public.realtime_global_capacity
     SET "usedSessions" = "usedSessions" - changed_rows,
         revision = revision + 1,
         "updatedAt" = clock_timestamp()
   WHERE id = 1
     AND "usedSessions" >= changed_rows;
  GET DIAGNOSTICS projected_rows = ROW_COUNT;
  IF projected_rows <> 1 THEN
    RAISE EXCEPTION 'realtime global capacity projection underflow' USING ERRCODE = '55000';
  END IF;
  RETURN NULL;
END;
$$;

CREATE FUNCTION public.deny_realtime_session_lease_truncate_v1()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
SET row_security = on
AS $$
BEGIN
  RAISE EXCEPTION 'realtime leases cannot be truncated' USING ERRCODE = '42501';
END;
$$;

CREATE FUNCTION public.preflight_realtime_global_capacity_v1(
  expected_provider_id TEXT,
  expected_provider_model TEXT,
  expected_global_max_sessions INTEGER,
  expected_provider_max_sessions INTEGER,
  expected_config_version INTEGER
)
RETURNS TABLE (status TEXT, "retryAt" TIMESTAMPTZ)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
SET row_security = on
SET statement_timeout = '2s'
SET lock_timeout = '750ms'
AS $$
DECLARE
  capacity_row RECORD;
  observed_at TIMESTAMPTZ := clock_timestamp();
BEGIN
  IF NULLIF(current_setting('app.current_company_id', TRUE), '') IS NULL
     OR expected_provider_id NOT IN ('openai', 'mistral')
     OR expected_provider_model IS NULL
     OR length(expected_provider_model) NOT BETWEEN 1 AND 100
     OR expected_global_max_sessions NOT BETWEEN 1 AND 1000
     OR expected_provider_max_sessions NOT BETWEEN expected_global_max_sessions AND 10000
     OR expected_config_version NOT BETWEEN 1 AND 2147483647 THEN
    RETURN QUERY SELECT 'unavailable'::TEXT, NULL::TIMESTAMPTZ;
    RETURN;
  END IF;

  -- Un refus plein peut rester sans verrou : une libération concurrente produira au pire un faux
  -- négatif sûr. Toute autorisation est ensuite revalidée sous FOR UPDATE jusqu'au COMMIT externe.
  SELECT capacity.mode, capacity."providerId", capacity."providerModel",
         capacity."globalMaxSessions", capacity."providerMaxSessions",
         capacity."configVersion", capacity."retryAfterSeconds", capacity."usedSessions"
    INTO capacity_row
    FROM public.realtime_global_capacity AS capacity
   WHERE capacity.id = 1;
  IF NOT FOUND
     OR capacity_row.mode <> 'active'
     OR capacity_row."providerId" IS DISTINCT FROM expected_provider_id
     OR capacity_row."providerModel" IS DISTINCT FROM expected_provider_model
     OR capacity_row."globalMaxSessions" IS DISTINCT FROM expected_global_max_sessions
     OR capacity_row."providerMaxSessions" IS DISTINCT FROM expected_provider_max_sessions
     OR capacity_row."configVersion" IS DISTINCT FROM expected_config_version THEN
    RETURN QUERY SELECT 'unavailable'::TEXT, NULL::TIMESTAMPTZ;
    RETURN;
  END IF;
  IF capacity_row."usedSessions" >= capacity_row."globalMaxSessions" THEN
    RETURN QUERY SELECT 'saturated'::TEXT,
      observed_at + make_interval(secs => capacity_row."retryAfterSeconds");
    RETURN;
  END IF;

  SELECT capacity.mode, capacity."providerId", capacity."providerModel",
         capacity."globalMaxSessions", capacity."providerMaxSessions",
         capacity."configVersion", capacity."retryAfterSeconds", capacity."usedSessions"
    INTO STRICT capacity_row
    FROM public.realtime_global_capacity AS capacity
   WHERE capacity.id = 1
   FOR UPDATE;
  IF capacity_row.mode <> 'active'
     OR capacity_row."providerId" IS DISTINCT FROM expected_provider_id
     OR capacity_row."providerModel" IS DISTINCT FROM expected_provider_model
     OR capacity_row."globalMaxSessions" IS DISTINCT FROM expected_global_max_sessions
     OR capacity_row."providerMaxSessions" IS DISTINCT FROM expected_provider_max_sessions
     OR capacity_row."configVersion" IS DISTINCT FROM expected_config_version THEN
    RETURN QUERY SELECT 'unavailable'::TEXT, NULL::TIMESTAMPTZ;
  ELSIF capacity_row."usedSessions" >= capacity_row."globalMaxSessions" THEN
    RETURN QUERY SELECT 'saturated'::TEXT,
      observed_at + make_interval(secs => capacity_row."retryAfterSeconds");
  ELSE
    RETURN QUERY SELECT 'allowed'::TEXT, NULL::TIMESTAMPTZ;
  END IF;
END;
$$;

CREATE FUNCTION public.inspect_realtime_global_capacity_v1()
RETURNS TABLE (
  mode TEXT,
  "providerId" TEXT,
  "providerModel" TEXT,
  "globalMaxSessions" INTEGER,
  "providerMaxSessions" INTEGER,
  "configVersion" INTEGER,
  "retryAfterSeconds" INTEGER,
  "usedSessions" INTEGER,
  revision BIGINT,
  "updatedAt" TIMESTAMPTZ
)
LANGUAGE sql
SECURITY DEFINER
SET search_path = pg_catalog
SET row_security = on
SET statement_timeout = '2s'
SET lock_timeout = '750ms'
AS $$
  SELECT capacity.mode, capacity."providerId", capacity."providerModel",
         capacity."globalMaxSessions", capacity."providerMaxSessions",
         capacity."configVersion", capacity."retryAfterSeconds", capacity."usedSessions",
         capacity.revision, capacity."updatedAt"
    FROM public.realtime_global_capacity AS capacity
   WHERE capacity.id = 1
$$;

REVOKE ALL ON FUNCTION public.sync_realtime_global_capacity_v1() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.deny_realtime_session_lease_truncate_v1() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.preflight_realtime_global_capacity_v1(TEXT, TEXT, INTEGER, INTEGER, INTEGER)
  FROM PUBLIC;
REVOKE ALL ON FUNCTION public.inspect_realtime_global_capacity_v1() FROM PUBLIC;

CREATE TRIGGER "00_realtime_global_capacity_insert"
AFTER INSERT ON public.realtime_session_leases
REFERENCING NEW TABLE AS new_rows
FOR EACH STATEMENT EXECUTE FUNCTION public.sync_realtime_global_capacity_v1();
CREATE TRIGGER "00_realtime_global_capacity_delete"
AFTER DELETE ON public.realtime_session_leases
REFERENCING OLD TABLE AS old_rows
FOR EACH STATEMENT EXECUTE FUNCTION public.sync_realtime_global_capacity_v1();
CREATE TRIGGER "00_realtime_global_capacity_truncate"
BEFORE TRUNCATE ON public.realtime_session_leases
FOR EACH STATEMENT EXECUTE FUNCTION public.deny_realtime_session_lease_truncate_v1();

ALTER TABLE public.realtime_session_leases
  ENABLE ALWAYS TRIGGER "00_realtime_global_capacity_insert";
ALTER TABLE public.realtime_session_leases
  ENABLE ALWAYS TRIGGER "00_realtime_global_capacity_delete";
ALTER TABLE public.realtime_session_leases
  ENABLE ALWAYS TRIGGER "00_realtime_global_capacity_truncate";

-- Une société portant une session distante doit être drainée avant suppression. CASCADE libérait
-- auparavant une place alors que l'appel OpenAI pouvait encore vivre hors de PostgreSQL.
ALTER TABLE public.realtime_session_leases
  DROP CONSTRAINT "realtime_session_leases_companyId_fkey";
ALTER TABLE public.realtime_session_leases
  ADD CONSTRAINT "realtime_session_leases_companyId_fkey"
  FOREIGN KEY ("companyId") REFERENCES public.companies(id)
  ON UPDATE CASCADE ON DELETE RESTRICT NOT VALID;
ALTER TABLE public.realtime_session_leases
  VALIDATE CONSTRAINT "realtime_session_leases_companyId_fkey";

-- L'expand termine fermé. Même un binaire N-1 ne peut rouvrir une session avant l'activation
-- explicite et attestée par le rituel de release.
UPDATE public.realtime_global_capacity
   SET mode = 'closed', revision = revision + 1, "updatedAt" = clock_timestamp()
 WHERE id = 1 AND mode = 'tracking';

COMMIT;
