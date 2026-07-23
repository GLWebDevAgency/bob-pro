#!/usr/bin/env sh
set -eu

ROOT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")/../../.." && pwd)"
cd "$ROOT_DIR"

: "${DIRECT_URL:?DIRECT_URL privileged migration URL is required}"
: "${INVOICE_SETTLEMENT_V2_ACTIVATION_RELEASE_SHA:?40-char release SHA is required}"

case "$INVOICE_SETTLEMENT_V2_ACTIVATION_RELEASE_SHA" in
  *[!0-9a-f]*|'')
    echo "INVOICE_SETTLEMENT_V2_ACTIVATION_RELEASE_SHA must be a lowercase hexadecimal SHA" >&2
    exit 1
    ;;
esac
if [ "${#INVOICE_SETTLEMENT_V2_ACTIVATION_RELEASE_SHA}" -ne 40 ]; then
  echo "INVOICE_SETTLEMENT_V2_ACTIVATION_RELEASE_SHA must contain exactly 40 characters" >&2
  exit 1
fi

psql "$DIRECT_URL" -X --single-transaction -v ON_ERROR_STOP=1 \
  -v release_sha="$INVOICE_SETTLEMENT_V2_ACTIVATION_RELEASE_SHA" <<'SQL'
-- psql ne substitue volontairement pas ses variables dans un corps dollar-quoté. On copie
-- donc la valeur validée dans un paramètre transactionnel, lisible depuis PL/pgSQL sans
-- concaténation SQL ni changement persistant de la session.
SELECT set_config('bob.invoice_settlement_activation_release_sha', :'release_sha', true);

DO $$
DECLARE
  exposed_role TEXT;
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM public._prisma_migrations
     WHERE migration_name = '20260721133600_invoice_settlement_semantics_v2'
       AND finished_at IS NOT NULL
       AND rolled_back_at IS NULL
  ) THEN
    RAISE EXCEPTION 'invoice settlement V2 migration is not fully applied';
  END IF;

  IF EXISTS (
    SELECT 1
      FROM pg_catalog.pg_class AS relation
      JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = relation.relnamespace
      CROSS JOIN LATERAL pg_catalog.aclexplode(
        coalesce(relation.relacl, pg_catalog.acldefault('r', relation.relowner))
      ) AS privilege
     WHERE namespace.nspname = 'public'
       AND relation.relname = 'invoice_settlement_protocol_state'
       AND privilege.grantee = 0
       AND privilege.privilege_type IN (
         'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER'
       )
  ) THEN
    RAISE EXCEPTION 'PUBLIC retains a mutation privilege on invoice settlement protocol state';
  END IF;
  FOREACH exposed_role IN ARRAY ARRAY['anon', 'authenticated', 'service_role']::TEXT[] LOOP
    IF pg_catalog.to_regrole(exposed_role) IS NOT NULL
       AND pg_catalog.has_table_privilege(
         exposed_role,
         'public.invoice_settlement_protocol_state',
         'INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER'
       ) THEN
      RAISE EXCEPTION '% retains a mutation privilege on invoice settlement protocol state',
        exposed_role;
    END IF;
  END LOOP;
END;
$$;

SELECT "activeVersion"
  FROM public.invoice_settlement_protocol_state
 WHERE id = 1
 FOR UPDATE;

DO $$
DECLARE
  current_version SMALLINT;
  v2_rows BIGINT;
BEGIN
  SELECT "activeVersion" INTO STRICT current_version
    FROM public.invoice_settlement_protocol_state
   WHERE id = 1;

  IF current_version = 2 THEN
    RETURN;
  END IF;
  IF current_version <> 1 THEN
    RAISE EXCEPTION 'unexpected invoice settlement protocol version: %', current_version;
  END IF;

  SELECT count(*) INTO v2_rows
    FROM public.invoices
   WHERE "settlementSemanticsVersion" = 2;
  IF v2_rows <> 0 THEN
    RAISE EXCEPTION 'V2 rows exist before protocol activation';
  END IF;

  UPDATE public.invoice_settlement_protocol_state
     SET "activeVersion" = 2,
         "activatedAt" = statement_timestamp(),
         "activatedByReleaseSha" =
           current_setting('bob.invoice_settlement_activation_release_sha'),
         "updatedAt" = statement_timestamp()
   WHERE id = 1 AND "activeVersion" = 1;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'invoice settlement protocol activation lost its lock';
  END IF;
END;
$$;

DO $$
DECLARE
  state public.invoice_settlement_protocol_state%ROWTYPE;
BEGIN
  SELECT * INTO STRICT state
    FROM public.invoice_settlement_protocol_state
   WHERE id = 1;
  IF state."activeVersion" <> 2
     OR state."activatedAt" IS NULL
     OR state."activatedByReleaseSha" !~ '^[0-9a-f]{40}$' THEN
    RAISE EXCEPTION 'invoice settlement protocol activation proof is incomplete';
  END IF;
END;
$$;
SQL

echo "Invoice settlement protocol V2 is active"
