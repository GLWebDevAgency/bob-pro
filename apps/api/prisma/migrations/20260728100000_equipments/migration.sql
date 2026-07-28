-- PR-11b « Le métier » (Bloc A, C1, exigence 2) — parc d'équipements d'un SITE.
-- Table NEUVE (contraintes inline, patron chantier_notes/customer_contacts) :
--   • FK composite (chantierId, companyId) anti-IDOR vers chantiers, ON DELETE RESTRICT ;
--   • CHECK status généré depuis la SOURCE TypeScript (EquipmentStatus, equipment.ts) —
--     'active' | 'retired', garde anti-drift dans equipments.postgres.test.ts ;
--   • cohérence TRIPLE statut/retrait [revue P11] : (status='retired') = (retiredAt NOT NULL)
--     — jamais un demi-état, « Retirée le … » affiche toujours un fait réel ;
--   • kind LIBRE : bornes de forme uniquement (btrim/longueur), JAMAIS d'énumération métier ;
--   • garantie >= pose quand les deux sont présentes (miroir du domaine).
-- RLS ENABLE+FORCE + policy tenant_isolation ; les grants runtime viennent du socle
-- grant_app_role de release.sh, le DELETE est RETIRÉ explicitement (retrait logique
-- uniquement — voir release.sh, REVOKE DELETE ON public.equipments).

BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

CREATE TABLE "equipments" (
  "id" TEXT NOT NULL,
  "companyId" TEXT NOT NULL,
  "chantierId" TEXT NOT NULL,
  "label" TEXT NOT NULL,
  "kind" TEXT,
  "brand" TEXT,
  "serialNumber" TEXT,
  "location" TEXT,
  "installedAt" DATE,
  "warrantyUntil" DATE,
  "status" TEXT NOT NULL DEFAULT 'active',
  "retiredAt" TIMESTAMPTZ(6),
  "notes" TEXT,
  "revision" INTEGER NOT NULL DEFAULT 1,
  "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(6) NOT NULL,
  CONSTRAINT "equipments_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "uniq_equipment_id_company" UNIQUE ("id", "companyId"),
  CONSTRAINT "equipments_companyId_fkey"
    FOREIGN KEY ("companyId") REFERENCES "companies"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "equipments_chantier_company_fkey"
    FOREIGN KEY ("chantierId", "companyId") REFERENCES "chantiers"("id", "companyId")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  -- Généré depuis la source TS (EquipmentStatus) — leçon 25/07, drift gardé par le cert.
  CONSTRAINT "equipments_status_check"
    CHECK ("status" IN ('active', 'retired')),
  -- [Revue P11] cohérence triple : jamais un retrait sans fait, jamais un fait sans retrait.
  CONSTRAINT "equipments_retired_coherence_check"
    CHECK (("status" = 'retired') = ("retiredAt" IS NOT NULL)),
  CONSTRAINT "equipments_label_check"
    CHECK (
      char_length(btrim("label")) BETWEEN 1 AND 200
      AND "label" = btrim("label")
      AND "label" !~ '[[:cntrl:]]'
    ),
  CONSTRAINT "equipments_kind_check"
    CHECK (
      "kind" IS NULL
      OR (
        char_length(btrim("kind")) BETWEEN 1 AND 200
        AND "kind" = btrim("kind")
        AND "kind" !~ '[[:cntrl:]]'
      )
    ),
  CONSTRAINT "equipments_brand_check"
    CHECK (
      "brand" IS NULL
      OR (
        char_length(btrim("brand")) BETWEEN 1 AND 200
        AND "brand" = btrim("brand")
        AND "brand" !~ '[[:cntrl:]]'
      )
    ),
  CONSTRAINT "equipments_serial_check"
    CHECK (
      "serialNumber" IS NULL
      OR (
        char_length(btrim("serialNumber")) BETWEEN 1 AND 200
        AND "serialNumber" = btrim("serialNumber")
        AND "serialNumber" !~ '[[:cntrl:]]'
      )
    ),
  CONSTRAINT "equipments_location_check"
    CHECK (
      "location" IS NULL
      OR (
        char_length(btrim("location")) BETWEEN 1 AND 200
        AND "location" = btrim("location")
        AND "location" !~ '[[:cntrl:]]'
      )
    ),
  CONSTRAINT "equipments_notes_check"
    CHECK (
      "notes" IS NULL
      OR (
        char_length(btrim("notes")) BETWEEN 1 AND 2000
        AND "notes" = btrim("notes")
        AND "notes" !~ '[[:cntrl:]]'
      )
    ),
  CONSTRAINT "equipments_warranty_check"
    CHECK (
      "installedAt" IS NULL
      OR "warrantyUntil" IS NULL
      OR "warrantyUntil" >= "installedAt"
    ),
  CONSTRAINT "equipments_revision_check"
    CHECK ("revision" BETWEEN 1 AND 2147483647)
);

-- Liste du parc (segment Actifs/Retirés) servie par index.
CREATE INDEX "equipments_company_chantier_status_idx"
  ON "equipments"("companyId", "chantierId", "status");

-- Défense en profondeur : même un défaut applicatif reste confiné au tenant courant.
ALTER TABLE "equipments" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "equipments" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "equipments"
  USING ("companyId" = current_setting('app.current_company_id', true))
  WITH CHECK ("companyId" = current_setting('app.current_company_id', true));

COMMIT;
