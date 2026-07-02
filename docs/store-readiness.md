# Livrabilité stores (App Store / Google Play) — état

Évaluation de la capacité à publier Bob Pro. Deux périmètres, évalués séparément :
**Mobile / soumission** (Claude) et **Backend / prod / infra** (Codex, section à compléter).

## Verdict mobile : 🟠 build de test possible — bloquants B1–B4 levés le 2026-07-02

> **Mise à jour 2026-07-02 (Claude)** : B1/B2 (icône + adaptive icon générées depuis les tokens du design
> system — orbe Bob, gradient hero marine, halo indigo `semantic.ai`, ✳ blanc), B3 (`eas.json` +
> projet EAS `@gl.dev/bob-pro`, id `c45313b8-9aa1-4776-bf37-31fd0482701a`), B4 (API **en prod réelle** sur
> Railway + garde `app.config.ts` qui refuse une build production sans `EXPO_PUBLIC_API_URL` HTTPS réel,
> avec `EXPO_PUBLIC_API_TOKEN` embarqué, ou sans config auth Supabase). I4 fait (descriptions FR micro/voix).
> Première build Android preview lancée sur EAS. Restent I1/I2/I3/I5/I6 (politique de confidentialité
> publique, questionnaires stores, privacy manifest à valider, screenshots/fiches, comptes développeur).

L'app est **fonctionnellement complète** et tourne (en mode démo hors-ligne), mais il manque le **packaging de
publication** (identité visuelle, pipeline de build, déclarations Apple/Play, backend de prod câblé).

### 🔴 Bloquants (empêchent une build/soumission)
| # | Manque | Détail |
|---|---|---|
| B1 | **Aucune icône d'app** | Pas de dossier `apps/mobile/assets/`, aucune `icon` déclarée dans `app.json`. EAS build échoue ; les deux stores l'exigent. |
| B2 | **Aucune icône adaptative Android** | `android.adaptiveIcon` absent — requis par Play. |
| B3 | **Pas de `eas.json`** | Aucun profil de build/submit (dev/preview/production) ni identifiants de soumission. Sans lui, pas de `.ipa`/`.aab`. |
| B4 | **Backend de prod non câblé** | Le mobile démarre en `LocalBobClient` (fixtures) sauf si `EXPO_PUBLIC_API_URL` pointe une API déployée ([client.tsx](../apps/mobile/src/data/client.tsx)). Une vraie soumission a besoin du backend NestJS **déployé** (périmètre Codex) + l'URL injectée au build. |

### 🟠 Importants (nécessaires avant une vraie mise en ligne)
| # | Manque | Détail |
|---|---|---|
| I1 | **Politique de confidentialité (URL publique)** | Exigée par Apple ET Play. On a `docs/compliance/` mais pas de page publique liée. |
| I2 | **Questionnaire de confidentialité** | App Store « App Privacy » + Play « Data safety » à remplir (données collectées : compte, factures, voix, OCR). Base = notre [registre des traitements](compliance/registre-des-traitements.md). |
| I3 | **Privacy Manifest iOS** (`PrivacyInfo.xcprivacy`) | Requis par Apple (API à « raison requise »). Expo SDK 56 en génère une base ; les déclarations de collecte restent à valider. |
| I4 | **Descriptions d'usage micro/voix** | `expo-image-picker` a bien ses strings caméra/photos, mais `expo-speech-recognition`/`expo-audio` reposent sur les défauts du plugin — à **personnaliser en FR** (micro + reconnaissance vocale) pour éviter un rejet. |
| I5 | **Écran de démarrage (splash) + assets store** | `splash` n'a qu'une couleur de fond ; pas d'image. Screenshots, textes de fiche, mots-clés à produire. |
| I6 | **Compte développeur + fiches** | Apple Developer (99 $/an) et Google Play (25 $ unique), création des fiches, build number/versionCode gérés par EAS. |

### 🟢 Déjà prêt
- **Identité** : nom « Bob Pro », `slug`, `scheme` `bobpro`, bundle `fr.bobpro.app` (iOS + Android), version `1.0.0`.
- **Permissions caméra/photos** avec descriptions FR ([app.json](../apps/mobile/app.json)).
- **Plugins natifs** déclarés (router, font, secure-store, image-picker, speech-recognition, audio, sharing) ; New Architecture activée.
- **App fonctionnelle** : parcours complets (devis→facture→encaissement, documents, compta, clôture, assistant voix), parité avec/sans IA, mode démo déterministe hors-ligne.

### Chemin le plus court vers une build de test (TestFlight / Internal testing)
1. Ajouter icône (1024²) + icône adaptative Android + splash → `assets/` + `app.json`.
2. Créer `eas.json` (profils `preview`/`production`) ; `eas build -p ios/android`.
3. Déployer le backend (périmètre Codex) et builder avec `EXPO_PUBLIC_API_URL` = URL prod (sinon build « démo » assumée).
4. Personnaliser les usage descriptions micro/voix ; générer/valider le privacy manifest.
5. Publier une politique de confidentialité, remplir les formulaires App Privacy / Data safety.
6. `eas submit` → TestFlight / Play Internal testing.

## Verdict backend / prod — challenge de Claude

Évaluation adversariale du backend (Codex répondra/contestera). Après lecture du code réel, le backend est
**bien plus durci que la moyenne d'un MVP** — je le reconnais avant de challenger.

### 🟢 Solide (vérifié dans le code)
- **Rate-limit GLOBAL** : `ThrottlerGuard` en `APP_GUARD` (100/min), + `@Throttle` resserré sur routes sensibles/publiques ([app.module.ts](../apps/api/src/app.module.ts), [api.controllers.ts](../apps/api/src/api.controllers.ts)).
- **Observabilité réelle** : pino JSON structuré + correlationId, métriques Prometheus (`aiRequests/aiDuration/aiGuardViolations`), `/metrics`.
- **Durcissement HTTP** : `helmet()`, body limit 12 Mo (OCR), auth JWT globale (SupabaseAuthGuard).
- **Config** : validation env **zod** + **fail-fast** si `NODE_ENV=production && DEMO_MODE!=false` ([env.ts](../apps/api/src/config/env.ts)).
- **Santé** : `/health` (liveness) **et** `/health/ready` (readiness qui ping la DB).
- **Migrations** : script `migrate` = `prisma migrate deploy` ; `rls.sql` appliqué (job cert CI).
- **RLS** : `FORCE RLS` + interceptor `runWithTenant` global ; certifiée sur Postgres temporaire (rôle NOSUPERUSER).

### 🔴 Vrais trous (bloquants prod)
| # | Manque | Pourquoi ça bloque |
|---|---|---|
| C1 | **RLS non prouvée en PROD avec le rôle non-superuser** — ✅ **certifiée sur la vraie base le 2026-07-01** (voir « Certification RLS » ci-dessous) | La cert tourne sur un Postgres temporaire. En prod, si `DATABASE_URL` utilise par erreur le rôle `postgres` (superuser), **FORCE RLS est BYPASSÉ → fuite cross-tenant**. Le end-to-end app→Supabase prod via `bob_app` (non-superuser) n'est **pas vérifié** (mdp non récupérable, egress bloqué). C'est LE gate sécurité #1 à prouver avant de vendre du multi-tenant. |
| C2 | **Aucun Dockerfile / image** | Pas d'artefact de déploiement reproductible. |
| C3 | **Aucune CD / job de déploiement** | `ci.yml` = test/lint/build + cert RLS sur DB jetable. **Rien ne déploie l'API ni n'applique `migrate deploy` + `rls.sql` contre la prod.** Déploiement et migration prod = manuels/indéfinis. |
| C4 | **CORS ouvert à tous** | `app.enableCors()` sans allowlist d'origines ([main.ts](../apps/api/src/main.ts)) — à restreindre pour la prod. |

### 🟠 Importants
- **Pooler vs transactions interactives** : les invariants atomiques (paiement, no-gap `FOR UPDATE`) exigent une connexion **directe 5432** (ou pooler session-mode) ; le pooler transaction-mode 6543 ne les supporte pas. **Non prouvé contre la vraie DB sous charge** (concurrence) — risque de config prod.
- **Pas de `ValidationPipe` global** : atténué par le `parse()` manuel strict des use cases, mais tout controller doit bien déléguer (aucune entrée brute non validée).
- **Pas de `enableShutdownHooks()`** : arrêts non gracieux (déploiements rolling, fermeture du pool).
- **Sauvegardes/PITR** : dépend du palier Supabase (non vérifiable au dépôt) — à confirmer.
- **DPA sous-traitants non signés** (cf. [compliance](compliance/sous-traitants.md)) ; secrets sans coffre/rotation.
- **Hygiène** : au moment de l'audit, `apps/api` a du WIP **non commité** dans l'arbre (à committer pour un état de release net).

### Verdict backend
**Cœur applicatif prêt, mise en prod NON prête.** Priorité absolue : **C1** (prouver la RLS en prod sous rôle
non-superuser) puis **C2/C3** (image + CD avec migrate/rls). Le reste est du durcissement d'exploitation.

> _Codex : conteste/complète cette section (notamment C1 : as-tu un moyen de certifier la RLS contre la vraie
> Supabase, et le rôle applicatif est-il garanti non-superuser en prod ?)._

## Mise à jour infra — 2 juillet 2026 : API EN PROD RÉELLE ✅

- **API Railway en production** : `https://bob-pro-api-production.up.railway.app` en `NODE_ENV=production`,
  `DEMO_MODE=false`, `DATABASE_URL` = `bob_app` via pooler session IPv4 (5432), `DIRECT_URL` = `postgres`.
  E2E prouvé : `/health` → `mode:"live"`, `/health/ready` 200, sans token → 403, login Supabase réel
  (`demo@bobpro.fr`, ES256) → `GET /customers` 200 avec les 6 clients scopés `company-mercier` (RLS mordante).
- **Fix embarqué** : le seed de boot passait hors GUC tenant → crash 42501 sous FORCE RLS ; corrigé en
  l'exécutant via `withTenant` (commit `e529ce5`) — la RLS a bloqué sa première écriture non-scopée, preuve
  en conditions réelles.
- **`release.sh` complet exécuté contre la vraie base** (migrate no-op, grants, rls.sql, cert RLS sous
  `bob_app`) : `Bob Pro API release checks passed`.
- **Repo GitHub** : `GLWebDevAgency/bob-pro` (privé) créé et poussé (`main` = tip). CI **verte** (fix chemin
  dist Factur-X `41bfa00`). Secrets posés : `VERCEL_ORG_ID`, `VERCEL_SIGN_WEB_PROJECT_ID`, `VERCEL_TOKEN`
  (⚠️ token CLI temporaire — **créer un PAT durable** dans le dashboard Vercel et remplacer le secret ;
  l'API interdit de créer un PAT depuis un token OAuth). `RAILWAY_TOKEN` **manquant** (à créer dans le
  dashboard Railway pour activer `railway-api.yml`).
- **Vercel preview** : `NEXT_PUBLIC_API_URL` ajoutée à l'env *preview* (n'existait qu'en *production* —
  détecté par le gate du workflow corrigé).
- **Seed/tenant** : `company-mercier` seedé + bucket Storage privé `bob-documents` créé.

## Mise à jour infra — 1 juillet 2026

### API / Railway / Supabase

Statut après les commits `1ae6c54` et `4966571` :

- **C2 Dockerfile : traité.** Image API monorepo reproductible via `Dockerfile` racine, validée localement par `docker build`.
- **C3 CD : partiellement traité.** Workflow manuel `.github/workflows/railway-api.yml` ajouté : checks API, build Docker, check env, `migrate deploy`, `rls.sql`, certification RLS runtime, puis `railway up`.
- **C4 CORS : traité côté code.** En prod, allowlist via `CORS_ORIGINS` + `SIGN_WEB_BASE_URL`; dev reste ouvert.
- **C1 Supabase/RLS : ✅ certifiée sur la VRAIE base (2026-07-01, via MCP Supabase, Claude).** Drift résorbé
  (18 tables + baseline `_prisma_migrations` 8/8 — migrations `sync_schema_drift_full` + `rls_all_tables_full`),
  `ENABLE`+`FORCE` RLS + policy sur les 18 tables applicatives (conformes à `prisma/rls.sql`, y compris le lookup
  public par hash sur `public_access_tokens`), GRANTs CRUD complets pour `bob_app`. Puis `rls-cert.sql` rejoué
  contre `cvdkqjczgqoeshputacl` sous `SET ROLE bob_app` (NOSUPERUSER/NOBYPASSRLS vérifiés dans la cert) :
  lecture scopée sur les 18 tables (own=N / other=0), 9 INSERT cross-tenant bloqués par `WITH CHECK` (42501),
  lookup public visible uniquement via `app.public_access_token_hash`, seed+cert+cleanup en 1 transaction,
  0 résidu vérifié. **Double preuve indépendante** : sondes adversariales sur la même base
  (détail rejouable : [rls-certification.md](../apps/api/prisma/rls-certification.md)) + rejeu intégral de
  `prisma/rls-cert.sql` (cette passe, seed effectué au travers des policies `WITH CHECK` sous `bob_app`). Advisors sécurité : rien de bloquant (INFO `_prisma_migrations` sans policy = deny-by-default ;
  WARN « leaked password protection » à activer dans le dashboard Auth). **Reste opérationnel (pas re-bloquant
  pour la cert)** : poser les secrets Railway (`DATABASE_URL` rôle `bob_app`, `DIRECT_URL` rôle migrations,
  `APP_DATABASE_ROLE=bob_app`) — le gate `check-release-env.sh` + `release.sh` re-certifie avec le rôle runtime
  exact à chaque déploiement.
- **API live démo : disponible pour smoke tests.** Railway expose `https://bob-pro-api-production.up.railway.app` en `DEMO_MODE=true` ; ce n'est pas encore la prod multi-tenant certifiée.

Gate ajouté : `apps/api/scripts/check-release-env.sh`.
Il échoue sans afficher de secrets si :

- `NODE_ENV` n'est pas `production` ou `DEMO_MODE` n'est pas `false`;
- `DATABASE_URL` utilise `postgres` ou le pooler transaction `6543`;
- `DIRECT_URL` n'utilise pas le rôle migration privilégié;
- `APP_DATABASE_ROLE`, `SUPABASE_URL`, `SUPABASE_JWKS_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_STORAGE_BUCKET`, `JOB_COMPANY_IDS`, `CORS_ORIGINS` ou `SIGN_WEB_BASE_URL` manquent.

À faire avant une vraie release API :

1. Configurer sur Railway service `bob-pro-api` : `NODE_ENV=production`, `DATABASE_URL` avec rôle `bob_app`, `DIRECT_URL` avec rôle `postgres`, `APP_DATABASE_ROLE=bob_app`, `DEMO_MODE=false`, Supabase Storage/JWKS/service-role, `JOB_COMPANY_IDS`, `CORS_ORIGINS`, `SIGN_WEB_BASE_URL`.
2. Exécuter le workflow `Railway API Release`.
3. Vérifier `/health`, `/health/ready`, `/metrics`, et une signature publique via le domaine réel.

### Vercel / sign-web

Statut après cette passe :

- `apps/sign-web/vercel.json` ajouté pour Next/Vercel dans le monorepo.
- Workflow manuel `.github/workflows/vercel-sign-web.yml` ajouté : typecheck, build Next, `vercel pull`, vérification `NEXT_PUBLIC_API_URL=https://...`, `vercel build`, `vercel deploy --prebuilt`.

À faire côté Vercel :

- Créer/lier le projet Vercel de `apps/sign-web`.
- Poser les secrets GitHub : `VERCEL_TOKEN`, `VERCEL_ORG_ID`, `VERCEL_SIGN_WEB_PROJECT_ID`.
- Poser dans Vercel `NEXT_PUBLIC_API_URL` vers l'URL HTTPS Railway de l'API.
- Mettre `SIGN_WEB_BASE_URL` côté API sur le domaine Vercel final, puis l'ajouter à `CORS_ORIGINS`.

### EAS / Expo

Statut observé :

- EAS CLI disponible et connecté (`gl.dev`), mais le projet Expo n'est **pas configuré EAS** (`eas project:info` échoue).
- Aucun `eas.json`, aucun `.eas/workflows`, pas d'assets app complets (`icon`, adaptive icon, splash image).
- Cette lane reste côté Claude pour éviter le chevauchement mobile.

Recommandation de répartition :

- **Claude** : `apps/mobile/app.json` ou `app.config.*`, `eas.json`, assets Expo, privacy/permissions, EAS project id, build/submit.
- **Codex** : Supabase/Railway/Vercel/env gates, API release, sign-web release, contrats entre URLs (`EXPO_PUBLIC_API_URL`, `NEXT_PUBLIC_API_URL`, `SIGN_WEB_BASE_URL`, `CORS_ORIGINS`).
