-- Fence durable des bindings push : la génération maximale survit à la suppression du device
-- actif, ce qui interdit à un POST retardé de ressusciter un ancien tenant après logout/relogin.
-- Migration expand-only : les lignes et clients N-1 restent valides avec colonnes NULL.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

LOCK TABLE "devices" IN SHARE ROW EXCLUSIVE MODE;

CREATE TABLE "push_installations" (
  "id" UUID NOT NULL,
  "revocationSecretHash" CHAR(64) NOT NULL,
  "maxGeneration" INTEGER NOT NULL,
  "currentBindingId" UUID,
  "currentCompanyId" TEXT,
  "currentUserId" TEXT,
  "lastConfirmedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "push_installations_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "push_installations_generation_positive" CHECK ("maxGeneration" > 0),
  CONSTRAINT "push_installations_secret_hash_shape"
    CHECK ("revocationSecretHash" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "push_installations_active_binding_shape" CHECK (
    (
      "currentBindingId" IS NULL
      AND "currentCompanyId" IS NULL
      AND "currentUserId" IS NULL
    )
    OR (
      "currentBindingId" IS NOT NULL
      AND "currentCompanyId" IS NOT NULL
    )
  )
);

ALTER TABLE "devices"
  ADD COLUMN "installationId" UUID,
  ADD COLUMN "bindingId" UUID,
  ADD COLUMN "bindingGeneration" INTEGER,
  ADD COLUMN "revocationSecretHash" CHAR(64);

ALTER TABLE "devices"
  ADD CONSTRAINT "devices_binding_shape" CHECK (
    (
      "installationId" IS NULL
      AND "bindingId" IS NULL
      AND "bindingGeneration" IS NULL
      AND "revocationSecretHash" IS NULL
    )
    OR (
      "installationId" IS NOT NULL
      AND "bindingId" IS NOT NULL
      AND "bindingGeneration" IS NOT NULL
      AND "bindingGeneration" > 0
      AND "revocationSecretHash" IS NOT NULL
      AND "revocationSecretHash" ~ '^[0-9a-f]{64}$'
    )
  );

CREATE UNIQUE INDEX "devices_installation_id_key" ON "devices"("installationId");
CREATE UNIQUE INDEX "devices_binding_id_key" ON "devices"("bindingId");
CREATE UNIQUE INDEX "push_installations_current_binding_id_key"
  ON "push_installations"("currentBindingId");

ALTER TABLE "devices"
  ADD CONSTRAINT "devices_installationId_fkey"
  FOREIGN KEY ("installationId") REFERENCES "push_installations"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

-- Défense en profondeur pour les UPDATE autorisés par RLS. En particulier, la neutralisation
-- d'une ancienne installation lors du transfert global d'un token ne peut modifier ni son
-- secret, ni son high-water mark, ni ses horodatages de confirmation/création.
CREATE FUNCTION app_enforce_push_installation_update_invariants()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW."id" IS DISTINCT FROM OLD."id"
     OR NEW."revocationSecretHash" IS DISTINCT FROM OLD."revocationSecretHash"
     OR NEW."createdAt" IS DISTINCT FROM OLD."createdAt" THEN
    RAISE EXCEPTION 'immutable push installation identity';
  END IF;
  IF NEW."maxGeneration" < OLD."maxGeneration" THEN
    RAISE EXCEPTION 'push installation generation cannot decrease';
  END IF;
  IF current_setting('app.current_device_operation', true) = 'register'
     AND NEW."currentBindingId" IS NULL THEN
    IF NEW."maxGeneration" IS DISTINCT FROM OLD."maxGeneration"
       OR NEW."lastConfirmedAt" IS DISTINCT FROM OLD."lastConfirmedAt" THEN
      RAISE EXCEPTION 'token transfer may only neutralize current ownership';
    END IF;
  END IF;
  IF current_setting('app.current_device_operation', true) IN ('revoke-auth', 'revoke-public')
     AND NEW."lastConfirmedAt" IS DISTINCT FROM OLD."lastConfirmedAt" THEN
    RAISE EXCEPTION 'revocation cannot rewrite confirmation time';
  END IF;
  IF current_setting('app.current_device_operation', true) = 'close-account'
     AND (
       NEW."maxGeneration" IS DISTINCT FROM OLD."maxGeneration"
       OR NEW."lastConfirmedAt" IS DISTINCT FROM OLD."lastConfirmedAt"
     ) THEN
    RAISE EXCEPTION 'account close may only neutralize current ownership';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER push_installations_update_invariants
BEFORE UPDATE ON "push_installations"
FOR EACH ROW
EXECUTE FUNCTION app_enforce_push_installation_update_invariants();

COMMIT;
