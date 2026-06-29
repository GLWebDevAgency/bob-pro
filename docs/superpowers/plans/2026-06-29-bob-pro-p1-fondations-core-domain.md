# Bob Pro — Plan 1 : Fondations & cœur déterministe

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal :** Mettre en place le monorepo et implémenter le cœur métier déterministe de Bob Pro (`packages/tokens` + `packages/core` shared-kernel, value objects, entités de requête, et tous les domain services purs), 100 % testé, avec les 3 tests d'or de conformité française verts.

**Architecture :** Clean Architecture — ce plan ne touche QUE le domaine (`packages/core/src/domain` + `shared-kernel`) et les tokens. Zéro framework, zéro I/O, **zéro `Promise` dans le domaine**. Tout calcul fiscal/légal est une fonction pure. Les agrégats avec comportement (Quote/Invoice/machines à états) et la couche Application arrivent au Plan 2.

**Tech Stack :** pnpm workspaces + Turborepo, TypeScript strict, Vitest (tests), tsup (build des packages). Node ≥ 20.

## Global Constraints

- **Langue & copy :** français partout ; aucune copy en dur dans le domaine.
- **Argent :** centimes (`number` entier) en interne. JAMAIS de flottant pour un montant. Format `fr-FR` (espace fine insécable U+202F pour les milliers, virgule décimale, `tabular-nums`) UNIQUEMENT à l'affichage, dans `packages/core/src/format/money.ts`. `formatEUR(162800) === "1 628,00 €"`.
- **Taux de TVA autorisés :** ensemble fermé `{0, 2.1, 5.5, 10, 20}`.
- **TypeScript :** `strict: true`, `noUncheckedIndexedAccess: true`, `exactOptionalPropertyTypes: true`. Pas de `any` non justifié.
- **Domaine :** méthodes retournant `DomainResult<T>` pour tout ce qui peut échouer ; VO immuables auto-validants via `static of()`. Aucune dépendance externe dans `packages/core`.
- **Référence d'architecture :** `docs/architecture/architecture-blueprint.md` (§4 domaine, §1 principes). En cas de doute sur une signature, le blueprint fait foi.
- **Règles métier de référence :** `_design_extract/design_handoff_bob_pro/DOMAIN_MODEL.md`.
- **Commits :** fréquents, un par task minimum, messages `type(scope): sujet` + ligne `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`.

---

## File Structure

```
bob-pro/
├─ package.json                      # root, scripts turbo, packageManager pnpm
├─ pnpm-workspace.yaml
├─ turbo.json
├─ tsconfig.base.json                # paths @bob/*
├─ .gitignore  .npmrc  .prettierrc  .eslintrc.cjs
├─ packages/
│  ├─ tokens/
│  │  ├─ package.json  tsconfig.json  tsup.config.ts  vitest.config.ts
│  │  └─ src/
│  │     ├─ index.ts                 # tokens figés (port de tokens.ts) + types
│  │     └─ index.test.ts
│  └─ core/
│     ├─ package.json  tsconfig.json  tsup.config.ts  vitest.config.ts
│     └─ src/
│        ├─ index.ts                 # barrel exports
│        ├─ format/
│        │  ├─ money.ts  money.test.ts
│        ├─ shared-kernel/
│        │  ├─ result.ts             # DomainResult, Result, errors
│        │  ├─ money.ts  money.test.ts
│        │  ├─ percentage.ts  percentage.test.ts
│        │  ├─ identifiers.ts        # Siren, Siret (Luhn)  + .test.ts
│        │  ├─ contact.ts            # Email, Address  + .test.ts
│        │  ├─ payment-terms.ts  payment-terms.test.ts
│        │  ├─ time.ts               # DateOnly, Instant, Clock
│        │  ├─ aggregate.ts          # AggregateRoot, DomainEvent
│        │  └─ index.ts
│        └─ domain/
│           ├─ billing/
│           │  └─ shared/
│           │     ├─ vat-rate.ts  vat-rate.test.ts
│           │     ├─ doc-number.ts  doc-number.test.ts
│           │     ├─ quantity.ts  quantity.test.ts
│           │     ├─ line-item.ts          # LineItem value type + LineCategory
│           │     └─ totals.ts             # Totals type
│           ├─ company/
│           │  └─ company.ts               # Company (entité, méthodes de requête)
│           ├─ customer/
│           │  ├─ customer.ts              # Customer (entité, méthodes de requête)
│           │  └─ score.ts                 # Score VO
│           └─ services/
│              ├─ compute-totals.ts  compute-totals.test.ts
│              ├─ suggest-vat-rate.ts  suggest-vat-rate.test.ts
│              ├─ build-mentions.ts  build-mentions.test.ts
│              ├─ score-customer.ts  score-customer.test.ts
│              ├─ einvoice-for.ts  einvoice-for.test.ts
│              ├─ project-cashflow.ts  project-cashflow.test.ts
│              └─ build-relance.ts  build-relance.test.ts
```

---

### Task 1 : Scaffold du monorepo

**Files :**
- Create: `package.json`, `pnpm-workspace.yaml`, `turbo.json`, `tsconfig.base.json`, `.gitignore`, `.npmrc`, `.prettierrc`, `.eslintrc.cjs`

**Interfaces :**
- Produces: workspace pnpm avec alias `@bob/tokens`, `@bob/core` ; commandes `pnpm typecheck`, `pnpm test`, `pnpm build`, `pnpm lint`.

- [ ] **Step 1 : Initialiser git et l'arbre racine**

```bash
cd "/Users/limameghassene/development/Bob Pro"
git init
mkdir -p packages/tokens/src packages/core/src
```

- [ ] **Step 2 : Écrire `pnpm-workspace.yaml`**

```yaml
packages:
  - "packages/*"
  - "apps/*"
```

- [ ] **Step 3 : Écrire `package.json` racine**

```json
{
  "name": "bob-pro",
  "private": true,
  "packageManager": "pnpm@9.12.0",
  "engines": { "node": ">=20" },
  "scripts": {
    "build": "turbo run build",
    "test": "turbo run test",
    "typecheck": "turbo run typecheck",
    "lint": "turbo run lint",
    "dev": "turbo run dev"
  },
  "devDependencies": {
    "turbo": "^2.1.0",
    "typescript": "^5.6.0",
    "vitest": "^2.1.0",
    "tsup": "^8.3.0",
    "prettier": "^3.3.0",
    "@typescript-eslint/eslint-plugin": "^8.8.0",
    "@typescript-eslint/parser": "^8.8.0",
    "eslint": "^8.57.0"
  }
}
```

- [ ] **Step 4 : Écrire `tsconfig.base.json`**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "lib": ["ES2022"],
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "exactOptionalPropertyTypes": true,
    "noImplicitOverride": true,
    "verbatimModuleSyntax": true,
    "declaration": true,
    "sourceMap": true,
    "skipLibCheck": true,
    "esModuleInterop": true,
    "forceConsistentCasingInFileNames": true,
    "baseUrl": ".",
    "paths": {
      "@bob/tokens": ["packages/tokens/src/index.ts"],
      "@bob/core": ["packages/core/src/index.ts"]
    }
  }
}
```

- [ ] **Step 5 : Écrire `turbo.json`**

```json
{
  "$schema": "https://turbo.build/schema.json",
  "tasks": {
    "build": { "dependsOn": ["^build"], "outputs": ["dist/**"] },
    "test": { "dependsOn": ["^build"] },
    "typecheck": { "dependsOn": ["^build"] },
    "lint": {},
    "dev": { "cache": false, "persistent": true }
  }
}
```

- [ ] **Step 6 : Écrire `.gitignore`, `.npmrc`, `.prettierrc`, `.eslintrc.cjs`**

`.gitignore` :
```
node_modules
dist
.turbo
*.log
.expo
.env*
!.env.example
_design_extract
*.zip
```
`.npmrc` :
```
auto-install-peers=true
strict-peer-dependencies=false
```
`.prettierrc` :
```json
{ "semi": true, "singleQuote": true, "printWidth": 100, "trailingComma": "all" }
```
`.eslintrc.cjs` :
```js
module.exports = {
  root: true,
  parser: '@typescript-eslint/parser',
  plugins: ['@typescript-eslint'],
  extends: ['eslint:recommended', 'plugin:@typescript-eslint/recommended'],
  parserOptions: { ecmaVersion: 2022, sourceType: 'module' },
  env: { node: true, es2022: true },
  ignorePatterns: ['dist', 'node_modules', '_design_extract'],
};
```

- [ ] **Step 7 : Commit**

```bash
git add -A && git commit -m "chore: scaffold pnpm + turborepo monorepo

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 2 : `packages/tokens` (design tokens figés + format argent)

**Files :**
- Create: `packages/tokens/package.json`, `packages/tokens/tsconfig.json`, `packages/tokens/tsup.config.ts`, `packages/tokens/vitest.config.ts`, `packages/tokens/src/index.ts`, `packages/tokens/src/index.test.ts`

**Interfaces :**
- Produces: `neutrals`, `semantic`, `themes`, `defaultTheme`, `gradients(t)`, `fonts`, `type`, `radius`, `shadow`, `shadowNative`, `space`, `frame`, `userSettings`, types `ThemeName`, `BrandTheme`. (Valeurs portées **verbatim** de `_design_extract/design_handoff_bob_pro/tokens.ts` — identité figée, ne rien modifier.)

- [ ] **Step 1 : Écrire les configs du package**

`packages/tokens/package.json` :
```json
{
  "name": "@bob/tokens",
  "version": "0.0.0",
  "type": "module",
  "main": "./dist/index.js",
  "module": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "exports": { ".": { "types": "./dist/index.d.ts", "import": "./dist/index.js" } },
  "scripts": {
    "build": "tsup src/index.ts --format esm --dts",
    "test": "vitest run",
    "typecheck": "tsc --noEmit",
    "lint": "eslint src"
  },
  "devDependencies": { "tsup": "^8.3.0", "typescript": "^5.6.0", "vitest": "^2.1.0" }
}
```
`packages/tokens/tsconfig.json` :
```json
{ "extends": "../../tsconfig.base.json", "include": ["src"] }
```
`packages/tokens/tsup.config.ts` :
```ts
import { defineConfig } from 'tsup';
export default defineConfig({ entry: ['src/index.ts'], format: ['esm'], dts: true, clean: true });
```
`packages/tokens/vitest.config.ts` :
```ts
import { defineConfig } from 'vitest/config';
export default defineConfig({ test: { environment: 'node' } });
```

- [ ] **Step 2 : Porter les tokens verbatim**

Copier le contenu de `_design_extract/design_handoff_bob_pro/tokens.ts` dans `packages/tokens/src/index.ts` **sans modifier aucune valeur** (couleurs, échelle typo, rayons, ombres, thèmes, `userSettings`). Vérifier la présence de : `neutrals`, `semantic`, `themes` (marine/foret/graphite/indigo), `defaultTheme='marine'`, `gradients`, `fonts`, `type`, `radius`, `shadow`, `shadowNative`, `space`, `frame`, `userSettings`.

- [ ] **Step 3 : Écrire le test des tokens (failing)**

`packages/tokens/src/index.test.ts` :
```ts
import { describe, it, expect } from 'vitest';
import { themes, defaultTheme, gradients, type, radius } from './index';

describe('tokens', () => {
  it('expose les 4 thèmes de marque avec marine par défaut', () => {
    expect(Object.keys(themes)).toEqual(['marine', 'foret', 'graphite', 'indigo']);
    expect(defaultTheme).toBe('marine');
    expect(themes.marine.d1).toBe('#0C2340');
  });
  it('dérive les dégradés du thème actif', () => {
    const g = gradients(themes.marine);
    expect(g.header).toContain('#0C2340');
    expect(g.cta).toContain('linear-gradient');
  });
  it('échelle typographique et rayons figés', () => {
    expect(type.heroNum.size).toBe(42);
    expect(radius.card).toBe(16);
  });
});
```

- [ ] **Step 4 : Lancer le test (doit échouer puis passer)**

Run: `pnpm --filter @bob/tokens test`
Expected: après le port verbatim (Step 2), PASS (3 tests).

- [ ] **Step 5 : Commit**

```bash
git add packages/tokens && git commit -m "feat(tokens): port des design tokens figés (4 thèmes)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 3 : `packages/core` scaffold + `Result`/erreurs + format argent

**Files :**
- Create: `packages/core/package.json`, `tsconfig.json`, `tsup.config.ts`, `vitest.config.ts`, `src/index.ts`, `src/shared-kernel/result.ts`, `src/format/money.ts`, `src/format/money.test.ts`

**Interfaces :**
- Produces:
  - `type DomainResult<T> = { ok: true; value: T } | { ok: false; error: DomainError }`
  - `type Result<T, E> = { ok: true; value: T } | { ok: false; error: E }`
  - `ok<T>(value: T)`, `err<E>(error: E)` helpers
  - `type DomainError` (union à code) — démarre avec `VAT_RATE_NOT_APPLICABLE`, `INVALID_TRANSITION`, `DOCUMENT_NUMBER_GAP`, `VALIDATION`
  - `formatEUR(cents: number): string`

- [ ] **Step 1 : Configs du package core**

`packages/core/package.json` :
```json
{
  "name": "@bob/core",
  "version": "0.0.0",
  "type": "module",
  "main": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "exports": { ".": { "types": "./dist/index.d.ts", "import": "./dist/index.js" } },
  "scripts": {
    "build": "tsup src/index.ts --format esm --dts",
    "test": "vitest run",
    "test:watch": "vitest",
    "typecheck": "tsc --noEmit",
    "lint": "eslint src"
  },
  "devDependencies": { "tsup": "^8.3.0", "typescript": "^5.6.0", "vitest": "^2.1.0" }
}
```
`packages/core/tsconfig.json` : `{ "extends": "../../tsconfig.base.json", "include": ["src"] }`
`packages/core/tsup.config.ts` et `vitest.config.ts` : identiques à ceux de `tokens` (entry `src/index.ts`).

- [ ] **Step 2 : Écrire `src/shared-kernel/result.ts`**

```ts
export type Result<T, E> = { ok: true; value: T } | { ok: false; error: E };

export type DomainError =
  | { code: 'VALIDATION'; field: string; message: string }
  | { code: 'VAT_RATE_NOT_APPLICABLE'; rate: number; reason: 'franchise_293B' | 'autoliquidation' | 'unknown' }
  | { code: 'INVALID_TRANSITION'; from: string; to: string }
  | { code: 'DOCUMENT_NUMBER_GAP'; expected: string; got: string }
  | { code: 'QUOTE_ALREADY_SIGNED'; quoteId: string }
  | { code: 'MISSING_SIREN_FOR_EINVOICE'; customerId: string };

export type DomainResult<T> = Result<T, DomainError>;

export const ok = <T>(value: T): { ok: true; value: T } => ({ ok: true, value });
export const err = <E>(error: E): { ok: false; error: E } => ({ ok: false, error });
export const isOk = <T, E>(r: Result<T, E>): r is { ok: true; value: T } => r.ok;
```

- [ ] **Step 3 : Écrire le test du format argent (failing)**

`packages/core/src/format/money.test.ts` :
```ts
import { describe, it, expect } from 'vitest';
import { formatEUR } from './money';

const NBSP_FINE = ' '; // espace fine insécable

describe('formatEUR', () => {
  it('formate les milliers avec espace fine insécable et virgule décimale', () => {
    expect(formatEUR(162800)).toBe(`1${NBSP_FINE}628,00${NBSP_FINE}€`);
  });
  it('formate un petit montant', () => {
    expect(formatEUR(48840)).toBe(`488,40${NBSP_FINE}€`);
  });
  it('gère zéro et les négatifs', () => {
    expect(formatEUR(0)).toBe(`0,00${NBSP_FINE}€`);
    expect(formatEUR(-5000)).toBe(`-50,00${NBSP_FINE}€`);
  });
});
```

- [ ] **Step 4 : Run → FAIL** (`Cannot find module './money'`)

Run: `pnpm --filter @bob/core test src/format/money.test.ts`
Expected: FAIL.

- [ ] **Step 5 : Implémenter `src/format/money.ts`**

```ts
const NBSP_FINE = ' ';

/** Formate des centimes (int) en EUR fr-FR : "1 628,00 €" (espaces = U+202F). */
export function formatEUR(cents: number): string {
  const negative = cents < 0;
  const abs = Math.abs(cents);
  const euros = Math.trunc(abs / 100);
  const dec = String(abs % 100).padStart(2, '0');
  const intStr = String(euros).replace(/\B(?=(\d{3})+(?!\d))/g, NBSP_FINE);
  return `${negative ? '-' : ''}${intStr},${dec}${NBSP_FINE}€`;
}
```

- [ ] **Step 6 : Écrire le barrel `src/index.ts`**

```ts
export * from './shared-kernel/result';
export * from './format/money';
```

- [ ] **Step 7 : Run → PASS**

Run: `pnpm --filter @bob/core test`
Expected: PASS.

- [ ] **Step 8 : Commit**

```bash
git add packages/core && git commit -m "feat(core): scaffold + Result/DomainError + formatEUR fr-FR

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 4 : Value object `Money` (centimes neutres)

**Files :**
- Create: `packages/core/src/shared-kernel/money.ts`, `packages/core/src/shared-kernel/money.test.ts`
- Modify: `packages/core/src/index.ts` (exporter `Money`)

**Interfaces :**
- Consumes: `DomainResult`, `ok`, `err` (Task 3).
- Produces: `class Money { readonly cents: number; readonly currency: 'EUR'; static of(cents, currency?): DomainResult<Money>; static zero(): Money; add(o): Money; sub(o): Money; mulInt(n): Money; isNegative(): boolean; equals(o): boolean; }`. **Pas de `applyRate`** (l'arrondi TVA vit dans `computeTotals`).

- [ ] **Step 1 : Test (failing)**

`packages/core/src/shared-kernel/money.test.ts` :
```ts
import { describe, it, expect } from 'vitest';
import { Money } from './money';

describe('Money', () => {
  it('refuse un non-entier', () => {
    const r = Money.of(10.5);
    expect(r.ok).toBe(false);
  });
  it('additionne et soustrait en centimes', () => {
    const a = Money.of(148000).value as Money;
    const b = Money.of(14800).value as Money;
    expect(a.add(b).cents).toBe(162800);
    expect(a.sub(b).cents).toBe(133200);
  });
  it('multiplie par un entier', () => {
    const a = Money.of(2000).value as Money;
    expect(a.mulInt(3).cents).toBe(6000);
  });
  it('zero et equals', () => {
    expect(Money.zero().cents).toBe(0);
    expect((Money.of(100).value as Money).equals(Money.of(100).value as Money)).toBe(true);
  });
});
```

- [ ] **Step 2 : Run → FAIL**

Run: `pnpm --filter @bob/core test src/shared-kernel/money.test.ts`
Expected: FAIL.

- [ ] **Step 3 : Implémenter `money.ts`**

```ts
import { type DomainResult, ok, err } from './result';

export class Money {
  private constructor(
    readonly cents: number,
    readonly currency: 'EUR',
  ) {}

  static of(cents: number, currency: 'EUR' = 'EUR'): DomainResult<Money> {
    if (!Number.isSafeInteger(cents)) {
      return err({ code: 'VALIDATION', field: 'cents', message: 'Le montant doit être un entier de centimes.' });
    }
    return ok(new Money(cents, currency));
  }

  static zero(currency: 'EUR' = 'EUR'): Money {
    return new Money(0, currency);
  }

  private assertSameCurrency(o: Money): void {
    if (o.currency !== this.currency) throw new Error('Devises incompatibles');
  }

  add(o: Money): Money {
    this.assertSameCurrency(o);
    return new Money(this.cents + o.cents, this.currency);
  }
  sub(o: Money): Money {
    this.assertSameCurrency(o);
    return new Money(this.cents - o.cents, this.currency);
  }
  mulInt(n: number): Money {
    if (!Number.isInteger(n)) throw new Error('mulInt exige un entier');
    return new Money(this.cents * n, this.currency);
  }
  isNegative(): boolean {
    return this.cents < 0;
  }
  equals(o: Money): boolean {
    return this.cents === o.cents && this.currency === o.currency;
  }
}
```

- [ ] **Step 4 : Exporter dans `src/index.ts`** — ajouter `export * from './shared-kernel/money';`

- [ ] **Step 5 : Run → PASS** (`pnpm --filter @bob/core test src/shared-kernel/money.test.ts`)

- [ ] **Step 6 : Commit**

```bash
git add packages/core && git commit -m "feat(core): Money VO (centimes neutres, sans applyRate)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 5 : VOs `Percentage`, `Siren`/`Siret`, `Email`/`Address`, `PaymentTerms`, `time`, `AggregateRoot`

**Files :**
- Create: `percentage.ts`(+test), `identifiers.ts`(+test), `contact.ts`(+test), `payment-terms.ts`(+test), `time.ts`, `aggregate.ts`, `shared-kernel/index.ts`
- Modify: `src/index.ts`

**Interfaces :**
- Produces:
  - `class Percentage { value: number; static of(v): DomainResult<Percentage> }` (0..100)
  - `class Siren { static of(raw): DomainResult<Siren>; value: string }` (9 chiffres + Luhn) ; `class Siret { static of(raw): DomainResult<Siret>; siren(): Siren; value: string }` (14 + Luhn)
  - `class Email { static of(raw): DomainResult<Email> }` ; `interface Address { line1; zip; city }`
  - `class PaymentTerms { static of({days,endOfMonth,label}): DomainResult<PaymentTerms>; dueDateFrom(d: DateOnly): DateOnly | null }`
  - `type DateOnly` (`YYYY-MM-DD`), `type Instant` (ISO string), `interface Clock { now(): Instant; today(): DateOnly }`, `class SystemClock implements Clock`
  - `abstract class AggregateRoot<TId>` avec `pullEvents(): DomainEvent[]` ; `interface DomainEvent { type: string; occurredAt: Instant; version: number }`

- [ ] **Step 1 : Tests (failing) — Luhn + Percentage + PaymentTerms**

`identifiers.test.ts` :
```ts
import { describe, it, expect } from 'vitest';
import { Siren, Siret } from './identifiers';
describe('Siren/Siret', () => {
  it('valide un SIREN correct (Luhn)', () => {
    expect(Siren.of('732829320').ok).toBe(true); // Danone — Luhn valide
  });
  it('rejette un SIREN à mauvaise longueur', () => {
    expect(Siren.of('1234').ok).toBe(false);
  });
  it('rejette un Luhn invalide', () => {
    expect(Siren.of('732829321').ok).toBe(false);
  });
  it('Siret expose son Siren', () => {
    const r = Siret.of('73282932000074');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.siren().value).toBe('732829320');
  });
});
```
`percentage.test.ts` :
```ts
import { describe, it, expect } from 'vitest';
import { Percentage } from './percentage';
describe('Percentage', () => {
  it('accepte 0..100', () => { expect(Percentage.of(30).ok).toBe(true); });
  it('refuse hors bornes', () => { expect(Percentage.of(120).ok).toBe(false); expect(Percentage.of(-1).ok).toBe(false); });
});
```
`payment-terms.test.ts` :
```ts
import { describe, it, expect } from 'vitest';
import { PaymentTerms } from './payment-terms';
describe('PaymentTerms', () => {
  it('calcule une échéance à 30 jours', () => {
    const t = PaymentTerms.of({ days: 30, endOfMonth: false, label: 'Paiement à 30 jours' });
    expect(t.ok).toBe(true);
    if (t.ok) expect(t.value.dueDateFrom('2026-01-10')).toBe('2026-02-09');
  });
  it('retourne null si non calculable (mandat administratif)', () => {
    const t = PaymentTerms.of({ days: 0, endOfMonth: false, label: 'Mandat administratif' });
    if (t.ok) expect(t.value.dueDateFrom('2026-01-10')).toBeNull();
  });
});
```

- [ ] **Step 2 : Run → FAIL** (`pnpm --filter @bob/core test src/shared-kernel`)

- [ ] **Step 3 : Implémenter les VOs**

`percentage.ts` :
```ts
import { type DomainResult, ok, err } from './result';
export class Percentage {
  private constructor(readonly value: number) {}
  static of(v: number): DomainResult<Percentage> {
    if (!Number.isFinite(v) || v < 0 || v > 100)
      return err({ code: 'VALIDATION', field: 'percentage', message: 'Pourcentage hors bornes (0..100).' });
    return ok(new Percentage(v));
  }
}
```
`identifiers.ts` :
```ts
import { type DomainResult, ok, err } from './result';

function luhnValid(num: string): boolean {
  let sum = 0;
  let alt = false;
  for (let i = num.length - 1; i >= 0; i--) {
    let d = num.charCodeAt(i) - 48;
    if (d < 0 || d > 9) return false;
    if (alt) { d *= 2; if (d > 9) d -= 9; }
    sum += d;
    alt = !alt;
  }
  return sum % 10 === 0;
}

export class Siren {
  private constructor(readonly value: string) {}
  static of(raw: string): DomainResult<Siren> {
    const v = raw.replace(/\s/g, '');
    if (!/^\d{9}$/.test(v)) return err({ code: 'VALIDATION', field: 'siren', message: 'SIREN = 9 chiffres.' });
    if (!luhnValid(v)) return err({ code: 'VALIDATION', field: 'siren', message: 'SIREN invalide (Luhn).' });
    return ok(new Siren(v));
  }
}
export class Siret {
  private constructor(readonly value: string) {}
  static of(raw: string): DomainResult<Siret> {
    const v = raw.replace(/\s/g, '');
    if (!/^\d{14}$/.test(v)) return err({ code: 'VALIDATION', field: 'siret', message: 'SIRET = 14 chiffres.' });
    if (!luhnValid(v)) return err({ code: 'VALIDATION', field: 'siret', message: 'SIRET invalide (Luhn).' });
    return ok(new Siret(v));
  }
  siren(): Siren {
    return (Siren.of(this.value.slice(0, 9)) as { ok: true; value: Siren }).value;
  }
}
```
`contact.ts` :
```ts
import { type DomainResult, ok, err } from './result';
export class Email {
  private constructor(readonly value: string) {}
  static of(raw: string): DomainResult<Email> {
    const v = raw.trim();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(v))
      return err({ code: 'VALIDATION', field: 'email', message: 'Email invalide.' });
    return ok(new Email(v));
  }
}
export interface Address { line1: string; zip: string; city: string }
```
`time.ts` :
```ts
export type DateOnly = string; // "YYYY-MM-DD"
export type Instant = string;  // ISO 8601

export interface Clock { now(): Instant; today(): DateOnly }

export class SystemClock implements Clock {
  now(): Instant { return new Date().toISOString(); }
  today(): DateOnly { return new Date().toISOString().slice(0, 10); }
}

/** Ajoute n jours à une DateOnly, en UTC, sans dépendance externe. */
export function addDays(date: DateOnly, days: number): DateOnly {
  const d = new Date(`${date}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}
```
`payment-terms.ts` :
```ts
import { type DomainResult, ok, err } from './result';
import { type DateOnly, addDays } from './time';
export class PaymentTerms {
  private constructor(
    readonly days: number,
    readonly endOfMonth: boolean,
    readonly label: string,
  ) {}
  static of(p: { days: number; endOfMonth: boolean; label: string }): DomainResult<PaymentTerms> {
    if (!Number.isInteger(p.days) || p.days < 0)
      return err({ code: 'VALIDATION', field: 'paymentTerms.days', message: 'Jours invalides.' });
    if (!p.label.trim()) return err({ code: 'VALIDATION', field: 'paymentTerms.label', message: 'Libellé requis.' });
    return ok(new PaymentTerms(p.days, p.endOfMonth, p.label));
  }
  /** null si non calculable (ex. days=0 sur un terme spécial type "Mandat administratif"). */
  dueDateFrom(issuedAt: DateOnly): DateOnly | null {
    if (this.days <= 0) return null;
    let due = addDays(issuedAt, this.days);
    if (this.endOfMonth) {
      const d = new Date(`${due}T00:00:00.000Z`);
      const last = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0));
      due = last.toISOString().slice(0, 10);
    }
    return due;
  }
}
```
`aggregate.ts` :
```ts
import { type Instant } from './time';
export interface DomainEvent { readonly type: string; readonly occurredAt: Instant; readonly version: number }
export abstract class AggregateRoot<TId> {
  private _events: DomainEvent[] = [];
  protected constructor(readonly id: TId) {}
  protected record(e: DomainEvent): void { this._events.push(e); }
  pullEvents(): DomainEvent[] { const e = this._events; this._events = []; return e; }
}
```
`shared-kernel/index.ts` :
```ts
export * from './result';
export * from './money';
export * from './percentage';
export * from './identifiers';
export * from './contact';
export * from './time';
export * from './payment-terms';
export * from './aggregate';
```

- [ ] **Step 4 : Mettre à jour `src/index.ts`**

```ts
export * from './shared-kernel/index';
export * from './format/money';
```
(Retirer les ré-exports redondants `./shared-kernel/result` et `./shared-kernel/money` désormais couverts par le barrel.)

- [ ] **Step 5 : Run → PASS** (`pnpm --filter @bob/core test src/shared-kernel`)

- [ ] **Step 6 : Commit**

```bash
git add packages/core && git commit -m "feat(core): VOs shared-kernel (Percentage, Siren/Siret Luhn, PaymentTerms, time, AggregateRoot)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 6 : VOs Billing (`VatRate`, `DocNumber`, `Quantity`) + types `LineItem`/`Totals`

**Files :**
- Create: `src/domain/billing/shared/vat-rate.ts`(+test), `doc-number.ts`(+test), `quantity.ts`(+test), `line-item.ts`, `totals.ts`
- Modify: `src/index.ts`

**Interfaces :**
- Produces:
  - `type VatRate = 0 | 2.1 | 5.5 | 10 | 20` ; `const VAT_RATES` ; `function isVatRate(n): n is VatRate`
  - `class DocNumber { value: string; static of(raw): DomainResult<DocNumber>; static format(prefix: 'D'|'F', year: number, seq: number): DocNumber }` (format `X-AAAA-NNNN`)
  - `class Quantity { value: number; static of(v): DomainResult<Quantity> }` (>0, max 3 décimales)
  - `type LineCategory = 'labor'|'supply'|'travel'|'disbursement'|'subscription'`
  - `interface LineInput { label: string; category: LineCategory; qty: number; unit?: string; unitPriceHT: number; vatRate: VatRate }`
  - `interface Totals { ht: number; vatByRate: Record<string, number>; vat: number; ttc: number; netToPay: number }`

- [ ] **Step 1 : Tests (failing)**

`vat-rate.test.ts` :
```ts
import { describe, it, expect } from 'vitest';
import { isVatRate, VAT_RATES } from './vat-rate';
describe('VatRate', () => {
  it('accepte uniquement {0,2.1,5.5,10,20}', () => {
    expect(VAT_RATES).toEqual([0, 2.1, 5.5, 10, 20]);
    expect(isVatRate(10)).toBe(true);
    expect(isVatRate(7)).toBe(false);
  });
});
```
`doc-number.test.ts` :
```ts
import { describe, it, expect } from 'vitest';
import { DocNumber } from './doc-number';
describe('DocNumber', () => {
  it('formate D-2026-0014', () => {
    expect(DocNumber.format('D', 2026, 14).value).toBe('D-2026-0014');
  });
  it('valide un numéro bien formé', () => {
    expect(DocNumber.of('F-2026-0118').ok).toBe(true);
  });
  it('rejette un format invalide', () => {
    expect(DocNumber.of('2026/118').ok).toBe(false);
  });
});
```
`quantity.test.ts` :
```ts
import { describe, it, expect } from 'vitest';
import { Quantity } from './quantity';
describe('Quantity', () => {
  it('refuse <= 0', () => { expect(Quantity.of(0).ok).toBe(false); });
  it('refuse > 3 décimales', () => { expect(Quantity.of(1.2345).ok).toBe(false); });
  it('accepte 2.5', () => { expect(Quantity.of(2.5).ok).toBe(true); });
});
```

- [ ] **Step 2 : Run → FAIL** (`pnpm --filter @bob/core test src/domain/billing`)

- [ ] **Step 3 : Implémenter**

`vat-rate.ts` :
```ts
export type VatRate = 0 | 2.1 | 5.5 | 10 | 20;
export const VAT_RATES: readonly VatRate[] = [0, 2.1, 5.5, 10, 20] as const;
export function isVatRate(n: number): n is VatRate {
  return (VAT_RATES as readonly number[]).includes(n);
}
```
`doc-number.ts` :
```ts
import { type DomainResult, ok, err } from '../../../shared-kernel/result';
export class DocNumber {
  private constructor(readonly value: string) {}
  static of(raw: string): DomainResult<DocNumber> {
    if (!/^[DF]-\d{4}-\d{4,}$/.test(raw))
      return err({ code: 'VALIDATION', field: 'docNumber', message: 'Format attendu X-AAAA-NNNN.' });
    return ok(new DocNumber(raw));
  }
  static format(prefix: 'D' | 'F', year: number, seq: number): DocNumber {
    return new DocNumber(`${prefix}-${year}-${String(seq).padStart(4, '0')}`);
  }
}
```
`quantity.ts` :
```ts
import { type DomainResult, ok, err } from '../../../shared-kernel/result';
export class Quantity {
  private constructor(readonly value: number) {}
  static of(v: number): DomainResult<Quantity> {
    if (!Number.isFinite(v) || v <= 0)
      return err({ code: 'VALIDATION', field: 'qty', message: 'Quantité > 0 requise.' });
    if (Math.round(v * 1000) !== v * 1000)
      return err({ code: 'VALIDATION', field: 'qty', message: 'Max 3 décimales.' });
    return ok(new Quantity(v));
  }
}
```
`line-item.ts` :
```ts
import { type VatRate } from './vat-rate';
export type LineCategory = 'labor' | 'supply' | 'travel' | 'disbursement' | 'subscription';
export interface LineInput {
  label: string;
  category: LineCategory;
  qty: number;
  unit?: string;
  unitPriceHT: number; // centimes
  vatRate: VatRate;
}
```
`totals.ts` :
```ts
export interface Totals {
  ht: number;                          // centimes
  vatByRate: Record<string, number>;   // clé = taux ("10"), valeur = TVA en centimes
  vat: number;
  ttc: number;
  netToPay: number;                    // = ttc, ou acompte si depositPct
}
```

- [ ] **Step 4 : Exporter dans `src/index.ts`**

```ts
export * from './domain/billing/shared/vat-rate';
export * from './domain/billing/shared/doc-number';
export * from './domain/billing/shared/quantity';
export * from './domain/billing/shared/line-item';
export * from './domain/billing/shared/totals';
```

- [ ] **Step 5 : Run → PASS** (`pnpm --filter @bob/core test src/domain/billing`)

- [ ] **Step 6 : Commit**

```bash
git add packages/core && git commit -m "feat(core): VOs billing (VatRate fermé, DocNumber, Quantity) + types LineInput/Totals

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 7 : Entités de requête `Company` & `Customer` (+ `Score`)

**Files :**
- Create: `src/domain/company/company.ts`, `src/domain/customer/customer.ts`, `src/domain/customer/score.ts`
- Modify: `src/index.ts`

**Interfaces :**
- Consumes: `Siren`, `Siret`, `Address`, `Percentage`, `DateOnly` (Tasks 5).
- Produces (méthodes de **requête** utilisées par les services ; les commandes/mutations arrivent au Plan 2) :
  - `type LegalForm`, `type VatRegime`, `type Trade`, `interface InsurancePolicy`
  - `class Company` props lecture + `isBtp(): boolean`, `isVatFranchise(): boolean`, `requiresAutoliquidation(customer): boolean`, `hasValidDecennale(asOf: DateOnly): boolean`, `assertCanIssue(): DomainResult<void>`
  - `type CustomerType = 'b2c'|'b2b'|'b2g'`
  - `class Customer` props lecture + `requiresSirenForEinvoice(): boolean`, `isInternational(): boolean`, `scoreBand(): 'green'|'orange'|'red'`
  - `class Score { value: number; static of(v): DomainResult<Score>; band(): 'green'|'orange'|'red' }`

> Détail des champs : suivre `DOMAIN_MODEL.md §1` et blueprint §4.2. Construire `Company`/`Customer` via un `static of(props)` validant les VO. Pour ce plan, exposer les **getters/méthodes de requête** ci-dessus ; le stockage interne peut être un objet de props validées.

- [ ] **Step 1 : Tests (failing)**

`src/domain/company/company.test.ts` :
```ts
import { describe, it, expect } from 'vitest';
import { Company } from './company';

const baseProps = {
  id: 'c1', name: 'Mercier Plomberie', legalForm: 'EI' as const, siren: '732829320',
  siret: '73282932000074', trade: 'plombier' as const, vatRegime: 'reel_simpl' as const,
  address: { line1: '1 rue X', zip: '92000', city: 'Nanterre' }, rcsOrRm: 'RM 92',
};

describe('Company', () => {
  it('détecte le BTP et la franchise', () => {
    const r = Company.of(baseProps);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.isBtp()).toBe(true);          // plombier ∈ BTP
      expect(r.value.isVatFranchise()).toBe(false);
    }
  });
  it('franchise => isVatFranchise true', () => {
    const r = Company.of({ ...baseProps, vatRegime: 'franchise' });
    if (r.ok) expect(r.value.isVatFranchise()).toBe(true);
  });
  it('assertCanIssue ok quand identité complète', () => {
    const r = Company.of(baseProps);
    if (r.ok) expect(r.value.assertCanIssue().ok).toBe(true);
  });
});
```
`src/domain/customer/customer.test.ts` :
```ts
import { describe, it, expect } from 'vitest';
import { Customer } from './customer';
describe('Customer', () => {
  it('b2b exige un SIREN pour e-invoice', () => {
    const r = Customer.of({ id: 'k1', type: 'b2b', name: 'Durand SARL', address: { line1: 'x', zip: '75001', city: 'Paris' }, score: 96, avgDelayDays: 2, outstanding: 0 });
    if (r.ok) expect(r.value.requiresSirenForEinvoice()).toBe(true);
  });
  it('bande de score', () => {
    const r = Customer.of({ id: 'k2', type: 'b2c', name: 'Martin', address: { line1: 'x', zip: '75001', city: 'Paris' }, score: 62, avgDelayDays: 20, outstanding: 50000 });
    if (r.ok) expect(r.value.scoreBand()).toBe('red');
  });
});
```

- [ ] **Step 2 : Run → FAIL**

- [ ] **Step 3 : Implémenter `score.ts`, `company.ts`, `customer.ts`**

`score.ts` :
```ts
import { type DomainResult, ok, err } from '../../shared-kernel/result';
export type ScoreBand = 'green' | 'orange' | 'red';
export class Score {
  private constructor(readonly value: number) {}
  static of(v: number): DomainResult<Score> {
    if (!Number.isInteger(v) || v < 0 || v > 100)
      return err({ code: 'VALIDATION', field: 'score', message: 'Score 0..100.' });
    return ok(new Score(v));
  }
  band(): ScoreBand { return this.value >= 85 ? 'green' : this.value >= 65 ? 'orange' : 'red'; }
}
```
`company.ts` :
```ts
import { type DomainResult, ok, err } from '../../shared-kernel/result';
import { type Address } from '../../shared-kernel/contact';
import { Siren } from '../../shared-kernel/identifiers';
import { Siret } from '../../shared-kernel/identifiers';
import { type DateOnly } from '../../shared-kernel/time';

export type LegalForm = 'EI' | 'EURL' | 'SASU' | 'SARL' | 'SAS' | 'micro';
export type VatRegime = 'franchise' | 'reel_simpl' | 'reel_normal';
export type Trade = 'plombier' | 'electricien' | 'macon' | 'peintre' | 'paysagiste' | 'consultant' | 'photographe' | 'coach' | 'autre';
export interface InsurancePolicy { insurer: string; policyNo: string; coverage: string; expiresAt: DateOnly }

const BTP_TRADES: ReadonlySet<Trade> = new Set(['plombier', 'electricien', 'macon', 'peintre', 'paysagiste']);

export interface CompanyProps {
  id: string; name: string; legalForm: LegalForm; siren: string; siret: string;
  apeCode?: string; trade: Trade; vatRegime: VatRegime; rcsOrRm?: string; address: Address;
  iban?: string; bic?: string; decennale?: InsurancePolicy;
}

export class Company {
  private constructor(private readonly p: CompanyProps, readonly sirenVo: Siren, readonly siretVo: Siret) {}
  static of(p: CompanyProps): DomainResult<Company> {
    const siren = Siren.of(p.siren); if (!siren.ok) return siren;
    const siret = Siret.of(p.siret); if (!siret.ok) return siret;
    if (siret.value.siren().value !== siren.value.value)
      return err({ code: 'VALIDATION', field: 'siret', message: 'SIRET incohérent avec le SIREN.' });
    return ok(new Company(p, siren.value, siret.value));
  }
  get id(): string { return this.p.id }
  get name(): string { return this.p.name }
  get trade(): Trade { return this.p.trade }
  get vatRegime(): VatRegime { return this.p.vatRegime }
  get address(): Address { return this.p.address }
  get rcsOrRm(): string | undefined { return this.p.rcsOrRm }
  get decennale(): InsurancePolicy | undefined { return this.p.decennale }
  isBtp(): boolean { return BTP_TRADES.has(this.p.trade) }
  isVatFranchise(): boolean { return this.p.vatRegime === 'franchise' }
  requiresAutoliquidation(customer: { type: 'b2c' | 'b2b' | 'b2g'; isSubcontractingBtp?: boolean }): boolean {
    return this.isBtp() && customer.type === 'b2b' && customer.isSubcontractingBtp === true;
  }
  hasValidDecennale(asOf: DateOnly): boolean {
    return !!this.p.decennale && this.p.decennale.expiresAt >= asOf;
  }
  assertCanIssue(): DomainResult<void> {
    if (!this.p.rcsOrRm) return err({ code: 'VALIDATION', field: 'rcsOrRm', message: 'RCS ou RM requis pour émettre.' });
    if (!this.p.address.line1 || !this.p.address.city)
      return err({ code: 'VALIDATION', field: 'address', message: 'Adresse complète requise.' });
    return ok(undefined);
  }
}
```
`customer.ts` :
```ts
import { type DomainResult, ok } from '../../shared-kernel/result';
import { type Address } from '../../shared-kernel/contact';
import { Score, type ScoreBand } from './score';

export type CustomerType = 'b2c' | 'b2b' | 'b2g';
export interface CustomerProps {
  id: string; type: CustomerType; name: string; siren?: string; address: Address;
  email?: string; phone?: string; paymentTermsLabel?: string;
  score: number; avgDelayDays: number; outstanding: number; isInternational?: boolean;
  isSubcontractingBtp?: boolean;
}
export class Customer {
  private constructor(private readonly p: CustomerProps, readonly scoreVo: Score) {}
  static of(p: CustomerProps): DomainResult<Customer> {
    const s = Score.of(p.score); if (!s.ok) return s;
    return ok(new Customer(p, s.value));
  }
  get id(): string { return this.p.id }
  get type(): CustomerType { return this.p.type }
  get name(): string { return this.p.name }
  get siren(): string | undefined { return this.p.siren }
  get outstanding(): number { return this.p.outstanding }
  get avgDelayDays(): number { return this.p.avgDelayDays }
  get isSubcontractingBtp(): boolean { return this.p.isSubcontractingBtp === true }
  isInternational(): boolean { return this.p.isInternational === true }
  requiresSirenForEinvoice(): boolean { return this.p.type === 'b2b' || this.p.type === 'b2g' }
  scoreBand(): ScoreBand { return this.scoreVo.band() }
}
```

- [ ] **Step 4 : Exporter** dans `src/index.ts` (`company`, `customer`, `score`).

- [ ] **Step 5 : Run → PASS** (`pnpm --filter @bob/core test src/domain/company src/domain/customer`)

- [ ] **Step 6 : Commit**

```bash
git add packages/core && git commit -m "feat(core): entités Company & Customer (méthodes de requête) + Score VO

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 8 : Domain service `computeTotals` (+ `roundVatForBase`) — **TEST D'OR chauffe-eau**

**Files :**
- Create: `src/domain/services/compute-totals.ts`, `src/domain/services/compute-totals.test.ts`
- Modify: `src/index.ts`

**Interfaces :**
- Consumes: `LineInput`, `Totals`, `VatRate` (Task 6).
- Produces: `function computeTotals(lines: LineInput[], opts?: { depositPct?: number }): Totals` ; `function roundVatForBase(baseCents: number, rate: VatRate): number`.

- [ ] **Step 1 : Test d'or (failing)**

`compute-totals.test.ts` :
```ts
import { describe, it, expect } from 'vitest';
import { computeTotals } from './compute-totals';
import type { LineInput } from '../billing/shared/line-item';

const chauffeEau: LineInput[] = [
  { label: 'Chauffe-eau 200 L', category: 'supply', qty: 1, unitPriceHT: 80000, vatRate: 10 },
  { label: "Main d'œuvre", category: 'labor', qty: 1, unitPriceHT: 68000, vatRate: 10 },
];

describe('computeTotals — test d’or chauffe-eau', () => {
  it('HT 1480 / TVA10 148 / TTC 1628', () => {
    const t = computeTotals(chauffeEau);
    expect(t.ht).toBe(148000);
    expect(t.vatByRate['10']).toBe(14800);
    expect(t.vat).toBe(14800);
    expect(t.ttc).toBe(162800);
    expect(t.netToPay).toBe(162800);
  });
  it('acompte 30% => net 488,40 €', () => {
    const t = computeTotals(chauffeEau, { depositPct: 30 });
    expect(t.netToPay).toBe(48840);
  });
  it('multi-taux : arrondis indépendants, somme exacte', () => {
    const lines: LineInput[] = [
      { label: 'A', category: 'supply', qty: 1, unitPriceHT: 999, vatRate: 20 },   // TVA 199.8 -> 200
      { label: 'B', category: 'labor', qty: 1, unitPriceHT: 1001, vatRate: 10 },   // TVA 100.1 -> 100
    ];
    const t = computeTotals(lines);
    expect(t.vatByRate['20']).toBe(200);
    expect(t.vatByRate['10']).toBe(100);
    expect(t.vat).toBe(300);
    expect(t.ttc).toBe(999 + 1001 + 300);
  });
});
```

- [ ] **Step 2 : Run → FAIL** (`pnpm --filter @bob/core test src/domain/services/compute-totals.test.ts`)

- [ ] **Step 3 : Implémenter `compute-totals.ts`**

```ts
import type { LineInput } from '../billing/shared/line-item';
import type { Totals } from '../billing/shared/totals';
import type { VatRate } from '../billing/shared/vat-rate';

/** Arrondi commercial (half-up) de la TVA pour une base donnée, en centimes. */
export function roundVatForBase(baseCents: number, rate: VatRate): number {
  return Math.round((baseCents * rate) / 100);
}

/**
 * Totaux d'un document. Arrondi TVA par TAUX (somme des bases d'un même taux),
 * source unique de la politique d'arrondi (cf. blueprint M10).
 */
export function computeTotals(lines: LineInput[], opts?: { depositPct?: number }): Totals {
  const baseByRate = new Map<VatRate, number>();
  let ht = 0;
  for (const l of lines) {
    const base = Math.round(l.qty * l.unitPriceHT);
    ht += base;
    baseByRate.set(l.vatRate, (baseByRate.get(l.vatRate) ?? 0) + base);
  }
  const vatByRate: Record<string, number> = {};
  let vat = 0;
  for (const [rate, base] of baseByRate) {
    const v = roundVatForBase(base, rate);
    vatByRate[String(rate)] = v;
    vat += v;
  }
  const ttc = ht + vat;
  const netToPay = opts?.depositPct ? Math.round((ttc * opts.depositPct) / 100) : ttc;
  return { ht, vatByRate, vat, ttc, netToPay };
}
```

- [ ] **Step 4 : Exporter** `export * from './domain/services/compute-totals';` dans `src/index.ts`.

- [ ] **Step 5 : Run → PASS** (les 3 tests d'or de totaux verts)

- [ ] **Step 6 : Commit**

```bash
git add packages/core && git commit -m "feat(core): computeTotals + roundVatForBase (test d'or chauffe-eau 488,40 €)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 9 : `suggestVatRate` — **TESTS D'OR franchise & autoliquidation**

**Files :**
- Create: `src/domain/services/suggest-vat-rate.ts`, `.test.ts`
- Modify: `src/index.ts`

**Interfaces :**
- Consumes: `Company`, `Customer` (Task 7), `VatRate`, `LineCategory` (Task 6), `DomainResult`.
- Produces: `function suggestVatRate(input: { company: Company; customer: Customer; category: LineCategory; requestedRate?: number; context?: { housingOlderThan2y?: boolean; energyRenovation?: boolean } }): DomainResult<VatRate>`.

> Règles (DOMAIN_MODEL §2 + blueprint §4.4) : franchise → 0 (sinon rejet `franchise_293B`) ; autoliquidation BTP B2B → 0 (sinon rejet `autoliquidation`) ; rénovation énergétique → 5.5 ; travaux + logement > 2 ans → 10 ; défaut → 20. Si `requestedRate` fourni, le valider contre ces invariants.

- [ ] **Step 1 : Tests d'or (failing)**

`suggest-vat-rate.test.ts` :
```ts
import { describe, it, expect } from 'vitest';
import { suggestVatRate } from './suggest-vat-rate';
import { Company } from '../company/company';
import { Customer } from '../customer/customer';

const company = (over: Partial<Parameters<typeof Company.of>[0]> = {}) =>
  (Company.of({ id: 'c1', name: 'Mercier Plomberie', legalForm: 'EI', siren: '732829320', siret: '73282932000074', trade: 'plombier', vatRegime: 'reel_simpl', address: { line1: 'x', zip: '92000', city: 'Nanterre' }, rcsOrRm: 'RM 92', ...over }) as { ok: true; value: Company }).value;
const customer = (over: Partial<Parameters<typeof Customer.of>[0]> = {}) =>
  (Customer.of({ id: 'k1', type: 'b2c', name: 'Martin', address: { line1: 'x', zip: '75001', city: 'Paris' }, score: 80, avgDelayDays: 5, outstanding: 0, ...over }) as { ok: true; value: Customer }).value;

describe('suggestVatRate', () => {
  it('travaux logement >2 ans => 10 (chauffe-eau)', () => {
    const r = suggestVatRate({ company: company(), customer: customer(), category: 'labor', context: { housingOlderThan2y: true } });
    expect(r.ok && r.value).toBe(10);
  });
  it('rénovation énergétique => 5.5', () => {
    const r = suggestVatRate({ company: company(), customer: customer(), category: 'labor', context: { energyRenovation: true } });
    expect(r.ok && r.value).toBe(5.5);
  });
  it('TEST D’OR franchise : régime franchise => 0', () => {
    const r = suggestVatRate({ company: company({ vatRegime: 'franchise' }), customer: customer(), category: 'supply' });
    expect(r.ok && r.value).toBe(0);
  });
  it('TEST D’OR franchise : taux 20 demandé sous franchise => rejet 293B', () => {
    const r = suggestVatRate({ company: company({ vatRegime: 'franchise' }), customer: customer(), category: 'supply', requestedRate: 20 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatchObject({ code: 'VAT_RATE_NOT_APPLICABLE', reason: 'franchise_293B' });
  });
  it('TEST D’OR autoliquidation : sous-traitance BTP B2B => 0', () => {
    const r = suggestVatRate({ company: company(), customer: customer({ type: 'b2b', siren: '732829320', isSubcontractingBtp: true }), category: 'labor' });
    expect(r.ok && r.value).toBe(0);
  });
  it('TEST D’OR autoliquidation : taux !=0 demandé => rejet', () => {
    const r = suggestVatRate({ company: company(), customer: customer({ type: 'b2b', siren: '732829320', isSubcontractingBtp: true }), category: 'labor', requestedRate: 20 });
    if (!r.ok) expect(r.error).toMatchObject({ code: 'VAT_RATE_NOT_APPLICABLE', reason: 'autoliquidation' });
  });
});
```

- [ ] **Step 2 : Run → FAIL**

- [ ] **Step 3 : Implémenter `suggest-vat-rate.ts`**

```ts
import { type DomainResult, ok, err } from '../../shared-kernel/result';
import type { VatRate } from '../billing/shared/vat-rate';
import type { LineCategory } from '../billing/shared/line-item';
import type { Company } from '../company/company';
import type { Customer } from '../customer/customer';

export interface SuggestVatInput {
  company: Company;
  customer: Customer;
  category: LineCategory;
  requestedRate?: number;
  context?: { housingOlderThan2y?: boolean; energyRenovation?: boolean };
}

export function suggestVatRate(input: SuggestVatInput): DomainResult<VatRate> {
  const { company, customer, context, requestedRate } = input;

  // 1. Franchise en base : 0 obligatoire.
  if (company.isVatFranchise()) {
    if (requestedRate !== undefined && requestedRate !== 0)
      return err({ code: 'VAT_RATE_NOT_APPLICABLE', rate: requestedRate, reason: 'franchise_293B' });
    return ok(0);
  }
  // 2. Autoliquidation BTP B2B sous-traitance : 0 obligatoire.
  if (company.requiresAutoliquidation({ type: customer.type, isSubcontractingBtp: customer.isSubcontractingBtp })) {
    if (requestedRate !== undefined && requestedRate !== 0)
      return err({ code: 'VAT_RATE_NOT_APPLICABLE', rate: requestedRate, reason: 'autoliquidation' });
    return ok(0);
  }
  // 3. Suggestion.
  let suggested: VatRate = 20;
  if (context?.energyRenovation) suggested = 5.5;
  else if (context?.housingOlderThan2y) suggested = 10;

  // 4. Surcharge utilisateur autorisée si dans l'ensemble fermé.
  if (requestedRate !== undefined) {
    if (![0, 2.1, 5.5, 10, 20].includes(requestedRate))
      return err({ code: 'VAT_RATE_NOT_APPLICABLE', rate: requestedRate, reason: 'unknown' });
    return ok(requestedRate as VatRate);
  }
  return ok(suggested);
}
```

- [ ] **Step 4 : Exporter** dans `src/index.ts`.

- [ ] **Step 5 : Run → PASS** (tests d'or franchise + autoliquidation verts)

- [ ] **Step 6 : Commit**

```bash
git add packages/core && git commit -m "feat(core): suggestVatRate (tests d'or franchise 293B + autoliquidation BTP)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 10 : `buildMentions` (mentions légales obligatoires)

**Files :**
- Create: `src/domain/services/build-mentions.ts`, `.test.ts`
- Modify: `src/index.ts`

**Interfaces :**
- Consumes: `Company`, `Customer`.
- Produces: `function buildMentions(input: { company: Company; customer: Customer; kind: 'quote' | 'invoice'; asOf: string; validUntilDays?: number }): string[]`.

> Compose (DOMAIN_MODEL §4) : identité + RCS|RM, TVA intracom ou « TVA non applicable, art. 293 B du CGI » (si franchise), pénalités de retard + indemnité forfaitaire 40 € (L441-10), décennale BTP, « Autoliquidation » si sous-traitance BTP B2B, et pour un devis : « Devis gratuit », durée de validité, « Bon pour accord ».

- [ ] **Step 1 : Test (failing)**

`build-mentions.test.ts` :
```ts
import { describe, it, expect } from 'vitest';
import { buildMentions } from './build-mentions';
import { Company } from '../company/company';
import { Customer } from '../customer/customer';

const co = (over = {}) => (Company.of({ id: 'c1', name: 'Mercier Plomberie', legalForm: 'EI', siren: '732829320', siret: '73282932000074', trade: 'plombier', vatRegime: 'reel_simpl', address: { line1: '1 rue X', zip: '92000', city: 'Nanterre' }, rcsOrRm: 'RM 92', decennale: { insurer: 'AXA', policyNo: 'P123', coverage: 'France', expiresAt: '2027-12-31' }, ...over }) as { ok: true; value: Company }).value;
const cu = (over = {}) => (Customer.of({ id: 'k1', type: 'b2c', name: 'Martin', address: { line1: 'x', zip: '75001', city: 'Paris' }, score: 80, avgDelayDays: 5, outstanding: 0, ...over }) as { ok: true; value: Customer }).value;

describe('buildMentions', () => {
  it('inclut indemnité 40 € (L441-10) et RM', () => {
    const m = buildMentions({ company: co(), customer: cu(), kind: 'invoice', asOf: '2026-06-01' });
    expect(m.some((s) => s.includes('40'))).toBe(true);
    expect(m.some((s) => s.includes('L441-10'))).toBe(true);
    expect(m.some((s) => s.includes('RM 92'))).toBe(true);
  });
  it('franchise => mention 293 B', () => {
    const m = buildMentions({ company: co({ vatRegime: 'franchise' }), customer: cu(), kind: 'invoice', asOf: '2026-06-01' });
    expect(m.some((s) => s.includes('293 B'))).toBe(true);
  });
  it('BTP => décennale présente', () => {
    const m = buildMentions({ company: co(), customer: cu(), kind: 'invoice', asOf: '2026-06-01' });
    expect(m.some((s) => s.includes('décennale'))).toBe(true);
  });
  it('devis => Bon pour accord', () => {
    const m = buildMentions({ company: co(), customer: cu(), kind: 'quote', asOf: '2026-06-01', validUntilDays: 30 });
    expect(m.some((s) => s.toLowerCase().includes('bon pour accord'))).toBe(true);
  });
});
```

- [ ] **Step 2 : Run → FAIL**

- [ ] **Step 3 : Implémenter `build-mentions.ts`**

```ts
import type { Company } from '../company/company';
import type { Customer } from '../customer/customer';

export interface BuildMentionsInput {
  company: Company;
  customer: Customer;
  kind: 'quote' | 'invoice';
  asOf: string;
  validUntilDays?: number;
}

export function buildMentions(input: BuildMentionsInput): string[] {
  const { company, customer, kind } = input;
  const m: string[] = [];
  m.push(`${company.name} — ${company.address.line1}, ${company.address.zip} ${company.address.city}`);
  if (company.rcsOrRm) m.push(company.rcsOrRm);

  if (company.isVatFranchise()) {
    m.push('TVA non applicable, art. 293 B du CGI');
  }
  if (company.requiresAutoliquidation({ type: customer.type, isSubcontractingBtp: customer.isSubcontractingBtp })) {
    m.push('Autoliquidation de la TVA (sous-traitance BTP, art. 283-2 nonies du CGI)');
  }

  m.push(
    'En cas de retard de paiement : pénalités au taux légal en vigueur et indemnité forfaitaire de recouvrement de 40 € (art. L441-10 du code de commerce).',
  );

  if (company.isBtp() && company.decennale) {
    const d = company.decennale;
    m.push(`Assurance décennale : ${d.insurer}, police n°${d.policyNo}, couverture ${d.coverage}.`);
  }

  if (kind === 'quote') {
    m.push('Devis gratuit.');
    if (input.validUntilDays) m.push(`Devis valable ${input.validUntilDays} jours.`);
    m.push('Bon pour accord (date + signature) :');
  }
  return m;
}
```

- [ ] **Step 4 : Exporter** dans `src/index.ts`.
- [ ] **Step 5 : Run → PASS**
- [ ] **Step 6 : Commit**

```bash
git add packages/core && git commit -m "feat(core): buildMentions (293B, L441-10 + 40€, décennale, autoliquidation, devis)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 11 : `scoreCustomer`, `einvoiceFor`, `projectCashflow`, `buildRelance`

**Files :**
- Create: `score-customer.ts`(+test), `einvoice-for.ts`(+test), `project-cashflow.ts`(+test), `build-relance.ts`(+test)
- Modify: `src/index.ts`

**Interfaces :**
- Produces:
  - `function scoreCustomer(m: { avgDelayDays: number; outstanding: number; paidOnTimeRatio: number }): number` (0..100)
  - `interface EinvoiceProfile { channel: 'pdp'|'chorus_pro'|'ereporting'; ereportingKind?: 'transactions'|'paiement'; scope?: 'domestic'|'international'; label: string; ready: boolean }` ; `function einvoiceFor(customer: Customer, company: Company): EinvoiceProfile`
  - `type Scenario='optimiste'|'realiste'|'prudent'`, `type Horizon=7|30|60|90`, `interface CashflowProjection { available: number; payout: number; risk: boolean }` ; `function projectCashflow(input: { bankBalance: number; receivables: number; charges: number; vatDue: number }, scenario: Scenario, horizon: Horizon): CashflowProjection`
  - `type RelanceTone='cordial'|'neutre'|'ferme'|'miseendemeure'` ; `interface RelanceMessage { subject: string; body: string }` ; `function buildRelance(input: { customerName: string; docNumber: string; amountCents: number; daysLate: number; tone: RelanceTone; personality: 'Pote'|'Pro'|'Direct' }): RelanceMessage`

- [ ] **Step 1 : Tests (failing)** — un fichier par service.

`score-customer.test.ts` :
```ts
import { describe, it, expect } from 'vitest';
import { scoreCustomer } from './score-customer';
describe('scoreCustomer', () => {
  it('bon payeur proche de 100', () => {
    expect(scoreCustomer({ avgDelayDays: 1, outstanding: 0, paidOnTimeRatio: 1 })).toBeGreaterThanOrEqual(85);
  });
  it('mauvais payeur < 65', () => {
    expect(scoreCustomer({ avgDelayDays: 40, outstanding: 500000, paidOnTimeRatio: 0.2 })).toBeLessThan(65);
  });
  it('borné 0..100', () => {
    const s = scoreCustomer({ avgDelayDays: 999, outstanding: 9_999_999, paidOnTimeRatio: 0 });
    expect(s).toBeGreaterThanOrEqual(0);
    expect(s).toBeLessThanOrEqual(100);
  });
});
```
`einvoice-for.test.ts` :
```ts
import { describe, it, expect } from 'vitest';
import { einvoiceFor } from './einvoice-for';
import { Company } from '../company/company';
import { Customer } from '../customer/customer';
const co = (Company.of({ id: 'c1', name: 'M', legalForm: 'EI', siren: '732829320', siret: '73282932000074', trade: 'plombier', vatRegime: 'reel_simpl', address: { line1: 'x', zip: '92', city: 'N' }, rcsOrRm: 'RM 92' }) as { ok: true; value: Company }).value;
const mk = (over = {}) => (Customer.of({ id: 'k', type: 'b2c', name: 'X', address: { line1: 'x', zip: '75', city: 'P' }, score: 80, avgDelayDays: 0, outstanding: 0, ...over }) as { ok: true; value: Customer }).value;
describe('einvoiceFor', () => {
  it('b2g => chorus_pro', () => { expect(einvoiceFor(mk({ type: 'b2g', siren: '732829320' }), co).channel).toBe('chorus_pro'); });
  it('b2b => pdp', () => { expect(einvoiceFor(mk({ type: 'b2b', siren: '732829320' }), co).channel).toBe('pdp'); });
  it('b2b sans siren => non ready', () => { expect(einvoiceFor(mk({ type: 'b2b' }), co).ready).toBe(false); });
  it('b2c => ereporting transactions', () => { const p = einvoiceFor(mk({ type: 'b2c' }), co); expect(p.channel).toBe('ereporting'); expect(p.ereportingKind).toBe('transactions'); });
});
```
`project-cashflow.test.ts` :
```ts
import { describe, it, expect } from 'vitest';
import { projectCashflow } from './project-cashflow';
describe('projectCashflow', () => {
  const base = { bankBalance: 682000, receivables: 300000, charges: 100000, vatDue: 124000 };
  it('prudent applique ~20% de risque sur les encours', () => {
    const real = projectCashflow(base, 'realiste', 30).available;
    const prud = projectCashflow(base, 'prudent', 30).available;
    expect(prud).toBeLessThan(real);
  });
  it('expose un payout positif quand la dispo est saine', () => {
    expect(projectCashflow(base, 'realiste', 30).payout).toBeGreaterThan(0);
  });
});
```
`build-relance.test.ts` :
```ts
import { describe, it, expect } from 'vitest';
import { buildRelance } from './build-relance';
describe('buildRelance', () => {
  it('mise en demeure cite L441-10 et 40 €', () => {
    const m = buildRelance({ customerName: 'M. Bernard', docNumber: 'F-2026-0118', amountCents: 162800, daysLate: 35, tone: 'miseendemeure', personality: 'Pro' });
    expect(m.body).toContain('L441-10');
    expect(m.body).toContain('40');
  });
  it('ton cordial en personnalité Pote tutoie', () => {
    const m = buildRelance({ customerName: 'Martin', docNumber: 'F-1', amountCents: 5000, daysLate: 7, tone: 'cordial', personality: 'Pote' });
    expect(m.body.toLowerCase()).toMatch(/\bton\b|\btu\b|\bte\b/);
  });
});
```

- [ ] **Step 2 : Run → FAIL** (`pnpm --filter @bob/core test src/domain/services`)

- [ ] **Step 3 : Implémenter les 4 services**

`score-customer.ts` :
```ts
export function scoreCustomer(m: { avgDelayDays: number; outstanding: number; paidOnTimeRatio: number }): number {
  const delayPenalty = Math.min(50, m.avgDelayDays * 1.2);
  const outstandingPenalty = Math.min(20, m.outstanding / 50000); // 1 pt / 500 €, plafond 20
  const punctualityBonus = m.paidOnTimeRatio * 30; // 0..30
  const raw = 70 + punctualityBonus - delayPenalty - outstandingPenalty;
  return Math.max(0, Math.min(100, Math.round(raw)));
}
```
`einvoice-for.ts` :
```ts
import type { Company } from '../company/company';
import type { Customer } from '../customer/customer';

export interface EinvoiceProfile {
  channel: 'pdp' | 'chorus_pro' | 'ereporting';
  ereportingKind?: 'transactions' | 'paiement';
  scope?: 'domestic' | 'international';
  label: string;
  ready: boolean;
}

export function einvoiceFor(customer: Customer, company: Company): EinvoiceProfile {
  const issuerReady = company.assertCanIssue().ok;
  if (customer.type === 'b2g')
    return { channel: 'chorus_pro', label: 'Client public · Chorus Pro', ready: issuerReady && !!customer.siren };
  if (customer.type === 'b2b')
    return { channel: 'pdp', label: 'Facture électronique requise (PDP)', ready: issuerReady && !!customer.siren };
  return {
    channel: 'ereporting',
    ereportingKind: 'transactions',
    scope: customer.isInternational() ? 'international' : 'domestic',
    label: 'Vente à un particulier · e-reporting',
    ready: issuerReady,
  };
}
```
`project-cashflow.ts` :
```ts
export type Scenario = 'optimiste' | 'realiste' | 'prudent';
export type Horizon = 7 | 30 | 60 | 90;
export interface CashflowProjection { available: number; payout: number; risk: boolean }

const RECEIVABLE_FACTOR: Record<Scenario, number> = { optimiste: 1, realiste: 0.9, prudent: 0.8 };

export function projectCashflow(
  input: { bankBalance: number; receivables: number; charges: number; vatDue: number },
  scenario: Scenario,
  horizon: Horizon,
): CashflowProjection {
  const horizonFactor = Math.min(1, horizon / 90); // plus l'horizon est long, plus d'encours rentrent
  const probableReceipts = Math.round(input.receivables * RECEIVABLE_FACTOR[scenario] * horizonFactor);
  const available = input.bankBalance + probableReceipts - input.charges - input.vatDue;
  // "Te verser" = ce qu'on peut sortir en gardant une réserve TVA + marge de sécurité.
  const safetyReserve = Math.round(input.vatDue * 0.5);
  const payout = Math.max(0, available - safetyReserve);
  return { available, payout, risk: available < 0 };
}
```
`build-relance.ts` :
```ts
import { formatEUR } from '../../format/money';
export type RelanceTone = 'cordial' | 'neutre' | 'ferme' | 'miseendemeure';
export interface RelanceMessage { subject: string; body: string }

export function buildRelance(input: {
  customerName: string; docNumber: string; amountCents: number; daysLate: number;
  tone: RelanceTone; personality: 'Pote' | 'Pro' | 'Direct';
}): RelanceMessage {
  const amount = formatEUR(input.amountCents);
  const tu = input.personality === 'Pote';
  const subjectBase = `Facture ${input.docNumber}`;
  switch (input.tone) {
    case 'cordial':
      return {
        subject: `${subjectBase} — petit rappel`,
        body: tu
          ? `Salut ${input.customerName}, petit rappel pour ta facture ${input.docNumber} de ${amount}. Quand tu peux ! Merci 🙂`
          : `Bonjour ${input.customerName}, nous vous rappelons la facture ${input.docNumber} d'un montant de ${amount}. Cordialement.`,
      };
    case 'neutre':
      return {
        subject: `${subjectBase} — relance`,
        body: `Bonjour ${input.customerName}, la facture ${input.docNumber} (${amount}) reste impayée à ce jour (${input.daysLate} jours). Merci de procéder au règlement.`,
      };
    case 'ferme':
      return {
        subject: `${subjectBase} — relance ferme`,
        body: `Bonjour ${input.customerName}, malgré nos relances, la facture ${input.docNumber} (${amount}) demeure impayée depuis ${input.daysLate} jours. Un règlement sous 8 jours est impératif.`,
      };
    case 'miseendemeure':
      return {
        subject: `Mise en demeure — ${subjectBase}`,
        body: `Madame, Monsieur (${input.customerName}), faute de règlement de la facture ${input.docNumber} (${amount}) échue depuis ${input.daysLate} jours, la présente vaut mise en demeure. Conformément à l'art. L441-10 du code de commerce, des pénalités de retard et une indemnité forfaitaire de recouvrement de 40 € sont dues.`,
      };
  }
}
```

- [ ] **Step 4 : Exporter** les 4 services dans `src/index.ts`.
- [ ] **Step 5 : Run → PASS** (toute la suite `src/domain/services` verte)
- [ ] **Step 6 : Commit**

```bash
git add packages/core && git commit -m "feat(core): services scoreCustomer, einvoiceFor, projectCashflow, buildRelance

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 12 : Verrou qualité — typecheck, lint, suite complète, couverture

**Files :** aucun nouveau fichier de production ; vérification globale.

- [ ] **Step 1 : Installer & builder tout**

Run:
```bash
cd "/Users/limameghassene/development/Bob Pro" && pnpm install && pnpm build
```
Expected: build OK pour `@bob/tokens` et `@bob/core`.

- [ ] **Step 2 : Typecheck + lint + tests sur tout le repo**

Run: `pnpm typecheck && pnpm lint && pnpm test`
Expected: 0 erreur TS, 0 erreur lint, **toutes les suites vertes** (tokens + core), dont les **3 tests d'or** (chauffe-eau 488,40 €, franchise 293B, autoliquidation BTP).

- [ ] **Step 3 : Vérifier explicitement les tests d'or**

Run: `pnpm --filter @bob/core test -- -t "test d'or"`
Expected: PASS (≥ 3 tests « test d'or »).

- [ ] **Step 4 : Commit final du plan 1**

```bash
git add -A && git commit -m "chore(core): verrou qualité plan 1 (typecheck+lint+tests verts)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Self-Review (rédacteur du plan)

- **Couverture spec :** ce plan couvre la **DoD #1** (core déterministe 100 % testé + 3 tests d'or) et amorce les fondations (DoD #6 partiel : packages). Les DoD #2 (numérotation no-gap), #3 (flux), #4 (écrans), #5 (Bob), #6 (NestJS), #7 (auth) relèvent des plans 2→7.
- **Pas de placeholder :** chaque step contient le code réel ou la commande exacte.
- **Cohérence des types :** `DomainResult`/`Result`/`ok`/`err` (Task 3) réutilisés partout ; `Money` sans `applyRate` (Task 4) cohérent avec `computeTotals`/`roundVatForBase` (Task 8) ; `VatRate` fermé (Task 6) consommé par `suggestVatRate` (Task 9) et `computeTotals` (Task 8) ; `Company`/`Customer` (Task 7) consommés par les services (Tasks 9-11).
- **Prochain plan :** Plan 2 — agrégats `Quote`/`Invoice`/`Payment`/`RelancePlan`/`EinvoiceTransmission` + 3 machines à états + couche Application (use cases + ports + fixtures).
