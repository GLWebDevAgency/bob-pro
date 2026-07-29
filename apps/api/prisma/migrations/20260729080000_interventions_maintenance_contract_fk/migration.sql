-- COUTURE INTER-TRAINS — la visite contractuelle PORTE enfin son contrat.
--
-- interventions."contractId" a été posée par le train Intervention (PR-15) comme colonne
-- ADDITIVE SANS FK, parce que `maintenance_contracts` appartenait à un train parallèle et
-- n'existait pas encore : CreateIntervention refusait donc TOUTE valeur, aucun lien non
-- vérifié n'a pu naître (aucun backfill n'est nécessaire, la colonne est vide par
-- construction). Les deux trains sont désormais sur la même lignée : la table cible existe,
-- la FK composite anti-IDOR peut être posée.
--
-- Patron du dépôt (leçon du 25/07) : NOT VALID ici, VALIDATE en migration séparée — la
-- validation prend un ACCESS EXCLUSIVE bref mais scanne la table ; les séparer garde chaque
-- migration bornée par lock_timeout.
ALTER TABLE "interventions"
  ADD CONSTRAINT "interventions_contract_fkey"
  FOREIGN KEY ("contractId", "companyId")
  REFERENCES "maintenance_contracts"("id", "companyId")
  ON DELETE RESTRICT ON UPDATE CASCADE
  NOT VALID;

-- Dérivation « visites du contrat » : le préfixe (companyId) sert aussi la lecture batchée,
-- même doctrine que invoices_contract_period_idx (annexe erratum n° 8).
CREATE INDEX "interventions_contract_idx"
  ON "interventions" ("companyId", "contractId")
  WHERE "contractId" IS NOT NULL;
