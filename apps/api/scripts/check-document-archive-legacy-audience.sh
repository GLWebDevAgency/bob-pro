#!/usr/bin/env sh
set -eu

ROOT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")/../../.." && pwd)"
cd "$ROOT_DIR"

: "${DIRECT_URL:?DIRECT_URL privileged read URL is required}"

command -v psql >/dev/null 2>&1 || {
  echo "psql is required" >&2
  exit 1
}

# Ce contrôle s'exécute AVANT `prisma migrate deploy`. Sur un schéma pré-1332, aucune audience
# historique n'a encore été figée : toute facture déjà émise exige donc une revue explicite. Si
# l'expand est déjà installé, seules les factures dont le snapshot reste NULL bloquent le train.
preflight_result=''
if ! preflight_result="$(
  psql "$DIRECT_URL" -X -qAt -v ON_ERROR_STOP=1 2>&1 <<'SQL'
SELECT EXISTS (
  SELECT 1
    FROM information_schema.tables
   WHERE table_schema = 'public'
     AND table_name = 'invoices'
) AS invoices_table_exists
\gset
\if :invoices_table_exists
  SELECT EXISTS (
    SELECT 1
      FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name = 'invoices'
       AND column_name = 'archiveAudienceAtIssuance'
  ) AS archive_audience_exists
  \gset
  \if :archive_audience_exists
    SELECT 'expanded|' || count(*)::text
      FROM public.invoices
     WHERE number IS NOT NULL
       AND "issuedAt" IS NOT NULL
       AND status <> 'draft'::public."InvoiceStatus"
       AND "archiveAudienceAtIssuance" IS NULL;
  \else
    SELECT 'pre-expand|' || count(*)::text
      FROM public.invoices
     WHERE number IS NOT NULL
       AND "issuedAt" IS NOT NULL
       AND status <> 'draft'::public."InvoiceStatus";
  \endif
\else
  SELECT 'pre-expand|0';
\endif
SQL
)"; then
  echo "document archive legacy audience preflight could not read the target schema" >&2
  echo "$preflight_result" >&2
  exit 1
fi

phase="${preflight_result%%|*}"
legacy_count="${preflight_result#*|}"
case "$phase" in
  pre-expand|expanded) ;;
  *)
    echo "document archive legacy audience preflight returned an invalid phase" >&2
    exit 1
    ;;
esac
case "$legacy_count" in
  *[!0-9]*|'')
    echo "document archive legacy audience preflight returned an invalid count" >&2
    exit 1
    ;;
esac

if [ "$legacy_count" -ne 0 ]; then
  if [ "$phase" = pre-expand ]; then
    echo "Refusing archive expansion: $legacy_count issued legacy invoice(s) require an audited audience snapshot before migration 1332." >&2
  else
    echo "Refusing archive release: $legacy_count issued invoice(s) still have no audited archive audience." >&2
  fi
  exit 1
fi

echo "Document archive legacy audience preflight passed ($phase)."
