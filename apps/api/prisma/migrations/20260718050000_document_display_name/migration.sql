-- Libellé d'affichage renommable d'un document du coffre (« Facture Leroy Merlin — 184,90 € »).
-- Le filename d'archive reste IMMUABLE (audit, empreintes) : seul le libellé de présentation
-- change. NULL = ligne historique jamais renommée : le domaine retombe sur le filename, aucune
-- valeur n'est rétro-remplie (pas de fausse donnée).
ALTER TABLE "documents"
  ADD COLUMN "displayName" TEXT;

ALTER TABLE "documents"
  ADD CONSTRAINT "documents_display_name_check"
  CHECK (
    "displayName" IS NULL
    OR (char_length("displayName") BETWEEN 1 AND 120 AND "displayName" = btrim("displayName"))
  );
