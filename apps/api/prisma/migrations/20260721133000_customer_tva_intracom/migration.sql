-- Factur-X France / BR-AE-2 — le n° TVA du preneur est une donnée réelle de la fiche client,
-- jamais une valeur calculée à partir du SIREN. Migration additive : NULL signifie « jamais
-- saisi/confirmé ». La contrainte protège aussi les écritures qui contourneraient le domaine.
BEGIN;

ALTER TABLE "customers"
  ADD COLUMN "tvaIntracom" TEXT;

ALTER TABLE "customers"
  ADD CONSTRAINT "customers_tva_intracom_fr_valid"
  CHECK (
    "tvaIntracom" IS NULL
    OR CASE
      WHEN "siren" IS NOT NULL
        AND "siren" ~ '^[0-9]{9}$'
        AND "tvaIntracom" ~ '^FR[0-9]{11}$'
      THEN right("tvaIntracom", 9) = "siren"
        AND substring("tvaIntracom" FROM 3 FOR 2)::integer =
          ((12 + 3 * (("siren"::bigint) % 97)) % 97)
      ELSE FALSE
    END
  ) NOT VALID;
ALTER TABLE "customers" VALIDATE CONSTRAINT "customers_tva_intracom_fr_valid";

-- L'identité société existait déjà sans garde SQL. On aligne le stockage sur Company.of :
-- une valeur historique incohérente fait échouer explicitement la migration au lieu d'être
-- silencieusement convertie en identifiant fiscal dans une prochaine facture.
ALTER TABLE "companies"
  ADD CONSTRAINT "companies_tva_intracom_fr_valid"
  CHECK (
    "tvaIntracom" IS NULL
    OR CASE
      WHEN "siren" ~ '^[0-9]{9}$'
        AND "tvaIntracom" ~ '^FR[0-9]{11}$'
      THEN right("tvaIntracom", 9) = "siren"
        AND substring("tvaIntracom" FROM 3 FOR 2)::integer =
          ((12 + 3 * (("siren"::bigint) % 97)) % 97)
      ELSE FALSE
    END
  ) NOT VALID;

-- La contrainte société protège immédiatement les nouvelles écritures mais reste NOT VALID
-- pendant l'EXPAND : une valeur historique éventuellement incohérente doit être identifiée et
-- corrigée explicitement avant le VALIDATE du lot CONTRACT, jamais réécrite automatiquement.

COMMIT;
