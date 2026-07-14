-- Idempotence transactionnelle des créations de devis (voix, saisie et retries réseau).
-- La clé brute possédée par le client n'entre jamais en base : uniquement deux SHA-256.

CREATE UNIQUE INDEX "uniq_quote_id_company"
  ON "quotes"("id", "companyId");

CREATE TABLE "quote_creation_requests" (
  "companyId" TEXT NOT NULL,
  "keyHash" CHAR(64) NOT NULL,
  "payloadHash" CHAR(64) NOT NULL,
  "quoteId" TEXT NOT NULL,
  "totalsHt" INTEGER NOT NULL,
  "totalsVat" INTEGER NOT NULL,
  "totalsTtc" INTEGER NOT NULL,
  "totalsNetToPay" INTEGER NOT NULL,
  "vatByRate" JSONB NOT NULL DEFAULT '{}'::JSONB,
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "quote_creation_requests_pkey"
    PRIMARY KEY ("companyId", "keyHash"),
  CONSTRAINT "quote_creation_requests_companyId_fkey"
    FOREIGN KEY ("companyId") REFERENCES "companies"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "quote_creation_requests_quoteId_companyId_fkey"
    FOREIGN KEY ("quoteId", "companyId") REFERENCES "quotes"("id", "companyId")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "quote_creation_requests_key_hash_check"
    CHECK ("keyHash"::TEXT ~ '^[a-f0-9]{64}$'),
  CONSTRAINT "quote_creation_requests_payload_hash_check"
    CHECK ("payloadHash"::TEXT ~ '^[a-f0-9]{64}$'),
  CONSTRAINT "quote_creation_requests_totals_nonnegative_check"
    CHECK (
      "totalsHt" >= 0 AND "totalsVat" >= 0 AND "totalsTtc" >= 0
      AND "totalsNetToPay" >= 0 AND "totalsNetToPay" <= "totalsTtc"
    ),
  CONSTRAINT "quote_creation_requests_totals_coherent_check"
    CHECK ("totalsHt" + "totalsVat" = "totalsTtc"),
  CONSTRAINT "quote_creation_requests_vat_by_rate_object_check"
    CHECK (jsonb_typeof("vatByRate") = 'object')
);

CREATE INDEX "quote_creation_requests_quoteId_companyId_idx"
  ON "quote_creation_requests"("quoteId", "companyId");

-- Append-only pour le rôle runtime : aucune policy UPDATE/DELETE. Le trigger ferme aussi les
-- UPDATE privilégiés accidentels ; une purge légale reste une opération DBA explicite (DELETE).
CREATE FUNCTION reject_quote_creation_request_update()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'quote creation idempotency records are immutable'
    USING ERRCODE = '55000';
END;
$$;

CREATE TRIGGER "quote_creation_requests_immutable"
BEFORE UPDATE ON "quote_creation_requests"
FOR EACH ROW EXECUTE FUNCTION reject_quote_creation_request_update();

ALTER TABLE "quote_creation_requests" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "quote_creation_requests" FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_quote_creation_request_select ON "quote_creation_requests"
  FOR SELECT
  USING ("companyId" = current_setting('app.current_company_id', true));

CREATE POLICY tenant_quote_creation_request_insert ON "quote_creation_requests"
  FOR INSERT
  WITH CHECK ("companyId" = current_setting('app.current_company_id', true));
