-- ÉPIC « facturation terrain » — socle DONNÉES des items B1/B2/B3/B4/B5 + canal de facturation
-- (AUDIT_INDISPENSABLES_V1 groupe B, validé fondateur). Migration STRICTEMENT ADDITIVE :
-- colonnes nullable ou défaut neutre, AUCUN backfill inventé — les pièces émises restent
-- identiques au centime, les fiches clients existantes gardent leur comportement.

-- ————————————————————————————————————————————————————————————————————————————————————————
-- B3 — Remises (art. L441-9 code de commerce ; art. 242 nonies A, I-8° annexe II CGI :
-- « rabais, remises, ristournes acquis à la date de l'opération et directement liés »).
-- Deux formes EXCLUSIVES par remise : pourcentage (0 < % ≤ 100, 2 décimales) OU montant HT en
-- centimes (> 0). Le plafond « montant ≤ base remisée » vit dans le domaine (qui connaît la base).
-- ————————————————————————————————————————————————————————————————————————————————————————
ALTER TABLE "line_items"
  ADD COLUMN "discountPercent" DECIMAL(5, 2),
  ADD COLUMN "discountAmountCents" INTEGER;

ALTER TABLE "line_items"
  ADD CONSTRAINT "line_items_discount_exclusive"
  CHECK ("discountPercent" IS NULL OR "discountAmountCents" IS NULL),
  ADD CONSTRAINT "line_items_discount_percent_range"
  CHECK ("discountPercent" IS NULL OR ("discountPercent" > 0 AND "discountPercent" <= 100)),
  ADD CONSTRAINT "line_items_discount_amount_positive"
  CHECK ("discountAmountCents" IS NULL OR "discountAmountCents" > 0);

ALTER TABLE "quotes"
  ADD COLUMN "globalDiscountPercent" DECIMAL(5, 2),
  ADD COLUMN "globalDiscountAmountCents" INTEGER,
  -- B5 — retenue de garantie stipulée au devis (loi n° 71-584 du 16/07/1971 : ≤ 5 % des
  -- acomptes/situations d'un marché privé de travaux) ; s'applique aux pièces dérivées.
  ADD COLUMN "retenueGarantiePct" DECIMAL(5, 2);

ALTER TABLE "quotes"
  ADD CONSTRAINT "quotes_global_discount_exclusive"
  CHECK ("globalDiscountPercent" IS NULL OR "globalDiscountAmountCents" IS NULL),
  ADD CONSTRAINT "quotes_global_discount_percent_range"
  CHECK ("globalDiscountPercent" IS NULL OR ("globalDiscountPercent" > 0 AND "globalDiscountPercent" <= 100)),
  ADD CONSTRAINT "quotes_global_discount_amount_positive"
  CHECK ("globalDiscountAmountCents" IS NULL OR "globalDiscountAmountCents" > 0),
  ADD CONSTRAINT "quotes_retenue_garantie_range"
  CHECK ("retenueGarantiePct" IS NULL OR ("retenueGarantiePct" > 0 AND "retenueGarantiePct" <= 5));

-- ————————————————————————————————————————————————————————————————————————————————————————
-- B1/B2/B3/B5 — colonnes de la pièce facture : situation de travaux (n° d'ordre + part de
-- déduction), remise globale, retenue de garantie, qualification d'urgence (facture directe
-- B2C, art. L221-10, al. 2 et L221-28, 8° c. conso), compléments de totaux figés, et suivi
-- MANUEL de transmission (canal de facturation — mutable après émission : suivi opérationnel).
-- ————————————————————————————————————————————————————————————————————————————————————————
ALTER TABLE "invoices"
  ADD COLUMN "totalsGrossHt" INTEGER,
  ADD COLUMN "totalsDiscountCents" INTEGER,
  ADD COLUMN "totalsRetenueGarantieCents" INTEGER,
  ADD COLUMN "situationOrder" INTEGER,
  ADD COLUMN "situationDeductionCents" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "globalDiscountPercent" DECIMAL(5, 2),
  ADD COLUMN "globalDiscountAmountCents" INTEGER,
  ADD COLUMN "retenueGarantiePct" DECIMAL(5, 2),
  ADD COLUMN "urgentRepairRequestedAt" TIMESTAMPTZ(6),
  ADD COLUMN "transmissionDepositedAt" DATE,
  ADD COLUMN "transmissionAcceptedAt" DATE;

ALTER TABLE "invoices"
  ADD CONSTRAINT "invoices_global_discount_exclusive"
  CHECK ("globalDiscountPercent" IS NULL OR "globalDiscountAmountCents" IS NULL),
  ADD CONSTRAINT "invoices_global_discount_percent_range"
  CHECK ("globalDiscountPercent" IS NULL OR ("globalDiscountPercent" > 0 AND "globalDiscountPercent" <= 100)),
  ADD CONSTRAINT "invoices_global_discount_amount_positive"
  CHECK ("globalDiscountAmountCents" IS NULL OR "globalDiscountAmountCents" > 0),
  ADD CONSTRAINT "invoices_retenue_garantie_range"
  CHECK ("retenueGarantiePct" IS NULL OR ("retenueGarantiePct" > 0 AND "retenueGarantiePct" <= 5)),
  -- Un n° d'ordre de situation n'existe que sur une situation (ou l'avoir qui la reflète).
  ADD CONSTRAINT "invoices_situation_order_shape"
  CHECK (
    "situationOrder" IS NULL
    OR ("situationOrder" >= 1 AND kind IN ('situation', 'credit_note'))
  ),
  -- La part « situations » est un SOUS-ENSEMBLE de la déduction totale de la finale.
  ADD CONSTRAINT "invoices_situation_deduction_shape"
  CHECK ("situationDeductionCents" >= 0 AND "situationDeductionCents" <= "depositDeductionCents"),
  ADD CONSTRAINT "invoices_totals_extras_positive"
  CHECK (
    ("totalsGrossHt" IS NULL OR "totalsGrossHt" >= 0)
    AND ("totalsDiscountCents" IS NULL OR "totalsDiscountCents" >= 0)
    AND ("totalsRetenueGarantieCents" IS NULL OR "totalsRetenueGarantieCents" >= 0)
  ),
  -- Suivi de transmission honnête : jamais d'acceptation sans dépôt ni antérieure au dépôt.
  ADD CONSTRAINT "invoices_transmission_shape"
  CHECK (
    "transmissionAcceptedAt" IS NULL
    OR ("transmissionDepositedAt" IS NOT NULL AND "transmissionAcceptedAt" >= "transmissionDepositedAt")
  );

-- ————————————————————————————————————————————————————————————————————————————————————————
-- B4 — Conditions de paiement PROPRES au client (jours + fin de mois + libellé imprimable) :
-- pilotent l'échéance dérivée à l'émission (IssueInvoice priorité 2, plafond légal L441-10
-- validé par le domaine). Les TROIS colonnes vont ensemble. `ptLabel` historique inchangé.
-- Canal de FACTURATION (validé fondateur) : email | chorus | portail — champs annexes liés à
-- LEUR type (un code service hors Chorus est un état sans sens, refusé fail-closed).
-- ————————————————————————————————————————————————————————————————————————————————————————
ALTER TABLE "customers"
  ADD COLUMN "paymentTermsDays" INTEGER,
  ADD COLUMN "paymentTermsEndOfMonth" BOOLEAN,
  ADD COLUMN "paymentTermsLabel" TEXT,
  ADD COLUMN "billingChannelType" TEXT,
  ADD COLUMN "billingChorusServiceCode" TEXT,
  ADD COLUMN "billingPortailNom" TEXT,
  ADD COLUMN "billingPortailUrl" TEXT;

ALTER TABLE "customers"
  ADD CONSTRAINT "customers_payment_terms_shape"
  CHECK (
    ("paymentTermsDays" IS NULL AND "paymentTermsEndOfMonth" IS NULL AND "paymentTermsLabel" IS NULL)
    OR (
      "paymentTermsDays" IS NOT NULL AND "paymentTermsEndOfMonth" IS NOT NULL
      AND "paymentTermsLabel" IS NOT NULL
      AND "paymentTermsDays" >= 0 AND "paymentTermsDays" <= 365
      AND btrim("paymentTermsLabel") <> '' AND char_length("paymentTermsLabel") <= 120
    )
  ),
  ADD CONSTRAINT "customers_billing_channel_type"
  CHECK ("billingChannelType" IS NULL OR "billingChannelType" IN ('email', 'chorus', 'portail')),
  ADD CONSTRAINT "customers_billing_channel_chorus_shape"
  CHECK (
    "billingChorusServiceCode" IS NULL
    OR (
      "billingChannelType" = 'chorus'
      AND btrim("billingChorusServiceCode") <> '' AND char_length("billingChorusServiceCode") <= 100
    )
  ),
  ADD CONSTRAINT "customers_billing_channel_portail_shape"
  CHECK (
    (
      "billingPortailNom" IS NULL
      OR (
        "billingChannelType" = 'portail'
        AND btrim("billingPortailNom") <> '' AND char_length("billingPortailNom") <= 200
      )
    )
    AND (
      "billingPortailUrl" IS NULL
      OR (
        "billingChannelType" = 'portail'
        AND btrim("billingPortailUrl") <> '' AND char_length("billingPortailUrl") <= 500
      )
    )
  );

-- ————————————————————————————————————————————————————————————————————————————————————————
-- PLAN COMPTABLE — le compte 4117 (Clients - retenues de garantie, PCG) fait partie du plan
-- opérationnel PAR DÉFAUT (chart-of-accounts.ts) : les tenants dont le plan est DÉJÀ initialisé
-- en base le reçoivent par cet INSERT additif — condition de la première situation avec retenue
-- (l'écriture de la situation débite 4117). Idempotent (NOT EXISTS), aucune ligne modifiée.
-- ————————————————————————————————————————————————————————————————————————————————————————
INSERT INTO "accounting_accounts"
  ("companyId", "code", "label", "kind", "normalSide", "parentCode", "active", "postingAllowed", "createdAt", "updatedAt")
SELECT DISTINCT a."companyId", '4117', 'Clients - retenues de garantie',
       'asset'::"AccountingAccountKind", 'debit'::"AccountingNormalSide", '41', true, true, now(), now()
  FROM "accounting_accounts" a
 WHERE NOT EXISTS (
   SELECT 1 FROM "accounting_accounts" b
    WHERE b."companyId" = a."companyId" AND b."code" = '4117'
 );

-- ————————————————————————————————————————————————————————————————————————————————————————
-- IMMUTABILITÉ des pièces émises (pattern épic A) : les nouveaux faits LÉGAUX de la pièce
-- (situation, remises, retenue, compléments de totaux, qualification d'urgence) rejoignent la
-- liste des champs figés après émission ET le miroir exact de l'avoir total. Les colonnes de
-- SUIVI de transmission restent VOLONTAIREMENT mutables (suivi opérationnel post-émission,
-- pas un fait de la pièce). Redéfinition complète (corps du précédent
-- 20260719120000_a1_a2_a6_a7_pieces_conformes_donnees + colonnes B) — autres gardes identiques.
-- ————————————————————————————————————————————————————————————————————————————————————————
CREATE OR REPLACE FUNCTION enforce_invoice_legal_traceability()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public
AS $$
DECLARE
  source_record RECORD;
BEGIN
  -- Une pièce déjà émise reste légalement figée ; seules sa progression de statut, les sommes
  -- encaissées et le SUIVI de transmission peuvent encore évoluer via les use cases dédiés.
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
    -- B2/B3/B5/B1 : situation, remises, retenue, compléments de totaux et qualification
    -- d'urgence sont des FAITS de la pièce émise — figés (le suivi de transmission ne l'est pas).
    OR NEW."situationOrder" IS DISTINCT FROM OLD."situationOrder"
    OR NEW."situationDeductionCents" IS DISTINCT FROM OLD."situationDeductionCents"
    OR NEW."globalDiscountPercent" IS DISTINCT FROM OLD."globalDiscountPercent"
    OR NEW."globalDiscountAmountCents" IS DISTINCT FROM OLD."globalDiscountAmountCents"
    OR NEW."retenueGarantiePct" IS DISTINCT FROM OLD."retenueGarantiePct"
    OR NEW."urgentRepairRequestedAt" IS DISTINCT FROM OLD."urgentRepairRequestedAt"
    OR NEW."totalsGrossHt" IS DISTINCT FROM OLD."totalsGrossHt"
    OR NEW."totalsDiscountCents" IS DISTINCT FROM OLD."totalsDiscountCents"
    OR NEW."totalsRetenueGarantieCents" IS DISTINCT FROM OLD."totalsRetenueGarantieCents"
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
      "deliveryAddress",
      "situationOrder",
      "situationDeductionCents",
      "globalDiscountPercent",
      "globalDiscountAmountCents",
      "retenueGarantiePct",
      "totalsGrossHt",
      "totalsDiscountCents",
      "totalsRetenueGarantieCents"
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
      OR NEW."deliveryAddress" IS DISTINCT FROM source_record."deliveryAddress"
      -- B2/B3/B5 : l'avoir reflète la MÊME situation, les MÊMES remises et la MÊME retenue
      -- (miroir exact du domaine, Invoice.creditNoteFor — jamais recalculés).
      OR NEW."situationOrder" IS DISTINCT FROM source_record."situationOrder"
      OR NEW."situationDeductionCents" IS DISTINCT FROM source_record."situationDeductionCents"
      OR NEW."globalDiscountPercent" IS DISTINCT FROM source_record."globalDiscountPercent"
      OR NEW."globalDiscountAmountCents" IS DISTINCT FROM source_record."globalDiscountAmountCents"
      OR NEW."retenueGarantiePct" IS DISTINCT FROM source_record."retenueGarantiePct"
      OR NEW."totalsGrossHt" IS DISTINCT FROM source_record."totalsGrossHt"
      OR NEW."totalsDiscountCents" IS DISTINCT FROM source_record."totalsDiscountCents"
      OR NEW."totalsRetenueGarantieCents" IS DISTINCT FROM source_record."totalsRetenueGarantieCents" THEN
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
