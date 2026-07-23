\set ON_ERROR_STOP on

-- Gate opérateur obligatoire AVANT de retirer une ancienne clé HMAC de preuve.
-- Préconditions hors base : couper le flag OpenAI natif, terminer les sessions owner, puis laisser
-- le reaper terminaliser les livraisons en vol. Le certificat est volontairement READ ONLY : il
-- constate un drain complet, il ne maquille ni ne backfill aucune preuve historique.
\if :{?proof_key_version}
\else
  \echo 'proof_key_version is required'
  \quit 3
\endif
\if :{?proof_key_fingerprint}
\else
  \echo 'proof_key_fingerprint is required'
  \quit 3
\endif

BEGIN TRANSACTION READ ONLY;
SELECT pg_catalog.set_config(
  'bob.openai_native_rotation_proof_key_version',
  :'proof_key_version',
  true
);
SELECT pg_catalog.set_config(
  'bob.openai_native_rotation_proof_key_fingerprint',
  :'proof_key_fingerprint',
  true
);
SET LOCAL statement_timeout = '5s';
SET LOCAL lock_timeout = '1s';

DO $$
DECLARE
  target_version_text TEXT := pg_catalog.current_setting(
    'bob.openai_native_rotation_proof_key_version',
    true
  );
  target_version INTEGER;
  target_fingerprint TEXT := pg_catalog.current_setting(
    'bob.openai_native_rotation_proof_key_fingerprint',
    true
  );
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM pg_catalog.pg_roles AS role
     WHERE role.rolname = current_user
       AND (role.rolsuper OR role.rolbypassrls)
  ) THEN
    RAISE EXCEPTION
      'OpenAI native proof rotation requires a role that can certify every tenant';
  END IF;
  IF target_version_text IS NULL
     OR target_version_text !~ '^[1-9][0-9]{0,9}$'
     OR target_version_text::NUMERIC > 2147483647 THEN
    RAISE EXCEPTION 'OpenAI native proof rotation requires an int4 key version';
  END IF;
  target_version := target_version_text::INTEGER;
  IF target_fingerprint IS NULL OR target_fingerprint !~ '^[a-f0-9]{64}$' THEN
    RAISE EXCEPTION 'OpenAI native proof rotation requires a SHA-256 key fingerprint';
  END IF;

  PERFORM pg_advisory_xact_lock(
    hashtextextended('openai-native-speech-proof-hmac-v1', 0)
  );
  IF NOT EXISTS (
    SELECT 1
      FROM public.realtime_mistral_conversation_key_version_floors AS floor
      JOIN public.realtime_mistral_conversation_key_bindings AS binding
        ON binding."keySpace" = floor."keySpace"
       AND binding."keyVersion" = target_version
     WHERE floor."keySpace" = 'openai-native-speech-proof-hmac-v1'
       AND floor."highestVersion" = target_version
       AND binding."keyFingerprint" = target_fingerprint
  ) THEN
    RAISE EXCEPTION
      'OpenAI native proof rotation blocked: durable version/fingerprint binding mismatch';
  END IF;

  IF EXISTS (
    SELECT 1
      FROM public.realtime_session_leases AS lease
     WHERE lease."providerId" = 'openai'
       AND lease."sidebandOwnerTokenHash" IS NOT NULL
       AND lease."sidebandOwnerLeaseExpiresAt" > pg_catalog.clock_timestamp()
  ) THEN
    RAISE EXCEPTION
      'OpenAI native proof rotation blocked: an OpenAI sideband owner lease is still live';
  END IF;

  -- `completed` reste non terminal et exige encore sa clé pour devenir `delivered`. Les quatre
  -- terminaux sont volontairement exclus : leur replay exact/conflit et leur réconciliation sont
  -- déterminés par l'état immuable, sans recalcul HMAC après retrait légitime de l'ancienne clé.
  IF EXISTS (
    SELECT 1
      FROM public.realtime_native_speech_deliveries AS delivery
     WHERE delivery.phase NOT IN ('delivered', 'cancelled', 'failed', 'expired')
       AND delivery."proofKeyVersion" <> target_version
  ) THEN
    RAISE EXCEPTION
      'OpenAI native proof rotation blocked: a nonterminal delivery still requires an old key';
  END IF;

  -- Les lignes N-1 delivered avec observation NULL/NULL sont lisibles pendant l'expand, mais ne
  -- prouvent jamais une restitution acoustique. Elles doivent expirer/purger avant l'activation.
  IF EXISTS (
    SELECT 1
      FROM public.realtime_native_speech_deliveries AS delivery
     WHERE delivery.phase = 'delivered'
       AND (
         delivery."localObservationFormatVersion" IS DISTINCT FROM 1
         OR delivery."localObservationKind" IS DISTINCT FROM
           'webrtc_remote_rtp_observed_provider_drained_v1'
       )
  ) THEN
    RAISE EXCEPTION
      'OpenAI native activation blocked: a legacy delivered row has no V1 local observation proof';
  END IF;
END;
$$;

ROLLBACK;
