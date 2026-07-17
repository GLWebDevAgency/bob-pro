-- Catalogue propriétaire et chantiers durables. Aucune ligne de démonstration n'est insérée.
CREATE TYPE "ChantierStatus" AS ENUM ('open', 'closed');

CREATE UNIQUE INDEX "uniq_customer_id_company" ON "customers"("id", "companyId");

CREATE TABLE "catalogue_prestations" (
  "id" TEXT NOT NULL,
  "companyId" TEXT NOT NULL,
  "label" TEXT NOT NULL,
  "category" "LineCategory" NOT NULL,
  "unit" TEXT,
  "unitPriceHt" INTEGER NOT NULL,
  "vatRate" DECIMAL(4,2) NOT NULL,
  "revision" INTEGER NOT NULL DEFAULT 1,
  "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "catalogue_prestations_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "uniq_catalogue_prestation_id_company" UNIQUE ("id", "companyId"),
  CONSTRAINT "catalogue_prestations_companyId_fkey"
    FOREIGN KEY ("companyId") REFERENCES "companies"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "catalogue_prestations_category_check"
    CHECK ("category" IN ('labor', 'supply', 'travel')),
  CONSTRAINT "catalogue_prestations_label_check"
    CHECK (
      char_length(btrim("label")) BETWEEN 1 AND 500
      AND "label" = btrim("label")
      AND "label" !~ '[[:cntrl:]]'
    ),
  CONSTRAINT "catalogue_prestations_unit_check"
    CHECK (
      "unit" IS NULL OR (
        char_length(btrim("unit")) BETWEEN 1 AND 80
        AND "unit" = btrim("unit")
        AND "unit" !~ '[[:cntrl:]]'
      )
    ),
  CONSTRAINT "catalogue_prestations_price_check"
    CHECK ("unitPriceHt" BETWEEN 1 AND 1500000000),
  CONSTRAINT "catalogue_prestations_vat_check"
    CHECK ("vatRate" IN (0, 5.5, 10, 20)),
  CONSTRAINT "catalogue_prestations_revision_check" CHECK ("revision" >= 1)
);

CREATE INDEX "catalogue_prestations_company_category_label_idx"
  ON "catalogue_prestations"("companyId", "category", "label");

CREATE TABLE "chantiers" (
  "id" TEXT NOT NULL,
  "companyId" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "customerId" TEXT,
  "address" TEXT,
  "status" "ChantierStatus" NOT NULL DEFAULT 'open',
  "openedAt" DATE NOT NULL,
  "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "chantiers_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "uniq_chantier_id_company" UNIQUE ("id", "companyId"),
  CONSTRAINT "chantiers_companyId_fkey"
    FOREIGN KEY ("companyId") REFERENCES "companies"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "chantiers_customer_company_fkey"
    FOREIGN KEY ("customerId", "companyId") REFERENCES "customers"("id", "companyId")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "chantiers_name_check"
    CHECK (
      char_length(btrim("name")) BETWEEN 1 AND 200
      AND "name" = btrim("name")
      AND "name" !~ '[[:cntrl:]]'
    ),
  CONSTRAINT "chantiers_address_check"
    CHECK (
      "address" IS NULL OR (
        char_length(btrim("address")) BETWEEN 1 AND 500
        AND "address" = btrim("address")
        AND "address" !~ '[[:cntrl:]]'
      )
    )
);

CREATE INDEX "chantiers_company_status_opened_idx"
  ON "chantiers"("companyId", "status", "openedAt" DESC);
CREATE INDEX "chantiers_customer_company_idx"
  ON "chantiers"("customerId", "companyId");

-- Défense en profondeur : même un défaut applicatif reste confiné au tenant courant.
ALTER TABLE "catalogue_prestations" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "catalogue_prestations" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "catalogue_prestations"
  USING ("companyId" = current_setting('app.current_company_id', true))
  WITH CHECK ("companyId" = current_setting('app.current_company_id', true));

ALTER TABLE "chantiers" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "chantiers" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "chantiers"
  USING ("companyId" = current_setting('app.current_company_id', true))
  WITH CHECK ("companyId" = current_setting('app.current_company_id', true));
