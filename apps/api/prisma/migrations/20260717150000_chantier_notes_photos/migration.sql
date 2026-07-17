-- Journal d'activité (notes horodatées) et photos de chantier — extension V1 du module vertical
-- Chantiers (fiche chantier). Les octets des photos vont au MÊME stockage documentaire que le
-- coffre (DocumentStoragePort) ; seule la métadonnée vit ici, séparée du coffre fiscal
-- (StoredDocument) qui porte des règles de rétention/versions propres aux pièces légales.

CREATE TABLE "chantier_notes" (
  "id" TEXT NOT NULL,
  "companyId" TEXT NOT NULL,
  "chantierId" TEXT NOT NULL,
  "text" TEXT NOT NULL,
  "authorLabel" TEXT NOT NULL,
  "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "chantier_notes_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "chantier_notes_companyId_fkey"
    FOREIGN KEY ("companyId") REFERENCES "companies"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "chantier_notes_chantier_company_fkey"
    FOREIGN KEY ("chantierId", "companyId") REFERENCES "chantiers"("id", "companyId")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "chantier_notes_text_check"
    CHECK (
      char_length(btrim("text")) BETWEEN 1 AND 2000
      AND "text" = btrim("text")
      AND "text" !~ '[[:cntrl:]]'
    ),
  CONSTRAINT "chantier_notes_author_check"
    CHECK (
      char_length(btrim("authorLabel")) BETWEEN 1 AND 200
      AND "authorLabel" = btrim("authorLabel")
      AND "authorLabel" !~ '[[:cntrl:]]'
    )
);

CREATE INDEX "chantier_notes_chantier_created_idx"
  ON "chantier_notes"("companyId", "chantierId", "createdAt" DESC);

CREATE TABLE "chantier_photos" (
  "id" TEXT NOT NULL,
  "companyId" TEXT NOT NULL,
  "chantierId" TEXT NOT NULL,
  "filename" TEXT NOT NULL,
  "mimeType" TEXT NOT NULL,
  "byteSize" INTEGER NOT NULL,
  "storageKey" TEXT NOT NULL,
  "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "chantier_photos_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "chantier_photos_storageKey_key" UNIQUE ("storageKey"),
  CONSTRAINT "chantier_photos_companyId_fkey"
    FOREIGN KEY ("companyId") REFERENCES "companies"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "chantier_photos_chantier_company_fkey"
    FOREIGN KEY ("chantierId", "companyId") REFERENCES "chantiers"("id", "companyId")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "chantier_photos_filename_check"
    CHECK (
      char_length(btrim("filename")) BETWEEN 1 AND 260
      AND "filename" !~ '[[:cntrl:]]'
    ),
  CONSTRAINT "chantier_photos_mime_check" CHECK ("mimeType" LIKE 'image/%'),
  CONSTRAINT "chantier_photos_size_check" CHECK ("byteSize" BETWEEN 1 AND 15000000)
);

CREATE INDEX "chantier_photos_chantier_created_idx"
  ON "chantier_photos"("companyId", "chantierId", "createdAt" DESC);

-- Défense en profondeur : même un défaut applicatif reste confiné au tenant courant.
ALTER TABLE "chantier_notes" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "chantier_notes" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "chantier_notes"
  USING ("companyId" = current_setting('app.current_company_id', true))
  WITH CHECK ("companyId" = current_setting('app.current_company_id', true));

ALTER TABLE "chantier_photos" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "chantier_photos" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "chantier_photos"
  USING ("companyId" = current_setting('app.current_company_id', true))
  WITH CHECK ("companyId" = current_setting('app.current_company_id', true));
