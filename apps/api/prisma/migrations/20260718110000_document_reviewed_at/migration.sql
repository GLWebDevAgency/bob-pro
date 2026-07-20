-- Confirmation humaine d'un document scanné (« c'est bon, je valide » — humain ou Bob, parité
-- voix). NULL = jamais validé. La première validation fait foi (latch) : elle n'est jamais
-- réécrite par un geste ultérieur.
ALTER TABLE "documents"
  ADD COLUMN "reviewedAt" TIMESTAMP(3);

-- Backfill SÉLECTIF, jamais généreux :
--   · linkedEntityType = 'expense' → traités PAR CONSTRUCTION (le geste « créer la dépense »
--     était déjà une confirmation humaine explicite) : reviewedAt = maintenant.
--   · folderId non nul SEUL (rangé par OCR/humain sans geste de validation) → reviewedAt reste
--     NULL : ces documents REVIENNENT dans « À valider » comme « rangés/classés à confirmer »
--     (cas du ticket Aldi rangé automatiquement sans confirmation).
-- Aucune autre ligne n'est touchée ; la révision optimiste n'est pas avancée (pas de mutation
-- métier, uniquement une qualification d'historique).
UPDATE "documents"
SET "reviewedAt" = CURRENT_TIMESTAMP
WHERE "linkedEntityType" = 'expense'
  AND "reviewedAt" IS NULL;
