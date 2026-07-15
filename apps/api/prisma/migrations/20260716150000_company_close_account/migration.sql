-- CloseAccount (Apple 5.1.1(v)) — clôture de compte, JAMAIS un cascade delete.
-- Additive uniquement : deux colonnes nullables sur "companies", aucune contrainte existante
-- touchée. Tous les autres champs de la company (name, siret, adresse, iban, décennale…) restent
-- la source live des pièces déjà émises — rétention légale 10 ans (Code de commerce), donc
-- volontairement JAMAIS anonymisés/mutés par la clôture.

-- AlterTable
ALTER TABLE "companies" ADD COLUMN "closedAt" TIMESTAMP(3);
ALTER TABLE "companies" ADD COLUMN "closureReason" TEXT;
