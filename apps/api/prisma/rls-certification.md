# Certification RLS multi-tenant — Supabase prod (C1)

> Preuve de la barrière de sécurité #1 : sur la **vraie** base Supabase de prod, sous le rôle
> applicatif **non-superuser** `bob_app`, l'isolation par tenant tient sur les 18 tables.
> Rejouable via le MCP Supabase (ou `psql`). Dernière exécution : **2026-07-01**.

## Contexte base

- Projet : `cvdkqjczgqoeshputacl` (région `eu-west-3`, Postgres 17).
- Schéma amené à l'état complet de `schema.prisma` (**18 tables**). Le drift historique (base figée à
  « init + idempotence paiement ») a été résorbé via le MCP : ajout de `public_access_tokens`,
  `documents`, `document_versions`, `document_archive_jobs`, `notification_jobs`,
  `agent_journal_entries`, `accounting_accounts`, `accounting_entries`, `accounting_entry_lines`,
  `supplier_memory_profiles` (DDL repris **verbatim** des migrations Prisma locales).
- Ledger `_prisma_migrations` **baseliné** (8 migrations marquées applied, checksums réels) → le
  `prisma migrate deploy` du CD est un **no-op propre**. La table est en RLS `ENABLE` sans policy
  (verrouillée côté PostgREST) et `bob_app` n'a **aucun** droit dessus.

## Modèle de rôles (audit `pg_roles`)

| Rôle | `rolbypassrls` | Rôle |
|---|---|---|
| `anon`, `authenticated`, `authenticator`, `bob_app` | **false** | soumis à la RLS (clients + runtime app) |
| `postgres` | true | migrations / admin (`DIRECT_URL`) — bypass normal |
| `service_role`, `supabase_admin` | true | clés serveur de confiance |

**Gate C1** : `DATABASE_URL` (runtime) **doit** être `bob_app` (NOSUPERUSER, NOBYPASSRLS). Jamais
`postgres` (bypasse `FORCE RLS` → fuite cross-tenant). `DIRECT_URL` (migrations) = `postgres`.

## Posture RLS (vérifiée sur les 18 tables)

`ENABLE` **et** `FORCE ROW LEVEL SECURITY`, **1 policy** par table. Policies :
- companyId direct : `USING/WITH CHECK ("companyId" = current_setting('app.current_company_id', true))`
  (companies via `id`) — 15 tables.
- rattachées au parent : `line_items` (via `quotes`/`invoices`), `document_versions` (via `documents`).
- duale : `public_access_tokens` = tenant **OU** `"tokenHash" = current_setting('app.public_access_token_hash', true)`
  (accès signature public), `WITH CHECK` tenant seul.

`bob_app` a `SELECT/INSERT/UPDATE/DELETE` sur les 18 tables (le GRANT est évalué **avant** la RLS).

## Sondes adversariales (rôle `bob_app`, chaque sonde = transaction `ROLLBACK`)

| # | Attaque | Attendu | Obtenu |
|---|---|---|---|
| 1 | SELECT sous GUC=A / GUC=B / sans GUC (documents, accounting_entries, companies) | own=1, autre=1, sans-GUC=0 | ✅ 1 / 1 / 0 |
| 2 | INSERT `companyId=B` sous GUC=A (WITH CHECK) ; INSERT own | rejeté ; ok | ✅ rejected / ok |
| 3 | UPDATE & DELETE ciblant B sous GUC=A ; UPDATE own | 0 ligne ; 0 ligne ; 1 ligne | ✅ 0 / 0 / 1 |
| 4 | SELECT `line_items` & `document_versions` (policies parent) | own=1, sans-GUC=0 | ✅ 1 / 1 / 0 |
| 5 | `public_access_tokens` : chemin tenant, chemin hash public, fuite cross-tenant | tenant=1, public=1, fuiteB=0 | ✅ 1 / 1 / 0 |

Base vide au moment du test (0 ligne partout) → comptages non pollués. Semis sous `postgres`
(bypass), tests sous `SET LOCAL ROLE bob_app`, `ROLLBACK` en fin de chaque sonde.

## Reste (hors périmètre SQL/MCP)

- **Auth** : activer « Leaked Password Protection » (HaveIBeenPwned) — Dashboard → Authentication
  (advisor sécurité WARN, non bloquant). Aucun outil MCP pour ce réglage.
- **Secrets runtime** (fournis par l'utilisateur) : `DATABASE_URL` = `bob_app`, `DIRECT_URL` = `postgres`,
  `SUPABASE_JWT/JWKS`. À poser sur Railway pour basculer l'API `demo → prod` (`DEMO_MODE=false`).
