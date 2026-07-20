-- Fiche société complète (Phase B fiscal) : code catégorie juridique INSEE brut + qualification
-- RGE fournis par le lookup SIRET (recherche-entreprises) et jusqu'ici jetés au provisioning —
-- extension ADDITIVE, nullable.
-- Backfill : AUCUN — NULL = donnée jamais fournie (fiches créées avant cette colonne) ; on
-- n'invente aucune valeur rétroactive. `estRge = false` reste une donnée réelle de l'annuaire.
ALTER TABLE "companies"
  ADD COLUMN "natureJuridiqueCode" TEXT,
  ADD COLUMN "estRge" BOOLEAN;

-- Hygiène du code quand présent : jamais une chaîne vide, non bornée ou avec caractères de
-- contrôle — même doctrine que les checks d'identifiants existants (sans présumer un format
-- INSEE exact que la source amont ne garantit pas contractuellement).
ALTER TABLE "companies"
  ADD CONSTRAINT "companies_nature_juridique_code_check" CHECK (
    "natureJuridiqueCode" IS NULL
    OR (
      char_length("natureJuridiqueCode") BETWEEN 1 AND 10
      AND "natureJuridiqueCode" = btrim("natureJuridiqueCode")
      AND "natureJuridiqueCode" !~ '[[:cntrl:]]'
    )
  );
