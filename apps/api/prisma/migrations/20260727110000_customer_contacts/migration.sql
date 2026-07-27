-- PR-09 « Le métier » — contacts multiples d'un client (exigence 1) : plusieurs personnes
-- jointes par fiche (demandeur, valideur, compta…), rôle porté par un label LIBRE — aucune
-- taxonomie codée en dur. Table NEUVE (contraintes inline, patron chantier_notes) :
-- FK composite (customerId, companyId) anti-IDOR + RLS ENABLE+FORCE + policy tenant_isolation.
-- Les grants runtime viennent du socle générique de release.sh (grant_app_role) au prochain
-- déploiement — aucune ligne historique, aucun backfill.

BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

CREATE TABLE "customer_contacts" (
  "id" TEXT NOT NULL,
  "companyId" TEXT NOT NULL,
  "customerId" TEXT NOT NULL,
  "label" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "email" TEXT,
  "phone" TEXT,
  "revision" INTEGER NOT NULL DEFAULT 1,
  "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(6) NOT NULL,
  CONSTRAINT "customer_contacts_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "uniq_customer_contact_id_company" UNIQUE ("id", "companyId"),
  CONSTRAINT "customer_contacts_companyId_fkey"
    FOREIGN KEY ("companyId") REFERENCES "companies"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "customer_contacts_customer_company_fkey"
    FOREIGN KEY ("customerId", "companyId") REFERENCES "customers"("id", "companyId")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  -- Formes canoniques (miroir des invariants CustomerContact.of — le domaine reste l'autorité).
  CONSTRAINT "customer_contacts_label_check"
    CHECK (
      char_length(btrim("label")) BETWEEN 1 AND 80
      AND "label" = btrim("label")
      AND "label" !~ '[[:cntrl:]]'
    ),
  CONSTRAINT "customer_contacts_name_check"
    CHECK (
      char_length(btrim("name")) BETWEEN 1 AND 160
      AND "name" = btrim("name")
      AND "name" !~ '[[:cntrl:]]'
    ),
  CONSTRAINT "customer_contacts_email_check"
    CHECK (
      "email" IS NULL
      OR (
        char_length("email") BETWEEN 3 AND 320
        AND "email" = btrim("email")
        AND "email" !~ '[[:cntrl:]]'
        AND position('@' IN "email") > 1
      )
    ),
  CONSTRAINT "customer_contacts_phone_check"
    CHECK (
      "phone" IS NULL
      OR (
        char_length(btrim("phone")) BETWEEN 1 AND 40
        AND "phone" = btrim("phone")
        AND "phone" !~ '[[:cntrl:]]'
      )
    ),
  CONSTRAINT "customer_contacts_revision_check"
    CHECK ("revision" BETWEEN 1 AND 2147483647)
);

-- Lecture « contacts d'un client » servie par index (fiche client + feuille d'envoi).
CREATE INDEX "customer_contacts_company_customer_idx"
  ON "customer_contacts"("companyId", "customerId");

-- Défense en profondeur : même un défaut applicatif reste confiné au tenant courant.
ALTER TABLE "customer_contacts" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "customer_contacts" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "customer_contacts"
  USING ("companyId" = current_setting('app.current_company_id', true))
  WITH CHECK ("companyId" = current_setting('app.current_company_id', true));

COMMIT;
