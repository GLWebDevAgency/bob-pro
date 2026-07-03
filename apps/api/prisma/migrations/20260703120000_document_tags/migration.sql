-- #11 (excellence OCR, A4-C14) : tags de classement/recherche sur les documents du coffre.
ALTER TABLE "documents" ADD COLUMN "tags" TEXT[] NOT NULL DEFAULT '{}';
