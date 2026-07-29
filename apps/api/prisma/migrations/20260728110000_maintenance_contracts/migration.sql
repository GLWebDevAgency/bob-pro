-- PR-12b « Le métier » (Bloc B, C2, exigence 3) — contrats de maintenance.
-- Trois tables NEUVES (contraintes inline, patron equipments/customer_contacts) :
--   • maintenance_contracts : machine draft|active|terminated (CHECK généré depuis la SOURCE
--     TS MaintenanceContractStatus, maintenance-contract.ts) ; cohérence TRIPLE de la
--     résiliation (chaque fait ⟺ statut) ; un actif/résilié porte TOUJOURS activatedAt ;
--     AUCUNE colonne billedThrough (direction 1 : la couverture se DÉRIVE des factures) ;
--   • maintenance_contract_lines : miroir du patron LineItem (§2.2 : unitPriceHtCents >= 0,
--     quantity > 0, position >= 0) — le montant annuel = Σ lignes, JAMAIS stocké ;
--   • maintenance_contract_equipments : liaison contrat↔équipements du MÊME site (garde use
--     case) — alimente l'avertissement au retrait (amélioration 4).
-- RLS ENABLE+FORCE + policy tenant_isolation ×3 ; grants via le socle release.sh
-- (maintenance_contract_equipments : REVOKE UPDATE — une liaison s'insère/se supprime,
-- jamais ne se modifie). [Amélioration 1 — défense en profondeur] trigger BEFORE DELETE
-- draft-only sur maintenance_contracts : le grant DELETE ne suffit jamais seul.

BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

CREATE TABLE "maintenance_contracts" (
  "id" TEXT NOT NULL,
  "companyId" TEXT NOT NULL,
  "customerId" TEXT NOT NULL,
  "chantierId" TEXT,
  "label" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'draft',
  "anniversaryDate" DATE NOT NULL,
  "noticeDays" INTEGER NOT NULL DEFAULT 30,
  "visitsPerYear" INTEGER NOT NULL DEFAULT 2,
  "tacitRenewal" BOOLEAN NOT NULL DEFAULT true,
  "importCoveredUntil" DATE,
  "activatedAt" TIMESTAMPTZ(6),
  "terminatedAt" TIMESTAMPTZ(6),
  "terminationEffectiveDate" DATE,
  "terminationNote" TEXT,
  "notes" TEXT,
  "revision" INTEGER NOT NULL DEFAULT 1,
  "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(6) NOT NULL,
  CONSTRAINT "maintenance_contracts_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "uniq_maintenance_contract_id_company" UNIQUE ("id", "companyId"),
  CONSTRAINT "maintenance_contracts_companyId_fkey"
    FOREIGN KEY ("companyId") REFERENCES "companies"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "maintenance_contracts_customer_company_fkey"
    FOREIGN KEY ("customerId", "companyId") REFERENCES "customers"("id", "companyId")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "maintenance_contracts_chantier_company_fkey"
    FOREIGN KEY ("chantierId", "companyId") REFERENCES "chantiers"("id", "companyId")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  -- Généré depuis la source TS (MaintenanceContractStatus) — drift gardé par le cert.
  CONSTRAINT "maintenance_contracts_status_check"
    CHECK ("status" IN ('draft', 'active', 'terminated')),
  CONSTRAINT "maintenance_contracts_label_check"
    CHECK (
      char_length(btrim("label")) BETWEEN 1 AND 200
      AND "label" = btrim("label")
      AND "label" !~ '[[:cntrl:]]'
    ),
  CONSTRAINT "maintenance_contracts_notice_check" CHECK ("noticeDays" BETWEEN 0 AND 365),
  CONSTRAINT "maintenance_contracts_visits_check" CHECK ("visitsPerYear" BETWEEN 0 AND 52),
  -- Cohérence TRIPLE de la résiliation : CHAQUE fait existe ssi le statut est résilié.
  CONSTRAINT "maintenance_contracts_terminated_coherence_check"
    CHECK (
      (("status" = 'terminated') = ("terminatedAt" IS NOT NULL))
      AND (("status" = 'terminated') = ("terminationEffectiveDate" IS NOT NULL))
    ),
  CONSTRAINT "maintenance_contracts_termination_note_check"
    CHECK ("terminationNote" IS NULL OR "status" = 'terminated'),
  -- Un actif/résilié a toujours son fait d'activation.
  CONSTRAINT "maintenance_contracts_activated_check"
    CHECK ("status" = 'draft' OR "activatedAt" IS NOT NULL),
  -- Motif et notes : texte de terrain multiligne (\n/\t admis, autres contrôles refusés).
  CONSTRAINT "maintenance_contracts_notes_check"
    CHECK (
      "notes" IS NULL
      OR (
        char_length(btrim("notes")) BETWEEN 1 AND 2000
        AND "notes" = btrim("notes")
        AND translate("notes", E'\n\t', '') !~ '[[:cntrl:]]'
      )
    ),
  CONSTRAINT "maintenance_contracts_termination_note_shape_check"
    CHECK (
      "terminationNote" IS NULL
      OR (
        char_length(btrim("terminationNote")) BETWEEN 1 AND 2000
        AND "terminationNote" = btrim("terminationNote")
        AND translate("terminationNote", E'\n\t', '') !~ '[[:cntrl:]]'
      )
    ),
  CONSTRAINT "maintenance_contracts_revision_check" CHECK ("revision" BETWEEN 1 AND 2147483647)
);

CREATE INDEX "maintenance_contracts_company_status_anniversary_idx"
  ON "maintenance_contracts"("companyId", "status", "anniversaryDate");
CREATE INDEX "maintenance_contracts_customer_company_idx"
  ON "maintenance_contracts"("customerId", "companyId");

CREATE TABLE "maintenance_contract_lines" (
  "id" TEXT NOT NULL,
  "companyId" TEXT NOT NULL,
  "contractId" TEXT NOT NULL,
  "catalogueItemId" TEXT,
  "label" TEXT NOT NULL,
  "quantity" DECIMAL(12,3) NOT NULL,
  "unitPriceHtCents" INTEGER NOT NULL,
  "vatRate" DECIMAL(4,2) NOT NULL,
  "position" INTEGER NOT NULL,
  CONSTRAINT "maintenance_contract_lines_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "uniq_maintenance_contract_line_id_company" UNIQUE ("id", "companyId"),
  CONSTRAINT "maintenance_contract_lines_companyId_fkey"
    FOREIGN KEY ("companyId") REFERENCES "companies"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  -- Les lignes suivent la vie du contrat (remplacement atomique par save) : CASCADE assumé,
  -- borné par le trigger draft-only du contrat (un contrat vivant ne se supprime jamais).
  CONSTRAINT "maintenance_contract_lines_contract_company_fkey"
    FOREIGN KEY ("contractId", "companyId") REFERENCES "maintenance_contracts"("id", "companyId")
    ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "maintenance_contract_lines_label_check"
    CHECK (
      char_length(btrim("label")) BETWEEN 1 AND 200
      AND "label" = btrim("label")
      AND "label" !~ '[[:cntrl:]]'
    ),
  CONSTRAINT "maintenance_contract_lines_quantity_check" CHECK ("quantity" > 0),
  CONSTRAINT "maintenance_contract_lines_unit_price_check"
    CHECK ("unitPriceHtCents" BETWEEN 0 AND 1500000000),
  CONSTRAINT "maintenance_contract_lines_position_check" CHECK ("position" >= 0)
);

CREATE INDEX "maintenance_contract_lines_contract_company_idx"
  ON "maintenance_contract_lines"("contractId", "companyId");

CREATE TABLE "maintenance_contract_equipments" (
  "companyId" TEXT NOT NULL,
  "contractId" TEXT NOT NULL,
  "equipmentId" TEXT NOT NULL,
  CONSTRAINT "maintenance_contract_equipments_pkey"
    PRIMARY KEY ("companyId", "contractId", "equipmentId"),
  CONSTRAINT "maintenance_contract_equipments_companyId_fkey"
    FOREIGN KEY ("companyId") REFERENCES "companies"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "maintenance_contract_equipments_contract_company_fkey"
    FOREIGN KEY ("contractId", "companyId") REFERENCES "maintenance_contracts"("id", "companyId")
    ON DELETE CASCADE ON UPDATE CASCADE,
  -- Un équipement COUVERT ne se supprime pas (le parc ne connaît que le retrait logique) :
  -- RESTRICT — l'avertissement honnête (amélioration 4) continue de se dériver.
  CONSTRAINT "maintenance_contract_equipments_equipment_company_fkey"
    FOREIGN KEY ("equipmentId", "companyId") REFERENCES "equipments"("id", "companyId")
    ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE INDEX "maintenance_contract_equipments_equipment_company_idx"
  ON "maintenance_contract_equipments"("equipmentId", "companyId");

-- [Amélioration 1] défense en profondeur : seul un BROUILLON se supprime — même si un défaut
-- applicatif (ou une policy future) laissait passer un DELETE, la base re-refuse.
CREATE OR REPLACE FUNCTION enforce_maintenance_contract_draft_only_delete()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF OLD.status <> 'draft' THEN
    RAISE EXCEPTION 'only draft maintenance contracts can be deleted'
      USING ERRCODE = '23514', CONSTRAINT = 'maintenance_contracts_draft_only_delete';
  END IF;
  RETURN OLD;
END;
$$;

CREATE TRIGGER maintenance_contracts_draft_only_delete
  BEFORE DELETE ON "maintenance_contracts"
  FOR EACH ROW EXECUTE FUNCTION enforce_maintenance_contract_draft_only_delete();

-- Défense en profondeur : même un défaut applicatif reste confiné au tenant courant.
ALTER TABLE "maintenance_contracts" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "maintenance_contracts" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "maintenance_contracts"
  USING ("companyId" = current_setting('app.current_company_id', true))
  WITH CHECK ("companyId" = current_setting('app.current_company_id', true));

ALTER TABLE "maintenance_contract_lines" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "maintenance_contract_lines" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "maintenance_contract_lines"
  USING ("companyId" = current_setting('app.current_company_id', true))
  WITH CHECK ("companyId" = current_setting('app.current_company_id', true));

ALTER TABLE "maintenance_contract_equipments" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "maintenance_contract_equipments" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "maintenance_contract_equipments"
  USING ("companyId" = current_setting('app.current_company_id', true))
  WITH CHECK ("companyId" = current_setting('app.current_company_id', true));

COMMIT;
