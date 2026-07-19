-- Bob Live Mistral v2 — reçu terminal durable après la rétention de Mission.
-- Cette preuve ne contient ni audio, ni transcript, ni userId, ni payload agent. Elle permet à
-- un client revenu tardivement de distinguer une fermeture certaine d'une session inconnue.

BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '5min';
-- Un rôle de migration insuffisamment privilégié ne doit jamais backfiller silencieusement zéro
-- ligne sous FORCE RLS. row_security=off force PostgreSQL à échouer plutôt qu'à masquer une ligne.
SET LOCAL row_security = off;

CREATE TABLE "realtime_mistral_conversation_terminal_receipts" (
  "companyId" TEXT NOT NULL,
  "sessionHandle" TEXT NOT NULL,
  "subjectHash" CHAR(64) NOT NULL,
  "subjectKeyVersion" INTEGER NOT NULL,
  protocol TEXT NOT NULL,
  "missionConnectionEpoch" INTEGER NOT NULL,
  "nextServerSequence" BIGINT NOT NULL,
  "terminalReason" TEXT NOT NULL,
  "closedAt" TIMESTAMPTZ NOT NULL,
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT "mistral_terminal_receipt_pkey"
    PRIMARY KEY ("companyId", "sessionHandle"),
  CONSTRAINT "mistral_terminal_receipt_company_fkey"
    FOREIGN KEY ("companyId") REFERENCES "companies"(id)
    ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "mistral_terminal_receipt_session_check" CHECK (
    length("sessionHandle") BETWEEN 16 AND 128
    AND "sessionHandle" ~ '^[A-Za-z0-9_-]+$'
  ),
  CONSTRAINT "mistral_terminal_receipt_subject_check" CHECK (
    "subjectHash"::TEXT ~ '^[a-f0-9]{64}$'
    AND "subjectKeyVersion" BETWEEN 1 AND 2147483647
  ),
  CONSTRAINT "mistral_terminal_receipt_protocol_check" CHECK (
    protocol = 'bob.mistral-pcm.v2'
  ),
  CONSTRAINT "mistral_terminal_receipt_cursor_check" CHECK (
    "missionConnectionEpoch" BETWEEN 1 AND 2147483647
    AND "nextServerSequence" BETWEEN 3 AND 4294967296
  ),
  CONSTRAINT "mistral_terminal_receipt_reason_check" CHECK (
    "terminalReason" IN (
      'user', 'background', 'context_changed', 'client_handoff',
      'expired', 'service_shutdown', 'fatal_error'
    )
  ),
  CONSTRAINT "mistral_terminal_receipt_time_check" CHECK (
    "createdAt" >= "closedAt"
  )
);

COMMENT ON TABLE "realtime_mistral_conversation_terminal_receipts" IS
  'Preuve terminale minimale conservée après purge Mission, sans TTL autonome, parole ni identité brute.';
COMMENT ON COLUMN "realtime_mistral_conversation_terminal_receipts"."nextServerSequence" IS
  'Curseur final exclusif : le dernier événement terminal porte nextServerSequence - 1.';

REVOKE ALL ON TABLE "realtime_mistral_conversation_terminal_receipts" FROM PUBLIC;

ALTER TABLE "realtime_mistral_conversation_terminal_receipts" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "realtime_mistral_conversation_terminal_receipts" FORCE ROW LEVEL SECURITY;

CREATE POLICY realtime_mistral_terminal_receipt_select
  ON "realtime_mistral_conversation_terminal_receipts" FOR SELECT
  USING ("companyId" = current_setting('app.current_company_id', true));

-- Seul le propriétaire de migration, également propriétaire de la fonction trigger, peut écrire.
-- Le runtime ne reçoit aucune policy ni aucun GRANT de mutation.
CREATE POLICY realtime_mistral_terminal_receipt_direct_insert
  ON "realtime_mistral_conversation_terminal_receipts" FOR INSERT
  TO CURRENT_USER
  WITH CHECK (true);

CREATE POLICY realtime_mistral_terminal_receipt_reaper_select
  ON "realtime_mistral_conversation_terminal_receipts" FOR SELECT
  USING (
    current_user = 'bob_mistral_bootstrap_reaper'
    AND EXISTS (
      SELECT 1
        FROM public.realtime_mistral_conversation_missions AS mission
       WHERE mission."companyId" =
             realtime_mistral_conversation_terminal_receipts."companyId"
         AND mission."sessionHandle" =
             realtime_mistral_conversation_terminal_receipts."sessionHandle"
         AND mission.phase = 'closed'
         AND mission."replayGraceExpiresAt" <= clock_timestamp()
         AND mission."retentionExpiresAt" <= clock_timestamp()
    )
  );

CREATE FUNCTION capture_realtime_mistral_conversation_terminal_receipt()
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

REVOKE ALL ON FUNCTION capture_realtime_mistral_conversation_terminal_receipt() FROM PUBLIC;

-- CREATE TRIGGER prend et conserve jusqu'au COMMIT un verrou SHARE ROW EXCLUSIVE sur Mission.
-- Il doit donc précéder le backfill : une fermeture déjà engagée termine avant ce verrou et
-- devient visible au SELECT suivant ; une fermeture plus tardive attend le COMMIT puis exécute
-- obligatoirement le trigger. Il n'existe ainsi aucune fenêtre sans autorité de capture.
CREATE TRIGGER realtime_mistral_conversation_00_terminal_receipt
AFTER INSERT OR UPDATE OF phase, "subjectHash", "subjectKeyVersion", protocol,
  "missionConnectionEpoch", "nextServerSequence", "terminalReason", "closedAt"
ON "realtime_mistral_conversation_missions"
FOR EACH ROW
WHEN (NEW.phase = 'closed')
EXECUTE FUNCTION capture_realtime_mistral_conversation_terminal_receipt();

COMMENT ON TRIGGER realtime_mistral_conversation_00_terminal_receipt
  ON "realtime_mistral_conversation_missions" IS
  'Grave atomiquement le reçu terminal minimal lors de la fermeture Mission.';

CREATE FUNCTION guard_realtime_mistral_conversation_terminal_receipt_immutable()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF TG_OP = 'DELETE' AND pg_trigger_depth() > 1 THEN
    -- Seule la cascade de la FK Company peut retirer la preuve ; un DELETE direct reste refusé.
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'mistral conversation terminal receipt is immutable'
    USING ERRCODE = '55000',
          CONSTRAINT = 'mistral_terminal_receipt_immutable';
END;
$$;

REVOKE ALL ON FUNCTION guard_realtime_mistral_conversation_terminal_receipt_immutable()
  FROM PUBLIC;

CREATE TRIGGER realtime_mistral_terminal_receipt_immutable
BEFORE UPDATE OR DELETE ON "realtime_mistral_conversation_terminal_receipts"
FOR EACH ROW EXECUTE FUNCTION guard_realtime_mistral_conversation_terminal_receipt_immutable();

CREATE TRIGGER realtime_mistral_terminal_receipt_truncate_guard
BEFORE TRUNCATE ON "realtime_mistral_conversation_terminal_receipts"
FOR EACH STATEMENT
EXECUTE FUNCTION guard_realtime_mistral_conversation_terminal_receipt_immutable();

-- Backfill append-only : chaque Mission déjà close produit exactement la même preuve que le
-- trigger. L'absence ou une divergence bloque la migration avant son COMMIT.
INSERT INTO "realtime_mistral_conversation_terminal_receipts" (
  "companyId", "sessionHandle", "subjectHash", "subjectKeyVersion", protocol,
  "missionConnectionEpoch", "nextServerSequence", "terminalReason", "closedAt", "createdAt"
)
SELECT mission."companyId", mission."sessionHandle", mission."subjectHash",
       mission."subjectKeyVersion", mission.protocol, mission."missionConnectionEpoch",
       mission."nextServerSequence", mission."terminalReason", mission."closedAt",
       GREATEST(clock_timestamp(), mission."closedAt")
  FROM "realtime_mistral_conversation_missions" AS mission
 WHERE mission.phase = 'closed'
ON CONFLICT ("companyId", "sessionHandle") DO NOTHING;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
      FROM public.realtime_mistral_conversation_missions AS mission
      LEFT JOIN public.realtime_mistral_conversation_terminal_receipts AS receipt
        ON receipt."companyId" = mission."companyId"
       AND receipt."sessionHandle" = mission."sessionHandle"
       AND receipt."subjectHash" IS NOT DISTINCT FROM mission."subjectHash"
       AND receipt."subjectKeyVersion" IS NOT DISTINCT FROM mission."subjectKeyVersion"
       AND receipt.protocol IS NOT DISTINCT FROM mission.protocol
       AND receipt."missionConnectionEpoch" IS NOT DISTINCT FROM mission."missionConnectionEpoch"
       AND receipt."nextServerSequence" IS NOT DISTINCT FROM mission."nextServerSequence"
       AND receipt."terminalReason" IS NOT DISTINCT FROM mission."terminalReason"
       AND receipt."closedAt" IS NOT DISTINCT FROM mission."closedAt"
     WHERE mission.phase = 'closed'
       AND receipt."companyId" IS NULL
  ) THEN
    RAISE EXCEPTION 'MISTRAL_TERMINAL_RECEIPT_BACKFILL_INCOMPLETE'
      USING ERRCODE = '55000',
            CONSTRAINT = 'mistral_terminal_receipt_backfill';
  END IF;
END;
$$;

COMMIT;
