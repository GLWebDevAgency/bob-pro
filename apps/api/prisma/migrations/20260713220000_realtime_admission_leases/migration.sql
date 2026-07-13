-- Bob Live — admission distribuée multi-répliques, quotas glissants et bail CAS.
-- Les identités utilisateur et les tokens 256 bits restent hors base sous forme brute.

CREATE TABLE "realtime_admission_events" (
  "id" UUID NOT NULL,
  "companyId" TEXT NOT NULL,
  "subjectHash" CHAR(64) NOT NULL,
  "sessionId" UUID NOT NULL,
  "admittedAt" TIMESTAMPTZ NOT NULL,
  CONSTRAINT "realtime_admission_events_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "realtime_admission_events_session_id_key" UNIQUE ("sessionId"),
  CONSTRAINT "realtime_admission_events_companyId_fkey"
    FOREIGN KEY ("companyId") REFERENCES "companies"("id")
    ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "realtime_admission_events_subject_hash_check"
    CHECK ("subjectHash"::TEXT ~ '^[a-f0-9]{64}$')
);

CREATE INDEX "realtime_admission_events_tenant_window_idx"
  ON "realtime_admission_events"("companyId", "admittedAt");
CREATE INDEX "realtime_admission_events_subject_window_idx"
  ON "realtime_admission_events"("companyId", "subjectHash", "admittedAt");

CREATE TABLE "realtime_session_leases" (
  "companyId" TEXT NOT NULL,
  "subjectHash" CHAR(64) NOT NULL,
  "sessionId" UUID NOT NULL,
  "leaseTokenHash" CHAR(64) NOT NULL,
  "state" TEXT NOT NULL,
  "providerCallId" TEXT,
  "reaperTokenHash" CHAR(64),
  "reservedAt" TIMESTAMPTZ NOT NULL,
  "leaseExpiresAt" TIMESTAMPTZ NOT NULL,
  "hardExpiresAt" TIMESTAMPTZ NOT NULL,
  "activatedAt" TIMESTAMPTZ,
  "updatedAt" TIMESTAMPTZ NOT NULL,
  "version" INTEGER NOT NULL DEFAULT 1,
  CONSTRAINT "realtime_session_leases_pkey" PRIMARY KEY ("companyId", "subjectHash"),
  CONSTRAINT "realtime_session_leases_companyId_fkey"
    FOREIGN KEY ("companyId") REFERENCES "companies"("id")
    ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "realtime_session_leases_session_id_key" UNIQUE ("sessionId"),
  CONSTRAINT "realtime_session_leases_token_hash_key" UNIQUE ("leaseTokenHash"),
  CONSTRAINT "realtime_session_leases_provider_call_id_key" UNIQUE ("providerCallId"),
  CONSTRAINT "realtime_session_leases_reaper_token_hash_key" UNIQUE ("reaperTokenHash"),
  CONSTRAINT "realtime_session_leases_subject_hash_check"
    CHECK ("subjectHash"::TEXT ~ '^[a-f0-9]{64}$'),
  CONSTRAINT "realtime_session_leases_token_hash_check"
    CHECK ("leaseTokenHash"::TEXT ~ '^[a-f0-9]{64}$'),
  CONSTRAINT "realtime_session_leases_reaper_token_hash_check"
    CHECK ("reaperTokenHash" IS NULL OR "reaperTokenHash"::TEXT ~ '^[a-f0-9]{64}$'),
  CONSTRAINT "realtime_session_leases_provider_call_id_check"
    CHECK (
      "providerCallId" IS NULL
      OR (length("providerCallId") BETWEEN 1 AND 200 AND "providerCallId" ~ '^[A-Za-z0-9._:-]+$')
    ),
  CONSTRAINT "realtime_session_leases_state_check"
    CHECK ("state" IN ('reserved', 'bound', 'active', 'reaping')),
  CONSTRAINT "realtime_session_leases_version_check" CHECK ("version" > 0),
  CONSTRAINT "realtime_session_leases_time_check"
    CHECK (
      "hardExpiresAt" > "reservedAt"
      AND "leaseExpiresAt" > "reservedAt"
      AND "updatedAt" >= "reservedAt"
    ),
  CONSTRAINT "realtime_session_leases_state_shape_check"
    CHECK (
      (
        "state" = 'reserved'
        AND "providerCallId" IS NULL
        AND "reaperTokenHash" IS NULL
        AND "activatedAt" IS NULL
      )
      OR (
        "state" = 'bound'
        AND "providerCallId" IS NOT NULL
        AND "reaperTokenHash" IS NULL
        AND "activatedAt" IS NULL
      )
      OR (
        "state" = 'active'
        AND "providerCallId" IS NOT NULL
        AND "reaperTokenHash" IS NULL
        AND "activatedAt" IS NOT NULL
      )
      OR (
        "state" = 'reaping'
        AND "providerCallId" IS NOT NULL
        AND "reaperTokenHash" IS NOT NULL
      )
    )
);

CREATE INDEX "realtime_session_leases_tenant_reaper_idx"
  ON "realtime_session_leases"("companyId", "state", "leaseExpiresAt");
CREATE INDEX "realtime_session_leases_global_reaper_idx"
  ON "realtime_session_leases"("state", "leaseExpiresAt");
CREATE INDEX "realtime_session_leases_hard_expiry_idx"
  ON "realtime_session_leases"("hardExpiresAt");

-- Fail-closed dès l'expand : les tables ne sont jamais visibles hors contexte tenant,
-- même avant la réapplication du script RLS général par la release.
ALTER TABLE "realtime_admission_events" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "realtime_admission_events" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "realtime_admission_events"
  USING ("companyId" = current_setting('app.current_company_id', true))
  WITH CHECK ("companyId" = current_setting('app.current_company_id', true));

ALTER TABLE "realtime_session_leases" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "realtime_session_leases" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "realtime_session_leases"
  USING ("companyId" = current_setting('app.current_company_id', true))
  WITH CHECK ("companyId" = current_setting('app.current_company_id', true));
