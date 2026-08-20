-- Jarvis U1-f — ANNUAIRE D'AUTORITÉ DES COORDONNÉES À DISPATCHER
-- (SPEC_U1F_CHAINE_ARMEE_20260820 §1, spec Jarvis §5.3 ; patron EXACT de
-- 20260819210000_jarvis_payload_retention_directory, dont ce fichier est le frère.)
--
-- POURQUOI UNE AUTORITÉ, ET PAS UNE LECTURE APPLICATIVE. Les policies de `jarvis_work_items`
-- sont OWNER-scopées : `jarvis_work_items_owner_select` exige à la fois
-- `app.current_company_id` ET `app.current_user_id`. Or le worker de dispatch cherche
-- précisément QUELS propriétaires ont du travail dû — la question à laquelle aucun rôle tenanté
-- ne peut répondre, puisqu'il faudrait déjà connaître la réponse pour poser le GUC. Tant qu'elle
-- n'a pas de réponse, `JarvisWorkItemDispatchService` rend `dependencies_absent` à chaque tick :
-- un `confirm` d'artisan n'écrit JAMAIS sa fiche, et le run reste en `committing` sans sortie.
-- Cette migration ferme ce trou.
--
-- CE QUE L'AUTORITÉ PEUT, ET RIEN DE PLUS :
--   · elle ne voit QUE des lignes RÉELLEMENT DUES — les trois cas que le worker traite : un item
--     à réclamer (`prepared`/`retry_due` dont l'échéance de réessai est passée), un effet autorisé
--     dont la lease a expiré (réconciliation §5.3), ou un résultat persisté dont le signal n'est
--     pas appliqué (redelivery level-triggered). Un run au repos reste INVISIBLE : l'annuaire ne
--     peut donc pas servir à cartographier l'activité d'un tenant ;
--   · elle ne lit QUE des coordonnées et les colonnes de sa propre borne, jamais de charge :
--     `payloadRef`, `authorizationSource`, `submittedJobRef`, `targetDigest`,
--     `authorizationDigest` et `resultDigest` lui sont INATTEIGNABLES par GRANT par colonne posé
--     au provisionnement (`release.sh`) ;
--   · elle n'écrit ni n'efface RIEN : aucune policy INSERT/UPDATE/DELETE ne la nomme. Le claim,
--     l'autorisation et le règlement restent owner-scopés, sous les GUC de la ligne cible, par
--     `PrismaJarvisWorkItemsRepository` — exactement comme avant.
--
-- LES POLICIES OWNER-SCOPÉES DE U1-a SONT INCHANGÉES : cette migration n'en réécrit aucune, elle
-- en AJOUTE une à côté, réservée à un rôle NOLOGIN/NOBYPASSRLS qui n'existe que pour ça.
--
-- La fonction naît SECURITY INVOKER : appliquée par un déployeur non-superuser, une migration ne
-- doit jamais créer d'elle-même un chemin privilégié. C'est le bloc `provision_*` de `release.sh`
-- qui bascule propriétaire et SECURITY DEFINER, puis n'accorde EXECUTE qu'au seul rôle applicatif.
-- Entre les deux, la fonction existe et REFUSE tout appelant : fail-closed par défaut.

BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

-- Contrat Supabase : le deployer non-superuser assume le propriétaire du schéma (même patron que
-- 20260818200000_jarvis_run_expand, qui a créé la table que cette migration prolonge).
DO $bob_jarvis_u1f_owner$
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
        MESSAGE = 'JARVIS_U1F_SCHEMA_OWNER_UNAVAILABLE';
    END IF;
    EXECUTE pg_catalog.format('SET LOCAL ROLE %I', schema_owner_name);
  END IF;

  IF current_user::pg_catalog.regrole <> schema_owner_oid THEN
    RAISE EXCEPTION USING
      ERRCODE = '42501',
      MESSAGE = 'JARVIS_U1F_SCHEMA_OWNER_NOT_ASSUMED';
  END IF;
END;
$bob_jarvis_u1f_owner$;

-- AUCUN INDEX NEUF, volontairement. `jarvis_work_items_dispatch_idx` ("companyId", "status",
-- "nextAttemptAt"), livré par U1-a, borne DÉJÀ le balayage par tenant et par statut — la première
-- des trois branches de la borne, celle qui court à chaque tick. Les deux autres (lease expirée,
-- signal pendant) portent sur des ensembles minuscules par construction : un effet en vol et un
-- résultat non signalé sont des états transitoires, pas des populations. Un index dédié coûterait
-- une écriture à chaque transition de work item pour un gain nul, et exigerait de modifier
-- `schema.prisma` : deux artefacts pour rien.

-- Policy d'autorité, AJOUTÉE à côté des policies owner-scopées (aucune n'est touchée). Deux
-- conditions, pas une : le rôle d'autorité ET le fait que la ligne soit RÉELLEMENT DUE. La
-- seconde n'est pas un luxe — sans elle, l'autorité énumérerait tous les runs actifs d'un tenant,
-- ce dont un balayage de dispatch n'a jamais besoin.
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
      -- (2) autorisé dont la lease est morte : réconciliation §5.3 (worker tombé APRÈS le point
      --     de non-retour). `leaseExpiresAt IS NULL` en `authorized` est un état incohérent —
      --     l'annuaire le rend VISIBLE plutôt que de le laisser dormir invisible.
      OR (
        "status" = 'authorized'
        AND ("leaseExpiresAt" IS NULL OR "leaseExpiresAt" <= statement_timestamp())
      )
      -- (3) résultat persisté, signal non appliqué : redelivery level-triggered, la seule branche
      --     qu'aucun kill switch ne coupe.
      OR ("resultDigest" IS NOT NULL AND "signalAppliedAt" IS NULL)
    )
  );

-- Le propriétaire du schéma est rendu ICI : la fonction doit naître sous le rôle qui applique la
-- migration (patron du reaper), sinon `release.sh` ne pourrait pas la transférer à l'autorité —
-- PostgreSQL exige que le rôle qui change un propriétaire puisse SET ROLE vers l'ANCIEN comme vers
-- le NOUVEAU, et le propriétaire de schéma, lui, n'est membre d'aucune autorité.
RESET ROLE;

-- Annuaire borné, sans état : ni curseur, ni claim, ni écriture. Deux appels successifs peuvent
-- rendre les mêmes coordonnées — c'est voulu : le balayage est idempotent (le claim réel est un
-- CAS fencé côté repository) et un curseur introduirait un état à réparer.
CREATE FUNCTION public.list_jarvis_dispatch_coordinates_v1(
  company_id TEXT,
  batch_limit INTEGER
)
RETURNS TABLE ("ownerUserId" TEXT, "runId" TEXT)
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog
SET row_security = on
SET statement_timeout = '4s'
SET lock_timeout = '1s'
AS $bob_jarvis_dispatch_coordinates$
BEGIN
  -- Premier geste, avant toute lecture : l'identité. Tant que `release.sh` n'a pas basculé la
  -- fonction en SECURITY DEFINER détenue par l'autorité, `current_user` est l'appelant et CE
  -- refus est la seule réponse possible. Nommé (42501), jamais un silence ni une page vide.
  IF current_user <> 'bob_jarvis_dispatch_directory' THEN
    RAISE EXCEPTION 'jarvis dispatch directory authority required'
      USING ERRCODE = '42501';
  END IF;
  -- Bornes d'entrée : mêmes invariants que la colonne `companyId` pour le tenant, et plafond dur
  -- aligné sur DIRECTORY_LIMIT du worker (50). Un appelant qui demande plus est un défaut
  -- d'appelant : il est refusé, jamais rogné en silence.
  IF company_id IS NULL
     OR pg_catalog.length(company_id) < 1
     OR pg_catalog.length(company_id) > 200
     OR company_id <> pg_catalog.btrim(company_id)
     OR company_id ~ '[[:cntrl:]]'
     OR batch_limit IS NULL
     OR batch_limit < 1
     OR batch_limit > 50 THEN
    RAISE EXCEPTION 'jarvis dispatch directory request rejected'
      USING ERRCODE = '22023';
  END IF;

  -- La projection ne porte QUE les coordonnées. Aucune colonne de charge n'est nommée ici, et le
  -- GRANT par colonne du provisionnement les rend inatteignables même pour le definer : une
  -- régression qui en ajouterait une ne rendrait pas de la donnée sensible, elle mourrait en
  -- 42501 à l'exécution — la base refuse, elle ne se contente pas de compter sur ce fichier.
  RETURN QUERY
    SELECT DISTINCT due."ownerUserId", due."runId"::text
      FROM public.jarvis_work_items AS due
     WHERE due."companyId" = company_id
     ORDER BY due."ownerUserId", due."runId"::text
     LIMIT batch_limit;
END;
$bob_jarvis_dispatch_coordinates$;

-- La migration ferme elle-même la fonction. Le provisionnement rouvrira EXECUTE au seul rôle
-- applicatif, après la bascule SECURITY DEFINER.
REVOKE ALL ON FUNCTION public.list_jarvis_dispatch_coordinates_v1(TEXT, INTEGER) FROM PUBLIC;

COMMIT;
