-- A3/A4 — Fonctionnalité de rétractation en ligne (art. L221-21 dernier al. c. conso, créé par
-- l'ordonnance n° 2026-2 du 05/01/2026 ; modalités art. D221-5, décret n° 2026-3 — en vigueur
-- depuis le 19/06/2026), embargo de paiement hors établissement (art. L221-10), qualité du
-- client figée à la conclusion, régime de TVA figé à l'émission, coordonnées de l'entreprise
-- pour les modèles R221-1/R221-3 (décret n° 2022-424).
-- Migration STRICTEMENT ADDITIVE : colonnes nullables, AUCUN backfill inventé — les lignes
-- historiques restent honnêtement sans fait figé (fallback dynamique documenté dans le code).

-- Nouveau scope de jeton public : fonctionnalité de rétractation en ligne, créée à la
-- signature d'un devis B2C, valable pendant TOUTE la durée du délai de rétractation.
-- (PostgreSQL ≥ 12 : ADD VALUE est permis en transaction tant que la valeur n'est pas
-- utilisée par le DDL de la même transaction — c'est le cas ici, usage runtime uniquement.)
ALTER TYPE "PublicAccessScope" ADD VALUE IF NOT EXISTS 'quote_retractation';

-- Qualité du client (b2c/b2b/b2g) FIGÉE à la CONCLUSION du contrat (SignQuote, même
-- transaction que la signature) : la qualité de consommateur s'apprécie au jour de la
-- conclusion (art. liminaire et L221-1 c. conso) — une édition ultérieure de la fiche client
-- ne peut ni lever ni créer rétroactivement le droit de rétractation ou l'embargo L221-10.
-- NULL = signature antérieure au figeage (fallback : type courant de la fiche, jamais inventé).
ALTER TABLE "quotes"
  ADD COLUMN "signatureCustomerType" "CustomerType";

-- Une qualité figée sans signature n'a aucun sens (elle est constatée EN signant).
ALTER TABLE "quotes"
  ADD CONSTRAINT "quotes_signature_customer_type_requires_signature"
  CHECK ("signatureCustomerType" IS NULL OR "signedAt" IS NOT NULL);

-- Rétractation exercée via la fonctionnalité en ligne (L221-21) — fait horodaté SERVEUR,
-- additif : le devis signé reste le contrat archivé (immutabilité des pièces), la rétractation
-- est un événement postérieur qui gèle toute facturation dérivée.
ALTER TABLE "quotes"
  ADD COLUMN "retractedAt" TIMESTAMPTZ(6);

-- On ne se rétracte que d'un contrat CONCLU (devis signé).
ALTER TABLE "quotes"
  ADD CONSTRAINT "quotes_retractation_requires_signature"
  CHECK ("retractedAt" IS NULL OR "signedAt" IS NOT NULL);

-- A4 — régime de TVA de la pièce, constaté par IssueInvoice et FIGÉ à l'émission : le XML
-- Factur-X régénéré (GET /invoices/:id/facturx) le lit en priorité — plus jamais deux
-- représentations fiscales divergentes de la même pièce émise. NULL = pièce émise avant le
-- figeage (dérivation dynamique honnête).
ALTER TABLE "invoices"
  ADD COLUMN "vatTreatmentAtIssuance" TEXT;

ALTER TABLE "invoices"
  ADD CONSTRAINT "invoices_vat_treatment_valid"
  CHECK ("vatTreatmentAtIssuance" IS NULL
         OR "vatTreatmentAtIssuance" IN ('standard', 'franchise', 'autoliquidation'));

-- Un régime figé sans émission n'existe pas (il est constaté À l'émission).
ALTER TABLE "invoices"
  ADD CONSTRAINT "invoices_vat_treatment_requires_issue"
  CHECK ("vatTreatmentAtIssuance" IS NULL OR "issuedAt" IS NOT NULL);

-- A3 — coordonnées DE L'ENTREPRISE (pas du compte utilisateur) exigées par les modèles types
-- de rétractation EN VIGUEUR : adresse électronique (formulaire annexe R221-1 ET avis annexe
-- R221-3), numéro de téléphone (avis annexe R221-3, instruction (2)) — décret n° 2022-424 du
-- 25/03/2022 (le télécopieur et la réserve « lorsqu'ils sont disponibles » ont disparu).
-- NULL = jamais saisies : les textes impriment le connu, jamais l'inventé.
ALTER TABLE "companies"
  ADD COLUMN "email" TEXT,
  ADD COLUMN "phone" TEXT;
