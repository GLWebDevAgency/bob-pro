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

| Composant             | Valeur                                                                                                                                                                                                                                                                                 |
| --------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| API publique          | `https://bob-pro-api-production.up.railway.app`                                                                                                                                                                                                                                        |
| Railway               | projet `bob-pro-api` (`215875ca-4dc9-421d-856c-e1e58c4bcc8c`), env `production` (`0ca9e425-…`), service `bob-pro-api` (`742e8318-…`), région `europe-west4-drams3a`, **1 replica obligatoire** (throttler process-local — moniteur topology 6 h)                                       |
| Base + Auth + Storage | Supabase `bob-pro` — ref `cvdkqjczgqoeshputacl`, eu-west-3 ; connexion directe `db.cvdkqjczgqoeshputacl.supabase.co:5432` (IPv4 OK — projet historique)                                                                                                                                |
| Buckets               | `bob-documents`, `bob-live-audio` (privés)                                                                                                                                                                                                                                             |
| Rôles DB              | `postgres` = déployeur **NON-superuser** (voir §5 pièges) ; `bob_app` = runtime `NOSUPERUSER/NOBYPASSRLS` (FORCE RLS) ; rôles d'autorité NOLOGIN : `bob_mistral_bootstrap_reaper`, `bob_openai_native_maintenance_directory`, `bob_realtime_reaper_directory`, `bob_realtime_capacity` |
| Protocoles            | settlement **V2 ACTIF** (26/07, SHA `9fcf3e76…`) ; archive documentaire **V2 ACTIF** (26/07, evidence liée à `9fcf3e76…`, base vierge)                                                                                                                                                 |
| Secrets notables      | `OPENAI_API_KEY` **posée** (D3 acté 25/07, inerte tant que Bob Live OFF) ; `RUN_RLS_CERT=true`, `RLS_CERT_CLEANUP=true` ; matrice complète : `design_handoff_bob_pro/MATRICE_FLAGS_V1.md`                                                                                              |
| Consommateurs         | APK **production** uniquement, cabinet web, sign-web                                                                                                                                                                                                                                   |

## 3. STAGING (miroir de prod)

| Composant             | Valeur                                                                                                                                                                                                                                                                                                                |
| --------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| API publique          | `https://bob-pro-api-staging.up.railway.app`                                                                                                                                                                                                                                                                          |
| Railway               | même projet/service, env `staging` (`3c687d72-…`)                                                                                                                                                                                                                                                                     |
| Base + Auth + Storage | Supabase `bob-pro-staging` — ref `afywrrzjjuyznewzvpmk`, eu-west-3 (créé 26/07 ; slot gratuit libéré par la pause de `swani-production`)                                                                                                                                                                              |
| ⚠️ Connexion DB       | **POOLER IPv4 OBLIGATOIRE depuis Railway** : `aws-0-eu-west-3.pooler.supabase.com:5432`, utilisateurs `postgres.afywrrzjjuyznewzvpmk` / `bob_app.afywrrzjjuyznewzvpmk` — l'hôte direct `db.<ref>.supabase.co` est **IPv6-only** (nouveaux projets) et Railway n'a pas d'IPv6 : boot OK en local, **500 en conteneur** |
| Buckets               | `bob-documents`, `bob-live-audio` (privés)                                                                                                                                                                                                                                                                            |
| Protocoles            | settlement **V2 ACTIF** (26/07, SHA `76939376…`) ; mêmes 110 migrations que prod                                                                                                                                                                                                                                      |
| Spécifique            | `CABINET_RELEASE_ENV=staging` ; `DEMO_MODE` selon besoin de test                                                                                                                                                                                                                                                      |
| Legacy                | Postgres Railway `tokaido` SUPPRIMÉ le 26/07                                                                                                                                                                                                                                                                          |
| Consommateurs         | APK **preview**, `apps/mobile/.env` (dev local), simulateur                                                                                                                                                                                                                                                           |

## 4. Rituel de déploiement (ordre STRICT — incident du 25/07 si violé)

1. Lire `/health/ready` du prédécesseur et relever
   `capabilities.realtimeAdmissionCancellationFence`. Exécuter ensuite via `railway run` :
   ```sh
   BOB_RELEASE_PHASE=predeploy \
   BOB_RELEASE_EXPECTED_ENV=<development|staging|production> \
   BOB_RELEASE_SHA=<sha-git-40-caracteres> \
   BOB_RELEASE_RUN_ID=<entier-positif-du-run> \
   BOB_RELEASE_RUN_ATTEMPT=<entier-positif> \
   REALTIME_CANCELLATION_FENCE_PREDECESSOR_CAPABLE=<true|false> \
   sh apps/api/scripts/release.sh
   ```
   → préflights (lignée, audience archive), fermeture des admissions, drain `closed|0` obligatoire
   au premier cutover/reprise partielle, **migrations sous l'ANCIEN binaire**, rôles, RLS,
   révocations PostgREST et certifications PostgreSQL. En staging, les certificats avec fixtures
   s'exécutent une seule fois, séquentiellement ; en production ils sont interdits et remplacés par
   les preuves structurelles. Après cleanup et fermeture finale, le script écrit un reçu non-PII
   lié au SHA, au run, à l'environnement, à la base, aux digests et à l’allowlist de configuration
   opérationnelle non secrète. Les keyrings ne contribuent que par leur inventaire de versions :
   aucune clé, aucun token, secret ou hash de secret n’entre dans l’artefact. Une cible attendue
   différente de `CABINET_RELEASE_ENV` échoue avant mutation. Exit 0 exigé ; la capacité reste
   fermée. Une liaison privée éphémère détecte en parallèle une rotation concurrente des secrets
   scalaires usage/control ; `.dockerignore` et `.railwayignore` l’excluent du contexte de build,
   et seul le reçu public exact est uploadé dans GitHub.
2. Déployer la révision (`railway up` depuis un clone propre au commit, ou pipeline GitHub).
3. Prouver une seule réplique, puis `/health/ready` avec `ready:true`, le SHA complet et
   l'environnement attendus, ainsi que `realtimeAdmissionCancellationFence:v1`. Le nouveau
   processus doit alors avoir attesté un snapshot durable `closed` valide. Lors d'une release
   suivante, ce snapshot peut encore porter les bindings N-1 et des sessions en drainage ; cela
   prouve l'aptitude du binaire au rollout, jamais l'ouverture des admissions. Le préflight SQL
   continue de refuser toute réservation tant que `postdeploy` n'a pas appliqué les bindings N et
   passé cette autorité à `active`. `/health` seul ne prouve RIEN : il répond même sur un binaire
   incompatible.
4. Exécuter l'**audit archive one-shot** isolé, lié au SHA et à son deployment id. Conserver son
   enveloppe non-PII et exiger son état terminal stable ; tout échec ou cleanup incomplet interdit
   la suite. Bob Live reste fermé pendant tout l'audit.
5. Revalider mono-réplique, SHA, environnement et capacités après l’audit, puis exécuter les
   **activations** monotones Archive V2, Settlement V2 et Outbox V2 via
   `activate-release-protocols-v2.sh`. Cet opérateur prouve d’abord que `DATABASE_URL` et
   `DIRECT_URL` visent la même base writable, revérifie le reçu et conserve un seul snapshot Railway
   de base/configuration pour les trois mutations. Elles sont irréversibles et ne précèdent jamais
   le fix des consommateurs (cf. runbooks `docs/runbooks/`). Rejouer exactement la même preuve de
   révision, y compris `railway-x-real-ip`, après ces activations et immédiatement avant le
   finaliseur.
6. Exécuter une seule fois, et seulement après les activations :
   ```sh
   BOB_RELEASE_PHASE=postdeploy \
   BOB_RELEASE_EXPECTED_ENV=<development|staging|production> \
   BOB_RELEASE_SHA=<meme-sha-git-40-caracteres> \
   BOB_RELEASE_RUN_ID=<meme-entier-positif-du-run> \
   BOB_RELEASE_RUN_ATTEMPT=<meme-entier-positif> \
   sh apps/api/scripts/release.sh
   ```
   Ce finaliseur vérifie deux fois le reçu `predeploy`, exige la bijection stricte des migrations,
   les trois protocoles V2 terminaux et les certificats structurels/ACL. En staging seulement, il
   rejoue la seed/cert RLS active et les certificats Archive/Settlement V2 si ce SHA vient de les
   activer ; le cleanup est obligatoire. Il n'exécute ni migration, ni replay `rls.sql`, ni
   provisioning, ni suite métier large. Les retraits N-1 puis `activate-existing` — sans DDL —
   constituent ses derniers gestes mutables. Toute erreur antérieure laisse la capacité fermée.

Il n'existe **aucun postdeploy intermédiaire** entre readiness et audit : rouvrir puis refermer
créait une fenêtre inutile et rejouait deux fois environ 18 minutes de certifications Supabase.
Le reçu n'est pas une autorité inter-run : un autre SHA, run, environnement, cluster ou digest est
refusé.

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
9. **bwrap est incompatible avec les conteneurs Railway** (namespaces utilisateur interdits).
   L’audit du 26/07 sur base vierge avait utilisé localement `/usr/bin/env` ; ce passe-plat est
   désormais explicitement interdit. Le correctif du 28/07 déplace le smoke Bubblewrap juste avant
   la première paire professionnelle : un inventaire vide/B2C, qui n’exécute aucun tiers, peut
   produire sa preuve ; toute paire professionnelle Railway reste P0 fail-closed, sans attestation
   ni fallback. **DETTE : certifier un launcher Landlock + seccomp sur Railway AVANT tout audit
   professionnel réel.** Trace GPT : `SPEC_ARCHIVE_AUDIT_RAILWAY_STABILIZATION.md` ; demande de
   contre-signature Claude émise le 28/07/2026 via `refs/agents/gpt`.
10. **Ne JAMAIS exporter `RAILWAY_ENV`** : le CLI Railway v5.26 l'interprète comme sélecteur
    de son backend INTERNE (`backboard.railway-staging.com`) — un jeton valide est alors
    présenté à la mauvaise API (« Invalid RAILWAY_TOKEN » trompeur ; cause réelle du rouge
    staging du moniteur, trouvée par GPT le 27/07). Utiliser `--environment` avec une
    variable au nom neutre (`TARGET_ENVIRONMENT_NAME`), verrouillé par le test de garde.
11. **Si le repo repasse PRIVÉ** : toutes les minutes GitHub Actions deviennent payantes
    (macOS ×10). Alléger alors les déclencheurs (jobs natifs, certifications, cadence du
    moniteur) ou passer au plan adapté.

## 6. Jetons & CI

| Chose                 | Où                                                                                                                                                                                                                                  |
| --------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Environnements GitHub | `production` (jeton deploy prod), `staging` (jeton deploy staging), `railway-topology-staging` + `railway-topology-production` (jetons scoped LECTURE topologie, créés 25/07 — le moniteur ne monte jamais un jeton de déploiement) |
| Moniteur topologie    | `.github/workflows/railway-topology-drift.yml`, cron 6 h, incidents auto label `railway-topology-monitor`                                                                                                                           |
| Supabase              | org `glwebdevagency's projects` ; `swani-production` EN PAUSE (slot gratuit) ; MCP Supabase = canal d'administration autorisé                                                                                                       |

Le workflow `railway-api.yml` exige, dans chaque environnement GitHub, les quatre identifiants
Railway non secrets `RAILWAY_PROJECT_ID`, `RAILWAY_ENVIRONMENT_ID`, `RAILWAY_API_SERVICE_ID` et
`RAILWAY_ARCHIVE_AUDIT_SERVICE_ID`. Il rapproche avant toute mutation les IDs avec les noms attendus,
puis lie les probes post-audit au `deploymentId` créé par la release. Staging porte ce bloc complet.

Une release normale exige `latestDeployment == activeDeployment` avant le prédeploy. Si Railway a
laissé un déploiement terminal en échec devant l'ancienne réplique saine, la seule sortie est le
purpose `release-recovery` : dispatch manuel direct de `railway-api.yml` sur `main`, staging
uniquement. Il accepte ce latest seulement s'il ne sert aucune instance, revalide immédiatement la
cible et la paire de bases, puis rétablit `latest == active == deploymentId` dès le nouvel upload.
Un appel via un workflow réutilisable, une autre branche ou une cible production est refusé.

`[BLOQUÉ FONDATEUR : GO de promotion production]` — au 4 août 2026, le bloc UUID de l'environnement
GitHub `production` n'est pas installé. Il sera provisionné et certifié seulement après une release
staging verte, avant la promotion production ; aucun UUID n'est inventé ni copié sans ce rituel.
