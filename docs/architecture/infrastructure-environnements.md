# INFRASTRUCTURE & ENVIRONNEMENTS — SOURCE DE VÉRITÉ

**Statut : NORMATIF pour Claude ET GPT/Codex.** Toute opération de déploiement, de migration,
de secret ou de bascule d'environnement se vérifie ICI d'abord. Établi le 26/07/2026 après la
remise à niveau complète prod+staging (110 migrations, settlement V2, staging dédié).
Toute modification de ce document = trace datée + accord des deux agents.

## 1. Vue d'ensemble

```mermaid
flowchart LR
  subgraph Clients
    APKPROD["APK PRODUCTION (stores)"]
    APKPREV["APK preview / dev local / simulateur"]
    CAB["Cabinet web (Vercel)"]
    SIGN["sign-web (Vercel)"]
  end
  subgraph Railway["Railway — projet bob-pro-api (215875ca)"]
    RP["env production — service bob-pro-api<br/>europe-west4, 1 replica"]
    RS["env staging — service bob-pro-api<br/>1 replica"]
    RPG["(legacy) Postgres Railway 'tokaido'<br/>À DÉCOMMISSIONNER"]
  end
  subgraph Supabase
    SBP["bob-pro (cvdkqjczgqoeshputacl)<br/>eu-west-3 — DB + Auth + Storage"]
    SBS["bob-pro-staging (afywrrzjjuyznewzvpmk)<br/>eu-west-3 — DB + Auth + Storage"]
  end
  APKPROD -->|API| RP
  APKPROD -->|Auth PKCE| SBP
  APKPREV -->|API| RS
  APKPREV -->|Auth PKCE| SBS
  CAB --> RP
  SIGN --> RP
  RP -->|DATABASE_URL bob_app<br/>DIRECT_URL postgres| SBP
  RS -->|DATABASE_URL bob_app.REF (pooler)<br/>DIRECT_URL postgres.REF (pooler)| SBS
```

**LOI des environnements (fondateur, 25/07/2026, gravée)** : PR → **staging validé** → production.
Seuls les builds **production** pointent la prod. Preview, dev local et simulateur pointent
**staging**. Invariant négatif verrouillé par `apps/api/src/flags-matrix-v1.test.ts`
(« le profil preview ne pointe JAMAIS la production »).

## 2. PRODUCTION

| Composant | Valeur |
|---|---|
| API publique | `https://bob-pro-api-production.up.railway.app` |
| Railway | projet `bob-pro-api` (`215875ca-4dc9-421d-856c-e1e58c4bcc8c`), env `production` (`0ca9e425-…`), service `bob-pro-api` (`742e8318-…`), région `europe-west4-drams3a`, **1 replica obligatoire** (throttler process-local — moniteur topology 6 h) |
| Base + Auth + Storage | Supabase `bob-pro` — ref `cvdkqjczgqoeshputacl`, eu-west-3 ; connexion directe `db.cvdkqjczgqoeshputacl.supabase.co:5432` (IPv4 OK — projet historique) |
| Buckets | `bob-documents`, `bob-live-audio` (privés) |
| Rôles DB | `postgres` = déployeur **NON-superuser** (voir §5 pièges) ; `bob_app` = runtime `NOSUPERUSER/NOBYPASSRLS` (FORCE RLS) ; rôles d'autorité NOLOGIN : `bob_mistral_bootstrap_reaper`, `bob_openai_native_maintenance_directory`, `bob_realtime_reaper_directory`, `bob_realtime_capacity` |
| Protocoles | settlement **V2 ACTIF** (26/07, SHA `9fcf3e76…`) ; archive documentaire **V1** (V2 = après nettoyage prod : audit one-shot puis `activate-document-archive-v2.sh`) |
| Secrets notables | `OPENAI_API_KEY` **posée** (D3 acté 25/07, inerte tant que Bob Live OFF) ; `RUN_RLS_CERT=true`, `RLS_CERT_CLEANUP=true` ; matrice complète : `design_handoff_bob_pro/MATRICE_FLAGS_V1.md` |
| Consommateurs | APK **production** uniquement, cabinet web, sign-web |

## 3. STAGING (miroir de prod)

| Composant | Valeur |
|---|---|
| API publique | `https://bob-pro-api-staging.up.railway.app` |
| Railway | même projet/service, env `staging` (`3c687d72-…`) |
| Base + Auth + Storage | Supabase `bob-pro-staging` — ref `afywrrzjjuyznewzvpmk`, eu-west-3 (créé 26/07 ; slot gratuit libéré par la pause de `swani-production`) |
| ⚠️ Connexion DB | **POOLER IPv4 OBLIGATOIRE depuis Railway** : `aws-0-eu-west-3.pooler.supabase.com:5432`, utilisateurs `postgres.afywrrzjjuyznewzvpmk` / `bob_app.afywrrzjjuyznewzvpmk` — l'hôte direct `db.<ref>.supabase.co` est **IPv6-only** (nouveaux projets) et Railway n'a pas d'IPv6 : boot OK en local, **500 en conteneur** |
| Buckets | `bob-documents`, `bob-live-audio` (privés) |
| Protocoles | settlement **V2 ACTIF** (26/07, SHA `76939376…`) ; mêmes 110 migrations que prod |
| Spécifique | `CABINET_RELEASE_ENV=staging` ; `DEMO_MODE` selon besoin de test |
| Legacy | l'ancien Postgres Railway (`tokaido.proxy.rlwy.net`) ne sert PLUS — à décommissionner (coût) |
| Consommateurs | APK **preview**, `apps/mobile/.env` (dev local), simulateur |

## 4. Rituel de déploiement (ordre STRICT — incident du 25/07 si violé)

1. `railway run --service bob-pro-api --environment <env> sh apps/api/scripts/release.sh`
   → préflights (lignée, audience archive), **migrations sous l'ANCIEN binaire**, rôles,
   RLS, révocations PostgREST, certifications PostgreSQL. Exit 0 exigé.
2. Déployer la révision (`railway up` depuis un clone propre au commit, ou pipeline GitHub).
3. Vérifier le **statut de révision** (`railway deployment list`) puis `/health/ready`
   → `ready:true` (`/health` seul ne prouve RIEN : il répond même sur binaire incompatible).
4. Activations éventuelles (V2 : par SHA complet certifié, IRRÉVERSIBLES, jamais avant le fix
   des consommateurs — cf. runbooks `docs/runbooks/`).
5. Rejouer `release.sh` (certification post-activation).

**Le conteneur ne migre JAMAIS** (`CMD node dist/main.js`) : déployer sans l'étape 1 = binaire
neuf sur schéma ancien = prod cassée (vécu le 25/07, ~40 min).

## 5. Pièges PROUVÉS (chacun a coûté une passe de release le 25-26/07)

1. **Supabase tue tout GRANT/REVOKE d'adhésion visant `postgres`** (connexion coupée, pas
   d'erreur). → adhésions par `createrole_self_grant='set'` à la création + GRANT conditionnel.
2. **L'ADMIN OPTION du créateur non-superuser est inamovible** → les certs de membership
   attestent l'invariant réel (seul session_user, SET, sans INHERIT), pas « exactement 1 ligne ».
3. **Supabase pré-accorde `anon/authenticated/service_role`** sur toute fonction/table publique
   (exposition RPC PostgREST) → release.sh les révoque (sweep sous `SET ROLE` propriétaire) et
   supprime les defaults.
4. **Après transfert d'ownership**, REVOKE/GRANT/EXECUTE exigent `SET ROLE` propriétaire
   (le superuser de CI masquait tout).
5. **IPv6 pooler** (voir §3) — tout nouveau projet Supabase.
6. **Latence WAN des certifications** : `--testTimeout=30000` + `PRISMA_TRANSACTION_TIMEOUT_MS`
   (exportés par release.sh uniquement).
7. **La CI (Postgres éphémère superuser) ne prouve JAMAIS Supabase** : tout nouveau script SQL
   de release se rejoue sur STAGING avant merge.
8. **EAS cloud ne lit QUE `eas.json`** (`.env` exclu) ; les 2 profils sont verrouillés par la
   matrice (scopes `mobile`, `mobile-preview`, `mobile-production`).

## 6. Jetons & CI

| Chose | Où |
|---|---|
| Environnements GitHub | `production` (jeton deploy prod), `staging` (jeton deploy staging), `railway-topology-staging` + `railway-topology-production` (jetons scoped LECTURE topologie, créés 25/07 — le moniteur ne monte jamais un jeton de déploiement) |
| Moniteur topologie | `.github/workflows/railway-topology-drift.yml`, cron 6 h, incidents auto label `railway-topology-monitor` |
| Supabase | org `glwebdevagency's projects` ; `swani-production` EN PAUSE (slot gratuit) ; MCP Supabase = canal d'administration autorisé |
