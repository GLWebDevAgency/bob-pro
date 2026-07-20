-- Bob Live Mistral — capacité d'ingress WSS one-shot, durable et tenant-scoped.
-- Le ticket brut 256 bits et le userId brut ne sont jamais persistés : SHA-256 + AEAD seulement.

BEGIN;

CREATE TABLE "realtime_mistral_ingress_tickets" (
  "id" UUID NOT NULL,
  "companyId" TEXT NOT NULL,
  "subjectHash" CHAR(64) NOT NULL,
  "subjectKeyVersion" INTEGER NOT NULL,
  "sessionId" UUID NOT NULL,
  "ticketHash" CHAR(64) NOT NULL,
  "protocol" TEXT NOT NULL,
  "state" TEXT NOT NULL,
  "plan" TEXT NOT NULL,
  "contextSchemaVersion" INTEGER NOT NULL,
  "contextRevision" INTEGER NOT NULL,
  "contextDigest" CHAR(64) NOT NULL,
  "userIdentityCiphertext" BYTEA NOT NULL,
  "userIdentityNonce" BYTEA NOT NULL,
  "userIdentityTag" BYTEA NOT NULL,
  "identityEncryptionKeyVersion" INTEGER NOT NULL,
  "maxAudioBytes" INTEGER NOT NULL,
  "providerSessionId" TEXT,
  "providerTermination" TEXT,
  "issuedAt" TIMESTAMPTZ NOT NULL,
  "ticketExpiresAt" TIMESTAMPTZ NOT NULL,
  "bindingExpiresAt" TIMESTAMPTZ,
  "hardExpiresAt" TIMESTAMPTZ NOT NULL,
  "consumedAt" TIMESTAMPTZ,
  "activatedAt" TIMESTAMPTZ,
  "finishedAt" TIMESTAMPTZ,
  "retentionExpiresAt" TIMESTAMPTZ NOT NULL,
  "version" INTEGER NOT NULL DEFAULT 1,
  CONSTRAINT "realtime_mistral_ingress_tickets_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "realtime_mistral_ingress_tickets_company_fkey"
    FOREIGN KEY ("companyId") REFERENCES "companies"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "realtime_mistral_ingress_tickets_ticket_hash_key" UNIQUE ("ticketHash"),
  CONSTRAINT "realtime_mistral_ingress_tickets_provider_session_key" UNIQUE ("providerSessionId"),
  CONSTRAINT "realtime_mistral_ingress_tickets_session_key" UNIQUE ("companyId", "sessionId"),
  CONSTRAINT "realtime_mistral_ingress_tickets_subject_hash_check"
    CHECK ("subjectHash"::TEXT ~ '^[a-f0-9]{64}$'),
  CONSTRAINT "realtime_mistral_ingress_tickets_subject_key_version_check"
    CHECK ("subjectKeyVersion" BETWEEN 1 AND 2147483647),
  CONSTRAINT "realtime_mistral_ingress_tickets_ticket_hash_check"
    CHECK ("ticketHash"::TEXT ~ '^[a-f0-9]{64}$'),
  CONSTRAINT "realtime_mistral_ingress_tickets_protocol_check"
    CHECK ("protocol" = 'bob.mistral-pcm.v1'),
  CONSTRAINT "realtime_mistral_ingress_tickets_state_check"
    CHECK ("state" IN ('issued', 'consumed', 'active', 'abandoned', 'completed')),
  CONSTRAINT "realtime_mistral_ingress_tickets_plan_check"
    CHECK ("plan" IN ('free', 'solo', 'pro', 'business')),
  CONSTRAINT "realtime_mistral_ingress_tickets_context_check"
    CHECK (
      "contextSchemaVersion" = 1
      AND "contextRevision" BETWEEN 1 AND 2147483647
      AND "contextDigest"::TEXT ~ '^[a-f0-9]{64}$'
    ),
  CONSTRAINT "realtime_mistral_ingress_tickets_identity_check"
    CHECK (
      octet_length("userIdentityCiphertext") BETWEEN 1 AND 1024
      AND octet_length("userIdentityNonce") = 12
      AND octet_length("userIdentityTag") = 16
      AND "identityEncryptionKeyVersion" BETWEEN 1 AND 2147483647
    ),
  CONSTRAINT "realtime_mistral_ingress_tickets_audio_budget_check"
    CHECK ("maxAudioBytes" BETWEEN 32000 AND 28800000 AND "maxAudioBytes" % 2 = 0),
  CONSTRAINT "realtime_mistral_ingress_tickets_provider_session_check"
    CHECK (
      "providerSessionId" IS NULL
      OR (
        length("providerSessionId") BETWEEN 1 AND 200
        AND "providerSessionId" ~ '^[A-Za-z0-9._:-]+$'
      )
    ),
  CONSTRAINT "realtime_mistral_ingress_tickets_termination_check"
    CHECK (
      "providerTermination" IS NULL
      OR "providerTermination" IN ('confirmed', 'not_created', 'unconfirmed')
    ),
  CONSTRAINT "realtime_mistral_ingress_tickets_time_check"
    CHECK (
      "ticketExpiresAt" > "issuedAt"
      AND "ticketExpiresAt" <= "hardExpiresAt"
      AND "retentionExpiresAt" > "hardExpiresAt"
      AND ("bindingExpiresAt" IS NULL OR "bindingExpiresAt" <= "hardExpiresAt")
      AND ("consumedAt" IS NULL OR "consumedAt" >= "issuedAt")
      AND ("activatedAt" IS NULL OR "activatedAt" >= "consumedAt")
      AND ("finishedAt" IS NULL OR (
        "finishedAt" >= "consumedAt" AND "finishedAt" < "retentionExpiresAt"
      ))
      AND "version" > 0
    ),
  CONSTRAINT "realtime_mistral_ingress_tickets_state_shape_check"
    CHECK (
      (
        "state" = 'issued'
        AND "bindingExpiresAt" IS NULL
        AND "consumedAt" IS NULL
        AND "providerSessionId" IS NULL
        AND "activatedAt" IS NULL
        AND "finishedAt" IS NULL
        AND "providerTermination" IS NULL
      )
      OR (
        "state" = 'consumed'
        AND "bindingExpiresAt" IS NOT NULL
        AND "consumedAt" IS NOT NULL
        AND "bindingExpiresAt" > "consumedAt"
        AND "providerSessionId" IS NULL
        AND "activatedAt" IS NULL
        AND "finishedAt" IS NULL
        AND "providerTermination" IS NULL
      )
      OR (
        "state" = 'active'
        AND "bindingExpiresAt" IS NOT NULL
        AND "consumedAt" IS NOT NULL
        AND "providerSessionId" IS NOT NULL
        AND "activatedAt" IS NOT NULL
        AND "finishedAt" IS NULL
        AND "providerTermination" IS NULL
      )
      OR (
        "state" = 'abandoned'
        AND "bindingExpiresAt" IS NOT NULL
        AND "consumedAt" IS NOT NULL
        AND "finishedAt" IS NOT NULL
        AND "providerTermination" IS NOT NULL
        AND (
          ("providerTermination" = 'not_created' AND "providerSessionId" IS NULL AND "activatedAt" IS NULL)
          OR ("providerTermination" IN ('confirmed', 'unconfirmed') AND "providerSessionId" IS NOT NULL)
        )
      )
      OR (
        "state" = 'completed'
        AND "bindingExpiresAt" IS NOT NULL
        AND "consumedAt" IS NOT NULL
        AND "providerSessionId" IS NOT NULL
        AND "activatedAt" IS NOT NULL
        AND "finishedAt" IS NOT NULL
        AND "providerTermination" = 'confirmed'
      )
    )
);

CREATE INDEX "realtime_mistral_ingress_tickets_tenant_state_idx"
  ON "realtime_mistral_ingress_tickets"("companyId", "state", "ticketExpiresAt");
CREATE INDEX "realtime_mistral_ingress_tickets_tenant_issued_idx"
  ON "realtime_mistral_ingress_tickets"("companyId", "issuedAt");
CREATE INDEX "realtime_mistral_ingress_tickets_retention_idx"
  ON "realtime_mistral_ingress_tickets"("companyId", "retentionExpiresAt");

COMMENT ON COLUMN "realtime_mistral_ingress_tickets"."ticketHash" IS
  'SHA-256 du ticket aléatoire 256 bits; le ticket brut ne doit jamais être persisté ni journalisé.';
COMMENT ON COLUMN "realtime_mistral_ingress_tickets"."userIdentityCiphertext" IS
  'userId chiffré AES-256-GCM avec AAD tenant/session/contexte; jamais exposé au mobile ni aux logs.';
COMMENT ON COLUMN "realtime_mistral_ingress_tickets"."subjectKeyVersion" IS
  'Version de la clé HMAC sujet, indépendante des versions de preuve et de chiffrement.';

-- L'insertion est liée à un bail réservé vivant dont le contexte canonique a déjà été écrit dans
-- la même transaction. Ainsi, même un writer SQL incomplet ne peut émettre une capacité orpheline.
CREATE FUNCTION guard_realtime_mistral_ingress_ticket_insert()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  PERFORM 1
    FROM public.realtime_session_leases AS lease
   WHERE lease."companyId" = NEW."companyId"
     AND lease."subjectHash" = NEW."subjectHash"
     AND lease."sessionId" = NEW."sessionId"
     AND lease.state = 'reserved'
     AND lease."providerId" IS NULL
     AND lease."providerCallId" IS NULL
     AND lease."leaseExpiresAt" > clock_timestamp()
     AND lease."hardExpiresAt" > clock_timestamp()
     AND lease."hardExpiresAt" = NEW."hardExpiresAt"
     AND NEW."ticketExpiresAt" <= lease."leaseExpiresAt"
     AND lease."contextSchemaVersion" = NEW."contextSchemaVersion"
     AND lease."contextRevision" = NEW."contextRevision"
     AND lease."contextDigest" = NEW."contextDigest"
   FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'mistral ingress ticket requires a matching reserved lease and context'
      USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER realtime_mistral_ingress_ticket_insert_guard
BEFORE INSERT ON "realtime_mistral_ingress_tickets"
FOR EACH ROW EXECUTE FUNCTION guard_realtime_mistral_ingress_ticket_insert();

-- Les preuves d'identité/contexte sont immuables et chaque transition est strictement monotone.
CREATE FUNCTION guard_realtime_mistral_ingress_ticket_transition()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF ROW(
    NEW.id, NEW."companyId", NEW."subjectHash", NEW."subjectKeyVersion", NEW."sessionId",
    NEW."ticketHash", NEW.protocol, NEW.plan, NEW."contextSchemaVersion", NEW."contextRevision",
    NEW."contextDigest", NEW."userIdentityCiphertext", NEW."userIdentityNonce",
    NEW."userIdentityTag", NEW."identityEncryptionKeyVersion", NEW."maxAudioBytes",
    NEW."issuedAt", NEW."ticketExpiresAt", NEW."hardExpiresAt", NEW."retentionExpiresAt"
  ) IS DISTINCT FROM ROW(
    OLD.id, OLD."companyId", OLD."subjectHash", OLD."subjectKeyVersion", OLD."sessionId",
    OLD."ticketHash", OLD.protocol, OLD.plan, OLD."contextSchemaVersion", OLD."contextRevision",
    OLD."contextDigest", OLD."userIdentityCiphertext", OLD."userIdentityNonce",
    OLD."userIdentityTag", OLD."identityEncryptionKeyVersion", OLD."maxAudioBytes",
    OLD."issuedAt", OLD."ticketExpiresAt", OLD."hardExpiresAt", OLD."retentionExpiresAt"
  ) THEN
    RAISE EXCEPTION 'mistral ingress ticket authority evidence is immutable' USING ERRCODE = '55000';
  END IF;
  IF NEW.version <> OLD.version + 1 THEN
    RAISE EXCEPTION 'mistral ingress ticket version must advance exactly once' USING ERRCODE = '55000';
  END IF;

  IF OLD.state = 'issued' AND NEW.state = 'consumed' THEN
    IF NEW."consumedAt" IS NULL OR NEW."bindingExpiresAt" IS NULL
      OR NEW."providerSessionId" IS NOT NULL OR NEW."activatedAt" IS NOT NULL
      OR NEW."finishedAt" IS NOT NULL OR NEW."providerTermination" IS NOT NULL
    THEN
      RAISE EXCEPTION 'invalid mistral ingress consume transition' USING ERRCODE = '55000';
    END IF;
    RETURN NEW;
  END IF;

  IF OLD.state = 'consumed' AND NEW.state IN ('active', 'abandoned') THEN
    IF NEW."bindingExpiresAt" IS DISTINCT FROM OLD."bindingExpiresAt"
      OR NEW."consumedAt" IS DISTINCT FROM OLD."consumedAt"
      OR (NEW.state = 'abandoned' AND NEW."activatedAt" IS NOT NULL)
    THEN
      RAISE EXCEPTION 'mistral ingress consume evidence is immutable' USING ERRCODE = '55000';
    END IF;
    RETURN NEW;
  END IF;

  IF OLD.state = 'active' AND NEW.state IN ('abandoned', 'completed') THEN
    IF NEW."bindingExpiresAt" IS DISTINCT FROM OLD."bindingExpiresAt"
      OR NEW."consumedAt" IS DISTINCT FROM OLD."consumedAt"
      OR NEW."providerSessionId" IS DISTINCT FROM OLD."providerSessionId"
      OR NEW."activatedAt" IS DISTINCT FROM OLD."activatedAt"
    THEN
      RAISE EXCEPTION 'mistral ingress active evidence is immutable' USING ERRCODE = '55000';
    END IF;
    RETURN NEW;
  END IF;

  RAISE EXCEPTION 'invalid mistral ingress ticket state transition' USING ERRCODE = '55000';
END;
$$;

CREATE TRIGGER realtime_mistral_ingress_ticket_transition_guard
BEFORE UPDATE ON "realtime_mistral_ingress_tickets"
FOR EACH ROW EXECUTE FUNCTION guard_realtime_mistral_ingress_ticket_transition();

CREATE FUNCTION guard_realtime_mistral_ingress_ticket_delete()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF OLD."retentionExpiresAt" > clock_timestamp() THEN
    RAISE EXCEPTION 'live mistral ingress ticket cannot be deleted' USING ERRCODE = '55000';
  END IF;
  RETURN OLD;
END;
$$;

CREATE TRIGGER realtime_mistral_ingress_ticket_delete_guard
BEFORE DELETE ON "realtime_mistral_ingress_tickets"
FOR EACH ROW EXECUTE FUNCTION guard_realtime_mistral_ingress_ticket_delete();

-- Une réplique du reaper admission ne doit pas supprimer une réservation entre la création de
-- l'appel Mistral et son bind durable. Un ticket consommé est la preuve qu'un appel peut exister :
-- le DELETE devient donc un no-op jusqu'à ce que bind/abandon rende l'identité provider durable.
CREATE FUNCTION preserve_consumed_mistral_ingress_lease()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF EXISTS (
    SELECT 1
      FROM public.realtime_mistral_ingress_tickets AS ticket
     WHERE ticket."companyId" = OLD."companyId"
       AND ticket."sessionId" = OLD."sessionId"
       AND ticket.state = 'consumed'
  ) THEN
    RETURN NULL;
  END IF;
  RETURN OLD;
END;
$$;

CREATE TRIGGER realtime_session_lease_consumed_mistral_guard
BEFORE DELETE ON "realtime_session_leases"
FOR EACH ROW EXECUTE FUNCTION preserve_consumed_mistral_ingress_lease();

ALTER TABLE "realtime_mistral_ingress_tickets" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "realtime_mistral_ingress_tickets" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "realtime_mistral_ingress_tickets"
  USING ("companyId" = current_setting('app.current_company_id', true))
  WITH CHECK ("companyId" = current_setting('app.current_company_id', true));

COMMIT;
