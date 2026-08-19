-- Jarvis U1-e — ANNUAIRE D'AUTORITÉ DES PROPRIÉTAIRES À PURGER
-- (SPEC_U1E_PARCOURS_VISIBLE_20260819 §4, spec Jarvis §5.5 ; patron RÉDUIT de
-- 20260722030000_realtime_reaper_directory).
--
-- POURQUOI UNE AUTORITÉ, ET PAS UNE LECTURE APPLICATIVE. `jarvis_proposal_payloads` est en
-- FORCE ROW LEVEL SECURITY et toutes ses policies sont OWNER-scopées : `bob_app` sans GUC
-- propriétaire ne voit AUCUNE ligne. Le balayage de rétention, lui, doit précisément découvrir
-- QUELS propriétaires ont du PII échu — une question à laquelle aucun rôle tenanté ne peut
-- répondre sans qu'on lui concède de voir le magasin d'autrui. Tant que cette réponse n'existe
-- pas, `JarvisProposalPayloadPurgeService` rend `owner_directory_absent` et le PII échu reste
-- EN BASE : la rétention est une promesse creuse. Cette migration ferme ce trou.
--
-- RÉDUIT vs le reaper : ni table de projection ni curseur. Le tenant vient déjà de
-- `ScheduledTenantDirectory` et l'échéance est PORTÉE PAR LA LIGNE (`retentionExpiresAt`) —
-- il n'y a donc rien à matérialiser ni à faire tourner : chaque appel relit l'état réel.
--
-- CE QUE L'AUTORITÉ PEUT, ET RIEN DE PLUS :
--   · elle ne voit QUE des lignes DÉJÀ ÉCHUES (la policy porte la même horloge SQL que la policy
--     DELETE de rétention : `statement_timestamp()`) — un propriétaire dont tout le PII est
--     vivant reste invisible, donc l'annuaire ne peut pas servir à cartographier les usagers ;
--   · elle ne lit QUE des coordonnées, jamais du contenu : la colonne `payload` est exclue par un
--     GRANT PAR COLONNE posé au provisionnement (`release.sh`), donc même le definer ne peut pas
--     l'atteindre ;
--   · elle n'écrit ni n'efface RIEN : aucune policy INSERT/UPDATE/DELETE ne la nomme. L'effacement
--     reste owner-scopé, sous les GUC de la ligne cible, exactement comme avant.
--
-- LES POLICIES OWNER-SCOPÉES DE U1-d SONT INCHANGÉES. Cette migration n'en réécrit aucune : elle
-- en AJOUTE une, à côté, réservée à un rôle NOLOGIN/NOBYPASSRLS qui n'existe que pour ça.
--
-- La fonction naît SECURITY INVOKER : appliquée par un déployeur non-superuser, une migration ne
-- doit jamais créer d'elle-même un chemin privilégié. C'est le bloc `provision_*` de `release.sh`
-- qui bascule propriétaire et SECURITY DEFINER, puis n'accorde EXECUTE qu'au seul rôle applicatif.
-- Entre les deux, la fonction existe et REFUSE tout appelant : fail-closed par défaut.
--
-- NE PAS COPIER les helpers cabinet `SET row_security = off` : cette table est en FORCE RLS, donc
-- `row_security = off` n'y fonctionnerait que si le definer avait BYPASSRLS — un privilège que
-- rien ici ne justifie et qui rendrait la policy d'autorité décorative.

BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

-- Contrat Supabase : le deployer non-superuser assume le propriétaire du schéma (même patron que
-- 20260819100000_jarvis_proposal_payloads, dont cette migration prolonge les objets).
DO $bob_jarvis_u1e_owner$
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
     AND relation.relname = 'jarvis_proposal_payloads'
     AND relation.relkind IN ('r', 'p');

  IF current_user::pg_catalog.regrole <> schema_owner_oid THEN
    IF schema_owner_name IS NULL
       OR NOT pg_catalog.pg_has_role(session_user, schema_owner_oid, 'SET') THEN
      RAISE EXCEPTION USING
        ERRCODE = '42501',
        MESSAGE = 'JARVIS_U1E_SCHEMA_OWNER_UNAVAILABLE';
    END IF;
    EXECUTE pg_catalog.format('SET LOCAL ROLE %I', schema_owner_name);
  END IF;

  IF current_user::pg_catalog.regrole <> schema_owner_oid THEN
    RAISE EXCEPTION USING
      ERRCODE = '42501',
      MESSAGE = 'JARVIS_U1E_SCHEMA_OWNER_NOT_ASSUMED';
  END IF;
END;
$bob_jarvis_u1e_owner$;

-- AUCUN INDEX NEUF, volontairement. `jarvis_proposal_payloads_retention_idx`
-- ("companyId", "retentionExpiresAt"), livré par U1-d, borne DÉJÀ le balayage aux lignes échues
-- DE CE TENANT — exactement l'ensemble que la purge s'apprête à effacer. Mesure sur PostgreSQL 17
-- jetable, 50 000 charges échues sur un tenant : Bitmap Index Scan sur cet index + agrégat,
-- 9,6 ms, très loin du fence de 4 s. Un index dédié ("companyId", "ownerUserId", ...) rendrait la
-- lecture index-only sans changer l'ordre de grandeur, et exigerait de modifier `schema.prisma`
-- (le modèle Prisma porte les index de cette table) : deux artefacts pour un gain nul.

-- Policy d'autorité, AJOUTÉE à côté des policies owner-scopées (aucune n'est touchée). Deux
-- conditions, pas une : le rôle d'autorité ET l'échéance dépassée. La seconde n'est pas un luxe —
-- sans elle, l'autorité pourrait énumérer les propriétaires ACTIFS d'un tenant, ce dont un
-- balayage de rétention n'a jamais besoin.
CREATE POLICY jarvis_proposal_payloads_retention_directory_select
  ON public.jarvis_proposal_payloads FOR SELECT
  USING (
    current_user = 'bob_jarvis_payload_retention_directory'
    AND "retentionExpiresAt" <= statement_timestamp()
  );

-- Le propriétaire du schéma est rendu ICI : la fonction doit naître sous le rôle qui applique la
-- migration (patron du reaper), sinon `release.sh` ne pourrait pas la transférer à l'autorité —
-- PostgreSQL exige que le rôle qui change un propriétaire puisse SET ROLE vers l'ANCIEN comme vers
-- le NOUVEAU, et le propriétaire de schéma, lui, n'est membre d'aucune autorité.
RESET ROLE;

-- Annuaire borné, sans état : ni curseur, ni claim, ni écriture. Deux appels successifs peuvent
-- rendre la même page — c'est voulu : le balayage est idempotent (une ligne déjà effacée n'existe
-- plus, une ligne vivante n'est jamais rendue) et un curseur introduirait un état à réparer.
CREATE FUNCTION public.list_jarvis_payload_retention_owners_v1(
  company_id TEXT,
  batch_limit INTEGER
)
RETURNS TABLE ("ownerUserId" TEXT)
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog
SET row_security = on
SET statement_timeout = '4s'
SET lock_timeout = '1s'
AS $bob_jarvis_payload_retention_owners$
BEGIN
  -- Premier geste, avant toute lecture : l'identité. Tant que `release.sh` n'a pas basculé la
  -- fonction en SECURITY DEFINER détenue par l'autorité, `current_user` est l'appelant et CE
  -- refus est la seule réponse possible. Nommé (42501), jamais un silence ni une page vide.
  IF current_user <> 'bob_jarvis_payload_retention_directory' THEN
    RAISE EXCEPTION 'jarvis payload retention directory authority required'
      USING ERRCODE = '42501';
  END IF;
  -- Bornes d'entrée : mêmes invariants que la colonne `ownerUserId` du magasin (U1-d) pour le
  -- tenant, et plafond dur aligné sur JARVIS_PROPOSAL_PAYLOAD_PURGE_MAX_OWNERS_PER_TENANT (50).
  -- Un appelant qui demande plus est un défaut d'appelant : il est refusé, jamais rogné en
  -- silence.
  IF company_id IS NULL
     OR pg_catalog.length(company_id) < 1
     OR pg_catalog.length(company_id) > 200
     OR company_id <> pg_catalog.btrim(company_id)
     OR company_id ~ '[[:cntrl:]]'
     OR batch_limit IS NULL
     OR batch_limit < 1
     OR batch_limit > 50 THEN
    RAISE EXCEPTION 'jarvis payload retention directory request rejected'
      USING ERRCODE = '22023';
  END IF;

  -- La projection ne porte QUE le propriétaire. Aucune colonne de contenu n'est nommée ici, et
  -- le GRANT par colonne du provisionnement rend `payload` inatteignable même pour le definer :
  -- une régression qui l'ajouterait ne rendrait pas de la PII, elle mourrait en 42501 à
  -- l'exécution — la base refuse, elle ne se contente pas de compter sur ce fichier.
  RETURN QUERY
    SELECT DISTINCT stored."ownerUserId"
      FROM public.jarvis_proposal_payloads AS stored
     WHERE stored."companyId" = company_id
       AND stored."retentionExpiresAt" <= statement_timestamp()
     ORDER BY stored."ownerUserId"
     LIMIT batch_limit;
END;
$bob_jarvis_payload_retention_owners$;

-- La migration ferme elle-même la fonction. Le provisionnement rouvrira EXECUTE au seul rôle
-- applicatif, après la bascule SECURITY DEFINER.
REVOKE ALL ON FUNCTION public.list_jarvis_payload_retention_owners_v1(TEXT, INTEGER) FROM PUBLIC;

COMMIT;
