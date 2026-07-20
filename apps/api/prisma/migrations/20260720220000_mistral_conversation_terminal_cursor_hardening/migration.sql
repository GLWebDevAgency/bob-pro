-- Bob Live Mistral Conversation v2 — aligne la borne du curseur Mission sur le reçu terminal.
--
-- Une Mission suit obligatoirement ready(next=1) -> draining(next>=2) -> closed(next>=3).
-- Le reçu terminal conserve donc sa borne stricte >= 3. Cette migration additive refuse les
-- états SQL non canoniques avant que le trigger de reçu ne tente son INSERT.

BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '5min';
SET LOCAL row_security = off;

ALTER TABLE public.realtime_mistral_conversation_missions
  ADD CONSTRAINT "realtime_mistral_conversation_missions_terminal_cursor_check_v2"
    CHECK (
      phase NOT IN ('draining', 'closed')
      OR (
        phase = 'draining'
        AND "nextServerSequence" BETWEEN 2 AND 4294967296
      )
      OR (
        phase = 'closed'
        AND "nextServerSequence" BETWEEN 3 AND 4294967296
        AND "terminalServerSequence" = "nextServerSequence" - 1
      )
    ) NOT VALID;

ALTER TABLE public.realtime_mistral_conversation_missions
  VALIDATE CONSTRAINT "realtime_mistral_conversation_missions_terminal_cursor_check_v2";

CREATE OR REPLACE FUNCTION public.capture_realtime_mistral_conversation_terminal_receipt()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
SET row_security = on
AS $$
BEGIN
  IF NEW.phase <> 'closed' THEN
    RETURN NEW;
  END IF;
  IF NEW."terminalReason" IS NULL OR NEW."closedAt" IS NULL THEN
    RAISE EXCEPTION 'closed Mission requires terminal receipt fields'
      USING ERRCODE = '55000',
            CONSTRAINT = 'mistral_terminal_receipt_source_incomplete';
  END IF;
  IF NEW."nextServerSequence" < 3
     OR NEW."terminalServerSequence" IS DISTINCT FROM NEW."nextServerSequence" - 1 THEN
    RAISE EXCEPTION 'closed Mission requires its canonical terminal cursor'
      USING ERRCODE = '23514',
            CONSTRAINT = 'mistral_terminal_receipt_source_cursor';
  END IF;

  INSERT INTO public.realtime_mistral_conversation_terminal_receipts (
    "companyId", "sessionHandle", "subjectHash", "subjectKeyVersion", protocol,
    "missionConnectionEpoch", "nextServerSequence", "terminalReason", "closedAt", "createdAt"
  ) VALUES (
    NEW."companyId", NEW."sessionHandle", NEW."subjectHash", NEW."subjectKeyVersion",
    NEW.protocol, NEW."missionConnectionEpoch", NEW."nextServerSequence",
    NEW."terminalReason", NEW."closedAt", GREATEST(clock_timestamp(), NEW."closedAt")
  )
  ON CONFLICT ("companyId", "sessionHandle") DO NOTHING;

  IF NOT EXISTS (
    SELECT 1
      FROM public.realtime_mistral_conversation_terminal_receipts AS receipt
     WHERE receipt."companyId" = NEW."companyId"
       AND receipt."sessionHandle" = NEW."sessionHandle"
       AND receipt."subjectHash" IS NOT DISTINCT FROM NEW."subjectHash"
       AND receipt."subjectKeyVersion" IS NOT DISTINCT FROM NEW."subjectKeyVersion"
       AND receipt.protocol IS NOT DISTINCT FROM NEW.protocol
       AND receipt."missionConnectionEpoch" IS NOT DISTINCT FROM NEW."missionConnectionEpoch"
       AND receipt."nextServerSequence" IS NOT DISTINCT FROM NEW."nextServerSequence"
       AND receipt."terminalReason" IS NOT DISTINCT FROM NEW."terminalReason"
       AND receipt."closedAt" IS NOT DISTINCT FROM NEW."closedAt"
  ) THEN
    RAISE EXCEPTION 'terminal receipt conflicts with closed Mission'
      USING ERRCODE = '55000',
            CONSTRAINT = 'mistral_terminal_receipt_exact_binding';
  END IF;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.capture_realtime_mistral_conversation_terminal_receipt()
  FROM PUBLIC;

COMMENT ON CONSTRAINT "realtime_mistral_conversation_missions_terminal_cursor_check_v2"
  ON public.realtime_mistral_conversation_missions IS
  'Le curseur exclusif inclut draining puis closed avant la capture du reçu terminal.';

COMMIT;
