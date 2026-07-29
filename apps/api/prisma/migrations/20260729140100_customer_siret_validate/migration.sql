-- Validation séparée des contraintes posées NOT VALID par customer_siret_expand.

BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '120s';

ALTER TABLE public.customers VALIDATE CONSTRAINT customers_siret_shape_check;
ALTER TABLE public.customers VALIDATE CONSTRAINT customers_siret_siren_coherence_check;

COMMIT;
