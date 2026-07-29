-- M2-A-0 — fondation durable des lignes de devis AgentMission.
-- Feature flag OFF : cette migration ne crée aucun writer applicatif.

BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

-- Supabase : le déployeur n'est pas superuser. Toute création/modification d'objet protégé est
-- exécutée sous le propriétaire exact, sans GRANT d'adhésion explicite au déployeur.
DO $bob_agent_mission_m2a_owner$
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
        MESSAGE = 'AGENT_MISSION_M2A_SCHEMA_OWNER_UNAVAILABLE';
    END IF;
    EXECUTE pg_catalog.format('SET LOCAL ROLE %I', schema_owner_name);
  END IF;

  IF current_user::pg_catalog.regrole <> schema_owner_oid THEN
    RAISE EXCEPTION USING
      ERRCODE = '42501',
      MESSAGE = 'AGENT_MISSION_M2A_SCHEMA_OWNER_NOT_ASSUMED';
  END IF;
END;
$bob_agent_mission_m2a_owner$;

CREATE TABLE public.agent_mission_quote_line_work (
  "id" UUID NOT NULL,
  "companyId" TEXT NOT NULL,
  "ownerUserId" TEXT NOT NULL,
  "missionId" UUID NOT NULL,
  "ordinal" SMALLINT NOT NULL,
  "revision" INTEGER NOT NULL,
  "state" TEXT NOT NULL,
  "origin" TEXT NOT NULL,
  "serviceReference" TEXT,
  "category" "LineCategory",
  "quantityMilli" BIGINT,
  "unit" TEXT,
  "unitPriceCents" INTEGER,
  "requestedVatRate" DECIMAL(4,2),
  "priceBasis" TEXT,
  "housingOlderThan2y" BOOLEAN,
  "energyRenovation" BOOLEAN,
  "requiredFact" TEXT,
  "catalogueItemId" TEXT,
  "expectedCatalogueRevision" INTEGER,
  "proposalId" UUID,
  "proposalRevision" INTEGER,
  "proposalDiffHash" CHAR(64),
  "createdAt" TIMESTAMPTZ(6) NOT NULL,
  "updatedAt" TIMESTAMPTZ(6) NOT NULL,
  CONSTRAINT agent_mission_quote_line_work_pkey PRIMARY KEY ("id"),
  CONSTRAINT agent_mission_quote_line_work_mission_owner_fkey
    FOREIGN KEY ("missionId", "companyId", "ownerUserId")
    REFERENCES public.agent_missions("id", "companyId", "ownerUserId")
    ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT agent_mission_quote_line_work_mission_ordinal_key
    UNIQUE ("missionId", "ordinal"),
  CONSTRAINT agent_mission_quote_line_work_ordinal_check
    CHECK ("ordinal" BETWEEN 1 AND 20),
  CONSTRAINT agent_mission_quote_line_work_revision_check
    CHECK ("revision" BETWEEN 1 AND 2147483647),
  CONSTRAINT agent_mission_quote_line_work_state_check
    CHECK ("state" IN (
      -- BEGIN GENERATED AGENT_MISSION_QUOTE_LINE_WORK_STATES
      'queued',
      'awaiting_catalogue_choice',
      'awaiting_details',
      'awaiting_confirmation'
      -- END GENERATED AGENT_MISSION_QUOTE_LINE_WORK_STATES
    )),
  CONSTRAINT agent_mission_quote_line_work_origin_check
    CHECK ("origin" IN (
      -- BEGIN GENERATED AGENT_MISSION_QUOTE_LINE_WORK_ORIGINS
      'user_voice',
      'user_tap'
      -- END GENERATED AGENT_MISSION_QUOTE_LINE_WORK_ORIGINS
    )),
  CONSTRAINT agent_mission_quote_line_work_service_reference_check
    CHECK (
      "serviceReference" IS NULL
      OR (
        char_length("serviceReference") BETWEEN 1 AND 500
        AND "serviceReference" = btrim("serviceReference")
        AND "serviceReference" !~ '[[:cntrl:]]'
      )
    ),
  CONSTRAINT agent_mission_quote_line_work_category_check
    CHECK (
      "category" IS NULL
      OR "category"::TEXT IN (
        -- BEGIN GENERATED AGENT_MISSION_QUOTE_LINE_CATEGORIES
        'labor',
        'supply',
        'travel',
        'subscription'
        -- END GENERATED AGENT_MISSION_QUOTE_LINE_CATEGORIES
      )
    ),
  CONSTRAINT agent_mission_quote_line_work_quantity_check
    CHECK ("quantityMilli" IS NULL OR "quantityMilli" BETWEEN 1 AND 1500000000000),
  CONSTRAINT agent_mission_quote_line_work_unit_check
    CHECK (
      "unit" IS NULL
      OR (
        char_length("unit") BETWEEN 1 AND 40
        AND "unit" = btrim("unit")
        AND "unit" !~ '[[:cntrl:]]'
      )
    ),
  CONSTRAINT agent_mission_quote_line_work_price_check
    CHECK ("unitPriceCents" IS NULL OR "unitPriceCents" BETWEEN 1 AND 1500000000),
  CONSTRAINT agent_mission_quote_line_work_vat_check
    CHECK (
      "requestedVatRate" IS NULL
      OR "requestedVatRate" IN (
        -- BEGIN GENERATED AGENT_MISSION_QUOTE_LINE_VAT_RATES
        0,
        2.1,
        5.5,
        10,
        20
        -- END GENERATED AGENT_MISSION_QUOTE_LINE_VAT_RATES
      )
    ),
  CONSTRAINT agent_mission_quote_line_work_price_basis_check
    CHECK (
      "priceBasis" IS NULL
      OR "priceBasis" IN (
        -- BEGIN GENERATED AGENT_MISSION_QUOTE_LINE_PRICE_BASES
        'per_unit',
        'total'
        -- END GENERATED AGENT_MISSION_QUOTE_LINE_PRICE_BASES
      )
    ),
  CONSTRAINT agent_mission_quote_line_work_required_fact_check
    CHECK (
      "requiredFact" IS NULL
      OR "requiredFact" IN (
        -- BEGIN GENERATED AGENT_MISSION_QUOTE_LINE_REQUIRED_FACTS
        'service_reference',
        'category',
        'quantity',
        'unit',
        'unit_price',
        'vat_rate',
        'housing_older_than_2y',
        'energy_renovation'
        -- END GENERATED AGENT_MISSION_QUOTE_LINE_REQUIRED_FACTS
      )
    ),
  CONSTRAINT agent_mission_quote_line_work_catalogue_fence_check
    CHECK (("catalogueItemId" IS NULL) = ("expectedCatalogueRevision" IS NULL)),
  CONSTRAINT agent_mission_quote_line_work_catalogue_id_check
    CHECK (
      "catalogueItemId" IS NULL
      OR (
        char_length("catalogueItemId") BETWEEN 1 AND 128
        AND "catalogueItemId" ~ '^[A-Za-z0-9-]+$'
      )
    ),
  CONSTRAINT agent_mission_quote_line_work_catalogue_revision_check
    CHECK (
      "expectedCatalogueRevision" IS NULL
      OR "expectedCatalogueRevision" BETWEEN 1 AND 2147483647
    ),
  CONSTRAINT agent_mission_quote_line_work_price_pair_check
    CHECK (("unitPriceCents" IS NULL) = ("priceBasis" IS NULL)),
  CONSTRAINT agent_mission_quote_line_work_proposal_check
    CHECK (
      (
        "proposalId" IS NULL
        AND "proposalRevision" IS NULL
        AND "proposalDiffHash" IS NULL
      )
      OR (
        "proposalId" IS NOT NULL
        AND "proposalRevision" IS NOT NULL
        AND "proposalDiffHash" IS NOT NULL
        AND "proposalRevision" = 1
        AND "proposalDiffHash" ~ '^[a-f0-9]{64}$'
      )
    ),
  CONSTRAINT agent_mission_quote_line_work_state_coherence_check
    CHECK (
      (
        "state" = 'queued'
        AND "requiredFact" IS NULL
        AND "catalogueItemId" IS NULL
        AND "expectedCatalogueRevision" IS NULL
        AND "proposalId" IS NULL
      )
      OR (
        "state" = 'awaiting_catalogue_choice'
        AND "serviceReference" IS NOT NULL
        AND "requiredFact" IS NULL
        AND "catalogueItemId" IS NULL
        AND "expectedCatalogueRevision" IS NULL
        AND "proposalId" IS NULL
      )
      OR (
        "state" = 'awaiting_details'
        AND "requiredFact" IS NOT NULL
        AND "proposalId" IS NULL
      )
      OR (
        "state" = 'awaiting_confirmation'
        AND "serviceReference" IS NOT NULL
        AND "category" IS NOT NULL
        AND "quantityMilli" IS NOT NULL
        AND "unit" IS NOT NULL
        AND "unitPriceCents" IS NOT NULL
        AND "requestedVatRate" IS NOT NULL
        AND "priceBasis" IS NOT NULL
        AND "requiredFact" IS NULL
        AND "proposalId" IS NOT NULL
      )
    ),
  CONSTRAINT agent_mission_quote_line_work_timestamps_check
    CHECK (
      isfinite("createdAt")
      AND isfinite("updatedAt")
      AND "updatedAt" >= "createdAt"
    )
);

CREATE INDEX agent_mission_quote_line_work_owner_queue_idx
  ON public.agent_mission_quote_line_work (
    "companyId",
    "ownerUserId",
    "missionId",
    "ordinal"
  );

CREATE FUNCTION public.guard_agent_mission_quote_line_work_v1()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  row_value public.agent_mission_quote_line_work;
  expected_mission_id TEXT :=
    nullif(current_setting('app.current_agent_mission_id', true), '');
BEGIN
  -- Uniquement la cascade FK de purge de la mission peut supprimer sans capability courante.
  IF TG_OP = 'DELETE' AND pg_trigger_depth() > 1 THEN
    RETURN OLD;
  END IF;

  row_value := CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;

  IF expected_mission_id IS NULL
     OR expected_mission_id <> row_value."missionId"::TEXT THEN
    RAISE EXCEPTION 'AGENT_MISSION_QUOTE_LINE_CAPABILITY_REQUIRED'
      USING ERRCODE = '42501';
  END IF;

  IF TG_OP = 'UPDATE' AND (
    OLD."id" IS DISTINCT FROM NEW."id"
    OR OLD."companyId" IS DISTINCT FROM NEW."companyId"
    OR OLD."ownerUserId" IS DISTINCT FROM NEW."ownerUserId"
    OR OLD."missionId" IS DISTINCT FROM NEW."missionId"
    OR OLD."ordinal" IS DISTINCT FROM NEW."ordinal"
    OR OLD."createdAt" IS DISTINCT FROM NEW."createdAt"
    OR NEW."revision" <> OLD."revision" + 1
  ) THEN
    RAISE EXCEPTION 'AGENT_MISSION_QUOTE_LINE_IDENTITY_OR_REVISION_INVALID'
      USING ERRCODE = '23514';
  END IF;

  IF NOT EXISTS (
    SELECT 1
      FROM public.agent_missions AS mission
     WHERE mission."id" = row_value."missionId"
       AND mission."companyId" = row_value."companyId"
       AND mission."ownerUserId" = row_value."ownerUserId"
       AND mission."kind" = 'quote_creation'
       AND mission."status" = 'active'
  ) THEN
    RAISE EXCEPTION 'AGENT_MISSION_QUOTE_LINE_ACTIVE_PARENT_REQUIRED'
      USING ERRCODE = '23503';
  END IF;

  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END;
$$;

CREATE TRIGGER agent_mission_quote_line_work_guard_v1
BEFORE INSERT OR UPDATE OR DELETE ON public.agent_mission_quote_line_work
FOR EACH ROW EXECUTE FUNCTION public.guard_agent_mission_quote_line_work_v1();

ALTER TABLE public.agent_mission_quote_line_work ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.agent_mission_quote_line_work FORCE ROW LEVEL SECURITY;

CREATE POLICY agent_mission_quote_line_work_owner_select
  ON public.agent_mission_quote_line_work
  FOR SELECT
  USING (
    "companyId" = current_setting('app.current_company_id', true)
    AND "ownerUserId" = nullif(current_setting('app.current_user_id', true), '')
  );

CREATE POLICY agent_mission_quote_line_work_owner_insert
  ON public.agent_mission_quote_line_work
  FOR INSERT
  WITH CHECK (
    "companyId" = current_setting('app.current_company_id', true)
    AND "ownerUserId" = nullif(current_setting('app.current_user_id', true), '')
    AND "missionId"::TEXT =
      nullif(current_setting('app.current_agent_mission_id', true), '')
  );

CREATE POLICY agent_mission_quote_line_work_owner_update
  ON public.agent_mission_quote_line_work
  FOR UPDATE
  USING (
    "companyId" = current_setting('app.current_company_id', true)
    AND "ownerUserId" = nullif(current_setting('app.current_user_id', true), '')
    AND "missionId"::TEXT =
      nullif(current_setting('app.current_agent_mission_id', true), '')
  )
  WITH CHECK (
    "companyId" = current_setting('app.current_company_id', true)
    AND "ownerUserId" = nullif(current_setting('app.current_user_id', true), '')
    AND "missionId"::TEXT =
      nullif(current_setting('app.current_agent_mission_id', true), '')
  );

CREATE POLICY agent_mission_quote_line_work_owner_delete
  ON public.agent_mission_quote_line_work
  FOR DELETE
  USING (
    "companyId" = current_setting('app.current_company_id', true)
    AND "ownerUserId" = nullif(current_setting('app.current_user_id', true), '')
    AND "missionId"::TEXT =
      nullif(current_setting('app.current_agent_mission_id', true), '')
  );

REVOKE ALL ON TABLE public.agent_mission_quote_line_work FROM PUBLIC;
REVOKE ALL ON FUNCTION public.guard_agent_mission_quote_line_work_v1() FROM PUBLIC;

DO $bob_agent_mission_m2a_data_api_revoke$
DECLARE
  exposed_role TEXT;
BEGIN
  FOREACH exposed_role IN ARRAY ARRAY['anon', 'authenticated', 'service_role']::TEXT[] LOOP
    IF pg_catalog.to_regrole(exposed_role) IS NOT NULL THEN
      EXECUTE pg_catalog.format(
        'REVOKE ALL PRIVILEGES ON TABLE public.agent_mission_quote_line_work FROM %I',
        exposed_role
      );
      EXECUTE pg_catalog.format(
        'REVOKE ALL PRIVILEGES ON FUNCTION public.guard_agent_mission_quote_line_work_v1() FROM %I',
        exposed_role
      );
    END IF;
  END LOOP;
END;
$bob_agent_mission_m2a_data_api_revoke$;

COMMENT ON TABLE public.agent_mission_quote_line_work IS
  'M2-A: faits normalisés de ligne en attente. Aucun transcript/prompt/snapshot catalogue.';

-- Le catalogue peut appartenir à un autre rôle de schéma sur un environnement existant.
RESET ROLE;

DO $bob_catalogue_m2a_owner$
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
     AND relation.relname = 'catalogue_prestations'
     AND relation.relkind IN ('r', 'p');

  IF current_user::pg_catalog.regrole <> schema_owner_oid THEN
    IF schema_owner_name IS NULL
       OR NOT pg_catalog.pg_has_role(session_user, schema_owner_oid, 'SET') THEN
      RAISE EXCEPTION USING
        ERRCODE = '42501',
        MESSAGE = 'CATALOGUE_M2A_SCHEMA_OWNER_UNAVAILABLE';
    END IF;
    EXECUTE pg_catalog.format('SET LOCAL ROLE %I', schema_owner_name);
  END IF;

  IF current_user::pg_catalog.regrole <> schema_owner_oid THEN
    RAISE EXCEPTION USING
      ERRCODE = '42501',
      MESSAGE = 'CATALOGUE_M2A_SCHEMA_OWNER_NOT_ASSUMED';
  END IF;
END;
$bob_catalogue_m2a_owner$;

ALTER TABLE public.catalogue_prestations
  ADD COLUMN "searchKey" TEXT GENERATED ALWAYS AS (
    pg_catalog.btrim(
      pg_catalog.regexp_replace(
        pg_catalog.lower(
          pg_catalog.translate(
            -- BEGIN GENERATED CATALOGUE_SEARCH_EXPANSION_EXPRESSION
            pg_catalog.replace(pg_catalog.replace(pg_catalog.replace(pg_catalog.replace(pg_catalog.replace(pg_catalog.replace(pg_catalog.replace(pg_catalog.replace(pg_catalog.replace(pg_catalog.replace(pg_catalog.replace(pg_catalog.replace(pg_catalog.replace(pg_catalog.replace(pg_catalog.replace(pg_catalog.replace(pg_catalog.replace(pg_catalog.replace(pg_catalog.replace(pg_catalog.replace(pg_catalog.replace(pg_catalog.replace(pg_catalog.replace(pg_catalog.replace(pg_catalog.replace(pg_catalog.replace("label", 'Å', 'a'), 'Œ', 'oe'), 'œ', 'oe'), 'Æ', 'ae'), 'æ', 'ae'), 'ẞ', 'ss'), 'ß', 'ss'), 'Þ', 'th'), 'þ', 'th'), 'Ð', 'd'), 'ð', 'd'), 'Đ', 'd'), 'đ', 'd'), 'Ł', 'l'), 'ł', 'l'), 'Ø', 'o'), 'ø', 'o'), 'Ħ', 'h'), 'ħ', 'h'), 'ı', 'i'), 'Ŋ', 'n'), 'ŋ', 'n'), 'Ŧ', 't'), 'ŧ', 't'), 'Ə', 'e'), 'ə', 'e')
            -- END GENERATED CATALOGUE_SEARCH_EXPANSION_EXPRESSION
            ,
            -- BEGIN GENERATED CATALOGUE_SEARCH_TRANSLITERATION_SOURCE
            'ÀÁÂÃÄÅÇÈÉÊËÌÍÎÏÑÒÓÔÕÖÙÚÛÜÝàáâãäåçèéêëìíîïñòóôõöùúûüýÿĀāĂăĄąĆćĈĉĊċČčĎďĒēĔĕĖėĘęĚěĜĝĞğĠġĢģĤĥĨĩĪīĬĭĮįİĴĵĶķĹĺĻļĽľŃńŅņŇňŌōŎŏŐőŔŕŖŗŘřŚśŜŝŞşŠšŢţŤťŨũŪūŬŭŮůŰűŲųŴŵŶŷŸŹźŻżŽžƠơƯưǍǎǏǐǑǒǓǔǕǖǗǘǙǚǛǜǞǟǠǡǦǧǨǩǪǫǬǭǰǴǵǸǹǺǻȀȁȂȃȄȅȆȇȈȉȊȋȌȍȎȏȐȑȒȓȔȕȖȗȘșȚțȞȟȦȧȨȩȪȫȬȭȮȯȰȱȲȳḀḁḂḃḄḅḆḇḈḉḊḋḌḍḎḏḐḑḒḓḔḕḖḗḘḙḚḛḜḝḞḟḠḡḢḣḤḥḦḧḨḩḪḫḬḭḮḯḰḱḲḳḴḵḶḷḸḹḺḻḼḽḾḿṀṁṂṃṄṅṆṇṈṉṊṋṌṍṎṏṐṑṒṓṔṕṖṗṘṙṚṛṜṝṞṟṠṡṢṣṤṥṦṧṨṩṪṫṬṭṮṯṰṱṲṳṴṵṶṷṸṹṺṻṼṽṾṿẀẁẂẃẄẅẆẇẈẉẊẋẌẍẎẏẐẑẒẓẔẕẖẗẘẙẠạẢảẤấẦầẨẩẪẫẬậẮắẰằẲẳẴẵẶặẸẹẺẻẼẽẾếỀềỂểỄễỆệỈỉỊịỌọỎỏỐốỒồỔổỖỗỘộỚớỜờỞởỠỡỢợỤụỦủỨứỪừỬửỮữỰựỲỳỴỵỶỷỸỹ̴̵̶̷̸̡̢̧̨̛̖̗̘̙̜̝̞̟̠̣̤̥̦̩̪̫̬̭̮̯̰̱̲̳̹̺̻̼͇͈͉͍͎̀́̂̃̄̅̆̇̈̉̊̋̌̍̎̏̐̑̒̓̔̽̾̿̀́͂̓̈́͆͊͋͌̕̚ͅ͏͓͔͕͖͙͚᪵᪶᪷᪸᪹᪺᪽͐͑͒͗͛ͣͤͥͦͧͨͩͪͫͬͭͮͯ᪰᪱᪲᪳᪴᪻᪼͘͜͟͢͝͞͠͡᪾ᪿᫀ᫃᫄᫊᫁᫂᫅᫆᫇᫈᫉᫋ᫌᫍᫎ᫏᫐᫑᫒᫓᫔᫕᫖᫗᫘᫙᫚᫛᫜᫝᫞᫟᫠᫡᫢᫣᫤᫥᫦᫧᫨᫩᫪᫫᫬᫭᫮᫯᫰᫱᫲᫳᫴᫵᫶᫷᫸᫹᫺᫻᫼᫽᫾᫿⃒⃓⃘⃙⃚᷐᷎᷺᷂᷊᷏᷹᷽᷿᷷᷸᷀᷁᷃᷄᷅᷆᷇᷈᷉᷋᷌᷑᷒ᷓᷔᷕᷖᷗᷘᷙᷚᷛᷜᷝᷞᷟᷠᷡᷢᷣᷤᷥᷦᷧᷨᷩᷪᷫᷬᷭᷮᷯᷰᷱᷲᷳᷴ᷵᷻᷾⃐⃑⃔⃕⃖⃗⃛⃜᷶᷼᷍⃝⃞⃟⃠⃡⃢⃣⃤⃥⃦⃪⃫⃨⃬⃭⃮⃯⃧⃩⃰⃱⃲⃳⃴⃵⃶⃷⃸⃹⃺⃻⃼⃽⃾⃿︧︨︩︪︫︬︭︠︡︢︣︤︥︦︮︯'
            -- END GENERATED CATALOGUE_SEARCH_TRANSLITERATION_SOURCE
            ,
            -- BEGIN GENERATED CATALOGUE_SEARCH_TRANSLITERATION_TARGET
            'AAAAAACEEEEIIIINOOOOOUUUUYaaaaaaceeeeiiiinooooouuuuyyAaAaAaCcCcCcCcDdEeEeEeEeEeGgGgGgGgHhIiIiIiIiIJjKkLlLlLlNnNnNnOoOoOoRrRrRrSsSsSsSsTtTtUuUuUuUuUuUuWwYyYZzZzZzOoUuAaIiOoUuUuUuUuUuAaAaGgKkOoOojGgNnAaAaAaEeEeIiIiOoOoRrRrUuUuSsTtHhAaEeOoOoOoOoYyAaBbBbBbCcDdDdDdDdDdEeEeEeEeEeFfGgHhHhHhHhHhIiIiKkKkKkLlLlLlLlMmMmMmNnNnNnNnOoOoOoOoPpPpRrRrRrRrSsSsSsSsSsTtTtTtTtUuUuUuUuUuVvVvWwWwWwWwWwXxXxYyZzZzZzhtwyAaAaAaAaAaAaAaAaAaAaAaAaEeEeEeEeEeEeEeEeIiIiOoOoOoOoOoOoOoOoOoOoOoOoUuUuUuUuUuUuUuYyYyYyYy'
            -- END GENERATED CATALOGUE_SEARCH_TRANSLITERATION_TARGET
          )
        ),
        '[^a-z0-9]+',
        ' ',
        'g'
      )
    )
  ) STORED;

CREATE INDEX catalogue_prestations_company_search_prefix_idx
  ON public.catalogue_prestations (
    "companyId",
    "searchKey" pg_catalog.text_pattern_ops,
    "id"
  );

CREATE INDEX catalogue_prestations_search_tokens_idx
  ON public.catalogue_prestations
  USING GIN (pg_catalog.to_tsvector('simple'::pg_catalog.regconfig, "searchKey"));

-- Les anciennes contraintes restent actives pendant expand/validate : writer N-1 inchangé.
ALTER TABLE public.catalogue_prestations
  ADD CONSTRAINT catalogue_prestations_category_check_m2a
    CHECK ("category"::TEXT IN (
      -- BEGIN GENERATED CATALOGUE_PRESTATION_CATEGORIES
      'labor',
      'supply',
      'travel',
      'subscription'
      -- END GENERATED CATALOGUE_PRESTATION_CATEGORIES
    )) NOT VALID,
  ADD CONSTRAINT catalogue_prestations_vat_check_m2a
    CHECK ("vatRate" IN (
      -- BEGIN GENERATED CATALOGUE_PRESTATION_VAT_RATES
      0,
      2.1,
      5.5,
      10,
      20
      -- END GENERATED CATALOGUE_PRESTATION_VAT_RATES
    )) NOT VALID;

RESET ROLE;

COMMIT;
