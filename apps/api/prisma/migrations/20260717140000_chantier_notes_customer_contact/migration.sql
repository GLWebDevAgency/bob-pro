-- Note libre sur un chantier (contexte, accès, consignes — jamais une pièce, purement informative)
-- et nom du contact chez un client entreprise/public (raison sociale ≠ personne physique jointe).
-- Extensions additives, nullables : aucune ligne existante n'est affectée.
ALTER TABLE "chantiers"
  ADD COLUMN "notes" TEXT;

ALTER TABLE "chantiers"
  ADD CONSTRAINT "chantiers_notes_check" CHECK (
    "notes" IS NULL OR (
      char_length(btrim("notes")) BETWEEN 1 AND 2000
      AND "notes" = btrim("notes")
      AND "notes" !~ '[[:cntrl:]]'
    )
  );

ALTER TABLE "customers"
  ADD COLUMN "contactName" VARCHAR(200);

ALTER TABLE "customers"
  ADD CONSTRAINT "customers_contact_name_check" CHECK (
    "contactName" IS NULL OR (
      char_length(btrim("contactName")) BETWEEN 1 AND 200
      AND "contactName" = btrim("contactName")
      AND "contactName" !~ '[[:cntrl:]]'
    )
  );
