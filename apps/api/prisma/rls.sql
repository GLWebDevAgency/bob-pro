-- Bob Pro — Row Level Security (défense en profondeur multi-tenant).
-- Tenant courant = current_setting('app.current_company_id'). L'app doit le poser par requête
-- (SET LOCAL app.current_company_id = '<companyId>' dans une transaction) et se connecter avec
-- un rôle applicatif. FORCE garantit que même le propriétaire de la table est soumis aux politiques.
-- À exécuter après les migrations Prisma : psql "$DATABASE_URL" -f prisma/rls.sql

DO $$
DECLARE t text;
BEGIN
  FOR t IN SELECT unnest(ARRAY['companies','customers','quotes','invoices','line_items','payments','public_access_tokens','document_counters']) LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
  END LOOP;
END $$;

DROP POLICY IF EXISTS tenant_isolation ON companies;
CREATE POLICY tenant_isolation ON companies
  USING (id = current_setting('app.current_company_id', true))
  WITH CHECK (id = current_setting('app.current_company_id', true));

DROP POLICY IF EXISTS tenant_isolation ON customers;
CREATE POLICY tenant_isolation ON customers
  USING ("companyId" = current_setting('app.current_company_id', true))
  WITH CHECK ("companyId" = current_setting('app.current_company_id', true));

DROP POLICY IF EXISTS tenant_isolation ON quotes;
CREATE POLICY tenant_isolation ON quotes
  USING ("companyId" = current_setting('app.current_company_id', true))
  WITH CHECK ("companyId" = current_setting('app.current_company_id', true));

DROP POLICY IF EXISTS tenant_isolation ON invoices;
CREATE POLICY tenant_isolation ON invoices
  USING ("companyId" = current_setting('app.current_company_id', true))
  WITH CHECK ("companyId" = current_setting('app.current_company_id', true));

DROP POLICY IF EXISTS tenant_isolation ON payments;
CREATE POLICY tenant_isolation ON payments
  USING ("companyId" = current_setting('app.current_company_id', true))
  WITH CHECK ("companyId" = current_setting('app.current_company_id', true));

DROP POLICY IF EXISTS tenant_or_public_token_lookup ON public_access_tokens;
CREATE POLICY tenant_or_public_token_lookup ON public_access_tokens
  USING (
    "companyId" = current_setting('app.current_company_id', true)
    OR "tokenHash" = current_setting('app.public_access_token_hash', true)
  )
  WITH CHECK ("companyId" = current_setting('app.current_company_id', true));

DROP POLICY IF EXISTS tenant_isolation ON document_counters;
CREATE POLICY tenant_isolation ON document_counters
  USING ("companyId" = current_setting('app.current_company_id', true))
  WITH CHECK ("companyId" = current_setting('app.current_company_id', true));

-- line_items : rattachées via leur document parent.
DROP POLICY IF EXISTS tenant_isolation ON line_items;
CREATE POLICY tenant_isolation ON line_items
  USING (
    EXISTS (SELECT 1 FROM quotes q WHERE q.id = line_items."quoteId" AND q."companyId" = current_setting('app.current_company_id', true))
    OR EXISTS (SELECT 1 FROM invoices i WHERE i.id = line_items."invoiceId" AND i."companyId" = current_setting('app.current_company_id', true))
  );
