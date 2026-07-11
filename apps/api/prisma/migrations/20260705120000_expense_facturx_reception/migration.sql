-- C-EXP6b « réception e-facture » : n° de facture FOURNISSEUR (Factur-X BT-1) + échéance (BT-9)
-- sur la dépense — ADDITIF (nullable, aucune donnée existante touchée), RLS inchangée.
ALTER TABLE "expenses" ADD COLUMN "supplierInvoiceNumber" TEXT;
ALTER TABLE "expenses" ADD COLUMN "dueAt" TEXT;

-- C-EXP-FIX1 (Bug 1 — DOUBLON TOCTOU) : le contrôle applicatif read-then-write (listByCompany, HORS
-- transaction, PK aléatoire) laissait passer deux `confirm {approve}` CONCURRENTS (double-tap/retry)
-- → 2 Expenses + double déduction TVA (44566), 401 doublé, FEC non fiable. La VRAIE garde
-- concurrentielle est une contrainte base : index UNIQUE PARTIEL sur (companyId, SIREN fournisseur,
-- n° de facture) RESTREINT aux e-factures (`supplierInvoiceNumber IS NOT NULL`). Toute e-facture porte
-- un n° BT-1 → contrainte ; les dépenses manuelles/OCR (n° NULL) restent HORS contrainte (multiples OK).
-- Prisma ne sait PAS exprimer un index unique PARTIEL dans schema.prisma → SQL brut ici (le schema
-- porte le commentaire `/// @unique partiel (…) géré en SQL`). Les colonnes étant ajoutées ci-dessus,
-- aucune ligne existante ne peut violer la contrainte à la création de l'index.
CREATE UNIQUE INDEX "uniq_expense_supplier_invoice"
  ON "expenses" ("companyId", "supplierSiren", "supplierInvoiceNumber")
  WHERE "supplierInvoiceNumber" IS NOT NULL;
