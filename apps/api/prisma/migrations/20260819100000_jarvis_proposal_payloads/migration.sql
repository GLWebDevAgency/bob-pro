-- Jarvis U1-d — magasin de payloads de proposition (SPEC_U1D_CALLERS_REELS_20260819 §3
-- « MOBILE » + greffe G4, spec Jarvis §5.1/§5.5/§9.1).
--
-- Table NEUVE, purpose-specific : les champs réellement proposés à l'artisan (nom, adresse,
-- e-mail d'une fiche client) n'ont AUCUN endroit légitime où vivre aujourd'hui — le state d'un
-- run ne porte que des digests (§5.1) et les événements sont immuables. Sans ce magasin, la
-- présentation écran et l'exécution de l'effet devraient soit ressaisir le PII depuis le client
-- (autorité perdue), soit l'inscrire dans le journal (rétention impossible). Ici il est scellé
-- par `fieldsDigest`, écrit UNE fois, et il meurt avec la rétention de son run.
--
-- ÉCRITURE AVANT `stage_proposal` : l'admission ne promet un sceau que si le contenu scellé
-- existe déjà. Un crash entre les deux ne laisse qu'un orphelin — jamais une proposition qui
-- référence du vide — et l'orphelin est ramassé par la rétention (§5.5).
--
-- RLS : patron owner-scoped de `jarvis_work_items` (U1-a) — company + owner + run épinglé par
-- `app.current_agent_mission_id`, FORCE, fail-closed sans GUC exacts. Deux écarts assumés,
-- justifiés ligne par ligne plus bas : aucune policy UPDATE (le payload est immuable) et une
-- policy DELETE bornée aux lignes ÉCHUES (la rétention d'un magasin PII n'est pas décorative —
-- précédent `voice_traces`/`retentionExpiresAt`).
--
-- Aucune modification d'un objet existant : le writer N-1 et le flux quote ignorent cette table.

BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

-- Contrat Supabase : le deployer non-superuser assume le propriétaire du schéma
-- (même patron que 20260818200000_jarvis_run_expand).
DO $bob_jarvis_u1d_owner$
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
     AND relation.relname = 'agent_missions'
     AND relation.relkind IN ('r', 'p');

  IF current_user::pg_catalog.regrole <> schema_owner_oid THEN
    IF schema_owner_name IS NULL
       OR NOT pg_catalog.pg_has_role(session_user, schema_owner_oid, 'SET') THEN
      RAISE EXCEPTION USING
        ERRCODE = '42501',
        MESSAGE = 'JARVIS_U1D_SCHEMA_OWNER_UNAVAILABLE';
    END IF;
    EXECUTE pg_catalog.format('SET LOCAL ROLE %I', schema_owner_name);
  END IF;

  IF current_user::pg_catalog.regrole <> schema_owner_oid THEN
    RAISE EXCEPTION USING
      ERRCODE = '42501',
      MESSAGE = 'JARVIS_U1D_SCHEMA_OWNER_NOT_ASSUMED';
  END IF;
END;
$bob_jarvis_u1d_owner$;

CREATE TABLE public.jarvis_proposal_payloads (
  "companyId" TEXT NOT NULL,
  "runId" UUID NOT NULL,
  "proposalId" UUID NOT NULL,
  "ownerUserId" TEXT NOT NULL,
  -- Sceau du contenu (sha-256 hexadécimal minuscule) : LE MÊME que celui inscrit dans le run
  -- par `stage_proposal` (computeCustomerContactFieldsDigest, @bob/core). La relecture le
  -- RECALCULE depuis le contenu ; un écart rend le payload absent (greffe G4).
  "fieldsDigest" CHAR(64) NOT NULL,
  -- Sceau du sous-ensemble SENSIBLE (§9.1 : TVA, canal de facturation, adresse, destinataire) —
  -- garde de staleness du confirm. Stocké pour que la ligne soit auto-descriptive, recalculé
  -- comme le précédent à la relecture.
  "sensitiveDigest" CHAR(64) NOT NULL,
  -- Contenu PII canonique, immuable et chiffrable : la colonne ne transporte qu'un objet JSON
  -- opaque pour la base — aucune requête métier ne l'indexe, aucun index ne l'expose, et un
  -- futur enveloppement chiffré (§5.5) reste une substitution de contenu, pas de schéma.
  "payload" JSONB NOT NULL,
  "createdAt" TIMESTAMPTZ(6) NOT NULL,
  -- Échéance PORTÉE PAR LA LIGNE et alignée sur celle de son run (§5.5) : la purge balaye ce
  -- qui est échu, elle ne rejoue jamais une politique — un changement de politique n'a donc
  -- aucun effet rétroactif sur du PII déjà écrit.
  "retentionExpiresAt" TIMESTAMPTZ(6) NOT NULL,
  CONSTRAINT jarvis_proposal_payloads_pkey PRIMARY KEY ("companyId", "runId", "proposalId"),
  CONSTRAINT jarvis_proposal_payloads_company_fkey
    FOREIGN KEY ("companyId") REFERENCES public.companies("id")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  -- FK composite : un payload ne pointe JAMAIS le run d'un autre propriétaire, même en cas de
  -- défaut applicatif. ÉCART ASSUMÉ vs jarvis_work_items (RESTRICT) : ici CASCADE, parce qu'un
  -- magasin PII ne survit jamais à son run — la purge de rétention du run emporte ses payloads
  -- et aucune ligne de PII ne peut rester orpheline. La doctrine « le run ne disparaît pas sous
  -- ses effets » reste tenue par la rétention du run lui-même : un run vivant n'est pas purgé.
  CONSTRAINT jarvis_proposal_payloads_run_fkey
    FOREIGN KEY ("runId", "companyId", "ownerUserId")
    REFERENCES public.agent_missions ("id", "companyId", "ownerUserId")
    ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT jarvis_proposal_payloads_owner_identifier_check CHECK (
    length("ownerUserId") BETWEEN 1 AND 200
    AND "ownerUserId" = btrim("ownerUserId")
    AND "ownerUserId" !~ '[[:cntrl:]]'
  ),
  CONSTRAINT jarvis_proposal_payloads_fields_digest_check
    CHECK ("fieldsDigest" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT jarvis_proposal_payloads_sensitive_digest_check
    CHECK ("sensitiveDigest" ~ '^[0-9a-f]{64}$'),
  -- Racine objet : un scalaire ou un tableau ne se relit pas en champs proposés.
  CONSTRAINT jarvis_proposal_payloads_payload_shape_check
    CHECK (jsonb_typeof("payload") = 'object'),
  -- Une rétention déjà échue à l'écriture serait un magasin qui ment sur sa durée de vie.
  CONSTRAINT jarvis_proposal_payloads_retention_check
    CHECK ("retentionExpiresAt" > "createdAt")
);

-- Purge de rétention (§5.5) : balayage par tenant, ordonné par échéance — l'index sert la
-- purge, jamais une lecture métier.
CREATE INDEX jarvis_proposal_payloads_retention_idx
  ON public.jarvis_proposal_payloads ("companyId", "retentionExpiresAt");
-- Effacement en cascade applicative d'un run (rétention anticipée, clôture de société).
CREATE INDEX jarvis_proposal_payloads_run_idx
  ON public.jarvis_proposal_payloads ("runId");

ALTER TABLE public.jarvis_proposal_payloads ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.jarvis_proposal_payloads FORCE ROW LEVEL SECURITY;

CREATE POLICY jarvis_proposal_payloads_owner_select
  ON public.jarvis_proposal_payloads FOR SELECT
  USING (
    "companyId" = current_setting('app.current_company_id', true)
    AND "ownerUserId" = nullif(current_setting('app.current_user_id', true), '')
  );

-- L'écriture est épinglée au run courant, exactement comme jarvis_work_items : un payload ne
-- peut naître que dans la transaction qui travaille CE run.
CREATE POLICY jarvis_proposal_payloads_owner_insert
  ON public.jarvis_proposal_payloads FOR INSERT
  WITH CHECK (
    "companyId" = current_setting('app.current_company_id', true)
    AND "ownerUserId" = nullif(current_setting('app.current_user_id', true), '')
    AND "runId"::text = nullif(current_setting('app.current_agent_mission_id', true), '')
  );

-- AUCUNE policy UPDATE, volontairement : un payload scellé est IMMUABLE. Une correction est
-- une nouvelle proposition (nouveau proposalId, nouveau sceau), jamais une réécriture — sans
-- quoi le digest inscrit dans le run cesserait de prouver quoi que ce soit.

-- DELETE borné à la RÉTENTION ÉCHUE, sous les MÊMES GUC owner-scopés que la lecture : le droit
-- d'effacer n'existe que pour du PII périmé, et jamais celui d'un autre propriétaire. Une ligne
-- vivante reste indestructible par l'applicatif — c'est la contrepartie exacte du droit
-- d'effacement d'un magasin PII (§5.5). Rien n'élargit la VISIBILITÉ : le balayage voit ce que
-- son propriétaire voit, ni plus ni moins.
CREATE POLICY jarvis_proposal_payloads_retention_delete
  ON public.jarvis_proposal_payloads FOR DELETE
  USING (
    "companyId" = current_setting('app.current_company_id', true)
    AND "ownerUserId" = nullif(current_setting('app.current_user_id', true), '')
    AND "retentionExpiresAt" <= statement_timestamp()
  );

GRANT SELECT, INSERT, DELETE ON public.jarvis_proposal_payloads TO bob_app;

COMMIT;
