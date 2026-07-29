-- Bob AgentMission K2 — backstop additif d'un foreground unique tous kinds confondus.
-- L'index owner/kind V1 reste intact pour les binaires N-1 et leur advisory lock historique.

BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';
SET LOCAL ROLE bob_schema_owner;

CREATE UNIQUE INDEX agent_missions_one_active_owner_key
  ON public.agent_missions ("companyId", "ownerUserId")
  WHERE "status" = 'active';

COMMIT;
