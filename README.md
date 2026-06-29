# Bob Pro

> **« Ton bureau pro dans la poche. »** — Le copilote administratif & financier des artisans, indépendants et TPE. Facture, encaisse, classe, suit ta trésorerie et reste conforme à la facturation électronique 2026/2027 — sans jargon ni paperasse. Dans l'app, l'assistant s'appelle **Bob**.

App **mobile** (Expo / React Native) + backend **NestJS**, en monorepo TypeScript. Pensée pour fonctionner **avec ou sans IA** : Bob est une couche d'accélération, jamais une dépendance.

---

## Stack

| | Version |
|---|---|
| Node | **22.18.0** (`.nvmrc`, ≥ 22.13.x) · pnpm **9.12.0** |
| Mobile | **Expo SDK 56** · React Native **0.85.3** · React **19.2.3** · expo-router |
| Backend | **NestJS 11** (REST + DI) · Prisma/Postgres (schéma documenté) |
| IA | Routeur **Claude / GLM** + mode démo déterministe · garde-fous anti-hallucination |
| Outillage | Turborepo · TypeScript strict · Vitest · ESLint · tsup |

## Architecture (Clean Architecture + DDD + SOLID)

La **règle de dépendance** est absolue : tout pointe vers le domaine. `packages/core` ne connaît ni NestJS, ni Prisma, ni Expo, ni les LLM.

```
bob-pro/
├─ packages/
│  ├─ tokens/        # design tokens figés (4 thèmes) — 0 dépendance
│  ├─ core/          # ★ DOMAINE + APPLICATION (0 framework, 0 Promise dans le domaine)
│  │                 #   VOs, agrégats (Quote/Invoice/Payment/RelancePlan/EinvoiceTransmission),
│  │                 #   machines à états, services purs (TVA, totaux, mentions, scoring,
│  │                 #   trésorerie, relances), use cases + ports, fixtures
│  ├─ ai/            # ★ couche IA Bob : ModelRouter, garde-fous, Tool, BobAgent
│  └─ api-client/    # façade BobClient : LocalBobClient (hors-ligne) + HttpBobClient (backend)
└─ apps/
   ├─ mobile/        # Expo : navigation 5 onglets + flux Devis→signature→facture
   └─ api/           # NestJS : REST + IA, adapters in-memory (V1) → Prisma (incrément suivant)
```

Documents de conception : [`docs/architecture/architecture-blueprint.md`](docs/architecture/architecture-blueprint.md) · [`docs/superpowers/specs`](docs/superpowers/specs) · [`docs/superpowers/plans`](docs/superpowers/plans).

### Le principe qui rend l'IA précise
Bob **ne rend jamais un montant qu'il a écrit lui-même.** Les outils de l'agent délèguent à des use cases ; tout calcul fiscal/légal vient de fonctions de domaine **déterministes**, et un garde-fou rejette tout montant monétaire absent de l'ensemble calculé. Parité IA/manuel **garantie par le typage** : un outil ne peut exister sans use case équivalent.

## Démarrage

```bash
nvm use            # Node 22.18.0
corepack enable    # pnpm 9.12.0
pnpm install
```

### App mobile
```bash
pnpm --filter @bob/mobile dev      # = expo start  → i (iOS) · a (Android) · Expo Go
```
Par défaut l'app tourne **hors-ligne sur fixtures** (`LocalBobClient`). Pour la brancher au backend, fournir un `HttpBobClient` au `BobClientProvider` (une ligne) :
```tsx
new HttpBobClient({ baseUrl: 'http://localhost:3000', companyId, getToken })
```

### Backend
```bash
cp apps/api/.env.example apps/api/.env   # DEMO_MODE=true par défaut (in-memory, sans base)
pnpm --filter @bob/api build && pnpm --filter @bob/api start
# Bob Pro API -> http://localhost:3000  (demo=true)
```
Endpoints : `GET /health`, `GET /customers`, `GET /cashflow`, `POST /quotes` (+ `/send` `/sign` `/invoice`), `POST /invoices/:id/{issue,pay}`, `POST /ai/ask`.

Pour la prod : `DEMO_MODE=false` + `DATABASE_URL` (Postgres/Supabase) + `ANTHROPIC_API_KEY`/`GLM_API_KEY` + `SUPABASE_JWKS_URL`. Les clés LLM vivent **uniquement** côté backend.

## Scripts (racine)
```bash
pnpm typecheck   # tsc --noEmit sur tout le monorepo
pnpm test        # Vitest (cœur, IA, api-client, tokens)
pnpm build       # tsup / tsc
pnpm lint        # ESLint
```

## Conformité française (cœur déterministe, testé)
- **TVA** 20/10/5,5/2,1/0 + suggestion par métier/contexte ; **test d'or** chauffe-eau : acompte 30 % = **488,40 €**.
- **Franchise 293 B** & **autoliquidation BTP** verrouillées par invariant (taux 0 imposé, rejet typé sinon).
- **Mentions légales** L441-10 + indemnité 40 €, décennale BTP, autoliquidation.
- **Numérotation séquentielle sans trou** (D-AAAA-NNNN / F-AAAA-NNNN), totaux & mentions **figés à l'émission**.
- **Facturation électronique 2026/2027** : routage PDP (B2B) / Chorus Pro (B2G) / e-reporting (B2C).

## État
Tranche 1 livrée et vérifiée (≈ 88 tests verts, typecheck intégral). **Reporté** (modélisé, non implémenté) : onboarding, auth UI, diagnostic 2026, OCR, compte/abo/équipe, facture-à-la-voix, adapters Prisma/Postgres réels, intégrations tierces (PDP, Chorus, banque, paiement, e-signature), app web Next.js + page de signature client.
