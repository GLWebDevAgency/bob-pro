-- Coffre documentaire hiérarchique : emplacement indépendant du rattachement métier.
CREATE TYPE "DocumentFolderStatus" AS ENUM ('active', 'deleted');

CREATE TABLE "document_folders" (
  "id" TEXT NOT NULL,
  "companyId" TEXT NOT NULL,
  "parentId" TEXT,
  "name" TEXT NOT NULL,
  "normalizedName" TEXT NOT NULL,
  "systemKey" TEXT,
  "status" "DocumentFolderStatus" NOT NULL DEFAULT 'active',
  "revision" INTEGER NOT NULL DEFAULT 1,
  "createdAt" TIMESTAMP(3) NOT NULL,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  "deletedAt" TIMESTAMP(3),
  CONSTRAINT "document_folders_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "uniq_document_folder_company_id" UNIQUE ("companyId", "id"),
  CONSTRAINT "uniq_document_folder_system_key" UNIQUE ("companyId", "systemKey"),
  CONSTRAINT "document_folders_companyId_fkey"
    FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "document_folders_companyId_parentId_fkey"
    FOREIGN KEY ("companyId", "parentId") REFERENCES "document_folders"("companyId", "id")
    ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE INDEX "document_folders_companyId_parentId_status_idx"
  ON "document_folders"("companyId", "parentId", "status");
-- PostgreSQL considère deux NULL distincts : COALESCE garantit aussi l'unicité à la racine.
CREATE UNIQUE INDEX "document_folders_active_sibling_name_key"
  ON "document_folders"("companyId", COALESCE("parentId", ''), "normalizedName")
  WHERE "status" = 'active';

-- Confirmation destructive à usage unique : le snapshot ne quitte jamais le serveur.
CREATE TABLE "document_folder_deletion_plans" (
  "id" TEXT NOT NULL,
  "companyId" TEXT NOT NULL,
  "folderId" TEXT NOT NULL,
  "expectedRevision" INTEGER NOT NULL,
  "expectedSnapshot" JSONB NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL,
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "consumedAt" TIMESTAMP(3),
  CONSTRAINT "document_folder_deletion_plans_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "document_folder_deletion_plans_companyId_fkey"
    FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "document_folder_deletion_plans_companyId_folderId_fkey"
    FOREIGN KEY ("companyId", "folderId") REFERENCES "document_folders"("companyId", "id")
    ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE INDEX "document_folder_deletion_plans_companyId_expiresAt_idx"
  ON "document_folder_deletion_plans"("companyId", "expiresAt");
CREATE INDEX "document_folder_deletion_plans_expiresAt_idx"
  ON "document_folder_deletion_plans"("expiresAt");

ALTER TABLE "documents" ADD COLUMN "folderId" TEXT;
ALTER TABLE "documents" ADD COLUMN "revision" INTEGER NOT NULL DEFAULT 1;
CREATE INDEX "documents_companyId_folderId_createdAt_idx"
  ON "documents"("companyId", "folderId", "createdAt");
ALTER TABLE "documents"
  ADD CONSTRAINT "documents_companyId_folderId_fkey"
  FOREIGN KEY ("companyId", "folderId") REFERENCES "document_folders"("companyId", "id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

-- Les dossiers de départ sont des données réelles, stables et renommables (systemKey ne change pas).
INSERT INTO "document_folders" (
  "id", "companyId", "parentId", "name", "normalizedName", "systemKey", "createdAt", "updatedAt"
)
SELECT c.id || ':vault:projects', c.id, NULL, 'Chantiers', 'chantiers', 'projects', NOW(), NOW() FROM "companies" c
UNION ALL
SELECT c.id || ':vault:purchases', c.id, NULL, 'Achats', 'achats', 'purchases', NOW(), NOW() FROM "companies" c
UNION ALL
SELECT c.id || ':vault:insurance', c.id, NULL, 'Assurances', 'assurances', 'insurance', NOW(), NOW() FROM "companies" c
UNION ALL
SELECT c.id || ':vault:tax_social', c.id, NULL, 'Fiscal & social', 'fiscal & social', 'tax_social', NOW(), NOW() FROM "companies" c
UNION ALL
SELECT c.id || ':vault:bank', c.id, NULL, 'Banque', 'banque', 'bank', NOW(), NOW() FROM "companies" c
UNION ALL
SELECT c.id || ':vault:accounting', c.id, NULL, 'Comptable', 'comptable', 'accounting', NOW(), NOW() FROM "companies" c;

UPDATE "documents" d
SET "folderId" = d."companyId" || ':vault:projects'
WHERE d."linkedEntityType" = 'chantier';

UPDATE "documents" d
SET "folderId" = d."companyId" || ':vault:purchases'
WHERE d."folderId" IS NULL
  AND (d."linkedEntityType" = 'expense' OR d."kind" = 'expense_receipt');

UPDATE "documents" d
SET "folderId" = d."companyId" || ':vault:accounting'
WHERE d."folderId" IS NULL
  AND d."kind" IN ('invoice_pdf', 'quote_pdf', 'facturx_xml', 'signed_quote');

-- Défense DB : le runtime applicatif ne voit et ne modifie que les dossiers du tenant courant.
ALTER TABLE "document_folders" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "document_folders" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "document_folders"
  USING ("companyId" = current_setting('app.current_company_id', true))
  WITH CHECK ("companyId" = current_setting('app.current_company_id', true));

ALTER TABLE "document_folder_deletion_plans" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "document_folder_deletion_plans" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "document_folder_deletion_plans"
  USING ("companyId" = current_setting('app.current_company_id', true))
  WITH CHECK ("companyId" = current_setting('app.current_company_id', true));
