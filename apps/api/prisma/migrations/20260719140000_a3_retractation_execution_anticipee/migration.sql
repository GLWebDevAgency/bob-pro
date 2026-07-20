-- A3 — Droit de rétractation 14 jours B2C (art. L221-18 s. du code de la consommation).
-- Migration STRICTEMENT ADDITIVE : colonne nullable, AUCUN backfill inventé — les signatures
-- historiques restent honnêtement sans demande d'exécution anticipée (on ne fabrique JAMAIS
-- un consentement légal rétroactif ; sans demande expresse, le gel s'applique, fail-closed).

-- Demande EXPRESSE d'exécution anticipée des travaux avant la fin du délai de rétractation
-- (art. L221-25 c. conso : le consommateur qui demande l'exécution avant la fin du délai doit
-- payer le prix correspondant au service fourni jusqu'à sa rétractation). Cochée par le client
-- B2C au moment de signer, horodatée SERVEUR (SignQuote), et cohérente par construction : le
-- use case ne la trace que pour un client b2c avec le devis signé dans la même transaction.
ALTER TABLE "quotes"
  ADD COLUMN "earlyExecutionRequestedAt" TIMESTAMPTZ(6);

-- Garde de cohérence minimale : une demande d'exécution anticipée sans signature n'a aucun
-- sens (elle est faite EN signant) — on n'exige pas l'égalité des horodatages (la colonne
-- signedAt et la demande partagent le même instant serveur mais restent deux faits distincts).
ALTER TABLE "quotes"
  ADD CONSTRAINT "quotes_early_execution_requires_signature"
  CHECK ("earlyExecutionRequestedAt" IS NULL OR "signedAt" IS NOT NULL);
