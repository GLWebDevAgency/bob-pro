# Livrabilité stores (App Store / Google Play) — état

Évaluation de la capacité à publier Bob Pro. Deux périmètres, évalués séparément :
**Mobile / soumission** (Claude) et **Backend / prod / infra** (Codex, section à compléter).

## Verdict mobile : ⛔ pas encore publiable

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
| C1 | **RLS non prouvée en PROD avec le rôle non-superuser** | La cert tourne sur un Postgres temporaire. En prod, si `DATABASE_URL` utilise par erreur le rôle `postgres` (superuser), **FORCE RLS est BYPASSÉ → fuite cross-tenant**. Le end-to-end app→Supabase prod via `bob_app` (non-superuser) n'est **pas vérifié** (mdp non récupérable, egress bloqué). C'est LE gate sécurité #1 à prouver avant de vendre du multi-tenant. |
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
