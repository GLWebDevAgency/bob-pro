-- Identité d'établissement du client (SIRET, 14 chiffres). La colonne reste nullable :
-- les lignes historiques et les fiches sans établissement connu ne doivent jamais être
-- complétées par une valeur inventée.
--
-- Aucune unicité : plusieurs tenants peuvent facturer le même établissement et un tenant peut
-- conserver plusieurs relations commerciales légitimes avec celui-ci. Aucun index tant qu'aucun
-- use case ne recherche par SIRET.

BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

ALTER TABLE public.customers
  ADD COLUMN "siret" CHAR(14);

-- NOT VALID évite le scan de la table pendant l'expand tout en protégeant immédiatement les
-- nouvelles écritures. La validation vit dans la migration suivante.
ALTER TABLE public.customers
  ADD CONSTRAINT customers_siret_shape_check
    CHECK ("siret" IS NULL OR "siret" ~ '^[0-9]{14}$') NOT VALID,
  ADD CONSTRAINT customers_siret_siren_coherence_check
    CHECK (
      "siret" IS NULL
      OR ("siren" IS NOT NULL AND left("siret", 9) = "siren")
    ) NOT VALID;

COMMIT;
