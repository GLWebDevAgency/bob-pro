-- Brouillon de devis serveur : aucune donnée initiale, un slot par tenant et propriétaire.
CREATE TABLE "quote_draft_slots" (
  "companyId" TEXT NOT NULL,
  "ownerUserId" TEXT NOT NULL,
  "revision" INTEGER NOT NULL DEFAULT 1,
  "payloadVersion" INTEGER NOT NULL DEFAULT 1,
  "payload" JSONB NOT NULL,
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "quote_draft_slots_pkey" PRIMARY KEY ("companyId", "ownerUserId"),
  CONSTRAINT "quote_draft_slots_companyId_fkey"
    FOREIGN KEY ("companyId") REFERENCES "companies"("id")
    ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "quote_draft_slots_owner_check" CHECK (
    length("ownerUserId") BETWEEN 1 AND 200
    AND "ownerUserId" = btrim("ownerUserId")
    AND "ownerUserId" !~ '[[:cntrl:]]'
  ),
  CONSTRAINT "quote_draft_slots_revision_check" CHECK ("revision" >= 1),
  CONSTRAINT "quote_draft_slots_payload_version_check" CHECK ("payloadVersion" = 1),
  CONSTRAINT "quote_draft_slots_payload_shape_check" CHECK (
    jsonb_typeof("payload") = 'object'
    AND "payload" @> '{"schema":"bob.quote-draft","version":1}'::jsonb
  ),
  CONSTRAINT "quote_draft_slots_payload_size_check" CHECK (octet_length("payload"::text) <= 262144),
  CONSTRAINT "quote_draft_slots_timestamps_check" CHECK ("updatedAt" >= "createdAt")
);

ALTER TABLE "quote_draft_slots" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "quote_draft_slots" FORCE ROW LEVEL SECURITY;

CREATE POLICY quote_draft_slot_owner_select ON "quote_draft_slots" FOR SELECT
  USING (
    "companyId" = current_setting('app.current_company_id', true)
    AND "ownerUserId" = nullif(current_setting('app.current_user_id', true), '')
  );
CREATE POLICY quote_draft_slot_owner_insert ON "quote_draft_slots" FOR INSERT
  WITH CHECK (
    "companyId" = current_setting('app.current_company_id', true)
    AND "ownerUserId" = nullif(current_setting('app.current_user_id', true), '')
  );
CREATE POLICY quote_draft_slot_owner_update ON "quote_draft_slots" FOR UPDATE
  USING (
    "companyId" = current_setting('app.current_company_id', true)
    AND "ownerUserId" = nullif(current_setting('app.current_user_id', true), '')
  )
  WITH CHECK (
    "companyId" = current_setting('app.current_company_id', true)
    AND "ownerUserId" = nullif(current_setting('app.current_user_id', true), '')
  );
CREATE POLICY quote_draft_slot_owner_delete ON "quote_draft_slots" FOR DELETE
  USING (
    "companyId" = current_setting('app.current_company_id', true)
    AND "ownerUserId" = nullif(current_setting('app.current_user_id', true), '')
  );
