-- Validation séparée de la FK composite expand : verrou compatible avec les writers N-1.

BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

ALTER TABLE public.quote_draft_slots
  VALIDATE CONSTRAINT quote_draft_slots_agent_mission_owner_fkey;

COMMIT;
