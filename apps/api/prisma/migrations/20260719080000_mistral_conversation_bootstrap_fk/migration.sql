-- Bob Live Mistral v2 — ferme l'intégrité tenant-bound Mission -> bootstrap.
-- EXPAND uniquement : NOT VALID protège immédiatement toutes les nouvelles écritures sans
-- scanner ni verrouiller longuement l'historique pendant cette première étape.

BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

ALTER TABLE "realtime_mistral_conversation_missions"
  ADD CONSTRAINT "mistral_conversation_mission_bootstrap_tenant_key"
    UNIQUE ("initialBootstrapId", "companyId"),
  ADD CONSTRAINT "mistral_conversation_mission_bootstrap_fkey"
    FOREIGN KEY ("initialBootstrapId", "companyId")
    REFERENCES "realtime_mistral_conversation_bootstrap_tickets"(id, "companyId")
    ON DELETE RESTRICT ON UPDATE CASCADE
    NOT VALID;

COMMENT ON CONSTRAINT "mistral_conversation_mission_bootstrap_fkey"
  ON "realtime_mistral_conversation_missions" IS
  'Interdit de purger la preuve bootstrap tant que sa Mission tenant-bound est retenue.';

COMMENT ON CONSTRAINT "mistral_conversation_mission_bootstrap_tenant_key"
  ON "realtime_mistral_conversation_missions" IS
  'Matérialise pour Prisma la cardinalité one-to-one du lien composite tenant-bound.';

COMMIT;
