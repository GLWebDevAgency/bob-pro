-- Jarvis U1-f — un résultat INDÉCIDABLE ne doit jamais affamer l'annuaire de dispatch.
--
-- `outcome_unknown` est volontairement durable et non signalable : aucune commande système ne
-- doit le transformer en faux succès ou faux échec. La policy précédente rendait pourtant toute
-- ligne avec `resultDigest` non nul et `signalAppliedAt` nul visible à l'annuaire. Comme la fonction
-- d'annuaire trie puis borne sa page, 25 coordonnées unknown pouvaient occuper chaque tick et
-- affamer un vrai claim ou un vrai signal situé après elles.
--
-- APPEND-ONLY : les migrations livrées ne sont pas réécrites. Cette version conserve exactement
-- les trois branches exécutables (claim, lease morte, authorized à réconcilier) et borne la branche
-- de redelivery aux seuls statuts que `listPendingSignals` et `markSignalApplied` acceptent :
-- `succeeded | failed_terminal | cancelled`. Les unknown restent visibles au drain de release,
-- mais ne sont jamais pris pour du travail que ce worker ne sait pas réconcilier.

BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

DO $bob_jarvis_u1f_signalable_owner$
DECLARE
  schema_owner_oid OID;
  schema_owner_name TEXT;
BEGIN
  SELECT relation.relowner, pg_catalog.pg_get_userbyid(relation.relowner)
    INTO STRICT schema_owner_oid, schema_owner_name
    FROM pg_catalog.pg_class AS relation
    JOIN pg_catalog.pg_namespace AS namespace
      ON namespace.oid = relation.relnamespace
   WHERE namespace.nspname = 'public'
     AND relation.relname = 'jarvis_work_items'
     AND relation.relkind IN ('r', 'p');

  IF current_user::pg_catalog.regrole <> schema_owner_oid THEN
    IF schema_owner_name IS NULL
       OR NOT pg_catalog.pg_has_role(session_user, schema_owner_oid, 'SET') THEN
      RAISE EXCEPTION USING
        ERRCODE = '42501',
        MESSAGE = 'JARVIS_U1F_SIGNALABLE_SCHEMA_OWNER_UNAVAILABLE';
    END IF;
    EXECUTE pg_catalog.format('SET LOCAL ROLE %I', schema_owner_name);
  END IF;

  IF current_user::pg_catalog.regrole <> schema_owner_oid THEN
    RAISE EXCEPTION USING
      ERRCODE = '42501',
      MESSAGE = 'JARVIS_U1F_SIGNALABLE_SCHEMA_OWNER_NOT_ASSUMED';
  END IF;
END;
$bob_jarvis_u1f_signalable_owner$;

DROP POLICY IF EXISTS jarvis_work_items_dispatch_directory_select ON public.jarvis_work_items;

CREATE POLICY jarvis_work_items_dispatch_directory_select
  ON public.jarvis_work_items FOR SELECT
  USING (
    current_user = 'bob_jarvis_dispatch_directory'
    AND (
      -- (1) À réclamer : le worker prendra la lease.
      (
        "status" IN ('prepared', 'retry_due')
        AND ("nextAttemptAt" IS NULL OR "nextAttemptAt" <= statement_timestamp())
      )
      -- (2) Lease morte avant autorisation : `claimDue` sait la reprendre.
      OR (
        "status" = 'leased'
        AND "leaseExpiresAt" IS NOT NULL
        AND "leaseExpiresAt" <= statement_timestamp()
      )
      -- (3) Point de non-retour orphelin : réconciliation purpose-specific avant toute reprise.
      OR (
        "status" = 'authorized'
        AND "leaseExpiresAt" IS NOT NULL
        AND "leaseExpiresAt" < statement_timestamp()
      )
      -- (4) Redelivery uniquement d'une issue DÉCIDÉE. `outcome_unknown` ne produit jamais de
      --     reçu de run et ne peut donc pas occuper la page de cet annuaire.
      OR (
        "status" IN ('succeeded', 'failed_terminal', 'cancelled')
        AND "resultDigest" IS NOT NULL
        AND "signalAppliedAt" IS NULL
        AND ("status" <> 'succeeded' OR (
          "authorizedAt" IS NOT NULL AND "authorizationDigest" IS NOT NULL
        ))
        AND ("status" <> 'cancelled' OR (
          "authorizedAt" IS NULL AND "authorizationDigest" IS NULL
        ))
      )
    )
  );

-- Le reader owner-scopé `listPendingSignals` applique le même prédicat. Remplacer l'index large
-- empêche une longue population d'unknown de polluer aussi son plan avant un vrai reçu dû.
DROP INDEX IF EXISTS public.jarvis_work_items_pending_signal_idx;
CREATE INDEX jarvis_work_items_pending_signal_idx
  ON public.jarvis_work_items ("companyId", "updatedAt")
  WHERE "status" IN ('succeeded', 'failed_terminal', 'cancelled')
    AND "resultDigest" IS NOT NULL
    AND "signalAppliedAt" IS NULL
    AND ("status" <> 'succeeded' OR (
      "authorizedAt" IS NOT NULL AND "authorizationDigest" IS NOT NULL
    ))
    AND ("status" <> 'cancelled' OR (
      "authorizedAt" IS NULL AND "authorizationDigest" IS NULL
    ));

COMMIT;
