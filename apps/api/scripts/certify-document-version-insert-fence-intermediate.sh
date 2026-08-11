#!/usr/bin/env sh
set -eu

ROOT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")/../../.." && pwd)"
cd "$ROOT_DIR"

: "${DIRECT_URL:?DIRECT_URL privileged migration URL is required}"
: "${DATABASE_URL:?DATABASE_URL runtime app-role URL is required}"
: "${CABINET_RELEASE_ENV:?CABINET_RELEASE_ENV is required}"
: "${DOCUMENT_VERSION_INSERT_FENCE_INTERMEDIATE_CERT_DATABASE_KIND:?ephemeral database kind is required}"

if [ "$DOCUMENT_VERSION_INSERT_FENCE_INTERMEDIATE_CERT_DATABASE_KIND" != ephemeral ]; then
  echo "Document version intermediate certificate is restricted to an ephemeral database" >&2
  exit 1
fi
if [ "$CABINET_RELEASE_ENV" != development ]; then
  echo "Document version intermediate certificate is restricted to development" >&2
  exit 1
fi

node apps/api/scripts/assert-database-pair.mjs --ephemeral-supabase-ci owner-split

active_version="$(
  psql "$DIRECT_URL" -X -qAt -v ON_ERROR_STOP=1 \
    -c 'SELECT "activeVersion" FROM public.document_archive_protocol_state WHERE id = 1'
)"
if [ "$active_version" != 1 ]; then
  echo "Document version intermediate certificate requires Archive Protocol V1" >&2
  exit 1
fi

# Le predeploy complet vient de créer le schéma frais et d'accorder le rôle runtime. Reconstituer
# uniquement la frontière immédiatement antérieure à cette migration, puis exécuter LE fichier
# versionné exact. Cette base est éphémère et l'opération ne touche ni staging ni production.
psql "$DIRECT_URL" -X --single-transaction -v ON_ERROR_STOP=1 <<'SQL'
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';
SET LOCAL row_security = off;

SELECT pg_catalog.format('SET LOCAL ROLE %I', owner.rolname)
  FROM pg_catalog.pg_class AS relation
  JOIN pg_catalog.pg_roles AS owner ON owner.oid = relation.relowner
 WHERE relation.oid = 'public.document_versions'::regclass
\gexec
DROP POLICY IF EXISTS tenant_document_version_insert ON public.document_versions;
CREATE POLICY tenant_document_version_insert ON public.document_versions
  FOR INSERT
  WITH CHECK (
    EXISTS (
      SELECT 1
        FROM public.documents AS document
       WHERE document.id = document_versions."documentId"
         AND document."companyId" = current_setting('app.current_company_id', true)
    )
  );
RESET ROLE;

SELECT pg_catalog.format('SET LOCAL ROLE %I', owner.rolname)
  FROM pg_catalog.pg_proc AS function
  JOIN pg_catalog.pg_roles AS owner ON owner.oid = function.proowner
 WHERE function.oid =
   'public.document_version_parent_belongs_to_current_tenant_v1(text)'::pg_catalog.regprocedure
\gexec
DROP FUNCTION public.document_version_parent_belongs_to_current_tenant_v1(TEXT);
RESET ROLE;
SQL

psql "$DIRECT_URL" -X -v ON_ERROR_STOP=1 \
  -f apps/api/prisma/migrations/20260810100000_document_version_insert_tenant_fence/migration.sql

RUN_POSTGRES_DOCUMENT_VERSION_INSERT_FENCE_INTERMEDIATE_CERT=true \
  pnpm --filter @bob/api exec vitest run --testTimeout=30000 \
    src/persistence/prisma/document-version-insert-fence-intermediate.postgres.test.ts

echo "Document version insert fence intermediate N-1 certificate passed"
