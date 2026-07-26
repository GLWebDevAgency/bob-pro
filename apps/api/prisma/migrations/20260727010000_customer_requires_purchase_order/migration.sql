-- PR-04 « Encaisser » — garde « BC obligatoire » PAR CLIENT (amendement fondateur 26/07 :
-- désactivée par défaut — RATP/publics l'activent, tous les autres clients restent en
-- facturation directe sans BC). Migration PUREMENT ADDITIVE : colonne nullable sans défaut,
-- les writers N-1 continuent d'insérer sans elle (NULL = non exigé, comportement inchangé).

BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

ALTER TABLE public.customers
  ADD COLUMN "requiresPurchaseOrder" BOOLEAN;

COMMIT;
