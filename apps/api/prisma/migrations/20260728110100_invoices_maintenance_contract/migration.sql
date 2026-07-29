-- PR-12b [direction 4 + annexe errata n° 1/8] — la facture PORTE son contrat de maintenance.
--
-- 1) Colonne ADDITIVE invoices."maintenanceContractId" (NULL = pièce hors contrat, aucun
--    backfill) + FK composite anti-IDOR NOT VALID (VALIDATE en migration séparée, leçon 25/07).
-- 2) Index PARTIEL de dérivation de couverture (annexe erratum n° 8 : son préfixe (companyId)
--    sert AUSSI la lecture BATCHÉE listContractInvoicesByCompany — une requête par tenant,
--    jamais N par contrat). CREATE INDEX non-CONCURRENTLY ASSUMÉ : invoices est de volumétrie
--    bêta faible et lock_timeout 5s borne l'attente ; règle de bascule écrite : si au moment
--    d'un futur redéploiement la table dépasse ~100k lignes en prod, l'index partirait en
--    CONCURRENTLY hors transaction (migration dédiée).
-- 3) Redéfinition COMPLÈTE de enforce_invoice_legal_traceability depuis sa DERNIÈRE version
--    en date = 20260727120000_invoices_chantier_freeze (annexe erratum n° 1 — JAMAIS un corps
--    périmé recopié : 20260719010000 dé-figerait silencieusement des champs légaux). Ajouts de
--    CETTE version, et rien d'autre :
--      • "maintenanceContractId" rejoint la liste d'immutabilité post-émission (le seul champ
--        nouveau — chantierId y est DÉJÀ depuis 20260727120000) ;
--      • le MIROIR exact de l'avoir est étendu à "chantierId", comme PROMIS par le commentaire
--        de 20260727120000 : tous les writers sont au niveau N depuis le train n°1 (le domaine
--        copie le site sur l'avoir, Invoice.creditNoteFor). Le miroir n'est PAS étendu à
--        maintenanceContractId : un writer N-1 (train n°2, encore en service pendant le
--        déploiement) crée des avoirs SANS cette colonne — l'exiger casserait l'avoir d'une
--        annuelle émise par un writer N (même leçon, l'extension suivra au train suivant).
--    Compatibilité writers N-1 sur la liste d'immutabilité : un UPDATE qui n'assigne pas la
--    colonne laisse NEW = OLD (IS DISTINCT FROM faux) — aucun chemin applicatif existant n'est
--    bloqué, seul un UPDATE SQL direct post-émission l'est. Writer N-1 rejoué par le cert
--    (maintenance-contracts.postgres.test.ts) sous CHAQUE état du trigger.

BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

ALTER TABLE "invoices" ADD COLUMN "maintenanceContractId" TEXT;

ALTER TABLE "invoices"
  ADD CONSTRAINT "invoices_maintenance_contract_company_fkey"
  FOREIGN KEY ("maintenanceContractId", "companyId")
  REFERENCES "maintenance_contracts"("id", "companyId")
  ON DELETE RESTRICT ON UPDATE CASCADE
  NOT VALID;

-- Dérivation de couverture (§2.5) : (companyId, maintenanceContractId, servicePeriodStart),
-- restreint aux pièces de contrat — épouse la forme de la requête, cardinalité minuscule.
CREATE INDEX "invoices_contract_period_idx"
  ON "invoices"("companyId", "maintenanceContractId", "servicePeriodStart")
  WHERE "maintenanceContractId" IS NOT NULL;

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
    -- PR-08 : le site de rattachement imprimé dans la vie de la pièce ÉMISE est un FAIT de
    -- la pièce — figé comme les autres (le rattachement se joue à la composition/dérivation,
    -- jamais après émission : aucun mutateur applicatif n'existe).
    OR NEW."chantierId" IS DISTINCT FROM OLD."chantierId"
    -- PR-12b : le contrat facturé par la pièce ÉMISE est un FAIT — figé. La couverture d'une
    -- période contractuelle se DÉRIVE de cette colonne : la muter après émission fabriquerait
    -- (ou effacerait) une couverture, donc une double facturation ou un revenu perdu.
    OR NEW."maintenanceContractId" IS DISTINCT FROM OLD."maintenanceContractId"
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
      "totalsRetenueGarantieCents",
      "chantierId"
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
      OR NEW."totalsRetenueGarantieCents" IS DISTINCT FROM source_record."totalsRetenueGarantieCents"
      -- PR-08→PR-12b : l'avoir rectifie la même opération sur le MÊME site (extension du
      -- miroir promise par 20260727120000 — tous les writers copient chantierId depuis le
      -- train n°1). maintenanceContractId N'EST PAS dans le miroir : writer N-1 compatible.
      OR NEW."chantierId" IS DISTINCT FROM source_record."chantierId" THEN
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

COMMIT;
