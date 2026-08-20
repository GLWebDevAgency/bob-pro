-- Jarvis U1-f — L'ANNUAIRE DOIT VOIR LES LEASES MORTES (correctif P0 de la revue adversariale).
--
-- CE QUI ÉTAIT CASSÉ. La policy posée par 20260820100000 borne l'autorité à trois cas : un item à
-- réclamer (`prepared`/`retry_due` dû), un effet `authorized` dont la lease a expiré, un résultat
-- dont le signal n'est pas appliqué. Il manquait le quatrième — et c'est précisément celui que
-- `claimDue` sait reprendre : un item passé en `leased` dont la lease est MORTE.
--
-- LE CHEMIN D'ÉCHEC, vérifié. Le worker réclame l'item (`prepared` → `leased`, lease de 5 min).
-- Avant d'avoir autorisé ou réglé quoi que ce soit, le processus disparaît — redéploiement, OOM,
-- ou simplement une erreur de base qui remonte au `catch` du traitement de lease, lequel rend
-- « échoué » en LAISSANT la ligne en `leased`. Cinq minutes plus tard la lease est morte.
-- `claimDue` sait exactement la reprendre (« une lease expirée est TOUJOURS récupérable », §5.3
-- revue C10) — mais il n'est JAMAIS appelé pour ce run : le worker ne boucle que sur les
-- coordonnées de l'annuaire, et l'annuaire ne voyait pas cet état. `resultDigest` étant encore
-- NULL, aucune des trois branches ne s'appliquait.
--
-- Conséquence exacte : l'action que l'artisan a CONFIRMÉE n'est jamais exécutée, sa fiche n'est
-- jamais écrite, et le run reste en `committing` indéfiniment — le symptôme même que ce lot
-- prétend refermer. Une borne d'annuaire plus ÉTROITE que le travail réel du worker, c'est du
-- travail perdu en silence : il n'y a ni alerte, ni reprise, ni sortie humaine.
--
-- LA RÈGLE QUE CE CORRECTIF INSCRIT. La borne de l'autorité doit être le MIROIR EXACT de ce que
-- le worker sait traiter — jamais plus large (elle cartographierait l'activité du tenant), jamais
-- plus étroite (elle perdrait du travail). Les quatre branches correspondent désormais une à une
-- aux quatre chemins du repository : claim (2 branches), réconciliation, redelivery.
--
-- APPEND-ONLY : la migration précédente est livrée, on ne la réécrit pas. On remplace la policy
-- par sa version complète — `DROP POLICY IF EXISTS` puis `CREATE POLICY`, idempotent.

BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

DO $bob_jarvis_u1f_leased_owner$
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
        MESSAGE = 'JARVIS_U1F_LEASED_SCHEMA_OWNER_UNAVAILABLE';
    END IF;
    EXECUTE pg_catalog.format('SET LOCAL ROLE %I', schema_owner_name);
  END IF;
END;
$bob_jarvis_u1f_leased_owner$;

DROP POLICY IF EXISTS jarvis_work_items_dispatch_directory_select ON public.jarvis_work_items;

CREATE POLICY jarvis_work_items_dispatch_directory_select
  ON public.jarvis_work_items FOR SELECT
  USING (
    current_user = 'bob_jarvis_dispatch_directory'
    AND (
      -- (1) à réclamer : le worker prendra la lease.
      (
        "status" IN ('prepared', 'retry_due')
        AND ("nextAttemptAt" IS NULL OR "nextAttemptAt" <= statement_timestamp())
      )
      -- (2) LEASE MORTE — la branche qui manquait. Miroir exact de la seconde condition de
      --     `claimDue` : un worker tombé entre le claim et le règlement laisse la ligne ici, et
      --     elle DOIT redevenir visible, sinon l'effet confirmé est perdu à jamais.
      OR (
        "status" = 'leased'
        AND "leaseExpiresAt" IS NOT NULL
        AND "leaseExpiresAt" <= statement_timestamp()
      )
      -- (3) autorisé dont la lease est morte : réconciliation §5.3.
      OR (
        "status" = 'authorized'
        AND ("leaseExpiresAt" IS NULL OR "leaseExpiresAt" <= statement_timestamp())
      )
      -- (4) résultat persisté, signal non appliqué : redelivery level-triggered.
      OR ("resultDigest" IS NOT NULL AND "signalAppliedAt" IS NULL)
    )
  );

COMMIT;
