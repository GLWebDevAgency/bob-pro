-- Un contrôle doit survivre au changement de réplique entre le rendu et l'ACK mobile. Il est donc
-- scellé sur un artefact READY, mais reste inutilisable tant que ce même artefact n'est pas DELIVERED.
-- Les tables, contraintes d'unicité, ACL et policies RLS de 20260713230000 restent inchangées.

CREATE OR REPLACE FUNCTION guard_realtime_control_grant()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    RAISE EXCEPTION 'realtime control grants are immutable'
      USING ERRCODE = '55000';
  END IF;

  IF NEW."issuedAt" > clock_timestamp() + INTERVAL '1 minute'
    OR NEW."expiresAt" <= clock_timestamp()
  THEN
    RAISE EXCEPTION 'realtime control grant is outside its validity window'
      USING ERRCODE = '55000';
  END IF;

  -- L'artefact porte le subject et l'owner exacts. Le grant ne peut être créé qu'après son CAS
  -- rendering -> ready, sous le même bail/contexte, et sa TTL ne dépasse aucun des trois fences.
  IF NOT EXISTS (
    SELECT 1
      FROM public.realtime_speech_artifacts AS artifact
      JOIN public.realtime_session_leases AS lease
        ON lease."companyId" = artifact."companyId"
       AND lease."subjectHash" = artifact."subjectHash"
       AND lease."sessionId" = artifact."sessionId"
     WHERE artifact."id" = NEW."artifactId"
       AND artifact."companyId" = NEW."companyId"
       AND artifact."sessionId" = NEW."sessionId"
       AND artifact."turnId" = NEW."turnId"
       AND artifact."state" = 'ready'
       AND artifact."readyAt" IS NOT NULL
       AND artifact."readyAt" <= NEW."issuedAt"
       AND artifact."contextRevision" = NEW."contextRevision"
       AND artifact."contextDigest" = NEW."contextDigest"
       AND lease."state" = 'active'
       AND lease."leaseExpiresAt" >= NEW."expiresAt"
       AND lease."hardExpiresAt" >= NEW."expiresAt"
       AND lease."contextRevision" = artifact."contextRevision"
       AND lease."contextDigest" = artifact."contextDigest"
       AND lease."contextAppliedRevision" = artifact."contextRevision"
       AND lease."contextAppliedDigest" = artifact."contextDigest"
       AND lease."contextAppliedOwnerEpoch" = artifact."sidebandOwnerEpoch"
       AND lease."sidebandOwnerEpoch" = artifact."sidebandOwnerEpoch"
       AND lease."sidebandOwnerTokenHash" = artifact."sidebandOwnerTokenHash"
       AND lease."sidebandOwnerLeaseExpiresAt" >= NEW."expiresAt"
       AND lease."sidebandProtocolVersion" = 2
  ) THEN
    RAISE EXCEPTION 'control grant requires an exactly bound ready artifact and live owner'
      USING ERRCODE = '55000';
  END IF;

  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION guard_realtime_control_consumption()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  existing_ack UUID;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    RAISE EXCEPTION 'realtime control consumptions are immutable'
      USING ERRCODE = '55000';
  END IF;

  SELECT consumption."acknowledgementId"
    INTO existing_ack
    FROM public.realtime_control_consumptions AS consumption
   WHERE consumption."companyId" = NEW."companyId"
     AND consumption."grantId" = NEW."grantId";

  IF existing_ack IS NOT NULL THEN
    IF existing_ack <> NEW."acknowledgementId" THEN
      RAISE EXCEPTION 'realtime control grant already consumed'
        USING ERRCODE = '23505';
    END IF;
    RETURN NEW;
  END IF;

  -- L'acknowledgementId EST le deliveryId durable. Une référence devinée, un autre artefact,
  -- un ancien contexte ou un owner remplacé ne peuvent donc jamais ouvrir le ciphertext.
  IF NOT EXISTS (
    SELECT 1
      FROM public.realtime_control_grants AS control_grant
      JOIN public.realtime_speech_artifacts AS artifact
        ON artifact."id" = control_grant."artifactId"
       AND artifact."companyId" = control_grant."companyId"
       AND artifact."sessionId" = control_grant."sessionId"
       AND artifact."turnId" = control_grant."turnId"
      JOIN public.realtime_session_leases AS lease
        ON lease."companyId" = artifact."companyId"
       AND lease."subjectHash" = artifact."subjectHash"
       AND lease."sessionId" = artifact."sessionId"
     WHERE control_grant."id" = NEW."grantId"
       AND control_grant."companyId" = NEW."companyId"
       AND control_grant."sessionId" = NEW."sessionId"
       AND control_grant."turnId" = NEW."turnId"
       AND control_grant."expiresAt" > clock_timestamp()
       AND artifact."state" = 'delivered'
       AND artifact."deliveryId" = NEW."acknowledgementId"
       AND artifact."deliveredAt" IS NOT NULL
       AND artifact."contextRevision" = control_grant."contextRevision"
       AND artifact."contextDigest" = control_grant."contextDigest"
       AND lease."state" = 'active'
       AND lease."leaseExpiresAt" > clock_timestamp()
       AND lease."hardExpiresAt" > clock_timestamp()
       AND lease."contextRevision" = artifact."contextRevision"
       AND lease."contextDigest" = artifact."contextDigest"
       AND lease."contextAppliedRevision" = artifact."contextRevision"
       AND lease."contextAppliedDigest" = artifact."contextDigest"
       AND lease."contextAppliedOwnerEpoch" = artifact."sidebandOwnerEpoch"
       AND lease."sidebandOwnerEpoch" = artifact."sidebandOwnerEpoch"
       AND lease."sidebandOwnerTokenHash" = artifact."sidebandOwnerTokenHash"
       AND lease."sidebandOwnerLeaseExpiresAt" > clock_timestamp()
       AND lease."sidebandProtocolVersion" = 2
  ) THEN
    RAISE EXCEPTION 'realtime control grant is not durably delivered or no longer current'
      USING ERRCODE = '55000';
  END IF;

  IF NEW."consumedAt" < clock_timestamp() - INTERVAL '1 minute'
    OR NEW."consumedAt" > clock_timestamp() + INTERVAL '1 minute'
  THEN
    RAISE EXCEPTION 'invalid realtime control consumption timestamp'
      USING ERRCODE = '55000';
  END IF;

  RETURN NEW;
END;
$$;

-- La migration de hardening 010000 a ajouté des triggers v2 devant les triggers historiques.
-- Ils doivent évoluer au même instant : laisser l'ancien v2 imposer DELIVERED recréerait une
-- dépendance à la Map mémoire et annulerait précisément la garantie multi-réplique recherchée.
CREATE OR REPLACE FUNCTION guard_realtime_control_grant_v2()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    RAISE EXCEPTION 'realtime control grants are immutable'
      USING ERRCODE = '55000';
  END IF;
  IF NOT EXISTS (
    SELECT 1
      FROM public.realtime_speech_artifacts AS artifact
      JOIN public.realtime_session_leases AS lease
        ON lease."companyId" = artifact."companyId"
       AND lease."subjectHash" = artifact."subjectHash"
       AND lease."sessionId" = artifact."sessionId"
     WHERE artifact."id" = NEW."artifactId"
       AND artifact."companyId" = NEW."companyId"
       AND artifact."sessionId" = NEW."sessionId"
       AND artifact."turnId" = NEW."turnId"
       AND artifact."state" = 'ready'
       AND artifact."storageExpiresAt" > clock_timestamp()
       AND artifact."objectPurgedAt" IS NULL
       AND artifact."contextRevision" = NEW."contextRevision"
       AND artifact."contextDigest" = NEW."contextDigest"
       AND lease."state" = 'active'
       AND lease."leaseExpiresAt" >= NEW."expiresAt"
       AND lease."hardExpiresAt" >= NEW."expiresAt"
       AND lease."contextRevision" = artifact."contextRevision"
       AND lease."contextDigest" = artifact."contextDigest"
       AND lease."contextAppliedRevision" = artifact."contextRevision"
       AND lease."contextAppliedDigest" = artifact."contextDigest"
       AND lease."contextAppliedOwnerEpoch" = artifact."sidebandOwnerEpoch"
       AND lease."sidebandOwnerEpoch" = artifact."sidebandOwnerEpoch"
       AND lease."sidebandOwnerTokenHash" = artifact."sidebandOwnerTokenHash"
       AND lease."sidebandOwnerLeaseExpiresAt" >= NEW."expiresAt"
       AND lease."sidebandProtocolVersion" = 2
  ) THEN
    RAISE EXCEPTION 'control grant requires live ready audio'
      USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION guard_realtime_control_consumption_v2()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    RAISE EXCEPTION 'realtime control consumptions are immutable'
      USING ERRCODE = '55000';
  END IF;
  IF NOT EXISTS (
    SELECT 1
      FROM public.realtime_control_grants AS control_grant
      JOIN public.realtime_speech_artifacts AS artifact
        ON artifact."id" = control_grant."artifactId"
       AND artifact."companyId" = control_grant."companyId"
       AND artifact."sessionId" = control_grant."sessionId"
       AND artifact."turnId" = control_grant."turnId"
      JOIN public.realtime_session_leases AS lease
        ON lease."companyId" = artifact."companyId"
       AND lease."subjectHash" = artifact."subjectHash"
       AND lease."sessionId" = artifact."sessionId"
     WHERE control_grant."id" = NEW."grantId"
       AND control_grant."companyId" = NEW."companyId"
       AND control_grant."sessionId" = NEW."sessionId"
       AND control_grant."turnId" = NEW."turnId"
       AND control_grant."issuedAt" <= NEW."consumedAt"
       AND control_grant."expiresAt" >= NEW."consumedAt"
       AND control_grant."expiresAt" > clock_timestamp()
       AND artifact."state" = 'delivered'
       AND artifact."deliveryId" = NEW."acknowledgementId"
       AND artifact."storageExpiresAt" > clock_timestamp()
       AND artifact."objectPurgedAt" IS NULL
       AND lease."state" = 'active'
       AND lease."leaseExpiresAt" > clock_timestamp()
       AND lease."hardExpiresAt" > clock_timestamp()
       AND lease."contextRevision" = artifact."contextRevision"
       AND lease."contextDigest" = artifact."contextDigest"
       AND lease."contextAppliedRevision" = artifact."contextRevision"
       AND lease."contextAppliedDigest" = artifact."contextDigest"
       AND lease."contextAppliedOwnerEpoch" = artifact."sidebandOwnerEpoch"
       AND lease."sidebandOwnerEpoch" = artifact."sidebandOwnerEpoch"
       AND lease."sidebandOwnerTokenHash" = artifact."sidebandOwnerTokenHash"
       AND lease."sidebandOwnerLeaseExpiresAt" > clock_timestamp()
       AND lease."sidebandProtocolVersion" = 2
     FOR SHARE OF artifact
  ) THEN
    RAISE EXCEPTION 'control consumption requires delivered audio and its exact acknowledgement'
      USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;

COMMENT ON TABLE realtime_control_grants IS
  'Contrôle UI chiffré scellé sur un artefact ready; inutilisable avant son ACK delivered exact.';
COMMENT ON COLUMN realtime_control_consumptions."acknowledgementId" IS
  'Même UUID que realtime_speech_artifacts.deliveryId; preuve que le mobile a acquitté cet audio.';
