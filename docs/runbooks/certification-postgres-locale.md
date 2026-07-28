# Certification PostgreSQL locale (cluster jetable)

> [Revue adversariale 28/07 — finding 10] La revue a relevé qu'**aucun cluster PostgreSQL local
> n'était documenté dans le dépôt** : les certifications `*.postgres.test.ts` restaient donc
> `skipped` hors CI, et un gate neuf pouvait être déclaré « complet » sans avoir jamais été
> exécuté. Ce runbook rend la certification rejouable sur un poste, à l'identique du job
> `ephemeral-postgres-release-certification` de `.github/workflows/ci.yml`.

**Ce runbook ne remplace pas la loi des environnements.** Un cluster local jetable prouve le SQL,
les triggers, la RLS et les writers N-1. Il ne prouve **jamais** Supabase : le rejeu sur
**staging** avant merge reste obligatoire (rôles managés, ACL `anon`/`authenticated`/`service_role`,
`createrole_self_grant`, extensions).

## Pré-requis

- PostgreSQL **≥ 16** (le bootstrap Supabase-like l'exige ; les certifications tournent en 17) :
  `brew install postgresql@17` — les binaires vivent dans `/opt/homebrew/opt/postgresql@17/bin`.
- Les artefacts workspace construits : `pnpm --filter "@bob/api..." run build`
  (sans eux, on certifierait un environnement différent de celui qui sera déployé).

## 1. Cluster jetable

Le socket Unix de PostgreSQL est limité à 103 octets : utiliser un répertoire **court**
(`/tmp/bobpg17`), jamais un scratchpad profond.

```sh
export PGBIN=/opt/homebrew/opt/postgresql@17/bin
export PGROOT=/tmp/bobpg17
export PGDATA="$PGROOT/data"

rm -rf "$PGROOT" && mkdir -p "$PGDATA"
"$PGBIN/initdb" -D "$PGDATA" -U postgres --auth=trust --encoding=UTF8 --locale=C
cat >> "$PGDATA/postgresql.conf" <<'CONF'
port = 55432
listen_addresses = '127.0.0.1'
fsync = off
synchronous_commit = off
full_page_writes = off
max_connections = 300
CONF
printf "unix_socket_directories = '%s'\n" "$PGROOT" >> "$PGDATA/postgresql.conf"
"$PGBIN/pg_ctl" -D "$PGDATA" -l "$PGROOT/pg.log" -w start
"$PGBIN/psql" -h 127.0.0.1 -p 55432 -U postgres -d postgres \
  -c "ALTER ROLE postgres PASSWORD 'postgres';" \
  -c "CREATE DATABASE bob_ephemeral_ci;"
```

Le nom de base **doit** être `bob_ephemeral_ci` (ou `bob_ephemeral_global_capacity` /
`bob_ephemeral_key_rotation`) : `assert-database-pair.mjs` refuse toute autre cible, tout hôte
non loopback, tout port implicite et toute URI paramétrée.

## 2. Environnement

Reprendre **exactement** les variables du job CI (`.github/workflows/ci.yml`,
`ephemeral-postgres-release-certification`), en particulier :

```sh
export PATH="/opt/homebrew/opt/postgresql@17/bin:$PATH"
export DATABASE_URL='postgresql://bob_app:bob_app@127.0.0.1:55432/bob_ephemeral_ci'
export DIRECT_URL='postgresql://postgres:postgres@127.0.0.1:55432/bob_ephemeral_ci'
export CI_POSTGRES_SUPER_URL="$DIRECT_URL"
export CI_POSTGRES_ADMIN_URL='postgresql://bob_ci_supabase_admin:bob_ci_supabase_admin@127.0.0.1:55432/bob_ephemeral_ci'
export APP_DATABASE_ROLE=bob_app
export RUN_RLS_CERT=true RLS_CERT_CLEANUP=true
export CABINET_RELEASE_ENV=development CABINET_INVITATION_WORKER_ENABLED=false
export DOCUMENT_ARCHIVE_TEST_SEED_ACTIVATION_EVIDENCE=true
export SUPABASE_STORAGE_BUCKET=documents
# Hors GitHub Actions, le bootstrap Supabase-like exige un aveu explicite :
export BOB_SUPABASE_CI_BOOTSTRAP_CONFIRMATION=EPHEMERAL_LOOPBACK_ONLY
```

Les clés Bob Live / Mistral déterministes du job CI sont à recopier telles quelles : elles arment
le protocole prepare/retire sans dépendre d'un secret externe.

## 3. Profil déployeur Supabase, rôle applicatif, contrat Storage

```sh
sh apps/api/scripts/bootstrap-supabase-ci-postgres.sh   # postgres devient déployeur NON-superuser
psql "$DIRECT_URL" -c "CREATE ROLE bob_app LOGIN PASSWORD 'bob_app' NOSUPERUSER NOBYPASSRLS;"
```

Puis le double minimal du **Storage** fournisseur (`storage.buckets` + `storage.objects`, FK
comprise) — créé **avant** les migrations, pour prouver que le trigger d'immuabilité des objets
légaux est bien attaché par la migration. Le SQL exact est dans le job CI (« Provision the
ephemeral Supabase Storage metadata contract »).

## 4. Gate complet

```sh
BOB_RELEASE_PHASE=predeploy sh apps/api/scripts/release.sh

DOCUMENT_ARCHIVE_V2_ACTIVATION_RELEASE_SHA=cccccccccccccccccccccccccccccccccccccccc \
  sh apps/api/scripts/activate-document-archive-v2.sh
INVOICE_SETTLEMENT_V2_ACTIVATION_RELEASE_SHA=cccccccccccccccccccccccccccccccccccccccc \
  sh apps/api/scripts/activate-invoice-settlement-v2.sh
sh apps/api/scripts/activate-notification-outbox-v2.sh

BOB_RELEASE_PHASE=postdeploy sh apps/api/scripts/release.sh
```

**Piège du SHA d'activation** : la preuve d'audit d'octets est seedée pendant le predeploy avec
`DOCUMENT_ARCHIVE_V2_ACTIVATION_RELEASE_SHA`, sinon `GITHUB_SHA`, sinon `'c' × 40`. Les scripts
d'activation exigent la **même** valeur — sinon `no successful byte-audit evidence for this
release`. En local, ou bien on exporte le même SHA aux deux étapes, ou bien on utilise la valeur
de repli ci-dessus.

`release.sh` enchaîne les certifications PostgreSQL une par une, dont
`RUN_POSTGRES_INTERVENTION_CERT=true … interventions.postgres.test.ts` (fiche de passage :
RLS FORCE, FK composites anti-IDOR, anti-drift du CHECK depuis `INTERVENTION_TRANSITIONS`,
demi-états, collision de PK inter-tenant, ERRATUM 6, verrou post-signature en insertion, en
DÉ-TAGGAGE et en retrait, **phase avant/après cohérente avec la machine à états (finding 6)**,
writer N-1 notes + photos, réglages isolés par tenant).

## 5. Arrêt et purge

```sh
"$PGBIN/pg_ctl" -D "$PGDATA" stop -m immediate
rm -rf "$PGROOT"
```

## Pièges rencontrés

- **Socket trop long** : `could not create Unix-domain socket … is too long (maximum 103 bytes)`
  → `unix_socket_directories` doit pointer un chemin court.
- **SQL brut refusé = transaction avortée** : dans une transaction interactive, un refus de
  trigger sur `$executeRaw` avorte la transaction (`25P02`) et tout ce qui suit échoue pour la
  mauvaise raison. Chaque refus attendu se prouve dans **sa** transaction.
- **Le nettoyage d'une certification doit lever ses propres verrous** : le verrou post-signature
  §3.4 empêche aussi le `afterAll` de retirer les traces d'une fiche signée. La cert dé-signe
  explicitement ses fixtures (retour `completed`, preuve retirée) avant de supprimer — jamais un
  `.catch` avaleur, jamais un contournement du trigger.
