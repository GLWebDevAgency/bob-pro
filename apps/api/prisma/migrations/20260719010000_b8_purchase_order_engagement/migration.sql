-- B8 — Bon de commande grands comptes (numéro d'engagement RATP/collectivités/majors du BTP).
-- Le numéro est saisi UNE FOIS sur le devis, repris sur la facture dérivée et DOIT figurer sur la
-- facture émise (exigence de paiement des grands comptes + obligation Chorus Pro secteur public).
--
-- Anti-IDOR : le document du coffre éventuellement lié (bon de commande scanné) est contraint au
-- MÊME tenant par une FK composite (companyId, purchaseOrderDocumentId) → documents(companyId, id),
-- même doctrine que les FK composites tenant existantes (customers, parentQuote, depositInvoice).
--
-- `revision` porte la concurrence optimiste des mutations de bon de commande (défaut 1 : toutes
-- les lignes historiques démarrent à la révision du domaine réhydraté — compat ascendante totale).

ALTER TABLE "quotes"
  ADD COLUMN "purchaseOrderNumber" TEXT,
  ADD COLUMN "purchaseOrderReceivedAt" TIMESTAMPTZ(6),
  ADD COLUMN "purchaseOrderDocumentId" TEXT,
  ADD COLUMN "revision" INTEGER NOT NULL DEFAULT 1;

ALTER TABLE "invoices"
  ADD COLUMN "purchaseOrderNumber" TEXT,
  ADD COLUMN "purchaseOrderReceivedAt" TIMESTAMPTZ(6),
  ADD COLUMN "purchaseOrderDocumentId" TEXT,
  ADD COLUMN "revision" INTEGER NOT NULL DEFAULT 1;

-- Garde de forme : miroir des invariants du domaine (numéro 1..60 assaini, pas de méta de bon de
-- commande sans numéro). La base reste sûre même face à une écriture administrative directe.
ALTER TABLE "quotes"
  ADD CONSTRAINT "quotes_po_number_shape"
  CHECK (
    "purchaseOrderNumber" IS NULL
    OR (length("purchaseOrderNumber") BETWEEN 1 AND 60 AND btrim("purchaseOrderNumber") <> '')
  ),
  ADD CONSTRAINT "quotes_po_meta_requires_number"
  CHECK (
    "purchaseOrderNumber" IS NOT NULL
    OR ("purchaseOrderReceivedAt" IS NULL AND "purchaseOrderDocumentId" IS NULL)
  ),
  ADD CONSTRAINT "quotes_revision_positive" CHECK ("revision" >= 1);

ALTER TABLE "invoices"
  ADD CONSTRAINT "invoices_po_number_shape"
  CHECK (
    "purchaseOrderNumber" IS NULL
    OR (length("purchaseOrderNumber") BETWEEN 1 AND 60 AND btrim("purchaseOrderNumber") <> '')
  ),
  ADD CONSTRAINT "invoices_po_meta_requires_number"
  CHECK (
    "purchaseOrderNumber" IS NOT NULL
    OR ("purchaseOrderReceivedAt" IS NULL AND "purchaseOrderDocumentId" IS NULL)
  ),
  ADD CONSTRAINT "invoices_revision_positive" CHECK ("revision" >= 1);

-- FK composites anti-IDOR : un devis/une facture ne peut référencer qu'un document de SON tenant.
ALTER TABLE "quotes"
  ADD CONSTRAINT "quotes_po_document_tenant_fkey"
  FOREIGN KEY ("companyId", "purchaseOrderDocumentId")
  REFERENCES "documents"("companyId", "id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "invoices"
  ADD CONSTRAINT "invoices_po_document_tenant_fkey"
  FOREIGN KEY ("companyId", "purchaseOrderDocumentId")
  REFERENCES "documents"("companyId", "id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE INDEX "quotes_po_document_company_idx"
  ON "quotes"("purchaseOrderDocumentId", "companyId")
  WHERE "purchaseOrderDocumentId" IS NOT NULL;
CREATE INDEX "invoices_po_document_company_idx"
  ON "invoices"("purchaseOrderDocumentId", "companyId")
  WHERE "purchaseOrderDocumentId" IS NOT NULL;

-- Le bon de commande d'une facture est FIGÉ à l'émission (le domaine n'autorise l'attache/le
-- retrait qu'en brouillon) : on l'ajoute à la liste des champs légalement immuables du trigger
-- invoices_legal_traceability. Redéfinition complète de la fonction (corps du précédent
-- 20260714060000 + les trois colonnes B8) — les autres gardes restent identiques.
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
    -- B8 : le numéro d'engagement imprimé sur la pièce émise ne bouge plus jamais.
    OR NEW."purchaseOrderNumber" IS DISTINCT FROM OLD."purchaseOrderNumber"
    OR NEW."purchaseOrderReceivedAt" IS DISTINCT FROM OLD."purchaseOrderReceivedAt"
    OR NEW."purchaseOrderDocumentId" IS DISTINCT FROM OLD."purchaseOrderDocumentId"
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
