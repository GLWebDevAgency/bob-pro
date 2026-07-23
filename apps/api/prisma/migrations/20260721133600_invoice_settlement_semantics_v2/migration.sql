-- Règlement facture V2 — persistance additive des faits qui distinguent la créance légale
-- (BT-115), l'exigible immédiat et la retenue de garantie. Aucun montant historique n'est
-- recalculé : version 1 + NULL conservent exactement l'absence de fait des pièces antérieures.

BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';
SET LOCAL row_security = off;

-- Rail expand/activate : la migration reste compatible N-1 et refuse tout writer V2 tant que la
-- révision N n'est pas seule et certifiée. L'activation monotone est faite post-readiness par le
-- script dédié ; aucun retour à V1 n'est possible après la première pièce V2.
CREATE TABLE public.invoice_settlement_protocol_state (
  id SMALLINT PRIMARY KEY,
  "activeVersion" SMALLINT NOT NULL,
  "activatedAt" TIMESTAMPTZ,
  "activatedByReleaseSha" CHAR(40),
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT statement_timestamp(),
  "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT statement_timestamp(),
  CONSTRAINT "invoice_settlement_protocol_singleton" CHECK (id = 1),
  CONSTRAINT "invoice_settlement_protocol_version" CHECK ("activeVersion" IN (1, 2)),
  CONSTRAINT "invoice_settlement_protocol_activation_shape" CHECK (
    ("activeVersion" = 1 AND "activatedAt" IS NULL AND "activatedByReleaseSha" IS NULL)
    OR (
      "activeVersion" = 2
      AND "activatedAt" IS NOT NULL
      AND "activatedByReleaseSha" ~ '^[0-9a-f]{40}$'
    )
  )
);

INSERT INTO public.invoice_settlement_protocol_state (id, "activeVersion") VALUES (1, 1);

CREATE FUNCTION public.enforce_invoice_settlement_protocol_monotonicity()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'invoice settlement protocol state is append-only'
      USING ERRCODE = '23514', CONSTRAINT = 'invoice_settlement_protocol_monotone';
  END IF;
  IF NEW.id IS DISTINCT FROM OLD.id
     OR NEW."activeVersion" < OLD."activeVersion"
     OR NEW."createdAt" IS DISTINCT FROM OLD."createdAt"
     OR (OLD."activeVersion" = 2 AND NEW IS DISTINCT FROM OLD) THEN
    RAISE EXCEPTION 'invoice settlement protocol cannot be downgraded or rewritten'
      USING ERRCODE = '23514', CONSTRAINT = 'invoice_settlement_protocol_monotone';
  END IF;
  IF OLD."activeVersion" = 1 AND NEW."activeVersion" = 1 AND NEW IS DISTINCT FROM OLD THEN
    RAISE EXCEPTION 'invoice settlement protocol V1 cannot be mutated before activation'
      USING ERRCODE = '23514', CONSTRAINT = 'invoice_settlement_protocol_monotone';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER invoice_settlement_protocol_monotonicity
BEFORE UPDATE OR DELETE ON public.invoice_settlement_protocol_state
FOR EACH ROW
EXECUTE FUNCTION public.enforce_invoice_settlement_protocol_monotonicity();

-- Comme pour l'archive légale, le rail V1 -> V2 est piloté par DIRECT_URL, jamais par la Data API.
-- Les révocations conditionnelles neutralisent aussi les default privileges Supabase historiques.
REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER
  ON TABLE public.invoice_settlement_protocol_state FROM PUBLIC;
DO $$
DECLARE
  exposed_role TEXT;
BEGIN
  FOREACH exposed_role IN ARRAY ARRAY['anon', 'authenticated', 'service_role']::TEXT[] LOOP
    IF pg_catalog.to_regrole(exposed_role) IS NOT NULL THEN
      EXECUTE pg_catalog.format(
        'REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER '
        'ON TABLE public.invoice_settlement_protocol_state FROM %I',
        exposed_role
      );
    END IF;
  END LOOP;
END;
$$;

ALTER TABLE public.invoices
  ADD COLUMN "settlementSemanticsVersion" INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN "totalsDuePayableCents" INTEGER;

ALTER TABLE public.invoices
  ADD CONSTRAINT "invoices_settlement_semantics_version_valid"
    CHECK ("settlementSemanticsVersion" IN (1, 2)) NOT VALID,
  ADD CONSTRAINT "invoices_due_payable_shape"
    CHECK (
      "totalsDuePayableCents" IS NULL
      OR (
        "totalsDuePayableCents" >= 0
        AND "totalsDuePayableCents" >= "totalsNetToPay"
      )
    ) NOT VALID,
  ADD CONSTRAINT "invoices_v2_due_payable_required"
    CHECK ("settlementSemanticsVersion" = 1 OR "totalsDuePayableCents" IS NOT NULL) NOT VALID,
  ADD CONSTRAINT "invoices_v2_due_payable_exact"
    CHECK (
      "settlementSemanticsVersion" = 1
      OR "totalsDuePayableCents"
         = "totalsNetToPay" + COALESCE("totalsRetenueGarantieCents", 0)
    ) NOT VALID;

-- La validation s'effectue hors verrou ACCESS EXCLUSIVE : les writers N-1 restent disponibles
-- pendant le scan des lignes historiques, qui sont toutes V1 par défaut.
ALTER TABLE public.invoices
  VALIDATE CONSTRAINT "invoices_settlement_semantics_version_valid",
  VALIDATE CONSTRAINT "invoices_due_payable_shape",
  VALIDATE CONSTRAINT "invoices_v2_due_payable_required",
  VALIDATE CONSTRAINT "invoices_v2_due_payable_exact";

-- Un writer N-1 peut encore insérer NULL pendant le rolling deploy. Les paiements déjà présents
-- sont déterministement ventilés en 411 : avant cette migration, aucune part 4117 n'existait.
ALTER TABLE public.payments
  ADD COLUMN "ordinaryReceivableCents" INTEGER,
  ADD COLUMN "retentionReceivableCents" INTEGER;

UPDATE public.payments
   SET "ordinaryReceivableCents" = amount,
       "retentionReceivableCents" = 0
 WHERE "ordinaryReceivableCents" IS NULL
   AND "retentionReceivableCents" IS NULL;

ALTER TABLE public.payments
  ADD CONSTRAINT "payments_receivable_allocation_shape"
    CHECK (
      (
        "ordinaryReceivableCents" IS NULL
        AND "retentionReceivableCents" IS NULL
      )
      OR (
        "ordinaryReceivableCents" IS NOT NULL
        AND "retentionReceivableCents" IS NOT NULL
        AND "ordinaryReceivableCents" >= 0
        AND "retentionReceivableCents" >= 0
        AND "ordinaryReceivableCents" + "retentionReceivableCents" = amount
      )
    ) NOT VALID;

ALTER TABLE public.payments
  VALIDATE CONSTRAINT "payments_receivable_allocation_shape";

-- Traçabilité ligne-à-ligne du devis signé vers les pièces dérivées. La FK empêche la disparition
-- de la ligne contractuelle ; le trigger ci-dessous impose devis source + même tenant + même devis.
ALTER TABLE public.line_items
  ADD COLUMN "sourceQuoteLineId" TEXT;

ALTER TABLE public.line_items
  ADD CONSTRAINT "line_items_source_quote_line_fkey"
    FOREIGN KEY ("sourceQuoteLineId")
    REFERENCES public.line_items(id)
    ON DELETE RESTRICT ON UPDATE RESTRICT
    NOT VALID;

ALTER TABLE public.line_items
  VALIDATE CONSTRAINT "line_items_source_quote_line_fkey";

CREATE INDEX "line_items_source_quote_line_idx"
  ON public.line_items("sourceQuoteLineId");

CREATE FUNCTION public.enforce_line_source_quote_traceability()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public
AS $$
DECLARE
  source_quote_id TEXT;
  source_company_id TEXT;
  source_quote_status public."QuoteStatus";
  target_quote_id TEXT;
  target_company_id TEXT;
BEGIN
  IF NEW."sourceQuoteLineId" IS NULL THEN
    RETURN NEW;
  END IF;

  IF NEW."invoiceId" IS NULL OR NEW."quoteId" IS NOT NULL THEN
    RAISE EXCEPTION 'only an invoice line may reference a quote line'
      USING ERRCODE = '23514', CONSTRAINT = 'line_items_source_quote_line_shape';
  END IF;

  SELECT source_line."quoteId", source_quote."companyId", source_quote.status
    INTO source_quote_id, source_company_id, source_quote_status
    FROM public.line_items AS source_line
    JOIN public.quotes AS source_quote ON source_quote.id = source_line."quoteId"
   WHERE source_line.id = NEW."sourceQuoteLineId"
     AND source_line."quoteId" IS NOT NULL
     AND source_line."invoiceId" IS NULL
     AND source_line."sourceQuoteLineId" IS NULL;
  IF NOT FOUND OR source_quote_status <> 'signed'::public."QuoteStatus" THEN
    RAISE EXCEPTION 'source quote line must belong to a signed quote'
      USING ERRCODE = '23514', CONSTRAINT = 'line_items_source_quote_line_signed_quote';
  END IF;

  SELECT invoice."parentQuoteId", invoice."companyId"
    INTO target_quote_id, target_company_id
    FROM public.invoices AS invoice
   WHERE invoice.id = NEW."invoiceId";
  IF NOT FOUND
     OR target_quote_id IS NULL
     OR target_quote_id IS DISTINCT FROM source_quote_id
     OR target_company_id IS DISTINCT FROM source_company_id THEN
    RAISE EXCEPTION 'source quote line must belong to the invoice tenant and parent quote'
      USING ERRCODE = '23503', CONSTRAINT = 'line_items_source_quote_line_tenant';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER line_items_source_quote_traceability
BEFORE INSERT OR UPDATE OF "sourceQuoteLineId", "invoiceId", "quoteId"
ON public.line_items
FOR EACH ROW
EXECUTE FUNCTION public.enforce_line_source_quote_traceability();

-- Snapshots ordonnés des acomptes/situations antérieurs. Les deux FK composites rendent un lien
-- inter-tenant impossible même avec un writer compromis ; le trigger compare le snapshot à la
-- pièce source réellement émise.
CREATE TABLE public.invoice_predecessors (
  "companyId" TEXT NOT NULL,
  "invoiceId" TEXT NOT NULL,
  "sourceInvoiceId" TEXT NOT NULL,
  kind public."DocKind" NOT NULL,
  number TEXT NOT NULL,
  "issuedAt" DATE NOT NULL,
  position INTEGER NOT NULL,
  CONSTRAINT "invoice_predecessors_pkey"
    PRIMARY KEY ("companyId", "invoiceId", position),
  CONSTRAINT "uniq_invoice_predecessor_source"
    UNIQUE ("companyId", "invoiceId", "sourceInvoiceId"),
  CONSTRAINT "invoice_predecessors_company_fkey"
    FOREIGN KEY ("companyId") REFERENCES public.companies(id)
    ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "invoice_predecessors_target_tenant_fkey"
    FOREIGN KEY ("invoiceId", "companyId")
    REFERENCES public.invoices(id, "companyId")
    ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "invoice_predecessors_source_tenant_fkey"
    FOREIGN KEY ("sourceInvoiceId", "companyId")
    REFERENCES public.invoices(id, "companyId")
    ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "invoice_predecessors_shape"
    CHECK (
      "invoiceId" <> "sourceInvoiceId"
      AND position >= 0
      AND kind IN ('deposit_invoice', 'situation')
      AND btrim(number) <> ''
    )
);

CREATE INDEX "invoice_predecessors_source_company_idx"
  ON public.invoice_predecessors("sourceInvoiceId", "companyId");

CREATE FUNCTION public.enforce_invoice_predecessor_traceability()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public
AS $$
DECLARE
  target_invoice RECORD;
  source_invoice RECORD;
BEGIN
  SELECT "companyId", "customerId", kind, status, "parentQuoteId", "settlementSemanticsVersion"
    INTO target_invoice
    FROM public.invoices
   WHERE id = NEW."invoiceId" AND "companyId" = NEW."companyId"
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'predecessor target invoice must belong to the tenant'
      USING ERRCODE = '23503', CONSTRAINT = 'invoice_predecessors_target_tenant_fkey';
  END IF;

  SELECT "companyId", "customerId", kind, status, number, "issuedAt", "parentQuoteId"
    INTO source_invoice
    FROM public.invoices
   WHERE id = NEW."sourceInvoiceId" AND "companyId" = NEW."companyId";
  IF NOT FOUND THEN
    RAISE EXCEPTION 'predecessor source invoice must belong to the tenant'
      USING ERRCODE = '23503', CONSTRAINT = 'invoice_predecessors_source_tenant_fkey';
  END IF;

  IF target_invoice.kind <> 'invoice'::public."DocKind"
     OR target_invoice.status <> 'draft'::public."InvoiceStatus"
     OR target_invoice."settlementSemanticsVersion" <> 2
     OR target_invoice."parentQuoteId" IS NULL THEN
    RAISE EXCEPTION 'predecessors require a draft V2 final invoice derived from a quote'
      USING ERRCODE = '23514', CONSTRAINT = 'invoice_predecessors_target_shape';
  END IF;
  IF source_invoice.kind NOT IN ('deposit_invoice', 'situation')
     OR source_invoice.status NOT IN ('issued', 'partially_paid', 'paid', 'late')
     OR source_invoice.number IS NULL
     OR source_invoice."issuedAt" IS NULL THEN
    RAISE EXCEPTION 'predecessor source must be an issued deposit or situation'
      USING ERRCODE = '23514', CONSTRAINT = 'invoice_predecessors_source_issued';
  END IF;
  IF source_invoice."customerId" IS DISTINCT FROM target_invoice."customerId"
     OR source_invoice."parentQuoteId" IS DISTINCT FROM target_invoice."parentQuoteId" THEN
    RAISE EXCEPTION 'predecessor source and target must share customer and quote'
      USING ERRCODE = '23514', CONSTRAINT = 'invoice_predecessors_same_contract';
  END IF;
  IF NEW.kind IS DISTINCT FROM source_invoice.kind
     OR NEW.number IS DISTINCT FROM source_invoice.number
     OR NEW."issuedAt" IS DISTINCT FROM source_invoice."issuedAt"::date THEN
    RAISE EXCEPTION 'predecessor snapshot does not match its source invoice'
      USING ERRCODE = '23514', CONSTRAINT = 'invoice_predecessors_snapshot_match';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER invoice_predecessors_traceability
BEFORE INSERT ON public.invoice_predecessors
FOR EACH ROW
EXECUTE FUNCTION public.enforce_invoice_predecessor_traceability();

CREATE FUNCTION public.enforce_invoice_predecessor_immutability()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public
AS $$
DECLARE
  target_status public."InvoiceStatus";
BEGIN
  IF TG_OP = 'UPDATE' THEN
    RAISE EXCEPTION 'invoice predecessor snapshots are immutable'
      USING ERRCODE = '23514', CONSTRAINT = 'invoice_predecessors_immutable';
  END IF;

  -- Avant émission seulement, la suppression du brouillon propriétaire peut retirer ses refs.
  -- Après émission, ou si la cible a disparu, la preuve est strictement append-only.
  SELECT status INTO target_status
    FROM public.invoices
   WHERE id = OLD."invoiceId" AND "companyId" = OLD."companyId"
   FOR UPDATE;
  IF FOUND AND target_status = 'draft'::public."InvoiceStatus" THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'issued invoice predecessor snapshots are immutable'
    USING ERRCODE = '23514', CONSTRAINT = 'invoice_predecessors_immutable';
END;
$$;

CREATE TRIGGER invoice_predecessors_immutability
BEFORE UPDATE OR DELETE ON public.invoice_predecessors
FOR EACH ROW
EXECUTE FUNCTION public.enforce_invoice_predecessor_immutability();

-- Garde focalisée, distincte du gros trigger légal historique : les nouveaux faits sont figés
-- après émission, et un avoir recopie exactement la sémantique de sa source.
CREATE FUNCTION public.enforce_invoice_settlement_semantics_v2()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public
AS $$
DECLARE
  source_settlement RECORD;
  expected_predecessor_count BIGINT;
  persisted_predecessor_count BIGINT;
  expected_deduction_cents BIGINT;
  expected_situation_cents BIGINT;
  expected_unique_source_id TEXT;
  becomes_live BOOLEAN := FALSE;
  retires_live_predecessor BOOLEAN := FALSE;
BEGIN
  IF TG_OP = 'INSERT' THEN
    becomes_live := NEW.status IN ('issued', 'partially_paid', 'paid', 'late');
  ELSE
    becomes_live := NEW.status IN ('issued', 'partially_paid', 'paid', 'late')
      AND OLD.status IN ('draft', 'cancelled');
    retires_live_predecessor := NEW.kind IN ('deposit_invoice', 'situation')
      AND OLD.status IN ('issued', 'partially_paid', 'paid', 'late')
      AND NEW.status = 'cancelled'::public."InvoiceStatus";
  END IF;

  IF NEW."settlementSemanticsVersion" = 2
     AND NOT EXISTS (
       SELECT 1
         FROM public.invoice_settlement_protocol_state
        WHERE id = 1 AND "activeVersion" = 2
     ) THEN
    RAISE EXCEPTION 'invoice settlement V2 is not activated for this deployment'
      USING ERRCODE = '55000', CONSTRAINT = 'invoice_settlement_v2_not_activated';
  END IF;

  IF TG_OP = 'UPDATE'
     AND NEW."settlementSemanticsVersion" IS DISTINCT FROM OLD."settlementSemanticsVersion" THEN
    RAISE EXCEPTION 'invoice settlement semantics version is immutable'
      USING ERRCODE = '23514', CONSTRAINT = 'invoices_settlement_version_immutable';
  END IF;

  IF TG_OP = 'UPDATE'
     AND OLD.status <> 'draft'::public."InvoiceStatus"
     AND NEW."totalsDuePayableCents" IS DISTINCT FROM OLD."totalsDuePayableCents" THEN
    RAISE EXCEPTION 'issued invoice settlement facts are immutable'
     USING ERRCODE = '23514', CONSTRAINT = 'invoices_issued_settlement_immutability';
  END IF;

  -- Le devis est l'agrégat de concurrence commun à toutes ses pièces. Ce verrou empêche
  -- qu'une finale observe un ensemble d'antécédents pendant qu'une situation ou un avoir
  -- devient simultanément vivant. Il couvre aussi les INSERT directs d'une pièce déjà émise.
  IF NEW."settlementSemanticsVersion" = 2
     AND NEW."parentQuoteId" IS NOT NULL
     AND (becomes_live OR retires_live_predecessor) THEN
    PERFORM 1
      FROM public.quotes AS contract_quote
     WHERE contract_quote.id = NEW."parentQuoteId"
       AND contract_quote."companyId" = NEW."companyId"
     FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'V2 issued invoice must reference a quote from its tenant'
        USING ERRCODE = '23503', CONSTRAINT = 'invoices_v2_parent_quote_tenant';
    END IF;
  END IF;

  -- Une finale vivante clôt son graphe contractuel : ajouter ou annuler ensuite un acompte/une
  -- situation rendrait ses déductions historiques fausses. Le verrou du devis ci-dessus rend ce
  -- refus sérialisable avec l'émission concurrente de la finale, quel que soit l'ordre gagnant.
  IF NEW."settlementSemanticsVersion" = 2
     AND NEW."parentQuoteId" IS NOT NULL
     AND NEW.kind IN ('deposit_invoice', 'situation')
     AND (becomes_live OR retires_live_predecessor)
     AND EXISTS (
       SELECT 1
         FROM public.invoices AS live_final
        WHERE live_final."companyId" = NEW."companyId"
          AND live_final."customerId" = NEW."customerId"
          AND live_final."parentQuoteId" = NEW."parentQuoteId"
          AND live_final.kind = 'invoice'::public."DocKind"
          AND live_final.status IN ('issued', 'partially_paid', 'paid', 'late')
     ) THEN
    RAISE EXCEPTION 'a live final invoice closes its predecessor set'
      USING ERRCODE = '23514', CONSTRAINT = 'invoices_v2_final_closes_predecessors';
  END IF;

  IF NEW.kind = 'credit_note'::public."DocKind" AND NEW."sourceInvoiceId" IS NOT NULL THEN
    SELECT "settlementSemanticsVersion", "totalsDuePayableCents"
      INTO source_settlement
      FROM public.invoices
     WHERE id = NEW."sourceInvoiceId" AND "companyId" = NEW."companyId";
    IF NOT FOUND THEN
      RAISE EXCEPTION 'credit note settlement source must belong to the tenant'
        USING ERRCODE = '23503', CONSTRAINT = 'invoices_credit_note_settlement_source_tenant';
    END IF;
    IF NEW."settlementSemanticsVersion" IS DISTINCT FROM source_settlement."settlementSemanticsVersion"
       OR NEW."totalsDuePayableCents" IS DISTINCT FROM source_settlement."totalsDuePayableCents" THEN
      RAISE EXCEPTION 'credit note settlement facts must mirror source invoice'
        USING ERRCODE = '23514', CONSTRAINT = 'invoices_credit_note_settlement_mirror';
    END IF;

    -- Une situation/acompte déjà absorbé par une finale vivante ne peut être avoiré seul :
    -- cela rendrait le solde final faux. Il faut d'abord avoirer la finale, puis corriger la source.
    IF becomes_live THEN
      PERFORM 1
        FROM public.invoice_predecessors AS predecessor
        JOIN public.invoices AS final_invoice
          ON final_invoice.id = predecessor."invoiceId"
         AND final_invoice."companyId" = predecessor."companyId"
       WHERE predecessor."companyId" = NEW."companyId"
         AND predecessor."sourceInvoiceId" = NEW."sourceInvoiceId"
         AND final_invoice.status IN ('issued', 'partially_paid', 'paid', 'late')
         AND NOT EXISTS (
           SELECT 1 FROM public.invoices AS final_credit
            WHERE final_credit."companyId" = final_invoice."companyId"
              AND final_credit.kind = 'credit_note'::public."DocKind"
              AND final_credit."sourceInvoiceId" = final_invoice.id
              AND final_credit.status NOT IN ('draft', 'cancelled')
         )
       FOR SHARE OF final_invoice;
      IF FOUND THEN
        RAISE EXCEPTION 'credit the live final invoice before crediting one of its predecessors'
          USING ERRCODE = '23514', CONSTRAINT = 'invoices_predecessor_credit_requires_final_credit';
      END IF;
    END IF;
  END IF;

  IF becomes_live
     AND NEW.kind = 'invoice'::public."DocKind"
     AND NEW."settlementSemanticsVersion" = 2 THEN
    -- Sérialise l'émission avec toute annulation/émission d'une pièce sœur ou de son avoir.
    -- Le verrou du devis dans le use case reste le premier niveau ; celui-ci protège la DB contre
    -- un writer direct ou une régression d'adapter.
    PERFORM 1
      FROM public.invoices AS sibling
     WHERE sibling."companyId" = NEW."companyId"
       AND sibling."customerId" = NEW."customerId"
       AND sibling."parentQuoteId" = NEW."parentQuoteId"
       AND sibling.id <> NEW.id
     FOR SHARE;

    SELECT
      COUNT(*),
      COALESCE(SUM(
        CASE source.kind
          WHEN 'deposit_invoice'::public."DocKind" THEN source."totalsNetToPay"
          ELSE source."totalsTtc"
        END
      ), 0),
      COALESCE(SUM(
        CASE WHEN source.kind = 'situation'::public."DocKind" THEN source."totalsTtc" ELSE 0 END
      ), 0),
      CASE WHEN COUNT(*) = 1 THEN MIN(source.id) ELSE NULL END
      INTO expected_predecessor_count, expected_deduction_cents,
           expected_situation_cents, expected_unique_source_id
      FROM public.invoices AS source
     WHERE source."companyId" = NEW."companyId"
       AND source."customerId" = NEW."customerId"
       AND source."parentQuoteId" = NEW."parentQuoteId"
       AND source.kind IN ('deposit_invoice', 'situation')
       AND source.status IN ('issued', 'partially_paid', 'paid', 'late')
       AND NOT EXISTS (
         SELECT 1
           FROM public.invoices AS credit
          WHERE credit."companyId" = source."companyId"
            AND credit.kind = 'credit_note'::public."DocKind"
            AND credit."sourceInvoiceId" = source.id
            AND credit.status NOT IN ('draft', 'cancelled')
       );

    SELECT COUNT(*)
      INTO persisted_predecessor_count
      FROM public.invoice_predecessors AS predecessor
     WHERE predecessor."companyId" = NEW."companyId"
       AND predecessor."invoiceId" = NEW.id;

    IF persisted_predecessor_count IS DISTINCT FROM expected_predecessor_count
       OR EXISTS (
         SELECT 1
           FROM public.invoices AS source
          WHERE source."companyId" = NEW."companyId"
            AND source."customerId" = NEW."customerId"
            AND source."parentQuoteId" = NEW."parentQuoteId"
            AND source.kind IN ('deposit_invoice', 'situation')
            AND source.status IN ('issued', 'partially_paid', 'paid', 'late')
            AND NOT EXISTS (
              SELECT 1 FROM public.invoices AS credit
               WHERE credit."companyId" = source."companyId"
                 AND credit.kind = 'credit_note'::public."DocKind"
                 AND credit."sourceInvoiceId" = source.id
                 AND credit.status NOT IN ('draft', 'cancelled')
            )
            AND NOT EXISTS (
              SELECT 1 FROM public.invoice_predecessors AS predecessor
               WHERE predecessor."companyId" = NEW."companyId"
                 AND predecessor."invoiceId" = NEW.id
                 AND predecessor."sourceInvoiceId" = source.id
            )
       )
       OR EXISTS (
         SELECT 1
           FROM public.invoice_predecessors AS predecessor
           JOIN public.invoices AS source
             ON source.id = predecessor."sourceInvoiceId"
            AND source."companyId" = predecessor."companyId"
          WHERE predecessor."companyId" = NEW."companyId"
            AND predecessor."invoiceId" = NEW.id
            AND (
              source."customerId" IS DISTINCT FROM NEW."customerId"
              OR source."parentQuoteId" IS DISTINCT FROM NEW."parentQuoteId"
              OR source.kind NOT IN ('deposit_invoice', 'situation')
              OR source.status NOT IN ('issued', 'partially_paid', 'paid', 'late')
              OR EXISTS (
                SELECT 1 FROM public.invoices AS credit
                 WHERE credit."companyId" = source."companyId"
                   AND credit.kind = 'credit_note'::public."DocKind"
                   AND credit."sourceInvoiceId" = source.id
                   AND credit.status NOT IN ('draft', 'cancelled')
              )
            )
       ) THEN
      RAISE EXCEPTION 'V2 final invoice predecessors no longer match active contract invoices'
        USING ERRCODE = '23514', CONSTRAINT = 'invoices_v2_predecessors_exact_set';
    END IF;

    IF NEW."depositDeductionCents" IS DISTINCT FROM expected_deduction_cents
       OR NEW."situationDeductionCents" IS DISTINCT FROM expected_situation_cents THEN
      RAISE EXCEPTION 'V2 final invoice deductions do not match active predecessors'
        USING ERRCODE = '23514', CONSTRAINT = 'invoices_v2_predecessor_amounts_exact';
    END IF;

    IF (expected_predecessor_count = 1
        AND NEW."depositInvoiceId" IS DISTINCT FROM expected_unique_source_id)
       OR (expected_predecessor_count <> 1 AND NEW."depositInvoiceId" IS NOT NULL) THEN
      RAISE EXCEPTION 'V2 final invoice navigation source does not match predecessor cardinality'
        USING ERRCODE = '23514', CONSTRAINT = 'invoices_v2_predecessor_navigation_exact';
    END IF;

    IF NEW."parentQuoteId" IS NOT NULL AND (
      NOT EXISTS (
        SELECT 1 FROM public.line_items AS any_target_line
         WHERE any_target_line."invoiceId" = NEW.id
      )
      OR EXISTS (
        SELECT 1
          FROM public.line_items AS target_line
          LEFT JOIN public.line_items AS source_line
            ON source_line.id = target_line."sourceQuoteLineId"
          LEFT JOIN public.quotes AS source_quote
            ON source_quote.id = source_line."quoteId"
         WHERE target_line."invoiceId" = NEW.id
           AND (
             target_line."sourceQuoteLineId" IS NULL
             OR source_line."invoiceId" IS NOT NULL
             OR source_quote.id IS NULL
             OR source_quote."companyId" IS DISTINCT FROM NEW."companyId"
             OR source_quote.id IS DISTINCT FROM NEW."parentQuoteId"
             OR source_quote.status <> 'signed'::public."QuoteStatus"
           )
      )
    ) THEN
      RAISE EXCEPTION 'V2 final lines must retain their signed quote provenance'
        USING ERRCODE = '23514', CONSTRAINT = 'invoices_v2_final_line_provenance';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER invoices_settlement_semantics_v2
BEFORE INSERT OR UPDATE ON public.invoices
FOR EACH ROW
EXECUTE FUNCTION public.enforce_invoice_settlement_semantics_v2();

COMMIT;
