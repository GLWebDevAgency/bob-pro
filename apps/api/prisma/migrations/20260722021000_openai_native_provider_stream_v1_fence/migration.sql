-- Contraction préactivation courte : la V1 n'émet aucun contrôle provider_stream. L'ajout
-- NOT VALID ne scanne aucune ligne et libère son verrou ACCESS EXCLUSIVE à la fin de ce statement.
ALTER TABLE public.realtime_control_grants
  ADD CONSTRAINT realtime_control_grants_provider_stream_v1_disabled_check
  CHECK ("deliveryKind" <> 'provider_stream') NOT VALID;

COMMENT ON CONSTRAINT realtime_control_grants_provider_stream_v1_disabled_check
  ON public.realtime_control_grants IS
  'V1: contrôle provider_stream interdit jusqu au déploiement atomique de sa purge de graphe.';
