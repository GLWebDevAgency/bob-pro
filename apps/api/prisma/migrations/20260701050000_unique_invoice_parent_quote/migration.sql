-- Empêche la double génération d'une facture du même type depuis le même devis signé.
-- Postgres autorise plusieurs NULL dans un index unique, donc les factures standalone restent multiples.

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM (
      SELECT "companyId", "parentQuoteId", kind, COUNT(*) AS n
      FROM "invoices"
      WHERE "parentQuoteId" IS NOT NULL
      GROUP BY "companyId", "parentQuoteId", kind
      HAVING COUNT(*) > 1
    ) duplicates
  ) THEN
    RAISE EXCEPTION 'Cannot add uniq_invoice_parent_quote_kind: duplicate invoices already exist for a quote/kind';
  END IF;
END $$;

CREATE UNIQUE INDEX "uniq_invoice_parent_quote_kind" ON "invoices"("companyId", "parentQuoteId", "kind");
