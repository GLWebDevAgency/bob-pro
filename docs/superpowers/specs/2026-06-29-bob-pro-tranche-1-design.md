# Spec — Bob Pro, Tranche Verticale 1

**Date :** 2026-06-29
**Statut :** Validée (autonomie complète, « le plus complet prod ready »)
**Architecture de référence :** [`docs/architecture/architecture-blueprint.md`](../../architecture/architecture-blueprint.md) — ce document de spec est le **quoi/périmètre** ; le blueprint est le **comment/architecture détaillée** (agrégats, ports, schéma, IA). En cas de divergence, le blueprint fait foi sur l'architecture, cette spec fait foi sur le périmètre.
**Source de design :** `_design_extract/design_handoff_bob_pro/` (tokens figés, `DOMAIN_MODEL.md`, `SCREENS.md`, `VOICE_AND_TONE.md`).

---

## 1. Problème & vision

**Bob Pro** — *« Ton bureau pro dans la poche. »* — copilote administratif & financier des artisans, indépendants et TPE en France. L'assistant s'appelle **Bob**. L'app facture, encaisse, classe, suit la trésorerie et tient la conformité (facturation électronique 2026/2027) **sans jargon ni paperasse**.

**Double exigence produit :**
1. **Utilisable avec ET sans IA** — parité fonctionnelle totale. Toute action de Bob a un équivalent manuel dans l'UI. `BOB_AI_MODE=off` masque l'onglet Assistant sans retirer aucune fonction.
2. **IA ultra-performante et précise** — Bob *agit* (annonce le plan puis exécute), route entre **Claude et GLM** selon la tâche, gère le contexte proprement, et **n'invente jamais un montant ni une mention légale** (tout vient du domaine déterministe).

## 2. Objectifs de la tranche 1

Livrer un **Bob fonctionnel de bout en bout**, en qualité production, qu'on étend ensuite écran par écran. Le premier livrable exécutable **tourne hors-ligne sur fixtures/mocks** (zéro base de données) ; le backend réel Postgres est branché ensuite par simple bascule de tokens DI, sans toucher au domaine ni à l'UI.

### Critères de succès (Definition of Done)
1. `packages/core` (domaine + application) **100 % testé, 0 I/O, 0 `Promise` dans le domaine** ; **3 tests d'or verts** : chauffe-eau (acompte 30 % → 488,40 €), franchise 293 B (taux forcé 0), autoliquidation BTP (rejet `vatRate≠0`).
2. Numérotation séquentielle **sans trou** prouvée par test de concurrence simulée ; totaux + mentions **figés à l'émission**.
3. Flux **Devis → signature (native sur place) → facture** bout-en-bout sur fixtures, hors-ligne, via mocks de ports.
4. Écrans **Aujourd'hui / Argent / Clients (+ fiche) / Assistant (Bob)** navigables sur fixtures ; 4 thèmes + densité (Cockpit/Zen) + personnalité (Pote/Pro/Direct) câblés sur l'UI réelle.
5. **Bob en mode démo** : chaque réponse passe par un `Tool` = wrapper strict d'un use case ; **0 montant inventé** (garde-fou placeholder testé).
6. Backend **NestJS Postgres-seul** : modules `auth`, `customers`, `billing`, `compliance` (stub), `documents` (stub), `cashflow`, `ai` ; bascule fixtures→Prisma par tokens DI ; CHECK `vatRate ∈ {0, 2.1, 5.5, 10, 20}`.
7. Auth Supabase JWT + scoping `companyId` par `Principal` (anti-IDOR).

## 3. Périmètre

### Inclus (tranche 1)
- **Monorepo** pnpm + Turborepo : `apps/{mobile,api}`, `packages/{tokens,i18n,core,ai,ui,api-client}` (+ `apps/web` présent dans l'arbre mais **non implémenté**).
- **`packages/tokens`** : tokens figés, 4 thèmes (marine défaut, foret, graphite, indigo), générateur CSS vars/RN, helper argent `fr-FR`.
- **`packages/core`** : Domain (VO, agrégats `Company/Customer/Quote/Invoice/Payment/RelancePlan/EinvoiceTransmission`, 3 machines à états, domain services purs) + Application (use cases, ports, `Result/AppError`, fixtures). Tests unitaires exhaustifs.
- **`packages/ai`** : Model Router (Claude/GLM/Demo), registre de `Tool` (= wrappers de use cases), Context Builder, Agent Loop, garde-fous anti-hallucination. Mode démo déterministe.
- **`packages/ui`** : primitives RN (Button, Card, Chip, Segmented, Badge, ListRow, ScoreBar, Sheet, FAB, TabBar, MoneyText, SignaturePad, Avatar, Stepper, SectionHeader…) + galerie.
- **`packages/api-client`** : transport pur HTTP/WS (implémente les ports ; TanStack Query vit dans `apps/mobile`).
- **`apps/mobile`** : expo-router, navigation 5 onglets + FAB, écrans Aujourd'hui/Argent/Clients(+fiche)/Assistant, flux Devis→signature→facture, ThemeProvider, préférences persistées, états loading/empty/error/offline.
- **`apps/api`** : NestJS modulaire (un module par bounded context), adapters fixtures→Prisma, controllers REST + gateway WS, auth Supabase, UnitOfWork, validation env Zod.

### Reporté (modélisé, non implémenté — stubs derrière ports)
Onboarding adaptatif · Auth UI complète · Diagnostic 2026 (UI) · Documents/OCR complet · Compte/Abo/Équipe/Paywall · Facture-à-la-voix · `apps/web` (Next.js) · page signature web (Vercel) · intégrations externes réelles (PDP, Chorus Pro, banque DSP2, paiement, OCR/VLM, e-signature, PDF Factur-X) · e-reporting paiement réel · `situation`/retenue de garantie · Mongo, Redis, BullMQ, outbox, idempotence distribuée, pub/sub WS scalable, RLS (arrivent à l'étape 7-8 du build order).

## 4. Architecture (résumé — détail dans le blueprint)

- **Clean Architecture** : règle de dépendance stricte, `Domain ← Application ← (Infrastructure, Interface)`. `packages/core` = seul détenteur des règles métier, zéro framework, zéro `Promise` dans le domaine.
- **DDD** : 9 bounded contexts (Identity&Company, CRM, Billing [core], Compliance [core], Payments&Cashflow [core], Relance, Documents, Assistant/AI, Subscription&Team) ; agrégats à invariants protégés ; events inter-agrégats.
- **SOLID** : Strategy aux 4 points de variation (TVA, canal e-invoice, ton de relance, routing modèle IA) ; ports petits (ISP) ; injection par abstraction (DIP).
- **Couche IA** : `packages/ai` au-dessus de l'Application ; `Tool<In,Out>{ usecase }` → parité IA/manuel **structurelle** ; placeholders monétaires résolus par le domaine + garde-fous (rejet de tout nombre monétaire libre).
- **Données** : Postgres (Supabase) = vérité financière (numérotation no-gap via `FOR UPDATE`, totaux/mentions figés, VO alignés). Mongo/Redis = reportés.

## 5. Stack & infra

- **Mobile** : Expo (SDK récent) / React Native / TypeScript strict ; expo-router ; react-native-reanimated ; @shopify/flash-list ; react-native-svg ; expo-font ; TanStack Query ; expo-secure-store.
- **Backend** : NestJS (Railway) ; Prisma + Postgres (Supabase) ; Supabase Auth (JWT/JWKS) + Storage ; Socket.IO (streaming Bob) ; validation Zod.
- **IA** : Anthropic (Claude) + GLM (Zhipu) via `LlmPort` + adapters (`AnthropicAdapter`, `GlmAdapter`, `DemoAdapter`) ; clés en env ; **fallback démo déterministe** si absentes ; exécution **backend uniquement** (jamais sur device).
- **Edge** (étape ultérieure) : Cloudflare (DNS/CDN/WAF). **Reporté** : Mongo (Atlas), Redis, BullMQ.

## 6. Ordre de construction (cf. blueprint §9.2)

1. **Fondations** — monorepo, `tokens`, `i18n`, `core/shared-kernel`, format argent.
2. **Domaine pur testé** — VO, domain services (tests d'or), agrégats, 3 machines à états. 100 % testé, 0 I/O.
3. **Application + ports** — use cases, ports write/read, `Result/AppError`, fixtures.
4. **Adapters mock + api-client** — `Fixture*Repository`, `DemoLlmAdapter`, mocks ACL ; api-client transport pur.
5. **UI + écrans mobile** — primitives, ThemeProvider 4 thèmes, hooks TanStack Query, écrans + flux Devis→signature→facture (hors-ligne sur fixtures).
6. **Couche IA Bob (démo)** — router, Tools, context builder, agent loop, garde-fous, streaming WS simulé.
7. **Backend réel** — NestJS modules, adapters Prisma (+ compteurs `FOR UPDATE`, UnitOfWork), Supabase Auth/Storage ; bascule `API_MODE=http`.
8. **Durcissement** — eval IA en CI (0 violation montant), rate-limit, observabilité, validation env, (Mongo/Redis/RLS si requis).

> **Premier livrable démontrable = fin de l'étape 6** (tout sur fixtures/mocks, zéro DB). Les étapes 7-8 branchent le réel sans toucher domaine/use cases/UI.

## 7. Risques & décisions ouvertes

Voir blueprint §10 (table des 19 risques). Principaux ouverts : coût/quota LLM (budget + rate-limit), exactitude Factur-X/UBL/CII (valider avec un PDP agréé avant prod, reporté), RGPD des prompts OCR (reporté), millésime des compteurs (`fiscalYear` = année civile, remise à zéro annuelle testée).

## 8. Conventions

- **Langue** : tout en français (Bob tutoie par défaut). Copy externalisée dans `packages/i18n`.
- **Argent** : centimes (int) en interne ; format `fr-FR` (espace fine insécable, virgule décimale, `tabular-nums`) à l'affichage uniquement (`core/format/money.ts`).
- **Code** : TypeScript strict, ESLint + Prettier, conventions du blueprint. Pas de couleur de marque en dur (tout via thème). Hit-targets ≥ 44 px. Pas d'animation d'entrée à opacité 0 sur contenu au repos.
- **Tests** : domaine + use cases unitaires (Vitest/Jest) ; e2e des flux clés ; garde-fou IA « 0 montant inventé » en CI.
