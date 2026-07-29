-- VALIDATE séparé (leçon 25/07) : la contrainte posée NOT VALID par 20260729080000 est
-- validée ici, hors de la migration qui l'a créée.
ALTER TABLE "interventions" VALIDATE CONSTRAINT "interventions_contract_fkey";
