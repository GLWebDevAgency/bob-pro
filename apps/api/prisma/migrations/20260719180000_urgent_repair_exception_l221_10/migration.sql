-- Exception DÉPANNAGE URGENT (art. L221-10, al. 2 et L221-28, 8° du code de la consommation) :
-- travaux d'entretien ou de réparation à réaliser EN URGENCE au domicile du consommateur et
-- EXPRESSÉMENT sollicités par lui, dans la limite des pièces de rechange et travaux strictement
-- nécessaires pour répondre à l'urgence.
-- Migration STRICTEMENT ADDITIVE : colonne nullable, AUCUN backfill — les devis historiques
-- restent honnêtement sans urgence déclarée (fail-closed : l'embargo L221-10 plein s'applique ;
-- on ne fabrique JAMAIS une sollicitation expresse rétroactive).

-- Posée À LA CRÉATION du devis (question du wizard, client B2C uniquement — CreateQuote refuse
-- le fait pour un professionnel), horodatée SERVEUR, IMMUABLE ensuite (aucun mutateur domaine).
ALTER TABLE "quotes"
  ADD COLUMN "urgentRepairRequestedAt" TIMESTAMPTZ(6);
