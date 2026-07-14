-- Avoirs totaux : rattachement légal à la facture exacte créditée.
--
-- Expand/backfill/contract sans supposition sur les avoirs historiques ambigus :
-- - les anciens avoirs ne sont backfillés que lorsqu'une source unique et émise existe ;
-- - la contrainte NOT VALID protège immédiatement toute nouvelle écriture sans bloquer
--   le déploiement si un ancien avoir exige une revue humaine ;
-- - le trigger impose en plus la concordance avec la source et l'immutabilité des snapshots.

ALTER TABLE "invoices"
  ADD COLUMN "sourceInvoiceId" TEXT,
  ADD COLUMN "sourceInvoiceKind" "DocKind",
  ADD COLUMN "sourceInvoiceNumber" TEXT,
  ADD COLUMN "sourceInvoiceIssuedAt" TIMESTAMP(3);

-- La FK composite interdit structurellement tout lien inter-tenant.
CREATE UNIQUE INDEX "uniq_invoice_id_company"
  ON "invoices"("id", "companyId");

WITH candidates AS (
  SELECT
    credit.id AS "creditNoteId",
    source.id AS "sourceInvoiceId",
    source.kind AS "sourceInvoiceKind",
    source.number AS "sourceInvoiceNumber",
    source."issuedAt" AS "sourceInvoiceIssuedAt",
    source."depositPct" AS "sourceDepositPct",
    source."depositDeductionCents" AS "sourceDepositDeductionCents",
    source."depositInvoiceId" AS "sourceDepositInvoiceId",
    source."totalsHt" AS "sourceTotalsHt",
    source."totalsVat" AS "sourceTotalsVat",
    source."totalsTtc" AS "sourceTotalsTtc",
    source."totalsNetToPay" AS "sourceTotalsNetToPay",
    source."vatByRate" AS "sourceVatByRate",
    count(*) OVER (PARTITION BY credit.id) AS "candidateCount"
  FROM "invoices" credit
  JOIN "invoices" source
    ON source."companyId" = credit."companyId"
   AND source."parentQuoteId" = credit."parentQuoteId"
  WHERE credit.kind = 'credit_note'
    AND credit."sourceInvoiceId" IS NULL
    AND credit.status = 'draft'
    AND credit."parentQuoteId" IS NOT NULL
    AND credit."customerId" = source."customerId"
    AND source.kind IN ('invoice', 'deposit_invoice', 'situation')
    AND source.status IN ('issued', 'partially_paid', 'paid', 'late')
    AND source.number IS NOT NULL
    AND source."issuedAt" IS NOT NULL
    -- Un vieux brouillon n'est repris automatiquement que si son contenu correspond encore
    -- exactement à la source. Toute ambiguïté ou divergence reste en revue humaine.
    AND NOT EXISTS (
      (SELECT position, label, category, qty, unit, "unitPriceHt", "vatRate"
         FROM line_items WHERE "invoiceId" = credit.id
       EXCEPT ALL
       SELECT position, label, category, qty, unit, "unitPriceHt", "vatRate"
         FROM line_items WHERE "invoiceId" = source.id)
      UNION ALL
      (SELECT position, label, category, qty, unit, "unitPriceHt", "vatRate"
         FROM line_items WHERE "invoiceId" = source.id
       EXCEPT ALL
       SELECT position, label, category, qty, unit, "unitPriceHt", "vatRate"
         FROM line_items WHERE "invoiceId" = credit.id)
    )
), unambiguous AS (
  SELECT * FROM candidates WHERE "candidateCount" = 1
)
UPDATE "invoices" credit
SET
  "sourceInvoiceId" = source."sourceInvoiceId",
  "sourceInvoiceKind" = source."sourceInvoiceKind",
  "sourceInvoiceNumber" = source."sourceInvoiceNumber",
  "sourceInvoiceIssuedAt" = source."sourceInvoiceIssuedAt",
  "depositPct" = source."sourceDepositPct",
  "depositDeductionCents" = source."sourceDepositDeductionCents",
  "depositInvoiceId" = source."sourceDepositInvoiceId",
  "totalsHt" = source."sourceTotalsHt",
  "totalsVat" = source."sourceTotalsVat",
  "totalsTtc" = source."sourceTotalsTtc",
  "totalsNetToPay" = source."sourceTotalsNetToPay",
  "vatByRate" = source."sourceVatByRate"
FROM unambiguous source
WHERE credit.id = source."creditNoteId";

ALTER TABLE "invoices"
  ADD CONSTRAINT "invoices_credit_note_source_tenant_fk"
  FOREIGN KEY ("sourceInvoiceId", "companyId")
  REFERENCES "invoices"("id", "companyId")
  ON DELETE RESTRICT
  ON UPDATE RESTRICT;

-- Une ligne probante ne doit jamais être orpheline : un brouillon se supprime en retirant
-- explicitement ses lignes d'abord, alors qu'une pièce émise reste bloquée par le trigger
-- d'immutabilité ci-dessous.
ALTER TABLE "line_items"
  DROP CONSTRAINT "line_items_invoiceId_fkey",
  ADD CONSTRAINT "line_items_invoiceId_fkey"
    FOREIGN KEY ("invoiceId") REFERENCES "invoices"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE UNIQUE INDEX "uniq_credit_note_source_invoice"
  ON "invoices"("companyId", "sourceInvoiceId");

-- L'ancienne unicité par devis empêchait d'annuler séparément un acompte et sa finale,
-- et empêchait aussi les situations successives. Seules les deux générations unitaires
-- (acompte/finale) restent idempotentes par devis ; chaque avoir l'est par facture source.
DROP INDEX IF EXISTS "uniq_invoice_parent_quote_kind";

CREATE UNIQUE INDEX "uniq_invoice_parent_quote_generated_kind"
  ON "invoices"("companyId", "parentQuoteId", kind)
  WHERE "parentQuoteId" IS NOT NULL
    AND kind IN ('invoice', 'deposit_invoice');

CREATE INDEX "invoices_parent_quote_kind_idx"
  ON "invoices"("companyId", "parentQuoteId", kind);

ALTER TABLE "invoices"
  ADD CONSTRAINT "invoices_credit_note_source_shape"
  CHECK (
    (
      kind = 'credit_note'
      AND "sourceInvoiceId" IS NOT NULL
      AND "sourceInvoiceKind" IS NOT NULL
      AND "sourceInvoiceKind" IN ('invoice', 'deposit_invoice', 'situation')
      AND "sourceInvoiceNumber" IS NOT NULL
      AND "sourceInvoiceIssuedAt" IS NOT NULL
    )
    OR
    (
      kind <> 'credit_note'
      AND "sourceInvoiceId" IS NULL
      AND "sourceInvoiceKind" IS NULL
      AND "sourceInvoiceNumber" IS NULL
      AND "sourceInvoiceIssuedAt" IS NULL
    )
  ) NOT VALID;

CREATE OR REPLACE FUNCTION enforce_invoice_legal_traceability()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public
AS $$
DECLARE
  source_record RECORD;
BEGIN
  -- Une pièce déjà émise reste légalement figée ; seules sa progression de statut et
  -- les sommes encaissées peuvent encore évoluer via les use cases dédiés.
  IF TG_OP = 'UPDATE' AND OLD.status <> 'draft' AND (
    NEW."companyId" IS DISTINCT FROM OLD."companyId"
    OR NEW."customerId" IS DISTINCT FROM OLD."customerId"
    OR NEW.kind IS DISTINCT FROM OLD.kind
    OR NEW.number IS DISTINCT FROM OLD.number
    OR NEW."issuedAt" IS DISTINCT FROM OLD."issuedAt"
    OR NEW."dueAt" IS DISTINCT FROM OLD."dueAt"
    OR NEW."parentQuoteId" IS DISTINCT FROM OLD."parentQuoteId"
    OR NEW."depositPct" IS DISTINCT FROM OLD."depositPct"
    OR NEW."depositDeductionCents" IS DISTINCT FROM OLD."depositDeductionCents"
    OR NEW."depositInvoiceId" IS DISTINCT FROM OLD."depositInvoiceId"
    OR NEW."totalsHt" IS DISTINCT FROM OLD."totalsHt"
    OR NEW."totalsVat" IS DISTINCT FROM OLD."totalsVat"
    OR NEW."totalsTtc" IS DISTINCT FROM OLD."totalsTtc"
    OR NEW."totalsNetToPay" IS DISTINCT FROM OLD."totalsNetToPay"
    OR NEW."vatByRate" IS DISTINCT FROM OLD."vatByRate"
    OR NEW."legalMentions" IS DISTINCT FROM OLD."legalMentions"
  ) THEN
    RAISE EXCEPTION 'issued invoice legal fields are immutable'
      USING ERRCODE = '23514', CONSTRAINT = 'invoices_issued_legal_immutability';
  END IF;

  IF TG_OP = 'UPDATE' AND NEW.status IS DISTINCT FROM OLD.status AND NOT (
    (OLD.status = 'draft' AND NEW.status IN ('issued', 'cancelled'))
    OR (OLD.status = 'issued' AND NEW.status IN ('partially_paid', 'paid', 'late', 'cancelled'))
    OR (OLD.status = 'partially_paid' AND NEW.status IN ('paid', 'late', 'cancelled'))
    OR (OLD.status = 'late' AND NEW.status IN ('partially_paid', 'paid', 'cancelled'))
  ) THEN
    RAISE EXCEPTION 'invalid invoice status transition from % to %', OLD.status, NEW.status
      USING ERRCODE = '23514', CONSTRAINT = 'invoices_status_transition';
  END IF;

  IF NEW.kind = 'credit_note' THEN
    IF NEW."sourceInvoiceId" IS NULL
      OR NEW."sourceInvoiceKind" IS NULL
      OR NEW."sourceInvoiceNumber" IS NULL
      OR NEW."sourceInvoiceIssuedAt" IS NULL THEN
      RAISE EXCEPTION 'credit note source traceability is required'
        USING ERRCODE = '23514', CONSTRAINT = 'invoices_credit_note_source_shape';
    END IF;

    SELECT
      id,
      "customerId",
      kind,
      status,
      number,
      "issuedAt",
      "parentQuoteId",
      "depositPct",
      "depositDeductionCents",
      "depositInvoiceId",
      "totalsHt",
      "totalsVat",
      "totalsTtc",
      "totalsNetToPay",
      "vatByRate"
      INTO source_record
      FROM public.invoices
     WHERE id = NEW."sourceInvoiceId"
       AND "companyId" = NEW."companyId";

    IF NOT FOUND THEN
      RAISE EXCEPTION 'credit note source must belong to the same tenant'
        USING ERRCODE = '23503', CONSTRAINT = 'invoices_credit_note_source_tenant_fk';
    END IF;
    IF source_record.kind NOT IN ('invoice', 'deposit_invoice', 'situation') THEN
      RAISE EXCEPTION 'a credit note can only credit an invoice, deposit or situation'
        USING ERRCODE = '23514', CONSTRAINT = 'invoices_credit_note_source_kind';
    END IF;
    IF source_record.status NOT IN ('issued', 'partially_paid', 'paid', 'late') THEN
      RAISE EXCEPTION 'credit note source must be issued and active'
        USING ERRCODE = '23514', CONSTRAINT = 'invoices_credit_note_source_issued';
    END IF;
    IF NEW."sourceInvoiceKind" IS DISTINCT FROM source_record.kind
      OR NEW."sourceInvoiceNumber" IS DISTINCT FROM source_record.number
      OR NEW."sourceInvoiceIssuedAt" IS DISTINCT FROM source_record."issuedAt" THEN
      RAISE EXCEPTION 'credit note source snapshot does not match its invoice'
        USING ERRCODE = '23514', CONSTRAINT = 'invoices_credit_note_source_snapshot_match';
    END IF;
    IF NEW."customerId" IS DISTINCT FROM source_record."customerId"
      OR NEW."parentQuoteId" IS DISTINCT FROM source_record."parentQuoteId"
      OR NEW."depositPct" IS DISTINCT FROM source_record."depositPct"
      OR NEW."depositDeductionCents" IS DISTINCT FROM source_record."depositDeductionCents"
      OR NEW."depositInvoiceId" IS DISTINCT FROM source_record."depositInvoiceId"
      OR NEW."totalsHt" IS DISTINCT FROM source_record."totalsHt"
      OR NEW."totalsVat" IS DISTINCT FROM source_record."totalsVat"
      OR NEW."totalsTtc" IS DISTINCT FROM source_record."totalsTtc"
      OR NEW."totalsNetToPay" IS DISTINCT FROM source_record."totalsNetToPay"
      OR NEW."vatByRate" IS DISTINCT FROM source_record."vatByRate" THEN
      RAISE EXCEPTION 'credit note legal content must exactly mirror its source invoice'
        USING ERRCODE = '23514', CONSTRAINT = 'invoices_credit_note_source_totals_match';
    END IF;

    IF TG_OP = 'UPDATE' AND OLD.kind = 'credit_note' AND (
      NEW."sourceInvoiceId" IS DISTINCT FROM OLD."sourceInvoiceId"
      OR NEW."sourceInvoiceKind" IS DISTINCT FROM OLD."sourceInvoiceKind"
      OR NEW."sourceInvoiceNumber" IS DISTINCT FROM OLD."sourceInvoiceNumber"
      OR NEW."sourceInvoiceIssuedAt" IS DISTINCT FROM OLD."sourceInvoiceIssuedAt"
    ) THEN
      RAISE EXCEPTION 'credit note source snapshot is immutable'
        USING ERRCODE = '23514', CONSTRAINT = 'invoices_credit_note_source_immutable';
    END IF;
  ELSIF NEW."sourceInvoiceId" IS NOT NULL
    OR NEW."sourceInvoiceKind" IS NOT NULL
    OR NEW."sourceInvoiceNumber" IS NOT NULL
    OR NEW."sourceInvoiceIssuedAt" IS NOT NULL THEN
    RAISE EXCEPTION 'only a credit note may reference a source invoice'
      USING ERRCODE = '23514', CONSTRAINT = 'invoices_credit_note_source_shape';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS invoices_legal_traceability ON "invoices";
CREATE TRIGGER invoices_legal_traceability
BEFORE INSERT OR UPDATE ON "invoices"
FOR EACH ROW
EXECUTE FUNCTION enforce_invoice_legal_traceability();

-- Les lignes d'une facture deviennent immuables dès son émission. Cela ferme aussi le
-- contournement consistant à modifier directement `line_items` sans sauvegarder l'agrégat.
CREATE OR REPLACE FUNCTION enforce_issued_invoice_line_immutability()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public
AS $$
DECLARE
  parent_status "InvoiceStatus";
BEGIN
  IF TG_OP <> 'INSERT' AND OLD."invoiceId" IS NOT NULL THEN
    SELECT status INTO parent_status FROM public.invoices WHERE id = OLD."invoiceId";
    IF FOUND AND parent_status <> 'draft' THEN
      RAISE EXCEPTION 'issued invoice lines are immutable'
        USING ERRCODE = '23514', CONSTRAINT = 'invoice_lines_issued_immutability';
    END IF;
  END IF;

  IF TG_OP <> 'DELETE' AND NEW."invoiceId" IS NOT NULL THEN
    SELECT status INTO parent_status FROM public.invoices WHERE id = NEW."invoiceId";
    IF FOUND AND parent_status <> 'draft' THEN
      RAISE EXCEPTION 'issued invoice lines are immutable'
        USING ERRCODE = '23514', CONSTRAINT = 'invoice_lines_issued_immutability';
    END IF;
  END IF;

  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END;
$$;

DROP TRIGGER IF EXISTS invoice_lines_issued_immutability ON "line_items";
CREATE TRIGGER invoice_lines_issued_immutability
BEFORE INSERT OR UPDATE OR DELETE ON "line_items"
FOR EACH ROW
EXECUTE FUNCTION enforce_issued_invoice_line_immutability();

-- La vérification est différée à COMMIT : l'avoir et ses lignes sont créés dans la même
-- transaction, puis comparés comme multisets (EXCEPT ALL préserve même les doublons).
CREATE OR REPLACE FUNCTION assert_credit_note_lines_match(p_credit_note_id TEXT)
RETURNS void
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public
AS $$
DECLARE
  source_id TEXT;
BEGIN
  SELECT "sourceInvoiceId"
    INTO source_id
    FROM public.invoices
   WHERE id = p_credit_note_id
     AND kind = 'credit_note';
  IF NOT FOUND THEN
    RETURN;
  END IF;

  IF EXISTS (
    SELECT 1
      FROM (
        (SELECT position, label, category, qty, unit, "unitPriceHt", "vatRate"
           FROM public.line_items WHERE "invoiceId" = p_credit_note_id
         EXCEPT ALL
         SELECT position, label, category, qty, unit, "unitPriceHt", "vatRate"
           FROM public.line_items WHERE "invoiceId" = source_id)
        UNION ALL
        (SELECT position, label, category, qty, unit, "unitPriceHt", "vatRate"
           FROM public.line_items WHERE "invoiceId" = source_id
         EXCEPT ALL
         SELECT position, label, category, qty, unit, "unitPriceHt", "vatRate"
           FROM public.line_items WHERE "invoiceId" = p_credit_note_id)
      ) AS mismatch
  ) THEN
    RAISE EXCEPTION 'credit note lines must exactly mirror the source invoice'
      USING ERRCODE = '23514', CONSTRAINT = 'invoice_credit_note_lines_match';
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION verify_credit_note_lines_from_invoice()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public
AS $$
BEGIN
  PERFORM public.assert_credit_note_lines_match(NEW.id);
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION verify_credit_note_lines_from_line()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public
AS $$
DECLARE
  affected_invoice_id TEXT;
  credit_id TEXT;
BEGIN
  FOR affected_invoice_id IN
    SELECT DISTINCT candidate
      FROM unnest(ARRAY[
        CASE WHEN TG_OP <> 'INSERT' THEN OLD."invoiceId" ELSE NULL END,
        CASE WHEN TG_OP <> 'DELETE' THEN NEW."invoiceId" ELSE NULL END
      ]) AS candidate
     WHERE candidate IS NOT NULL
  LOOP
    PERFORM public.assert_credit_note_lines_match(affected_invoice_id);
    FOR credit_id IN
      SELECT id FROM public.invoices WHERE "sourceInvoiceId" = affected_invoice_id
    LOOP
      PERFORM public.assert_credit_note_lines_match(credit_id);
    END LOOP;
  END LOOP;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END;
$$;

DROP TRIGGER IF EXISTS invoice_credit_note_lines_match ON "invoices";
CREATE CONSTRAINT TRIGGER invoice_credit_note_lines_match
AFTER INSERT OR UPDATE ON "invoices"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
EXECUTE FUNCTION verify_credit_note_lines_from_invoice();

DROP TRIGGER IF EXISTS line_credit_note_lines_match ON "line_items";
CREATE CONSTRAINT TRIGGER line_credit_note_lines_match
AFTER INSERT OR UPDATE OR DELETE ON "line_items"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
EXECUTE FUNCTION verify_credit_note_lines_from_line();

COMMENT ON CONSTRAINT "invoices_credit_note_source_shape" ON "invoices" IS
  'NOT VALID only for ambiguous legacy rows; every INSERT/UPDATE is enforced and must be remediated before VALIDATE CONSTRAINT.';
