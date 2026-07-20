-- ÉPIC « pièces conformes » — socle DONNÉES des items A1/A2/A6/A7 (AUDIT_INDISPENSABLES_V1).
-- Migration STRICTEMENT ADDITIVE : colonnes nullable, AUCUN backfill inventé — les lignes
-- historiques restent honnêtement sans valeur (jamais rétro-datées, jamais rétro-remplies).

-- A6 — Capital social (art. R123-238 code de commerce : forme juridique + capital social sur
-- les factures et documents des sociétés commerciales ; décret n° 2022-725 du 28/04/2022 pour
-- la mention « EI » des entrepreneurs individuels — portée par legalForm, pas par une colonne).
-- BIGINT en CENTIMES, NULL = jamais saisi. Sociétés uniquement : garde du domaine (Company.of).
-- A2 — Médiateur de la consommation (art. L612-1 code conso : adhésion obligatoire ;
-- art. L616-1 : communication du nom et des coordonnées du médiateur sur les documents ;
-- sanction art. L641-1 : amende administrative 3 000 € / 15 000 €). Les deux colonnes vont
-- ensemble : un nom sans coordonnées (ou l'inverse) n'a aucun sens de saisine.
ALTER TABLE "companies"
  ADD COLUMN "capitalSocialCents" BIGINT,
  ADD COLUMN "mediateurConsoNom" TEXT,
  ADD COLUMN "mediateurConsoCoordonnees" TEXT;

ALTER TABLE "companies"
  ADD CONSTRAINT "companies_capital_social_positive"
  CHECK ("capitalSocialCents" IS NULL OR "capitalSocialCents" > 0),
  ADD CONSTRAINT "companies_mediateur_conso_shape"
  CHECK (
    ("mediateurConsoNom" IS NULL AND "mediateurConsoCoordonnees" IS NULL)
    OR (
      "mediateurConsoNom" IS NOT NULL AND "mediateurConsoCoordonnees" IS NOT NULL
      AND btrim("mediateurConsoNom") <> '' AND char_length("mediateurConsoNom") <= 200
      AND btrim("mediateurConsoCoordonnees") <> '' AND char_length("mediateurConsoCoordonnees") <= 500
    )
  );

-- A1 — Date d'établissement du devis (arrêté du 24 janvier 2017 relatif à la publicité des prix
-- des prestations de dépannage/réparation/entretien : le devis porte sa date d'établissement).
-- Dérivée à l'ENVOI (jour métier Europe/Paris) par l'agrégat Quote — NULL = brouillon jamais
-- envoyé, ou devis legacy envoyé avant l'ajout du champ (jamais rétro-daté depuis createdAt).
ALTER TABLE "quotes"
  ADD COLUMN "issuedAt" DATE;

-- A7 — Date de la vente/prestation si distincte de l'émission + adresse de chantier/livraison si
-- distincte de la facturation (art. L441-9 code de commerce et art. 242 nonies A, I-8° annexe II
-- CGI ; donnée renforcée par la réforme e-invoicing 2026). FIGÉES à l'émission (trigger ci-après).
ALTER TABLE "invoices"
  ADD COLUMN "servicePeriodStart" DATE,
  ADD COLUMN "servicePeriodEnd" DATE,
  ADD COLUMN "deliveryAddress" TEXT;

ALTER TABLE "invoices"
  ADD CONSTRAINT "invoices_service_period_shape"
  CHECK (
    "servicePeriodEnd" IS NULL
    OR ("servicePeriodStart" IS NOT NULL AND "servicePeriodEnd" >= "servicePeriodStart")
  ),
  ADD CONSTRAINT "invoices_delivery_address_shape"
  CHECK (
    "deliveryAddress" IS NULL
    OR (btrim("deliveryAddress") <> '' AND char_length("deliveryAddress") <= 500)
  );

-- Les trois champs A7 sont FIGÉS à l'émission (le domaine ne les écrit que dans Invoice.issue) :
-- ajout à la liste des champs légalement immuables ET au miroir exact de l'avoir total.
-- Redéfinition complète de la fonction (corps du précédent 20260719010000 + colonnes A7) —
-- les autres gardes restent identiques.
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
    -- A7 : date de prestation et adresse de chantier imprimées sur la pièce émise — figées.
    OR NEW."servicePeriodStart" IS DISTINCT FROM OLD."servicePeriodStart"
    OR NEW."servicePeriodEnd" IS DISTINCT FROM OLD."servicePeriodEnd"
    OR NEW."deliveryAddress" IS DISTINCT FROM OLD."deliveryAddress"
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
      "vatByRate",
      "servicePeriodStart",
      "servicePeriodEnd",
      "deliveryAddress"
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
      OR NEW."vatByRate" IS DISTINCT FROM source_record."vatByRate"
      -- A7 : l'avoir rectifie la MÊME opération (art. 242 nonies A CGI) — période de prestation
      -- et adresse de chantier reprises À L'IDENTIQUE de la pièce annulée.
      OR NEW."servicePeriodStart" IS DISTINCT FROM source_record."servicePeriodStart"
      OR NEW."servicePeriodEnd" IS DISTINCT FROM source_record."servicePeriodEnd"
      OR NEW."deliveryAddress" IS DISTINCT FROM source_record."deliveryAddress" THEN
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
