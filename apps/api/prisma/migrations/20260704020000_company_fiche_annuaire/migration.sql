-- C24b « fiche société complète » : à l'inscription, TOUTES les infos officielles de
-- l'entreprise (annuaire Recherche d'entreprises) sont persistées — additif, RLS inchangée.
ALTER TABLE "companies" ADD COLUMN "tvaIntracom" TEXT;
ALTER TABLE "companies" ADD COLUMN "dateCreation" DATE;
