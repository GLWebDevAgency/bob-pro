-- O7 / ACCOUNT-DELETE-LIFECYCLE-01
-- Expand compatible N-1 : toute transition Company ouverte -> clôturée inscrit durablement la
-- suppression Auth et minimise les notifications dans LA transaction de clôture.

BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

DO $account_deletion_schema_owner$
DECLARE
  owner_oids OID[];
  owner_name TEXT;
BEGIN
  IF pg_catalog.to_regrole('bob_auth_user_deletion_authority') IS NULL THEN
    RAISE EXCEPTION USING
      ERRCODE = '42501',
      MESSAGE = 'AUTH_USER_DELETION_AUTHORITY_ROLE_MISSING';
  END IF;
  SELECT pg_catalog.array_agg(DISTINCT relation.relowner)
    INTO owner_oids
    FROM pg_catalog.pg_class AS relation
   WHERE relation.oid IN (
     'public.companies'::pg_catalog.regclass,
     'public.cabinet_members'::pg_catalog.regclass,
     'public.notification_jobs'::pg_catalog.regclass
   );
  IF pg_catalog.cardinality(owner_oids) <> 1 THEN
    RAISE EXCEPTION USING
      ERRCODE = '42501',
      MESSAGE = 'ACCOUNT_DELETION_SCHEMA_OWNER_DRIFT';
  END IF;
  owner_name := pg_catalog.pg_get_userbyid(owner_oids[1]);
  IF owner_name IS NULL
     OR NOT pg_catalog.pg_has_role(session_user, owner_oids[1], 'SET') THEN
    RAISE EXCEPTION USING
      ERRCODE = '42501',
      MESSAGE = 'ACCOUNT_DELETION_SCHEMA_OWNER_UNAVAILABLE';
  END IF;
  IF current_user::pg_catalog.regrole <> owner_oids[1] THEN
    EXECUTE pg_catalog.format('SET LOCAL ROLE %I', owner_name);
  END IF;
  IF current_user::pg_catalog.regrole <> owner_oids[1] THEN
    RAISE EXCEPTION USING
      ERRCODE = '42501',
      MESSAGE = 'ACCOUNT_DELETION_SCHEMA_OWNER_NOT_ASSUMED';
  END IF;
END;
$account_deletion_schema_owner$;

GRANT USAGE, CREATE ON SCHEMA public TO bob_auth_user_deletion_authority;

CREATE TABLE public.auth_user_deletion_jobs (
  id UUID PRIMARY KEY,
  "companyId" TEXT NOT NULL,
  provider TEXT NOT NULL DEFAULT 'supabase',
  "userId" TEXT,
  "subjectHash" CHAR(64) NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  attempts INTEGER NOT NULL DEFAULT 0,
  "nextAttemptAt" TIMESTAMPTZ(6) NOT NULL DEFAULT pg_catalog.transaction_timestamp(),
  "leaseToken" UUID,
  "lastErrorCode" TEXT,
  "completedAt" TIMESTAMPTZ(6),
  "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT pg_catalog.transaction_timestamp(),
  "updatedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT pg_catalog.transaction_timestamp(),
  CONSTRAINT auth_user_deletion_jobs_company_fkey
    FOREIGN KEY ("companyId") REFERENCES public.companies(id)
    ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT auth_user_deletion_jobs_company_key UNIQUE ("companyId"),
  CONSTRAINT auth_user_deletion_jobs_provider_subject_key UNIQUE (provider, "subjectHash"),
  CONSTRAINT auth_user_deletion_jobs_provider_check CHECK (provider = 'supabase'),
  CONSTRAINT auth_user_deletion_jobs_subject_hash_check
    CHECK ("subjectHash" ~ '^[0-9a-f]{64}$'),
  -- GENERATED CONTRACT: apps/api/src/auth/company-owner-binding.ts
  CONSTRAINT auth_user_deletion_jobs_user_check CHECK (
    "userId" IS NULL
    OR (
      "userId" ~ '^[A-Za-z0-9-]{1,56}$'
      AND "companyId" = 'company-' || "userId"
    )
  ),
  CONSTRAINT auth_user_deletion_jobs_status_check
    CHECK (status IN ('pending', 'failed', 'done')),
  CONSTRAINT auth_user_deletion_jobs_attempts_check
    CHECK (attempts BETWEEN 0 AND 2147483647),
  -- GENERATED CONTRACT: apps/api/src/persistence/auth-user-deletion-jobs.ts
  CONSTRAINT auth_user_deletion_jobs_error_check CHECK (
    "lastErrorCode" IS NULL
    OR "lastErrorCode" IN (
      'network', 'timeout', 'http_408', 'http_429', 'http_4xx', 'http_5xx',
      'misconfigured', 'unknown'
    )
  ),
  CONSTRAINT auth_user_deletion_jobs_state_check CHECK (
    (
      status = 'pending'
      AND "userId" IS NOT NULL
      AND "completedAt" IS NULL
      AND "lastErrorCode" IS NULL
    )
    OR (
      status = 'failed'
      AND "userId" IS NOT NULL
      AND "completedAt" IS NULL
      AND "lastErrorCode" IS NOT NULL
    )
    OR (
      status = 'done'
      AND "userId" IS NULL
      AND "completedAt" IS NOT NULL
      AND "leaseToken" IS NULL
      AND "lastErrorCode" IS NULL
    )
  )
);

-- Les DEFAULT PRIVILEGES du propriétaire peuvent accorder CRUD au runtime au moment exact du
-- CREATE TABLE. La relation est encore invisible hors de cette transaction, mais elle le
-- deviendrait avec ces ACL au COMMIT : on retire donc ici TOUS les grantees non-owner (table et
-- colonnes), avant de reconstruire l'allowlist de l'autorité. Le provisioner post-migration n'est
-- qu'une seconde barrière ; il ne doit jamais être requis pour fermer une fenêtre de rollout.
DO $auth_user_deletion_initial_acl_cleanup$
DECLARE
  privilege RECORD;
  column_privilege RECORD;
  grantee_sql TEXT;
BEGIN
  FOR privilege IN
    SELECT DISTINCT acl.grantee, grantee.rolname
      FROM pg_catalog.pg_class AS relation
     CROSS JOIN LATERAL pg_catalog.aclexplode(
       COALESCE(relation.relacl, pg_catalog.acldefault('r', relation.relowner))
     ) AS acl
      LEFT JOIN pg_catalog.pg_roles AS grantee ON grantee.oid = acl.grantee
     WHERE relation.oid = 'public.auth_user_deletion_jobs'::pg_catalog.regclass
       AND acl.grantee <> relation.relowner
       AND (acl.grantee = 0 OR grantee.rolname IS NOT NULL)
  LOOP
    grantee_sql := CASE
      WHEN privilege.grantee = 0 THEN 'PUBLIC'
      ELSE pg_catalog.format('%I', privilege.rolname)
    END;
    EXECUTE 'REVOKE ALL PRIVILEGES ON TABLE public.auth_user_deletion_jobs FROM '
      || grantee_sql || ' CASCADE';
  END LOOP;

  FOR column_privilege IN
    SELECT DISTINCT attribute.attname, acl.grantee, grantee.rolname
      FROM pg_catalog.pg_class AS relation
      JOIN pg_catalog.pg_attribute AS attribute
        ON attribute.attrelid = relation.oid
       AND attribute.attnum > 0
       AND NOT attribute.attisdropped
     CROSS JOIN LATERAL pg_catalog.aclexplode(attribute.attacl) AS acl
      LEFT JOIN pg_catalog.pg_roles AS grantee ON grantee.oid = acl.grantee
     WHERE relation.oid = 'public.auth_user_deletion_jobs'::pg_catalog.regclass
       AND acl.grantee <> relation.relowner
       AND (acl.grantee = 0 OR grantee.rolname IS NOT NULL)
  LOOP
    grantee_sql := CASE
      WHEN column_privilege.grantee = 0 THEN 'PUBLIC'
      ELSE pg_catalog.format('%I', column_privilege.rolname)
    END;
    EXECUTE pg_catalog.format(
      'REVOKE SELECT (%I), INSERT (%I), UPDATE (%I), REFERENCES (%I) ON TABLE public.auth_user_deletion_jobs FROM %s CASCADE',
      column_privilege.attname,
      column_privilege.attname,
      column_privilege.attname,
      column_privilege.attname,
      grantee_sql
    );
  END LOOP;
END;
$auth_user_deletion_initial_acl_cleanup$;

CREATE INDEX auth_user_deletion_jobs_due_idx
  ON public.auth_user_deletion_jobs ("nextAttemptAt", "createdAt", id)
  WHERE status IN ('pending', 'failed');
CREATE UNIQUE INDEX auth_user_deletion_jobs_lease_key
  ON public.auth_user_deletion_jobs ("leaseToken")
  WHERE "leaseToken" IS NOT NULL;

ALTER TABLE public.auth_user_deletion_jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.auth_user_deletion_jobs FORCE ROW LEVEL SECURITY;

CREATE POLICY auth_user_deletion_authority_select
  ON public.auth_user_deletion_jobs FOR SELECT
  TO bob_auth_user_deletion_authority USING (TRUE);
CREATE POLICY auth_user_deletion_authority_insert
  ON public.auth_user_deletion_jobs FOR INSERT
  TO bob_auth_user_deletion_authority WITH CHECK (TRUE);
CREATE POLICY auth_user_deletion_authority_update
  ON public.auth_user_deletion_jobs FOR UPDATE
  TO bob_auth_user_deletion_authority USING (TRUE) WITH CHECK (TRUE);

CREATE POLICY cabinet_member_auth_deletion_subject_select
  ON public.cabinet_members FOR SELECT
  TO bob_auth_user_deletion_authority
  USING (
    "userId" = NULLIF(
      pg_catalog.current_setting('app.auth_user_deletion_subject_id', TRUE),
      ''
    )
  );
CREATE POLICY company_auth_deletion_subject_select
  ON public.companies FOR SELECT
  TO bob_auth_user_deletion_authority
  USING (
    id = NULLIF(
      pg_catalog.current_setting('app.auth_user_deletion_company_id', TRUE),
      ''
    )
  );
CREATE POLICY company_auth_deletion_closed_claim_select
  ON public.companies FOR SELECT
  TO bob_auth_user_deletion_authority
  USING (
    "closedAt" IS NOT NULL
    AND pg_catalog.current_setting('app.auth_user_deletion_claim_mode', TRUE)
      = 'closed-company-v1'
  );
CREATE POLICY company_auth_deletion_subject_update
  ON public.companies FOR UPDATE
  TO bob_auth_user_deletion_authority
  USING (
    id = NULLIF(
      pg_catalog.current_setting('app.auth_user_deletion_company_id', TRUE),
      ''
    )
  )
  WITH CHECK (
    id = NULLIF(
      pg_catalog.current_setting('app.auth_user_deletion_company_id', TRUE),
      ''
    )
  );
CREATE POLICY notification_job_auth_deletion_subject_select
  ON public.notification_jobs FOR SELECT
  TO bob_auth_user_deletion_authority
  USING (
    "companyId" = NULLIF(
      pg_catalog.current_setting('app.auth_user_deletion_company_id', TRUE),
      ''
    )
  );
CREATE POLICY notification_job_auth_deletion_subject_update
  ON public.notification_jobs FOR UPDATE
  TO bob_auth_user_deletion_authority
  USING (
    "companyId" = NULLIF(
      pg_catalog.current_setting('app.auth_user_deletion_company_id', TRUE),
      ''
    )
  )
  WITH CHECK (
    "companyId" = NULLIF(
      pg_catalog.current_setting('app.auth_user_deletion_company_id', TRUE),
      ''
    )
  );

REVOKE ALL PRIVILEGES ON TABLE public.auth_user_deletion_jobs FROM PUBLIC;
GRANT SELECT, INSERT, UPDATE ON TABLE public.auth_user_deletion_jobs
  TO bob_auth_user_deletion_authority;
GRANT SELECT ON TABLE public.cabinet_members, public.companies, public.notification_jobs
  TO bob_auth_user_deletion_authority;
-- PostgreSQL exige un privilège UPDATE pour SELECT ... FOR UPDATE ; seule la colonne clé est
-- accordée, et la policy UPDATE reste bornée au companyId placé par la fonction.
GRANT UPDATE (id) ON TABLE public.companies TO bob_auth_user_deletion_authority;
GRANT UPDATE (
  status, payload, recipient, subject, "payloadFingerprint", "leaseToken", "lastError", "updatedAt"
) ON TABLE public.notification_jobs TO bob_auth_user_deletion_authority;
REVOKE DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN
  ON TABLE public.auth_user_deletion_jobs FROM bob_auth_user_deletion_authority;

DO $account_deletion_exposed_table_roles$
DECLARE
  exposed_role TEXT;
BEGIN
  FOREACH exposed_role IN ARRAY ARRAY['anon', 'authenticated', 'service_role']::TEXT[] LOOP
    IF pg_catalog.to_regrole(exposed_role) IS NOT NULL THEN
      EXECUTE pg_catalog.format(
        'REVOKE ALL PRIVILEGES ON TABLE public.auth_user_deletion_jobs FROM %I',
        exposed_role
      );
    END IF;
  END LOOP;
END;
$account_deletion_exposed_table_roles$;

SET LOCAL ROLE bob_auth_user_deletion_authority;

CREATE FUNCTION public.auth_user_deletion_subject_hash_v1(p_user_id TEXT)
RETURNS TEXT
LANGUAGE sql
STABLE
STRICT
PARALLEL SAFE
SET search_path = pg_catalog
AS $function$
  SELECT pg_catalog.encode(
    pg_catalog.sha256(
      pg_catalog.convert_to('bob.auth-user-deletion.v1', 'UTF8')
      || pg_catalog.decode('00', 'hex')
      || pg_catalog.convert_to(p_user_id, 'UTF8')
    ),
    'hex'
  );
$function$;

CREATE FUNCTION public.enqueue_auth_user_deletion_internal_v1(
  p_request_id UUID,
  p_company_id TEXT,
  p_user_id TEXT
)
RETURNS TABLE (
  job_id UUID,
  job_status TEXT,
  already_requested BOOLEAN,
  rejection_reason TEXT
)
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog
SET row_security = on
AS $function$
DECLARE
  v_hash TEXT;
  v_inserted BOOLEAN;
  v_id UUID;
  v_status TEXT;
  v_company TEXT;
  v_provider TEXT;
  v_stored_hash TEXT;
  v_found BOOLEAN;
BEGIN
  IF p_request_id IS NULL
     OR p_company_id IS NULL
     OR p_user_id IS NULL
     OR p_user_id !~ '^[A-Za-z0-9-]{1,56}$'
     OR p_company_id IS DISTINCT FROM 'company-' || p_user_id THEN
    RETURN QUERY
      SELECT NULL::UUID, NULL::TEXT, NULL::BOOLEAN,
             'company_owner_binding_mismatch'::TEXT;
    RETURN;
  END IF;

  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('bob.auth-subject-lifecycle.v1:' || p_user_id, 0)
  );
  PERFORM pg_catalog.set_config(
    'app.auth_user_deletion_subject_id', p_user_id, TRUE
  );
  IF EXISTS (
    SELECT 1
      FROM public.cabinet_members AS member
     WHERE member."userId" = p_user_id
       AND member.status::TEXT IN ('active', 'suspended')
  ) THEN
    RETURN QUERY
      SELECT NULL::UUID, NULL::TEXT, NULL::BOOLEAN,
             'active_cabinet_memberships'::TEXT;
    RETURN;
  END IF;

  v_hash := public.auth_user_deletion_subject_hash_v1(p_user_id);
  INSERT INTO public.auth_user_deletion_jobs (
    id, "companyId", provider, "userId", "subjectHash", status, attempts,
    "nextAttemptAt", "leaseToken", "lastErrorCode", "completedAt", "createdAt", "updatedAt"
  ) VALUES (
    p_request_id, p_company_id, 'supabase', p_user_id, v_hash, 'pending', 0,
    pg_catalog.statement_timestamp(), NULL, NULL, NULL,
    pg_catalog.statement_timestamp(), pg_catalog.statement_timestamp()
  )
  ON CONFLICT DO NOTHING
  RETURNING id, status INTO v_id, v_status;
  v_inserted := FOUND;

  IF NOT v_inserted THEN
    SELECT job.id, job.status, job."companyId", job.provider, job."subjectHash"::TEXT
      INTO v_id, v_status, v_company, v_provider, v_stored_hash
      FROM public.auth_user_deletion_jobs AS job
     WHERE job."companyId" = p_company_id;
    v_found := FOUND;
    IF NOT v_found THEN
      SELECT job.id, job.status, job."companyId", job.provider, job."subjectHash"::TEXT
        INTO v_id, v_status, v_company, v_provider, v_stored_hash
        FROM public.auth_user_deletion_jobs AS job
       WHERE job.provider = 'supabase'
         AND job."subjectHash" = v_hash;
      v_found := FOUND;
    END IF;
    IF NOT v_found THEN
      SELECT job.id, job.status, job."companyId", job.provider, job."subjectHash"::TEXT
        INTO v_id, v_status, v_company, v_provider, v_stored_hash
        FROM public.auth_user_deletion_jobs AS job
       WHERE job.id = p_request_id;
      v_found := FOUND;
    END IF;
    IF NOT v_found
       OR v_company IS DISTINCT FROM p_company_id
       OR v_provider IS DISTINCT FROM 'supabase'
       OR v_stored_hash IS DISTINCT FROM v_hash THEN
      RAISE EXCEPTION USING
        ERRCODE = '23505',
        MESSAGE = 'AUTH_USER_DELETION_IDEMPOTENCY_CONFLICT',
        CONSTRAINT = 'auth_user_deletion_jobs_idempotency';
    END IF;
  END IF;

  RETURN QUERY SELECT v_id, v_status, NOT v_inserted, NULL::TEXT;
END;
$function$;

CREATE FUNCTION public.request_auth_user_deletion_v1(
  p_request_id UUID,
  p_company_id TEXT,
  p_user_id TEXT
)
RETURNS TABLE (
  outcome TEXT,
  "requestId" UUID,
  status TEXT,
  "alreadyRequested" BOOLEAN,
  "rejectionReason" TEXT
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
SET row_security = on
SET lock_timeout = '1s'
SET statement_timeout = '4s'
AS $function$
DECLARE
  request_result RECORD;
  v_closed_at TIMESTAMP;
  v_company_found BOOLEAN;
  v_existing_id UUID;
  v_existing_status TEXT;
  v_existing_provider TEXT;
  v_existing_hash TEXT;
  v_expected_hash TEXT;
  v_existing_found BOOLEAN;
BEGIN
  IF NULLIF(
       pg_catalog.current_setting('app.current_company_id', TRUE), ''
     ) IS DISTINCT FROM p_company_id
     OR p_request_id IS NULL
     OR p_company_id IS NULL
     OR p_user_id IS NULL
     OR p_user_id !~ '^[A-Za-z0-9-]{1,56}$'
     OR p_company_id IS DISTINCT FROM 'company-' || p_user_id THEN
    RETURN QUERY SELECT
      'rejected'::TEXT, NULL::UUID, NULL::TEXT, NULL::BOOLEAN,
      'company_owner_binding_mismatch'::TEXT;
    RETURN;
  END IF;

  -- PRE-FLIGHT seulement tant que la Company est ouverte. L'ancienne version insérait ici une
  -- ligne pending, donc un appel RPC isolé pouvait être claimé puis supprimer Auth sans fermer
  -- le tenant. Le requestId vit maintenant dans un GUC transaction-local consommé uniquement
  -- par le trigger Company ouverte -> fermée. Sans transition dans CETTE transaction : aucun job.
  PERFORM pg_catalog.set_config(
    'app.auth_user_deletion_company_id', p_company_id, TRUE
  );
  SELECT company."closedAt"
    INTO v_closed_at
    FROM public.companies AS company
   WHERE company.id = p_company_id
   FOR UPDATE;
  v_company_found := FOUND;
  IF NOT v_company_found THEN
    RETURN QUERY SELECT
      'rejected'::TEXT, NULL::UUID, NULL::TEXT, NULL::BOOLEAN,
      'company_owner_binding_mismatch'::TEXT;
    RETURN;
  END IF;

  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('bob.auth-subject-lifecycle.v1:' || p_user_id, 0)
  );
  PERFORM pg_catalog.set_config(
    'app.auth_user_deletion_subject_id', p_user_id, TRUE
  );
  IF EXISTS (
    SELECT 1
      FROM public.cabinet_members AS member
     WHERE member."userId" = p_user_id
       AND member.status::TEXT IN ('active', 'suspended')
  ) THEN
    RETURN QUERY SELECT
      'rejected'::TEXT, NULL::UUID, NULL::TEXT, NULL::BOOLEAN,
      'active_cabinet_memberships'::TEXT;
    RETURN;
  END IF;

  IF v_closed_at IS NULL THEN
    -- Une ligne historique/injectée reste non-claimable tant que la Company est ouverte, mais la
    -- projection doit tout de même corréler le VRAI reçu que le trigger conservera ensuite.
    -- Sinon l'API auditerait p_request_id alors que l'unique row préexistante porte un autre UUID.
    v_expected_hash := public.auth_user_deletion_subject_hash_v1(p_user_id);
    SELECT job.id, job.status, job.provider, job."subjectHash"::TEXT
      INTO v_existing_id, v_existing_status, v_existing_provider, v_existing_hash
      FROM public.auth_user_deletion_jobs AS job
     WHERE job."companyId" = p_company_id;
    v_existing_found := FOUND;
    IF v_existing_found
       AND (
         v_existing_provider IS DISTINCT FROM 'supabase'
         OR v_existing_hash IS DISTINCT FROM v_expected_hash
       ) THEN
      RAISE EXCEPTION USING
        ERRCODE = '23505',
        MESSAGE = 'AUTH_USER_DELETION_IDEMPOTENCY_CONFLICT',
        CONSTRAINT = 'auth_user_deletion_jobs_idempotency';
    END IF;
    PERFORM pg_catalog.set_config(
      'app.auth_user_deletion_request_id',
      CASE WHEN v_existing_found THEN v_existing_id ELSE p_request_id END::TEXT,
      TRUE
    );
    PERFORM pg_catalog.set_config(
      'app.auth_user_deletion_request_company_id', p_company_id, TRUE
    );
    RETURN QUERY SELECT
      'accepted'::TEXT,
      CASE WHEN v_existing_found THEN v_existing_id ELSE p_request_id END,
      CASE WHEN v_existing_found THEN v_existing_status ELSE 'pending'::TEXT END,
      v_existing_found,
      NULL::TEXT;
    RETURN;
  END IF;

  -- Réparation/idempotence : une Company déjà fermée peut recréer un job historique
  -- manquant, mais jamais l'inverse. Le même garde owner/Cabinet demeure dans l'interne.
  SELECT * INTO STRICT request_result
    FROM public.enqueue_auth_user_deletion_internal_v1(
      p_request_id, p_company_id, p_user_id
    );
  IF request_result.rejection_reason IS NOT NULL THEN
    RETURN QUERY SELECT
      'rejected'::TEXT, NULL::UUID, NULL::TEXT, NULL::BOOLEAN,
      request_result.rejection_reason::TEXT;
    RETURN;
  END IF;
  RETURN QUERY SELECT
    'accepted'::TEXT,
    request_result.job_id::UUID,
    request_result.job_status::TEXT,
    request_result.already_requested::BOOLEAN,
    NULL::TEXT;
END;
$function$;

CREATE FUNCTION public.guard_notification_job_open_company_v1()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
SET row_security = on
SET lock_timeout = '1s'
SET statement_timeout = '4s'
AS $function$
DECLARE
  v_closed_at TIMESTAMP;
  v_found BOOLEAN;
  v_expected_status public."NotificationJobStatus";
  v_cleanup_shape BOOLEAN;
BEGIN
  PERFORM pg_catalog.set_config(
    'app.auth_user_deletion_company_id', NEW."companyId", TRUE
  );
  BEGIN
    SELECT company."closedAt"
      INTO v_closed_at
      FROM public.companies AS company
     WHERE company.id = NEW."companyId"
     FOR SHARE NOWAIT;
    v_found := FOUND;
  EXCEPTION WHEN lock_not_available THEN
    RAISE EXCEPTION USING
      ERRCODE = '55P03',
      MESSAGE = 'NOTIFICATION_COMPANY_LIFECYCLE_BUSY';
  END;
  IF NOT v_found THEN
    RAISE EXCEPTION USING
      ERRCODE = '23503',
      MESSAGE = 'NOTIFICATION_COMPANY_MISSING',
      CONSTRAINT = 'notification_jobs_open_company_fence';
  END IF;
  IF v_closed_at IS NULL THEN
    RETURN NEW;
  END IF;

  IF TG_OP = 'UPDATE' THEN
    v_expected_status := CASE
      WHEN OLD.status::TEXT IN ('pending', 'failed')
        THEN 'cancelled'::public."NotificationJobStatus"
      ELSE OLD.status
    END;
    v_cleanup_shape :=
      NEW.status = v_expected_status
      AND NEW.payload IS NULL
      AND NEW.recipient = '[redacted]'
      AND NEW.subject = '[redacted]'
      AND NEW."payloadFingerprint" IS NULL
      AND NEW."leaseToken" IS NULL
      AND NEW."lastError" IS NULL
      AND (
        OLD.status::TEXT IN ('pending', 'failed')
        OR NEW."updatedAt" IS NOT DISTINCT FROM OLD."updatedAt"
      )
      AND (
        pg_catalog.to_jsonb(NEW) - ARRAY[
          'status', 'payload', 'recipient', 'subject', 'payloadFingerprint',
          'leaseToken', 'lastError', 'updatedAt'
        ]::TEXT[]
      ) IS NOT DISTINCT FROM (
        pg_catalog.to_jsonb(OLD) - ARRAY[
          'status', 'payload', 'recipient', 'subject', 'payloadFingerprint',
          'leaseToken', 'lastError', 'updatedAt'
        ]::TEXT[]
      );
    IF v_cleanup_shape THEN
      RETURN NEW;
    END IF;
  END IF;
  RAISE EXCEPTION USING
    ERRCODE = '23514',
    MESSAGE = 'NOTIFICATION_COMPANY_CLOSED',
    CONSTRAINT = 'notification_jobs_open_company_fence';
END;
$function$;

CREATE FUNCTION public.enqueue_auth_user_deletion_on_company_close_v1()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
SET row_security = on
SET lock_timeout = '1s'
SET statement_timeout = '4s'
AS $function$
DECLARE
  request_result RECORD;
  v_user_id TEXT;
  v_request_id_text TEXT;
  v_request_company_id TEXT;
  v_request_id UUID;
BEGIN
  v_user_id := pg_catalog.substr(NEW.id, 9);
  v_request_id_text := NULLIF(
    pg_catalog.current_setting('app.auth_user_deletion_request_id', TRUE),
    ''
  );
  v_request_company_id := NULLIF(
    pg_catalog.current_setting('app.auth_user_deletion_request_company_id', TRUE),
    ''
  );
  IF v_request_company_id = NEW.id
     AND v_request_id_text ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' THEN
    v_request_id := v_request_id_text::UUID;
  ELSE
    -- Writer N-1 / rattrapage SQL : aucun pre-flight O7 n'existe, le trigger reste autonome.
    v_request_id := pg_catalog.gen_random_uuid();
  END IF;
  SELECT * INTO STRICT request_result
    FROM public.enqueue_auth_user_deletion_internal_v1(
      v_request_id, NEW.id, v_user_id
    );
  IF request_result.rejection_reason = 'active_cabinet_memberships' THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'ACCOUNT_DELETION_ACTIVE_CABINET_MEMBERSHIPS',
      CONSTRAINT = 'companies_auth_deletion_cabinet_fence';
  END IF;
  IF request_result.rejection_reason IS NOT NULL THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'COMPANY_OWNER_BINDING_MISMATCH',
      CONSTRAINT = 'companies_auth_deletion_owner_binding';
  END IF;

  PERFORM pg_catalog.set_config(
    'app.auth_user_deletion_company_id', NEW.id, TRUE
  );
  -- Un requestId ne peut jamais être réutilisé par une seconde transition dans la transaction.
  PERFORM pg_catalog.set_config('app.auth_user_deletion_request_id', '', TRUE);
  PERFORM pg_catalog.set_config('app.auth_user_deletion_request_company_id', '', TRUE);
  UPDATE public.notification_jobs AS job
     SET status = CASE
           WHEN job.status::TEXT IN ('pending', 'failed')
             THEN 'cancelled'::public."NotificationJobStatus"
           ELSE job.status
         END,
         payload = NULL,
         recipient = '[redacted]',
         subject = '[redacted]',
         "payloadFingerprint" = NULL,
         "leaseToken" = NULL,
         "lastError" = NULL,
         "updatedAt" = CASE
           WHEN job.status::TEXT IN ('pending', 'failed')
             THEN pg_catalog.statement_timestamp()
           ELSE job."updatedAt"
         END
   WHERE job."companyId" = NEW.id
     AND (
       job.status::TEXT IN ('pending', 'failed')
       OR job.payload IS NOT NULL
       OR job.recipient <> '[redacted]'
       OR job.subject <> '[redacted]'
       OR job."payloadFingerprint" IS NOT NULL
       OR job."leaseToken" IS NOT NULL
       OR job."lastError" IS NOT NULL
     );
  RETURN NEW;
END;
$function$;

CREATE FUNCTION public.guard_cabinet_member_auth_deletion_v1()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
SET row_security = on
SET lock_timeout = '1s'
SET statement_timeout = '4s'
AS $function$
DECLARE
  v_subject_id TEXT;
  v_hash TEXT;
BEGIN
  -- UPDATE userId prend les deux verrous dans un ordre stable ; DELETE/revocation prennent aussi
  -- le verrou afin qu'une request concurrente observe entièrement l'avant ou l'après.
  FOR v_subject_id IN
    SELECT subject_id
      FROM (
        SELECT CASE WHEN TG_OP <> 'INSERT' THEN OLD."userId" END AS subject_id
        UNION
        SELECT CASE WHEN TG_OP <> 'DELETE' THEN NEW."userId" END AS subject_id
      ) AS subjects
     WHERE subject_id IS NOT NULL
     ORDER BY subject_id
  LOOP
    PERFORM pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtextextended(
        'bob.auth-subject-lifecycle.v1:' || v_subject_id,
        0
      )
    );
  END LOOP;

  IF TG_OP <> 'DELETE' AND NEW.status::TEXT <> 'revoked' THEN
    PERFORM pg_catalog.set_config(
      'app.auth_user_deletion_subject_id', NEW."userId", TRUE
    );
    v_hash := public.auth_user_deletion_subject_hash_v1(NEW."userId");
    IF EXISTS (
      SELECT 1
        FROM public.auth_user_deletion_jobs AS job
       WHERE job.provider = 'supabase'
         AND job."subjectHash" = v_hash
    ) THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        MESSAGE = 'CABINET_MEMBER_AUTH_SUBJECT_DELETION_REQUESTED',
        CONSTRAINT = 'cabinet_members_auth_user_deletion_fence';
    END IF;
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END;
$function$;

CREATE FUNCTION public.claim_auth_user_deletions_v1(p_limit INTEGER)
RETURNS TABLE (
  id UUID,
  "companyId" TEXT,
  "userId" TEXT,
  "leaseToken" UUID,
  attempts INTEGER
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
SET row_security = on
SET lock_timeout = '1s'
SET statement_timeout = '4s'
AS $function$
BEGIN
  IF p_limit IS NULL OR p_limit < 1 OR p_limit > 100 THEN
    RAISE EXCEPTION USING
      ERRCODE = '22023',
      MESSAGE = 'AUTH_USER_DELETION_CLAIM_LIMIT_INVALID';
  END IF;
  -- Défense indépendante de la RPC request : même une ligne injectée par le propriétaire
  -- ou laissée par une ancienne version n'est jamais livrée tant que la Company reste ouverte.
  PERFORM pg_catalog.set_config(
    'app.auth_user_deletion_claim_mode', 'closed-company-v1', TRUE
  );
  RETURN QUERY
  WITH candidate AS (
    SELECT job.id
      FROM public.auth_user_deletion_jobs AS job
      JOIN public.companies AS company
        ON company.id = job."companyId"
       AND company."closedAt" IS NOT NULL
     WHERE job.status IN ('pending', 'failed')
       AND job."userId" IS NOT NULL
       AND job."nextAttemptAt" <= pg_catalog.statement_timestamp()
     ORDER BY job."nextAttemptAt", job."createdAt", job.id
     FOR UPDATE OF job SKIP LOCKED
     LIMIT p_limit
  ), claimed AS (
    UPDATE public.auth_user_deletion_jobs AS job
       SET attempts = CASE
             WHEN job.attempts = 2147483647 THEN job.attempts
             ELSE job.attempts + 1
           END,
           "leaseToken" = pg_catalog.gen_random_uuid(),
           "nextAttemptAt" = pg_catalog.statement_timestamp()
             + pg_catalog.make_interval(mins => 5),
           "updatedAt" = pg_catalog.statement_timestamp()
      FROM candidate
     WHERE job.id = candidate.id
    RETURNING job.id, job."companyId", job."userId", job."leaseToken", job.attempts
  )
  SELECT claimed.id, claimed."companyId", claimed."userId", claimed."leaseToken", claimed.attempts
    FROM claimed;
END;
$function$;

CREATE FUNCTION public.complete_auth_user_deletion_v1(
  p_id UUID,
  p_lease_token UUID
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
SET row_security = on
SET lock_timeout = '1s'
SET statement_timeout = '4s'
AS $function$
BEGIN
  UPDATE public.auth_user_deletion_jobs AS job
     SET status = 'done',
         "userId" = NULL,
         "leaseToken" = NULL,
         "lastErrorCode" = NULL,
         "completedAt" = pg_catalog.statement_timestamp(),
         "nextAttemptAt" = pg_catalog.statement_timestamp(),
         "updatedAt" = pg_catalog.statement_timestamp()
   WHERE job.id = p_id
     AND job."leaseToken" = p_lease_token
     AND job.status IN ('pending', 'failed')
     AND job."nextAttemptAt" > pg_catalog.statement_timestamp();
  RETURN FOUND;
END;
$function$;

CREATE FUNCTION public.retry_auth_user_deletion_v1(
  p_id UUID,
  p_lease_token UUID,
  p_error_code TEXT,
  p_retry_delay_ms INTEGER
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
SET row_security = on
SET lock_timeout = '1s'
SET statement_timeout = '4s'
AS $function$
BEGIN
  IF p_error_code IS NULL
     OR p_error_code NOT IN (
       'network', 'timeout', 'http_408', 'http_429', 'http_4xx', 'http_5xx',
       'misconfigured', 'unknown'
     )
     OR p_retry_delay_ms IS NULL
     OR p_retry_delay_ms < 1000
     OR p_retry_delay_ms > 7200000 THEN
    RAISE EXCEPTION USING
      ERRCODE = '22023',
      MESSAGE = 'AUTH_USER_DELETION_RETRY_INPUT_INVALID';
  END IF;
  UPDATE public.auth_user_deletion_jobs AS job
     SET status = 'failed',
         "leaseToken" = NULL,
         "lastErrorCode" = p_error_code,
         "nextAttemptAt" = pg_catalog.statement_timestamp()
           + pg_catalog.make_interval(secs => p_retry_delay_ms::DOUBLE PRECISION / 1000.0),
         "updatedAt" = pg_catalog.statement_timestamp()
   WHERE job.id = p_id
     AND job."leaseToken" = p_lease_token
     AND job.status IN ('pending', 'failed')
     AND job."nextAttemptAt" > pg_catalog.statement_timestamp();
  RETURN FOUND;
END;
$function$;

REVOKE ALL PRIVILEGES ON FUNCTION public.auth_user_deletion_subject_hash_v1(TEXT) FROM PUBLIC;
REVOKE ALL PRIVILEGES ON FUNCTION public.enqueue_auth_user_deletion_internal_v1(UUID, TEXT, TEXT) FROM PUBLIC;
REVOKE ALL PRIVILEGES ON FUNCTION public.request_auth_user_deletion_v1(UUID, TEXT, TEXT) FROM PUBLIC;
REVOKE ALL PRIVILEGES ON FUNCTION public.guard_notification_job_open_company_v1() FROM PUBLIC;
REVOKE ALL PRIVILEGES ON FUNCTION public.enqueue_auth_user_deletion_on_company_close_v1() FROM PUBLIC;
REVOKE ALL PRIVILEGES ON FUNCTION public.guard_cabinet_member_auth_deletion_v1() FROM PUBLIC;
REVOKE ALL PRIVILEGES ON FUNCTION public.claim_auth_user_deletions_v1(INTEGER) FROM PUBLIC;
REVOKE ALL PRIVILEGES ON FUNCTION public.complete_auth_user_deletion_v1(UUID, UUID) FROM PUBLIC;
REVOKE ALL PRIVILEGES ON FUNCTION public.retry_auth_user_deletion_v1(UUID, UUID, TEXT, INTEGER) FROM PUBLIC;

RESET ROLE;

DO $account_deletion_trigger_owner$
DECLARE
  owner_oid OID;
  owner_name TEXT;
BEGIN
  SELECT relation.relowner, pg_catalog.pg_get_userbyid(relation.relowner)
    INTO STRICT owner_oid, owner_name
    FROM pg_catalog.pg_class AS relation
   WHERE relation.oid = 'public.companies'::pg_catalog.regclass;
  IF NOT pg_catalog.pg_has_role(session_user, owner_oid, 'SET') THEN
    RAISE EXCEPTION USING
      ERRCODE = '42501',
      MESSAGE = 'ACCOUNT_DELETION_TRIGGER_OWNER_UNAVAILABLE';
  END IF;
  IF current_user::pg_catalog.regrole <> owner_oid THEN
    EXECUTE pg_catalog.format('SET LOCAL ROLE %I', owner_name);
  END IF;
END;
$account_deletion_trigger_owner$;

CREATE TRIGGER "00_notification_jobs_open_company_v1"
BEFORE INSERT OR UPDATE ON public.notification_jobs
FOR EACH ROW EXECUTE FUNCTION public.guard_notification_job_open_company_v1();

CREATE TRIGGER companies_auth_user_deletion_n1_v1
AFTER UPDATE OF "closedAt" ON public.companies
FOR EACH ROW
WHEN (OLD."closedAt" IS NULL AND NEW."closedAt" IS NOT NULL)
EXECUTE FUNCTION public.enqueue_auth_user_deletion_on_company_close_v1();

CREATE TRIGGER "00_cabinet_members_auth_deletion_fence"
BEFORE INSERT OR UPDATE OR DELETE ON public.cabinet_members
FOR EACH ROW EXECUTE FUNCTION public.guard_cabinet_member_auth_deletion_v1();

REVOKE CREATE ON SCHEMA public FROM bob_auth_user_deletion_authority;
GRANT USAGE ON SCHEMA public TO bob_auth_user_deletion_authority;

COMMIT;
