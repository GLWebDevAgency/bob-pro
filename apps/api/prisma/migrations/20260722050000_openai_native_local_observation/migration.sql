-- Bob Live OpenAI natif — observation locale V1 du premier ACK durable.
--
-- Expand N-1/N : les deux colonnes restent nullable afin qu'un writer N-1 puisse terminer sa
-- requête pendant le déploiement. Le writer N exige ensuite le couple exact au niveau domaine et
-- wire. `webrtc_remote_rtp_observed_provider_drained_v1` signifie uniquement qu'au moins un paquet
-- RTP distant a été observé par le mobile puis que le fournisseur a signalé son buffer drainé ;
-- ce n'est ni une preuve de vidange DAC, ni une preuve d'audibilité humaine.

BEGIN;

ALTER TABLE public.realtime_native_speech_deliveries
  ADD COLUMN "localObservationFormatVersion" INTEGER,
  ADD COLUMN "localObservationKind" TEXT;

ALTER TABLE public.realtime_native_speech_deliveries
  ADD CONSTRAINT "realtime_native_speech_deliveries_local_observation_shape_check"
    CHECK (
      (
        "localObservationFormatVersion" IS NULL
        AND "localObservationKind" IS NULL
      )
      OR (
        "phase" = 'delivered'
        AND "localObservationFormatVersion" = 1
        AND "localObservationKind" = 'webrtc_remote_rtp_observed_provider_drained_v1'
      )
    ) NOT VALID;

ALTER TABLE public.realtime_native_speech_deliveries
  VALIDATE CONSTRAINT "realtime_native_speech_deliveries_local_observation_shape_check";

-- Le trigger existant conserve son nom et son binding. Son périmètre est étendu atomiquement aux
-- deux dimensions allowlistées : elles ne peuvent apparaître que lors du premier completed ->
-- delivered et deviennent ensuite immuables avec le lot SLO.
CREATE OR REPLACE FUNCTION public.guard_realtime_native_speech_slo_v1()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW."localObservationFormatVersion" IS NOT NULL
       OR NEW."localObservationKind" IS NOT NULL
       OR NEW."sloFormatVersion" IS NOT NULL
       OR NEW."speechStoppedEventToFirstInboundRtpMs" IS NOT NULL
       OR NEW."bargeInStatus" IS NOT NULL
       OR cardinality(NEW."bargeInDurationsMs") <> 0
    THEN
      RAISE EXCEPTION 'native speech observation and SLO cannot precede durable delivery acknowledgement'
        USING ERRCODE = '55000';
    END IF;
    RETURN NEW;
  END IF;

  IF ROW(
    NEW."localObservationFormatVersion", NEW."localObservationKind",
    NEW."sloFormatVersion", NEW."speechStoppedEventToFirstInboundRtpMs",
    NEW."bargeInStatus", NEW."bargeInDurationsMs"
  ) IS DISTINCT FROM ROW(
    OLD."localObservationFormatVersion", OLD."localObservationKind",
    OLD."sloFormatVersion", OLD."speechStoppedEventToFirstInboundRtpMs",
    OLD."bargeInStatus", OLD."bargeInDurationsMs"
  ) AND NOT (
    OLD."phase" = 'completed'
    AND NEW."phase" = 'delivered'
    AND OLD."localObservationFormatVersion" IS NULL
    AND OLD."localObservationKind" IS NULL
    AND OLD."sloFormatVersion" IS NULL
    AND OLD."speechStoppedEventToFirstInboundRtpMs" IS NULL
    AND OLD."bargeInStatus" IS NULL
    AND cardinality(OLD."bargeInDurationsMs") = 0
  ) THEN
    RAISE EXCEPTION 'native speech observation and SLO are immutable outside first durable delivery acknowledgement'
      USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.guard_realtime_native_speech_slo_v1() FROM PUBLIC;

COMMENT ON COLUMN public.realtime_native_speech_deliveries."localObservationFormatVersion" IS
  'V1 = observation mobile RTP distant + buffer fournisseur drainé ; nullable pour compatibilité expand N-1/N.';
COMMENT ON COLUMN public.realtime_native_speech_deliveries."localObservationKind" IS
  'Allowlist V1 webrtc_remote_rtp_observed_provider_drained_v1 ; jamais une preuve de fin DAC ou d audibilité.';

COMMIT;
