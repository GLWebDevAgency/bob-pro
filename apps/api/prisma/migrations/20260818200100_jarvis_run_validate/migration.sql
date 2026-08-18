-- Jarvis U1-a — validate séparé (convention expand/validate maison).
-- Les VALIDATE ne prennent qu'un SHARE UPDATE EXCLUSIVE : sûrs sous trafic writer N-1.

BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '120s';

ALTER TABLE public.agent_missions
  VALIDATE CONSTRAINT agent_missions_definition_version_check;
ALTER TABLE public.agent_missions
  VALIDATE CONSTRAINT agent_missions_kind_check;
ALTER TABLE public.agent_missions
  VALIDATE CONSTRAINT agent_missions_status_check;

COMMIT;
