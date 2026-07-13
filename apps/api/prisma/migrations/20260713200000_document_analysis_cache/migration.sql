-- Cache d'analyse documentaire append-only, strictement lié au tenant ET à la version
-- binaire analysée. Les contraintes composites sont volontairement redondantes avec les clés
-- existantes : elles empêchent un cache de pointer vers un autre tenant ou un autre original.
ALTER TABLE "documents"
  ADD CONSTRAINT "uniq_stored_document_company_id" UNIQUE ("companyId", "id");

ALTER TABLE "document_versions"
  ADD CONSTRAINT "uniq_document_version_source"
  UNIQUE ("documentId", "version", "sha256");

-- Contrat persistant V1. Le domaine TypeScript reste responsable de la normalisation métier ;
-- ce validateur PostgreSQL constitue une dernière barrière fail-closed contre les JSON tronqués,
-- incohérents ou injectés hors du chemin applicatif normal. Une évolution incompatible doit créer
-- is_valid_document_analysis_v2 et incrémenter analysisSchemaVersion, jamais modifier V1 en place.
CREATE FUNCTION is_valid_document_analysis_v1(
  candidate JSONB,
  expected_document_id TEXT,
  expected_document_version INTEGER,
  expected_source_sha256 TEXT,
  expected_analyzer_version TEXT,
  expected_analyzed_at TIMESTAMPTZ
)
RETURNS BOOLEAN
LANGUAGE plpgsql
IMMUTABLE
STRICT
SET search_path = pg_catalog
SET datestyle = 'ISO, YMD'
SET timezone = 'UTC'
AS $$
DECLARE
  key_count INTEGER;
  fact_count INTEGER;
  fact JSONB;
  provenance JSONB;
  evidence JSONB;
  bounding_box JSONB;
  dependency JSONB;
  tag JSONB;
  warning JSONB;
  fact_key TEXT;
  value_type TEXT;
  source_type TEXT;
  expected_folder TEXT;
  numeric_value NUMERIC;
  has_grounding BOOLEAN;
  has_low_confidence BOOLEAN := FALSE;
  all_fact_keys TEXT[] := ARRAY[]::TEXT[];
  derived_keys TEXT[];
  tags_seen TEXT[] := ARRAY[]::TEXT[];
  warnings_seen TEXT[] := ARRAY[]::TEXT[];
BEGIN
  IF jsonb_typeof(candidate) IS DISTINCT FROM 'object' THEN
    RETURN FALSE;
  END IF;
  SELECT count(*) INTO key_count FROM jsonb_object_keys(candidate);
  IF key_count <> 14 OR NOT (candidate ?& ARRAY[
    'documentId', 'documentVersion', 'sourceSha256', 'type', 'typeConfidence', 'summary',
    'facts', 'suggestedTags', 'suggestedFilename', 'suggestedSystemFolder', 'warnings',
    'requiresHumanReview', 'analyzerVersion', 'analyzedAt'
  ]) THEN
    RETURN FALSE;
  END IF;

  IF jsonb_typeof(candidate -> 'documentId') IS DISTINCT FROM 'string'
     OR candidate ->> 'documentId' IS DISTINCT FROM expected_document_id
     OR jsonb_typeof(candidate -> 'documentVersion') IS DISTINCT FROM 'number'
     OR (candidate ->> 'documentVersion')::NUMERIC <> expected_document_version
     OR mod((candidate ->> 'documentVersion')::NUMERIC, 1) <> 0
     OR jsonb_typeof(candidate -> 'sourceSha256') IS DISTINCT FROM 'string'
     OR candidate ->> 'sourceSha256' IS DISTINCT FROM expected_source_sha256
     OR candidate ->> 'sourceSha256' !~ '^[a-f0-9]{64}$'
     OR jsonb_typeof(candidate -> 'analyzerVersion') IS DISTINCT FROM 'string'
     OR candidate ->> 'analyzerVersion' IS DISTINCT FROM expected_analyzer_version
     OR length(candidate ->> 'analyzerVersion') NOT BETWEEN 1 AND 120
     OR btrim(candidate ->> 'analyzerVersion') IS DISTINCT FROM candidate ->> 'analyzerVersion'
     OR candidate ->> 'analyzerVersion' ~ '[[:cntrl:]]' THEN
    RETURN FALSE;
  END IF;

  IF jsonb_typeof(candidate -> 'analyzedAt') IS DISTINCT FROM 'string'
     OR candidate ->> 'analyzedAt' !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$' THEN
    RETURN FALSE;
  END IF;
  BEGIN
    IF (candidate ->> 'analyzedAt')::TIMESTAMPTZ IS DISTINCT FROM expected_analyzed_at THEN
      RETURN FALSE;
    END IF;
  EXCEPTION WHEN OTHERS THEN
    RETURN FALSE;
  END;

  IF jsonb_typeof(candidate -> 'type') IS DISTINCT FROM 'string'
     OR NOT (candidate ->> 'type' = ANY (ARRAY[
       'supplier_invoice', 'receipt', 'bank_statement', 'insurance_certificate',
       'tax_or_social_document', 'contract', 'company_record', 'chantier_photo',
       'accounting_document', 'other'
     ]))
     OR jsonb_typeof(candidate -> 'typeConfidence') IS DISTINCT FROM 'number' THEN
    RETURN FALSE;
  END IF;
  numeric_value := (candidate ->> 'typeConfidence')::NUMERIC;
  IF numeric_value < 0 OR numeric_value > 1 THEN
    RETURN FALSE;
  END IF;

  IF jsonb_typeof(candidate -> 'summary') IS DISTINCT FROM 'string'
     OR length(candidate ->> 'summary') NOT BETWEEN 1 AND 800
     OR btrim(candidate ->> 'summary') IS DISTINCT FROM candidate ->> 'summary'
     OR candidate ->> 'summary' ~ '[[:cntrl:]]' THEN
    RETURN FALSE;
  END IF;

  IF jsonb_typeof(candidate -> 'facts') IS DISTINCT FROM 'array' THEN
    RETURN FALSE;
  END IF;
  fact_count := jsonb_array_length(candidate -> 'facts');
  IF fact_count > 32 THEN
    RETURN FALSE;
  END IF;

  FOR fact IN SELECT value FROM jsonb_array_elements(candidate -> 'facts') LOOP
    IF jsonb_typeof(fact) IS DISTINCT FROM 'object' THEN
      RETURN FALSE;
    END IF;
    SELECT count(*) INTO key_count FROM jsonb_object_keys(fact);
    IF key_count <> 5 OR NOT (fact ?& ARRAY['key', 'valueType', 'value', 'confidence', 'provenance'])
       OR jsonb_typeof(fact -> 'key') IS DISTINCT FROM 'string'
       OR jsonb_typeof(fact -> 'valueType') IS DISTINCT FROM 'string'
       OR jsonb_typeof(fact -> 'confidence') IS DISTINCT FROM 'number'
       OR jsonb_typeof(fact -> 'provenance') IS DISTINCT FROM 'object' THEN
      RETURN FALSE;
    END IF;

    fact_key := fact ->> 'key';
    value_type := fact ->> 'valueType';
    IF NOT (fact_key = ANY (ARRAY[
      'issuer_name', 'recipient_name', 'supplier_name', 'customer_name', 'company_name',
      'document_number', 'contract_number', 'policy_number', 'bank_name', 'account_reference',
      'iban_masked', 'siren', 'siret', 'fiscal_period', 'subject', 'chantier_name',
      'document_date', 'due_date', 'period_start', 'period_end', 'coverage_start',
      'coverage_end', 'expiry_date', 'total_ht', 'vat_amount', 'total_ttc', 'amount_due',
      'account_balance', 'tax_amount', 'vat_rate'
    ])) OR fact_key = ANY (all_fact_keys) THEN
      RETURN FALSE;
    END IF;
    all_fact_keys := array_append(all_fact_keys, fact_key);

    numeric_value := (fact ->> 'confidence')::NUMERIC;
    IF numeric_value < 0 OR numeric_value > 1 THEN
      RETURN FALSE;
    END IF;
    IF numeric_value < 0.5 THEN
      has_low_confidence := TRUE;
    END IF;

    IF fact_key = ANY (ARRAY[
      'issuer_name', 'recipient_name', 'supplier_name', 'customer_name', 'company_name',
      'document_number', 'contract_number', 'policy_number', 'bank_name', 'account_reference',
      'iban_masked', 'siren', 'siret', 'fiscal_period', 'subject', 'chantier_name'
    ]) THEN
      IF value_type IS DISTINCT FROM 'text'
         OR jsonb_typeof(fact -> 'value') IS DISTINCT FROM 'string'
         OR length(fact ->> 'value') NOT BETWEEN 1 AND
            (CASE WHEN fact_key = 'subject' THEN 500 ELSE 240 END)
         OR btrim(fact ->> 'value') IS DISTINCT FROM fact ->> 'value'
         OR fact ->> 'value' ~ '[[:cntrl:]]'
         OR (fact_key = 'siren' AND fact ->> 'value' !~ '^[0-9]{9}$')
         OR (fact_key = 'siret' AND fact ->> 'value' !~ '^[0-9]{14}$') THEN
        RETURN FALSE;
      END IF;
    ELSIF fact_key = ANY (ARRAY[
      'document_date', 'due_date', 'period_start', 'period_end', 'coverage_start',
      'coverage_end', 'expiry_date'
    ]) THEN
      IF value_type IS DISTINCT FROM 'date'
         OR jsonb_typeof(fact -> 'value') IS DISTINCT FROM 'string'
         OR fact ->> 'value' !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' THEN
        RETURN FALSE;
      END IF;
      BEGIN
        IF ((fact ->> 'value')::DATE)::TEXT IS DISTINCT FROM fact ->> 'value' THEN
          RETURN FALSE;
        END IF;
      EXCEPTION WHEN OTHERS THEN
        RETURN FALSE;
      END;
    ELSIF fact_key = ANY (ARRAY[
      'total_ht', 'vat_amount', 'total_ttc', 'amount_due', 'account_balance', 'tax_amount'
    ]) THEN
      IF value_type IS DISTINCT FROM 'money'
         OR jsonb_typeof(fact -> 'value') IS DISTINCT FROM 'object' THEN
        RETURN FALSE;
      END IF;
      SELECT count(*) INTO key_count FROM jsonb_object_keys(fact -> 'value');
      IF key_count <> 2 OR NOT ((fact -> 'value') ?& ARRAY['amountMinor', 'currency'])
         OR jsonb_typeof(fact -> 'value' -> 'amountMinor') IS DISTINCT FROM 'number'
         OR jsonb_typeof(fact -> 'value' -> 'currency') IS DISTINCT FROM 'string'
         OR fact -> 'value' ->> 'currency' !~ '^[A-Z]{3}$' THEN
        RETURN FALSE;
      END IF;
      numeric_value := (fact -> 'value' ->> 'amountMinor')::NUMERIC;
      IF mod(numeric_value, 1) <> 0 OR abs(numeric_value) > 100000000000000 THEN
        RETURN FALSE;
      END IF;
    ELSE
      IF fact_key IS DISTINCT FROM 'vat_rate'
         OR value_type IS DISTINCT FROM 'percentage'
         OR jsonb_typeof(fact -> 'value') IS DISTINCT FROM 'number' THEN
        RETURN FALSE;
      END IF;
      numeric_value := (fact ->> 'value')::NUMERIC;
      IF numeric_value < 0 OR numeric_value > 100 THEN
        RETURN FALSE;
      END IF;
    END IF;

    provenance := fact -> 'provenance';
    SELECT count(*) INTO key_count FROM jsonb_object_keys(provenance);
    IF key_count <> 4 OR NOT (provenance ?& ARRAY['source', 'evidence', 'derivedFrom', 'rule'])
       OR jsonb_typeof(provenance -> 'source') IS DISTINCT FROM 'string'
       OR jsonb_typeof(provenance -> 'evidence') IS DISTINCT FROM 'array'
       OR jsonb_typeof(provenance -> 'derivedFrom') IS DISTINCT FROM 'array'
       OR jsonb_array_length(provenance -> 'evidence') > 4 THEN
      RETURN FALSE;
    END IF;
    source_type := provenance ->> 'source';
    IF NOT (source_type = ANY (ARRAY['document_text', 'document_visual', 'derived'])) THEN
      RETURN FALSE;
    END IF;

    has_grounding := FALSE;
    FOR evidence IN SELECT value FROM jsonb_array_elements(provenance -> 'evidence') LOOP
      IF jsonb_typeof(evidence) IS DISTINCT FROM 'object' THEN
        RETURN FALSE;
      END IF;
      SELECT count(*) INTO key_count FROM jsonb_object_keys(evidence);
      IF key_count <> 3 OR NOT (evidence ?& ARRAY['page', 'excerpt', 'boundingBox'])
         OR jsonb_typeof(evidence -> 'page') IS DISTINCT FROM 'number' THEN
        RETURN FALSE;
      END IF;
      numeric_value := (evidence ->> 'page')::NUMERIC;
      IF mod(numeric_value, 1) <> 0 OR numeric_value < 1 OR numeric_value > 10000 THEN
        RETURN FALSE;
      END IF;

      IF jsonb_typeof(evidence -> 'excerpt') = 'string' THEN
        IF length(evidence ->> 'excerpt') NOT BETWEEN 1 AND 180
           OR btrim(evidence ->> 'excerpt') IS DISTINCT FROM evidence ->> 'excerpt'
           OR evidence ->> 'excerpt' ~ '[[:cntrl:]]' THEN
          RETURN FALSE;
        END IF;
        has_grounding := TRUE;
      ELSIF jsonb_typeof(evidence -> 'excerpt') IS DISTINCT FROM 'null' THEN
        RETURN FALSE;
      END IF;

      bounding_box := evidence -> 'boundingBox';
      IF jsonb_typeof(bounding_box) = 'object' THEN
        SELECT count(*) INTO key_count FROM jsonb_object_keys(bounding_box);
        IF key_count <> 4 OR NOT (bounding_box ?& ARRAY['x', 'y', 'width', 'height'])
           OR jsonb_typeof(bounding_box -> 'x') IS DISTINCT FROM 'number'
           OR jsonb_typeof(bounding_box -> 'y') IS DISTINCT FROM 'number'
           OR jsonb_typeof(bounding_box -> 'width') IS DISTINCT FROM 'number'
           OR jsonb_typeof(bounding_box -> 'height') IS DISTINCT FROM 'number'
           OR (bounding_box ->> 'x')::NUMERIC < 0
           OR (bounding_box ->> 'y')::NUMERIC < 0
           OR (bounding_box ->> 'width')::NUMERIC <= 0
           OR (bounding_box ->> 'height')::NUMERIC <= 0
           OR (bounding_box ->> 'x')::NUMERIC > 1
           OR (bounding_box ->> 'y')::NUMERIC > 1
           OR (bounding_box ->> 'width')::NUMERIC > 1
           OR (bounding_box ->> 'height')::NUMERIC > 1
           OR (bounding_box ->> 'x')::NUMERIC + (bounding_box ->> 'width')::NUMERIC > 1.000001
           OR (bounding_box ->> 'y')::NUMERIC + (bounding_box ->> 'height')::NUMERIC > 1.000001 THEN
          RETURN FALSE;
        END IF;
        IF source_type = 'document_visual' THEN
          has_grounding := TRUE;
        END IF;
      ELSIF jsonb_typeof(bounding_box) IS DISTINCT FROM 'null' THEN
        RETURN FALSE;
      END IF;
      IF jsonb_typeof(evidence -> 'excerpt') = 'null'
         AND jsonb_typeof(bounding_box) = 'null' THEN
        RETURN FALSE;
      END IF;
    END LOOP;

    IF source_type = 'derived' THEN
      IF jsonb_array_length(provenance -> 'evidence') <> 0
         OR jsonb_array_length(provenance -> 'derivedFrom') NOT BETWEEN 1 AND 32
         OR jsonb_typeof(provenance -> 'rule') IS DISTINCT FROM 'string'
         OR length(provenance ->> 'rule') NOT BETWEEN 1 AND 120
         OR btrim(provenance ->> 'rule') IS DISTINCT FROM provenance ->> 'rule'
         OR provenance ->> 'rule' ~ '[[:cntrl:]]' THEN
        RETURN FALSE;
      END IF;
      derived_keys := ARRAY[]::TEXT[];
      FOR dependency IN SELECT value FROM jsonb_array_elements(provenance -> 'derivedFrom') LOOP
        IF jsonb_typeof(dependency) IS DISTINCT FROM 'string'
           OR NOT (dependency #>> '{}' = ANY (ARRAY[
             'issuer_name', 'recipient_name', 'supplier_name', 'customer_name', 'company_name',
             'document_number', 'contract_number', 'policy_number', 'bank_name', 'account_reference',
             'iban_masked', 'siren', 'siret', 'fiscal_period', 'subject', 'chantier_name',
             'document_date', 'due_date', 'period_start', 'period_end', 'coverage_start',
             'coverage_end', 'expiry_date', 'total_ht', 'vat_amount', 'total_ttc', 'amount_due',
             'account_balance', 'tax_amount', 'vat_rate'
           ]))
           OR dependency #>> '{}' = ANY (derived_keys) THEN
          RETURN FALSE;
        END IF;
        derived_keys := array_append(derived_keys, dependency #>> '{}');
      END LOOP;
    ELSE
      IF jsonb_array_length(provenance -> 'derivedFrom') <> 0
         OR jsonb_typeof(provenance -> 'rule') IS DISTINCT FROM 'null'
         OR (NOT has_grounding AND (fact ->> 'confidence')::NUMERIC > 0.4) THEN
        RETURN FALSE;
      END IF;
    END IF;
  END LOOP;

  -- Les dépendances dérivées ne peuvent référencer qu'un fait réellement présent dans la forme V1.
  FOR fact IN SELECT value FROM jsonb_array_elements(candidate -> 'facts') LOOP
    provenance := fact -> 'provenance';
    IF provenance ->> 'source' = 'derived' THEN
      FOR dependency IN SELECT value FROM jsonb_array_elements(provenance -> 'derivedFrom') LOOP
        IF NOT (dependency #>> '{}' = ANY (all_fact_keys)) THEN
          RETURN FALSE;
        END IF;
      END LOOP;
    END IF;
  END LOOP;

  IF jsonb_typeof(candidate -> 'suggestedTags') IS DISTINCT FROM 'array'
     OR jsonb_array_length(candidate -> 'suggestedTags') NOT BETWEEN 1 AND 8 THEN
    RETURN FALSE;
  END IF;
  FOR tag IN SELECT value FROM jsonb_array_elements(candidate -> 'suggestedTags') LOOP
    IF jsonb_typeof(tag) IS DISTINCT FROM 'string'
       OR tag #>> '{}' !~ '^[a-z0-9]+(-[a-z0-9]+)*$'
       OR length(tag #>> '{}') NOT BETWEEN 2 AND 32
       OR tag #>> '{}' = ANY (tags_seen) THEN
      RETURN FALSE;
    END IF;
    tags_seen := array_append(tags_seen, tag #>> '{}');
  END LOOP;

  IF jsonb_typeof(candidate -> 'suggestedFilename') IS DISTINCT FROM 'string'
     OR candidate ->> 'suggestedFilename' !~ '^[a-z0-9]+(-[a-z0-9]+)*$'
     OR length(candidate ->> 'suggestedFilename') NOT BETWEEN 3 AND 96 THEN
    RETURN FALSE;
  END IF;

  CASE candidate ->> 'type'
    WHEN 'supplier_invoice' THEN expected_folder := 'purchases';
    WHEN 'receipt' THEN expected_folder := 'purchases';
    WHEN 'bank_statement' THEN expected_folder := 'bank';
    WHEN 'insurance_certificate' THEN expected_folder := 'insurance';
    WHEN 'tax_or_social_document' THEN expected_folder := 'tax_social';
    WHEN 'chantier_photo' THEN expected_folder := 'projects';
    WHEN 'accounting_document' THEN expected_folder := 'accounting';
    ELSE expected_folder := NULL;
  END CASE;
  IF expected_folder IS NULL THEN
    IF jsonb_typeof(candidate -> 'suggestedSystemFolder') IS DISTINCT FROM 'null' THEN
      RETURN FALSE;
    END IF;
  ELSIF jsonb_typeof(candidate -> 'suggestedSystemFolder') IS DISTINCT FROM 'string'
        OR candidate ->> 'suggestedSystemFolder' IS DISTINCT FROM expected_folder THEN
    RETURN FALSE;
  END IF;

  IF jsonb_typeof(candidate -> 'warnings') IS DISTINCT FROM 'array'
     OR jsonb_array_length(candidate -> 'warnings') > 8 THEN
    RETURN FALSE;
  END IF;
  FOR warning IN SELECT value FROM jsonb_array_elements(candidate -> 'warnings') LOOP
    IF jsonb_typeof(warning) IS DISTINCT FROM 'string'
       OR length(warning #>> '{}') NOT BETWEEN 1 AND 240
       OR btrim(warning #>> '{}') IS DISTINCT FROM warning #>> '{}'
       OR warning #>> '{}' ~ '[[:cntrl:]]'
       OR warning #>> '{}' = ANY (warnings_seen) THEN
      RETURN FALSE;
    END IF;
    warnings_seen := array_append(warnings_seen, warning #>> '{}');
  END LOOP;

  IF jsonb_typeof(candidate -> 'requiresHumanReview') IS DISTINCT FROM 'boolean'
     OR (candidate ->> 'requiresHumanReview')::BOOLEAN IS DISTINCT FROM (
       candidate ->> 'type' = 'other'
       OR (candidate ->> 'typeConfidence')::NUMERIC < 0.75
       OR expected_folder IS NULL
       OR fact_count = 0
       OR has_low_confidence
       OR jsonb_array_length(candidate -> 'warnings') > 0
     ) THEN
    RETURN FALSE;
  END IF;

  RETURN TRUE;
EXCEPTION WHEN OTHERS THEN
  -- Un cast inattendu ou une structure hostile ne doit jamais contourner le CHECK.
  RETURN FALSE;
END;
$$;

CREATE TABLE "document_analyses" (
  "companyId" TEXT NOT NULL,
  "documentId" TEXT NOT NULL,
  "documentVersion" INTEGER NOT NULL,
  "sourceSha256" CHAR(64) NOT NULL,
  "analyzerVersion" TEXT NOT NULL,
  "analysisSchemaVersion" INTEGER NOT NULL DEFAULT 1,
  "analysis" JSONB NOT NULL,
  "analyzedAt" TIMESTAMPTZ NOT NULL,
  CONSTRAINT "document_analyses_pkey"
    PRIMARY KEY ("companyId", "documentId", "documentVersion", "sourceSha256"),
  CONSTRAINT "document_analyses_companyId_documentId_fkey"
    FOREIGN KEY ("companyId", "documentId") REFERENCES "documents"("companyId", "id")
    ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "document_analyses_documentId_documentVersion_sourceSha256_fkey"
    FOREIGN KEY ("documentId", "documentVersion", "sourceSha256")
    REFERENCES "document_versions"("documentId", "version", "sha256")
    ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "document_analyses_document_version_check"
    CHECK ("documentVersion" > 0),
  CONSTRAINT "document_analyses_source_sha256_check"
    CHECK ("sourceSha256" ~ '^[a-f0-9]{64}$'),
  CONSTRAINT "document_analyses_analyzer_version_check"
    CHECK (length(btrim("analyzerVersion")) BETWEEN 1 AND 120),
  CONSTRAINT "document_analyses_analysis_schema_version_check"
    CHECK ("analysisSchemaVersion" = 1),
  CONSTRAINT "document_analyses_analysis_v1_check"
    CHECK (is_valid_document_analysis_v1(
      "analysis",
      "documentId",
      "documentVersion",
      "sourceSha256"::TEXT,
      "analyzerVersion",
      "analyzedAt"
    ) IS TRUE)
);

-- Une entrée publiée ne peut pas être réécrite. La suppression reste autorisée uniquement via
-- la cascade d'une purge légitime du document/de sa version ; aucune policy runtime DELETE n'existe.
CREATE FUNCTION reject_document_analysis_update()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'document analysis cache entries are immutable'
    USING ERRCODE = '55000';
END;
$$;

CREATE TRIGGER "document_analyses_immutable"
BEFORE UPDATE ON "document_analyses"
FOR EACH ROW EXECUTE FUNCTION reject_document_analysis_update();

ALTER TABLE "document_analyses" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "document_analyses" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_analysis_select ON "document_analyses"
  FOR SELECT
  USING ("companyId" = current_setting('app.current_company_id', true));
CREATE POLICY tenant_analysis_insert ON "document_analyses"
  FOR INSERT
  WITH CHECK ("companyId" = current_setting('app.current_company_id', true));
