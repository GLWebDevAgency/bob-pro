-- Étape séparée : toute Mission historique doit posséder sa preuve bootstrap exacte.
-- Un orphelin bloque volontairement le déploiement ; aucune preuve ne peut être reconstruite.

BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '5min';

ALTER TABLE "realtime_mistral_conversation_missions"
  VALIDATE CONSTRAINT "mistral_conversation_mission_bootstrap_fkey";

COMMIT;
