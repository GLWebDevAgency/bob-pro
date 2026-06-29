# Bob Pro — Blueprint d'Architecture Final (Tranche Verticale 1)

> Document d'architecture (signatures TS, ports, agrégats, use cases, événements). **Pas de code d'implémentation complet.** Périmètre d'implémentation V1 = mobile-only ; structure de packages présentation-agnostique (web restauré mais reporté, cf. §10 #8). Infra figée. Conforme à `DOMAIN_MODEL.md` (TVA 20/10/5,5/2,1/0, exemple chauffe-eau, mentions L441-10 + indemnité 40 €, cycle e-invoice `issued→transmitted→received→accepted/refused→paid`).
>
> **Version finale** : intègre toutes les corrections *blocker* et *major* des critiques clean-arch/SOLID, DDD/domaine et YAGNI. Les arbitrages sont consignés en §0.

---

## 0. Arbitrage des critiques — corrections actées (lire en premier)

Les trois revues adversariales sont convergentes : l'ossature Clean Arch est saine, mais trois *blockers* structurels contaminent les signatures du domaine/ports, et ~10 *majors* corrigent des fautes de domaine français ou des illusions SOLID. Toutes les corrections justifiées ci-dessous sont **appliquées**. Aucune n'a été écartée pour dégradation de rigueur.

| # | Origine | Correction actée |
|---|---|---|
| **B1** | cleanarch *blocker* — port async dans domaine sync | **L'allocation de numéro est une responsabilité du USE CASE**, jamais de l'agrégat. `Company.allocateNumber` est **supprimé**. Le use case fait `await SequenceCounterPort.allocate(...)` dans le `UnitOfWork`, puis appelle la méthode **pure** `BillingDoc.assignNumber(n: DocNumber): DomainResult<…>` qui valide l'invariant local (format, immuabilité, cohérence kind/année) sans I/O. Le domaine **exprime** l'invariant (validation pure), l'infra le **garantit** (`FOR UPDATE`), le use case **orchestre**. Une méthode de domaine ne touche jamais une `Promise`. |
| **B2** | cleanarch *blocker* + ddd *major* — God-aggregate `BillingDoc` | **Scission en deux agrégats** partageant un kernel commun : **`Quote`** (cycle commercial devis) et **`Invoice`** (cycle commercial facture, sous-kinds `final`/`deposit`/`credit_note`/`situation`). Le **cycle de transmission e-invoice** (`transmit/accept/refuse/received`) sort de Billing et devient l'agrégat **`EinvoiceTransmission`** du contexte **Compliance**. `Payment` et `RelancePlan` deviennent des **agrégats racines séparés** (référence par `docId`), retirés de la frontière Billing. |
| **B3** | cleanarch *major* — parité IA non typée | **L'orchestration agentique sort de la couche Application** : `AskBob` n'est PAS un use case. Il vit dans `packages/ai` et ne dépend que d'un **registre de `Tool`**. Chaque `Tool<In,Out>` est typé comme **wrapper strict d'un `UseCase<In,Out>` existant** (`{ usecase: UseCase<In,Out> }`) → un outil ne **peut pas** exister sans use case correspondant : la parité IA/manuel devient **structurelle**, pas conventionnelle. |
| M1 | ddd *major* — état `received` perdu | **Réintroduit.** Deux machines à états séparées : `Quote.commercialStatus` + `Invoice.commercialStatus` (Billing) et `EinvoiceTransmission.status = issued→transmitted→received→accepted/refused→paid` (Compliance). Liaison par identité (`invoiceId`), jamais fusion d'enum. |
| M2 | ddd *major* — e-reporting sous-spécifié | `einvoiceFor` étendu : sous-type e-reporting **`transactions` vs `paiement`** (services encaissés), distinction **B2C domestique vs international**, et `ready` dérivé de la **complétude émetteur** (`company.assertCanIssue`) **ET** destinataire (SIREN B2B/B2G), pas seulement `customer.siren`. |
| M3 | cleanarch *major* — ports repo jumeaux | Conséquence de B2 : `QuoteRepository.save(q: Quote)` et `InvoiceRepository.save(i: Invoice)` portent des **types distincts** → ISP réel. Les queries de lecture spécialisées (`findOverdue`) passent par des **ports read-side** séparés (CQRS léger). |
| M4 | cleanarch *major* — `UnitOfWork` fuit `tx` | `UnitOfWork.run<T>(work: () => Promise<Result<T,AppError>>)` **n'expose plus aucun `tx`**. Transaction propagée implicitement via **`AsyncLocalStorage`** côté infra ; les repositories résolvent le `tx` ambiant. Aucun type ORM dans `packages/core`. |
| M5 | cleanarch *major* — canaux e-invoice par héritage | **Une seule interface `EInvoiceChannel`** (`transmit`/`getStatus`). Le choix est une vraie **Strategy** : `EInvoiceChannelStrategy.select(profile): EInvoiceChannel`, alimentée par `einvoiceFor()`. Adapters enregistrés dans une **map** `channel→adapter`. Plus de sous-interfaces `PdpPort`/`ChorusProPort`/`EReportingPort`. |
| M6 | cleanarch *major* + ddd — `api-client` couple TanStack | **Scindé** : `packages/api-client` = **pur adapter transport** (fetch/WS, implémente les ports, 0 TanStack). Les hooks **TanStack Query vivent dans `apps/*`** (présentation). |
| M7 | cleanarch *major* — `apps/web` supprimé contredit README | **`apps/web` restauré** dans l'arbre (présentation-agnostique), mais **reporté** hors V1. Le contrat des ports/use cases ne suppose jamais le mobile. |
| M8 | ddd *major* — autoliquidation BTP non modélisée | Invariant ajouté : flag `subcontractingBtp` → `suggestVatRate` renvoie 0, `Invoice.addLine`/`computeTotals` **rejettent tout `vatRate≠0`** (`VAT_RATE_NOT_APPLICABLE reason='autoliquidation'`), `buildMentions` impose « Autoliquidation ». Test d'or dédié. |
| M9 | ddd *minor→appliqué* — franchise non verrouillée | `Quote/Invoice.addLine` valide contre `company.isVatFranchise()` : franchise ⇒ `vatRate` forcé 0 sinon `VAT_RATE_NOT_APPLICABLE reason='franchise_293B'` + mention 293 B. Test d'or. |
| M10 | cleanarch *minor* + ddd — arrondi TVA double source | `Money.applyRate` **supprimé.** `Money` = conteneur de centimes neutre (`add/sub/mulInt`). **Toute** politique d'arrondi TVA (par ligne / par taux) centralisée dans `computeTotals` + helper `roundVatForBase`. Un seul chemin testé. |
| M11 | cleanarch *minor* + ddd — idempotence handlers | **Élevée au rang de contrat de port en V1** (plus un « risque ouvert ») : `ProcessedEventStore` + clé `(eventId, handlerName)`, `EventBus` garantit at-least-once. Effet des **avoirs** sur `outstanding` spécifié (`CreditNoteIssued` ajuste l'encours). |
| M12 | ddd *major* — séries de compteurs | Mapping explicite `DocKind(5)→compteur(3)` via `counterKeyFor(kind)` conforme au modèle : **une** série factures `F-AAAA-NNNN` (invoice+deposit+situation+credit partagent la séquence comptable), une série devis `D-`, conformément à `invoiceCounters:{quote,invoice,credit}`. Avoir = clé `credit` distincte si l'admin l'exige ; **décision actée** : `credit` partage la série facture pour garantir l'unicité de la chaîne (configurable). |
| M13 | ddd *minor* — VO repassés en primitives | Persistance alignée sur le domaine : `vatRate` = CHECK sur ensemble fermé `{0,2.1,5.5,10,20}` ; `depositPct` via `Percentage` ; **`paymentTerms` = VO structuré** `{ days:int; endOfMonth:bool; label:string }` ; `DocNumber` validé par VO à l'écriture. |

**Note YAGNI (consignée, non bloquante)** : la critique pragmatique recommande de ne pas sur-modéliser la V1. On conserve donc *modélisés mais non implémentés* (stubs derrière ports) : `EinvoiceTransmission` réel (PDP/Chorus), e-reporting paiement, situation/retenue de garantie. Le **langage** et les **frontières** sont posés (coût marginal nul) ; l'**implémentation** reste reportée. Les agrégats `Quote`/`Invoice`/`Payment`/`RelancePlan` sont, eux, pleinement implémentés en V1.

Tous les autres points des dossiers convergent et sont intégrés tels quels.

---

## 0.bis Réconciliation pragmatique V1 (revue YAGNI rejouée)

> La revue YAGNI (échouée pendant le workflow) a été **rejouée** et appliquée. Principe directeur : **on garde le langage et les frontières DDD (coût marginal nul), on reporte la machinerie de système distribué.** L'ossature Clean Arch/DDD/SOLID reste intacte ; seule l'**infra runtime** est séquencée plus tard.

**Le premier livrable (ordre §9.2, étapes 1→6) ne provisionne AUCUNE base de données** : `core` + use cases + adapters *fixtures/mocks* + UI + Bob *démo*, flux Devis→signature→facture **fonctionnel hors-ligne**. Postgres arrive à l'étape 7, Mongo/Redis/outbox/idempotence/RLS/pub-sub à l'étape 7-8.

| Décision | Statut V1 | Détail |
|---|---|---|
| Domaine pur déterministe (`computeTotals`+`roundVatForBase`, `suggestVatRate`, `buildMentions`, tests d'or chauffe-eau/franchise/autoliquidation) | **GARDER** | Cœur de valeur & de conformité FR. Zéro simplification. |
| Split `Quote`/`Invoice` + `Payment`/`RelancePlan` ARs séparés (B2) | **GARDER** | Frontières de cohérence légitimes, types repo distincts. |
| Allocation n° par use case + `assignNumber` pure + `FOR UPDATE` no-gap (B1/M12) | **GARDER** | Chaîne sans trou = obligation fiscale (s'applique dès Postgres, étape 7). |
| Parité IA structurelle : `Tool<In,Out>{usecase}`, garde-fous anti-hallucination (B3, §7.3) | **GARDER** | Le différenciateur « précis ». |
| 4 thèmes de marque (marine défaut, foret, graphite, indigo) | **GARDER** | *(override expert du finding YAGNI #11)* — déjà 100% définis dans `tokens.ts`, coût ≈ une map + un Provider. Densité Cockpit/Zen + personnalité incluses. |
| Outbox + EventBus at-least-once + `ProcessedEventStore` (M11) | **REPORTER** (étape 7-8) | V1 : handlers d'events **in-process synchrones dans le même `UnitOfWork`**. Le langage d'events reste ; l'infra async arrive avec le 1er worker appelant un tiers (PDP/email). |
| `UnitOfWork` via AsyncLocalStorage (M4) | **SIMPLIFIER** | Garder le **port** `UnitOfWork.run()` (sans fuite de `tx`) ; impl. V1 = client transactionnel explicite via le scope de requête NestJS. ALS = optimisation ultérieure. Zéro impact sur `core`. |
| 3 bases dès J1 (Postgres+Mongo+Redis) | **REPORTER** | V1 réel (étape 7) = **Postgres seul**. Traces IA démo → JSONB ou néant ; jobs `MarkOverdue`/`ExpireQuotes` → `@nestjs/schedule` cron, pas BullMQ. Mongo+Redis à l'étape 8. |
| Pub/Sub Redis + Socket.IO multi-instance + replay + backpressure (§7.4) | **SIMPLIFIER** | V1 : streaming Bob via **SSE / WS mono-instance** sans Redis adapter ni replay. Contrat d'events `plan|token|card|done` conservé. |
| CQRS read-side séparé (`*ReadModel`, M3) | **SIMPLIFIER** | Garder les *queries* comme use cases tapant le **même repository** (`*QueryService`) ; séparation formelle write/read si un read-model dénormalisé apparaît. ISP préservé. |
| RLS Postgres « option b » + service-role workers (§8) | **SIMPLIFIER** | V1 : **scoping applicatif strict par `companyId` du `Principal`** (anti-IDOR, déjà spécifié). RLS = durcissement étape 8. |
| `EinvoiceTransmission` réel, e-reporting paiement, situation/retenue | **REPORTER** | Modélisés (langage + frontières), **zéro adapter/runtime** en V1 (e-invoicing FR = 2026/27). |

### Definition of Done — tranche 1 (livrable & démontrable)

1. `packages/core` : domaine + use cases **100% testés, 0 I/O, 0 Promise dans le domaine** ; **3 tests d'or verts** (chauffe-eau 488,40 € ; franchise 293B→0 ; autoliquidation BTP→rejet `vatRate≠0`).
2. Numérotation **sans trou** prouvée par test de concurrence simulée ; totaux + mentions **figés à l'émission**.
3. Flux **Devis→signature→facture** bout-en-bout **sur fixtures, hors-ligne**, via mocks de ports (signature native sur place).
4. Écrans **Aujourd'hui / Argent / Clients(+fiche) / Assistant** navigables sur données fixtures, 4 thèmes + densité + personnalité câblés.
5. **Bob en mode démo** : chaque réponse passe par un `Tool` = wrapper d'un use case ; **0 montant inventé** (garde-fou placeholder testé) ; `BOB_AI_MODE=off` masque l'onglet sans perte de fonction.
6. Backend NestJS **Postgres-seul** : modules auth/customers/billing/compliance(stub)/documents(stub)/cashflow/ai ; bascule fixtures→Prisma par tokens DI ; CHECK `vatRate∈{0,2.1,5.5,10,20}`.
7. Auth Supabase JWT + scoping `companyId` par `Principal` (anti-IDOR).

**Reporté sans honte :** outbox, idempotence distribuée, Mongo, Redis, BullMQ, pub/sub WS scalable, RLS, read-models CQRS séparés, intégrations tierces, transmission e-invoice réelle.

---

## 1. Vue d'ensemble & principes directeurs

### 1.1 Les trois invariants stratégiques souverains

1. **Le domaine financier est déterministe et souverain.** Tout montant, taux, mention légale, statut e-invoice, échéance de relance vient d'une **fonction pure** de `packages/core`. Le LLM n'invente **jamais** un chiffre ni une mention.
2. **Parité IA / non-IA — désormais garantie par le type system.** Chaque outil de Bob = un **wrapper strict** d'un use case Application. L'Assistant n'a aucune logique métier propre (B3).
3. **Argent en centimes (int), source de vérité = Postgres.** Le contexte propriétaire d'une donnée est le seul à pouvoir la muter. MongoDB ne stocke que de l'IA/audit, jamais une vérité financière. Format `fr-FR` réservé à la présentation.

### 1.2 Les 4 couches (Clean Architecture) & règle de dépendance

Le code source ne pointe que vers l'intérieur : **Domain ← Application ← (Infrastructure, Interface)**. Inversion par ports déclarés dans Application, implémentés dehors. **Aucune signature de `packages/core` ne contient de `Promise` dans le domaine, ni de type ORM dans les ports** (B1, M4).

```
┌─────────────────────────────────────────────────────────────┐
│ INTERFACE  apps/mobile · apps/web (reporté) · apps/api ctrl/WS│
│ INFRASTRUCTURE  Prisma · Mongo · Redis/BullMQ · LLM · ACL    │
│   ┌───────────────────────────────────────────────────────┐ │
│   │ ORCHESTRATION IA  packages/ai (Bob)  ─ dépend de core ─│ │  ← au-dessus de Application (B3)
│   │   ┌───────────────────────────────────────────────────┐│ │
│   │   │ APPLICATION (packages/core/application)            ││ │
│   │   │   use cases · PORTS · DTOs · Result/AppError       ││ │
│   │   │   ┌─────────────────────────────────────────────┐ ││ │
│   │   │   │ DOMAIN (packages/core/domain)                │ ││ │
│   │   │   │  agrégats (Quote, Invoice, Payment,          │ ││ │
│   │   │   │  RelancePlan, EinvoiceTransmission, Company,  │ ││ │
│   │   │   │  Customer) · VO · events · services purs      │ ││ │
│   │   │   └─────────────────────────────────────────────┘ ││ │
│   │   └───────────────────────────────────────────────────┘│ │
│   └───────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────┘
        Dépendances pointent toutes vers le centre →
```

`packages/core` est le **seul** package contenant des règles métier ; il n'importe aucun framework. `packages/ai` connaît `core` (use cases), jamais l'inverse.

### 1.3 SOLID appliqué (synthèse, corrigée)

- **S** : un use case = une raison de changer. L'allocation de numéro (B1) et la génération de facture depuis devis sont des handlers distincts.
- **O** : Strategy aux 4 points de variation — **taux TVA** (`VatStrategy`), **canal e-invoice** (`EInvoiceChannelStrategy`, M5, **vraie** Strategy via map, pas héritage), **ton de relance** (`RelanceToneStrategy`), **choix modèle IA** (`ModelRoutingStrategy`).
- **L** : tout adapter d'un port est interchangeable sans throw surprise (`DemoLlmAdapter` ↔ `ClaudeGlmRouterAdapter`, `Fixture*Repository` ↔ `Prisma*Repository`).
- **I** : ports petits et ciblés. `QuoteRepository` et `InvoiceRepository` portent des **types distincts** (M3) ; read-side séparé du write-side.
- **D** : les handlers dépendent d'abstractions définies dans `core` ; NestJS branche les adapters via tokens d'injection.

---

## 2. Bounded contexts & context map

Neuf contextes. **Core** = avantage concurrentiel ; **Supporting** = nécessaire non différenciant ; **Generic** = standard/ACL.

| Bounded Context | Classe | Agrégats (corrigés B2) | Responsabilité |
|---|---|---|---|
| **Identity & Company** | Supporting (auth=Generic) | `Company` | Auth (Supabase), profil émetteur, régime TVA, RCS/RM, IBAN, décennale. **N'alloue plus de numéro lui-même** (B1) — porte le port `SequenceCounterPort` via le use case. |
| **Customers / CRM** | Supporting | `Customer` | Carnet, type b2c/b2b/b2g, score & encours **dérivés** (projections via events idempotents). |
| **Billing** | **Core** | **`Quote`**, **`Invoice`** (+ `LineItem`, `Signature`, `Totals` internes) | Cycle commercial devis→signature→facture/acompte/avoir/situation, totaux, numérotation sans trou (à la 1re sortie de draft), machines à états **commerciales**. |
| **Compliance (e-invoicing 2026/27)** | **Core** | **`EinvoiceTransmission`**, `ComplianceChecklist` | Profil e-invoice, mentions légales, format Factur-X/UBL/CII, **cycle de transmission `issued→transmitted→received→accepted/refused→paid`** (M1), e-reporting transactions + paiement (M2), diagnostic. |
| **Payments & Cashflow** | **Core** | **`Payment`** (AR séparé) / read-model `CashflowProjection` | Encaissements, rapprochement, trésorerie prédictive (« le solde ment »). |
| **Relance / Recouvrement** | Supporting | **`RelancePlan`** (AR séparé, réf. `docId`) | Cadence J+7→mise en demeure, tons, L441-10. |
| **Documents / Vault** | Supporting | `Doc`, `Folder` | Coffre-fort, classement, OCR (rattachement en V1, OCR complet reporté). |
| **Assistant / AI (Bob)** | Core produit / *conformist downstream* | `ConversationThread`, `AgentRun` (Mongo) | Conversation, humeurs, streaming, **orchestration de use cases (hors couche Application, B3)**, Model Router, store Mongo. |
| **Subscription & Team** | Generic/Supporting | `Subscription`, `Member` (réservé) | Offres, rôles, paywall (UI reportée). |

### 2.1 Context map (patterns DDD)

```
Identity&Company ──Shared Kernel (Company lecture)──▶ tous
CRM ◀──Open Host (events: InvoiceIssued, PaymentReceived, CreditNoteIssued)── Billing/Payments  (projection score/encours)
Billing ──events (InvoiceIssued)──▶ Compliance ; Compliance possède EinvoiceTransmission (transmit/received/accept/refuse)
Billing ──events──▶ Payments&Cashflow ; ──events (InvoiceLate)──▶ Relance ; ──events──▶ Documents
Assistant ──Conformist (downstream, via registre de Tools = use cases)──▶ TOUS les contextes
Compliance ──ACL + EInvoiceChannelStrategy(map)──▶ [PDP / Chorus Pro / e-reporting]
Payments ──ACL──▶ [Banque DSP2 / Paiement CB]   ;   Documents ──ACL──▶ [OCR/VLM / Storage]
Relance ──ACL──▶ [Email/SMS]   ;   Assistant ──ACL + Model Router──▶ [Claude / GLM]
```

**Lecture clé** : le flux d'autorité va toujours vers le noyau financier (Billing/Compliance/Payments). Tout l'externe est derrière un ACL. **Aucune flèche ne pointe depuis le noyau vers l'Assistant**.

**Frontière Billing ↔ Compliance (tranchée, M1)** : le **statut commercial** (`Invoice.commercialStatus`) appartient à Billing ; le **statut de transmission** (`EinvoiceTransmission.status`) appartient à Compliance. Une facture peut être `paid` commercialement et encore `transmitted`/`received` côté plateforme — état conjoint désormais exprimable. Liaison par identité `invoiceId`, jamais fusion d'enum. `legalMentions` figées dans la facture à l'émission.

---

## 3. Structure du monorepo (pnpm + Turborepo)

```
bob-pro/
├─ pnpm-workspace.yaml  turbo.json  tsconfig.base.json
├─ packages/
│  ├─ tokens/                 # design tokens (0 dép.) — 4 thèmes (marine défaut, foret, graphite, indigo)
│  ├─ i18n/                   # copy FR (microcopy Bob, humeurs Pote/Pro/Direct) (0 dép.)
│  ├─ core/                   # ★ DOMAIN + APPLICATION (0 dép. framework, 0 Promise dans domain)
│  │  └─ src/
│  │     ├─ shared-kernel/    # Money(neutre), Siren, Siret, Address, Percentage, Result, DomainEvent, AggregateRoot, Clock
│  │     ├─ domain/
│  │     │  ├─ company/       # Company (sans allocateNumber), events
│  │     │  ├─ customer/      # Customer, Score, PaymentTerms(VO structuré), services/{scoreCustomer,einvoiceFor}
│  │     │  ├─ billing/
│  │     │  │  ├─ quote/      # Quote (AR), QuoteStatus machine
│  │     │  │  ├─ invoice/    # Invoice (AR), InvoiceStatus machine, sous-kinds final|deposit|credit|situation
│  │     │  │  ├─ shared/     # LineItem, Signature, Totals, vo/{VatRate,DocNumber,Quantity}
│  │     │  │  └─ services/   # computeTotals(+roundVatForBase), suggestVatRate, buildMentions
│  │     │  ├─ payment/       # Payment (AR séparé), events
│  │     │  ├─ dunning/       # RelancePlan (AR séparé), RelanceTone, services/buildRelance
│  │     │  ├─ cashflow/      # services/projectCashflow, Scenario, Horizon, CashflowProjection (read-model)
│  │     │  └─ compliance/    # EinvoiceTransmission (AR), TransmissionStatus, EinvoiceProfile, mentions, calendar2026
│  │     ├─ application/
│  │     │  ├─ ports/         # repositories.ts, read-models.ts, services.ts, tokens.ts
│  │     │  ├─ billing/ customers/ payments/ cashflow/ compliance/ relance/ documents/ identity/
│  │     │  ├─ result.ts      # Result<T,E>, AppError, DomainError
│  │     │  └─ dtos/ mappers/
│  │     └─ fixtures/         # DATA_CLIENTS, DOCS_FOLDERS, CASH, SCORES, SCEN, TONES (Mercier Plomberie + 6 clients)
│  ├─ ai/                     # ★ orchestration agentique (dép. core) — router, tools(=use cases), context, agent, eval
│  │  └─ src/{ports,router,tools,context,agent,eval}/
│  ├─ ui/                     # primitives partagées (contrats + impl. *.native.tsx / *.web.tsx) — Button, Card, MoneyText…
│  └─ api-client/             # ★ PUR adapter transport HTTP/WS (impl. ports, 0 TanStack) (M6)
└─ apps/
   ├─ mobile/                 # Expo / RN / TS — écrans, hooks TanStack Query, ThemeProvider, DI client
   ├─ web/                    # Next.js App Router — REPORTÉ hors V1, structure présente (M7)
   └─ api/                    # NestJS (Railway) — modules par BC, adapters, controllers, WS gateways
      └─ src/
         ├─ persistence/prisma/   # adapters Prisma (impl. ports) + UnitOfWork (AsyncLocalStorage)
         ├─ persistence/mongo/    # ThreadStore, AgentTraceStore, AuditTrailStore, ProcessedEventStore
         ├─ cache/redis/  queues/bullmq/  ai-infra/adapters/  auth/  http/  ws/
         └─ {auth,company,customers,billing,compliance,cashflow,documents,relance,ai,subscription}/
```

---

## 4. Domaine (agrégats, VO, events, services)

Règles : un agrégat = une frontière de cohérence = une transaction ; références inter-agrégats **par identité** ; méthodes intentionnelles retournant des Domain Events ; VO immuables auto-validants via `static of()` → `DomainResult<T>` ; **aucune `Promise` dans le domaine**.

### 4.1 Shared kernel

```ts
export type DomainResult<T> = { ok: true; value: T } | { ok: false; error: DomainError };

export class Money {                       // centimes (int) — conteneur NEUTRE (M10)
  private constructor(readonly cents: number, readonly currency: 'EUR') {}
  static of(cents: number, c?: 'EUR'): DomainResult<Money>;   // Number.isSafeInteger
  add(o: Money): Money; sub(o: Money): Money;                 // devises identiques
  mulInt(n: number): Money;                                   // quantité entière uniquement
  // PAS d'applyRate ici (M10) — l'arrondi TVA vit UNIQUEMENT dans computeTotals.
  // PAS de format ici → core/format/money.ts fait fr-FR (1 628,00 €, espace fine, tabular-nums)
}
export class Percentage { static of(v: number): DomainResult<Percentage>; } // borné 0..100 (M13)
export class Siren { static of(raw: string): DomainResult<Siren>; }   // 9 chiffres + Luhn
export class Siret { static of(raw: string): DomainResult<Siret>; siren(): Siren; }
export class PaymentTerms {                 // VO structuré (M13) — remplace string libre
  static of(p: { days: number; endOfMonth: boolean; label: string }): DomainResult<PaymentTerms>;
  dueDateFrom(issuedAt: DateOnly): DateOnly | null;  // null si non calculable (ex. "Mandat administratif")
}
export abstract class AggregateRoot<TId> { pullEvents(): DomainEvent[]; }
```

### 4.2 Agrégats & invariants clés (corrigés B1/B2)

```ts
// ── Company (AR) — NE possède PLUS allocateNumber (B1) ──
export class Company extends AggregateRoot<CompanyId> {
  isBtp(): boolean; isVatFranchise(): boolean;                        // 293 B / décennale / autoliquidation
  assertCanIssue(): DomainResult<void>;                               // I-C3 identité complète (SIREN/SIRET+adresse+RCS|RM)
  changeVatRegime(next: VatRegime): DomainResult<CompanyVatRegimeChanged>;
  hasValidDecennale(asOf: DateOnly): boolean;                         // I-C4 BTP décennale présente & non expirée
}
// I-C2 cohérence siren/siret. La numérotation n'est PLUS un invariant porté par Company.

// ── Quote (AR) — cycle COMMERCIAL devis (B2) ──
export class Quote extends AggregateRoot<QuoteId> {
  static compose(p: ComposeQuoteCmd): DomainResult<Quote>;           // status=draft, sans numéro
  addLine/updateLine/removeLine(...): DomainResult<...>;             // I-B4b édition en draft uniquement ;
                                                                      // valide franchise→0 (M9) & autoliq→0 (M8)
  setDeposit(pct: Percentage | null): DomainResult<void>;            // I-B5
  totals(): Totals;                                                   // dérivé via computeTotals, jamais stocké libre
  assignNumber(n: DocNumber): DomainResult<DocumentNumbered>;        // PURE (B1) — alloué par le use case, validé ici
  send(): DomainResult<QuoteSent>;                                    // draft→sent (exige number déjà assigné)
  markViewed(at: Instant): DomainResult<QuoteViewed>;
  sign(sig: Signature): DomainResult<QuoteSigned>;                    // I-B8 signature liante
  refuse(): DomainResult<QuoteRefused>;
  markExpired(now: Instant): DomainResult<QuoteExpired>;             // job: validUntil<now & status∈{sent,viewed}
}
// QuoteStatus: draft → sent → viewed → signed | refused | expired

// ── Invoice (AR) — cycle COMMERCIAL facture (B2) ──
export class Invoice extends AggregateRoot<InvoiceId> {
  static fromSignedQuote(q: Quote, mode:'deposit'|'final', company: Company): DomainResult<Invoice>; // draft
  static composeStandalone(p: ComposeInvoiceCmd): DomainResult<Invoice>;
  static creditNoteFor(inv: Invoice, reason: string): DomainResult<Invoice>;   // kind=credit_note
  addLine/updateLine(...): DomainResult<...>;                        // franchise→0 (M9), autoliq→0 (M8) verrouillés
  totals(): Totals;
  assignNumber(n: DocNumber): DomainResult<DocumentNumbered>;        // PURE (B1)
  issue(company: Company, terms: PaymentTerms, at: Instant): DomainResult<InvoiceIssued>; // →issued, gèle totals+mentions
  issueBalance(deposit: Invoice): DomainResult<InvoiceIssued>;       // I-B6 solde = TTC − acompte
  registerPayment(p: PaymentRef): DomainResult<PaymentReceived | InvoicePartiallyPaid>; // I-B9
  markLate(now: Instant): DomainResult<InvoiceLate>;
  cancel(reason: string): DomainResult<InvoiceCancelled>;
}
// InvoiceStatus (commercial): draft → issued → partially_paid → paid ; + late ; + cancelled
// kind: 'final' | 'deposit' | 'credit_note' | 'situation'
// I-B1 numéro à la 1re sortie de draft, immuable ; I-B3 lignes valides ;
// I-B7 dueAt = issuedAt + paymentTerms (M13) ; pas de DELETE → cancel + avoir.

// ── EinvoiceTransmission (AR, Compliance) — cycle TRANSMISSION (M1) ──
export class EinvoiceTransmission extends AggregateRoot<TransmissionId> {
  static open(invoiceId: InvoiceId, profile: EinvoiceProfile): DomainResult<EinvoiceTransmission>; // issued
  transmit(receipt: ChannelReceipt): DomainResult<InvoiceTransmitted>;        // issued→transmitted
  acknowledgeReceived(): DomainResult<InvoiceReceived>;                       // transmitted→received (M1)
  accept(): DomainResult<InvoiceAccepted>;                                    // received→accepted
  refuse(reason: string): DomainResult<InvoiceRefused>;                       // received→refused
  markPaidOnPlatform(): DomainResult<...>;                                    // →paid (volet e-reporting paiement, M2)
}
// TransmissionStatus: issued → transmitted → received → accepted | refused → paid

// ── Customer (AR) — score/encours dérivés (M11) ──
export class Customer extends AggregateRoot<CustomerId> {
  applyScore(s: Score): void; scoreBand(): 'green'|'orange'|'red';   // I-CU2 ≥85/65–84/<65
  increaseOutstanding(m: Money): DomainResult<void>;                 // event InvoiceIssued (handler idempotent)
  decreaseOutstanding(m: Money): DomainResult<void>;                 // event PaymentReceived (handler idempotent)
  adjustForCreditNote(m: Money): DomainResult<void>;                 // event CreditNoteIssued (M11)
  requiresSirenForEinvoice(): boolean;                              // I-CU1 b2b/b2g exigent SIREN
}
// I-CU4 outstanding ≥ 0 (clamp = garde documentée, pas correctif silencieux — M11)

export class Payment extends AggregateRoot<PaymentId> {              // AR séparé (B2)
  static record(p: { invoiceId; amount: Money; method; at }): DomainResult<Payment>; // immuable, >0
}
export class RelancePlan extends AggregateRoot<RelancePlanId> {      // AR séparé, réf. docId (B2)
  static defaultCadence(issuedAt: DateOnly): RelanceStep[];          // J+7 cordial→J+15 neutre→J+30 ferme→MED
  escalate(): RelanceTone;                                           // I-R1 monotone ; MED ⇒ L441-10 + 40 €
}
```

### 4.3 Machines à états SÉPARÉES (M1)

```
QUOTE (commercial):
  draft ─send→ sent ─markViewed→ viewed ─sign→ signed
                          └─refuse→ refused ;  sent|viewed ─(validUntil<now, job)→ expired

INVOICE (commercial):
  draft ─issue→ issued ─registerPayment→ partially_paid ─registerPayment→ paid
         issued|partially_paid ─markLate→ late ; (tout sauf paid) ─cancel→ cancelled

EINVOICE_TRANSMISSION (Compliance, M1 — 'received' réintroduit):
  issued ─transmit→ transmitted ─acknowledgeReceived→ received ─accept→ accepted
                                                              └─refuse→ refused ; (accepted) ─→ paid
```
Trois tables de transitions pures et exhaustives ; toute combinaison absente → `InvalidTransitionError`. Le passage `Quote.signed → Invoice` se fait par **event** `QuoteSigned` → handler `GenerateInvoiceFromQuote` (pas une méthode de `Quote`).

### 4.4 Domain services purs (le noyau déterministe anti-hallucination)

```ts
suggestVatRate(company, customer, line, ctx): VatRate;
  // franchise → 0 (293 B) ; autoliquidation BTP B2B → 0 (M8) ;
  // réno énergétique → 5.5 ; travaux + logement >2 ans → 10 (chauffe-eau) ; défaut → 20

computeTotals(lines, { depositPct? }): Totals;
  // arrondi UNIQUE via roundVatForBase, PAR LIGNE et PAR TAUX (M10), centimes
  // TEST D'OR chauffe-eau: HT 148000 / TVA10 14800 / TTC 162800 ; acompte 30% → netToPay 48840 (488,40 €)
  // TEST D'OR franchise: ligne tentée à 20% sur company franchise → DomainError VAT_RATE_NOT_APPLICABLE
  // TEST D'OR autoliquidation: vatRate≠0 en sous-traitance BTP B2B → DomainError
  // TEST multi-taux: deux taux distincts → arrondis indépendants, somme exacte

buildMentions(company, customer, doc): string[];
  // identité, RCS|RM, TVA|293 B, n° séquentiel, pénalités + 40 € (L441-10),
  // décennale BTP (assureur/police/couverture), Autoliquidation si sous-traitance BTP B2B (M8),
  // devis (validité, "Devis gratuit", "Bon pour accord")

scoreCustomer({ avgDelayDays, outstanding, history }): Score;       // 0..100, bandes 85/65
einvoiceFor(customer, company): EinvoiceProfile;                    // M2 (cf. ci-dessous)
projectCashflow({ bankBalance, receivables, charges, vatDue }, scenario, horizon): CashflowProjection;
  // dispo = solde + encaissements_probables − charges − TVA ; 'prudent' ~20% risque impayé ; expose "te verser"
buildRelance(doc, customer, tone, personality): RelanceMessage;     // 4 tons ; MED → L441-10 + 40 €
```

**`einvoiceFor` étendu (M2)** :

```ts
interface EinvoiceProfile {
  channel: 'pdp' | 'chorus_pro' | 'ereporting';
  ereportingKind?: 'transactions' | 'paiement';   // services encaissés → volet paiement (M2)
  scope?: 'domestic' | 'international';            // B2C/e-reporting (M2)
  label: string;
  ready: boolean;                                  // dérivé émetteur ET destinataire (M2)
}
function einvoiceFor(customer: Customer, company: Company): EinvoiceProfile {
  const issuerReady = company.assertCanIssue().ok;                 // complétude émetteur (M2)
  if (customer.type === 'b2g')
    return { channel:'chorus_pro', label:'Client public · Chorus Pro', ready: issuerReady && !!customer.siren };
  if (customer.type === 'b2b')
    return { channel:'pdp', label:'Facture électronique requise (PDP)', ready: issuerReady && !!customer.siren };
  // B2C / international → e-reporting (transactions, + paiement si service encaissé)
  return { channel:'ereporting', ereportingKind:'transactions',
           scope: customer.isInternational() ? 'international' : 'domestic',
           label:'Vente à un particulier · e-reporting', ready: issuerReady };
}
```

Ces fonctions sont les **seules** sources des montants et mentions. Le mode démo réutilise exactement les mêmes.

### 4.5 Domain events (émis par agrégats, publiés après commit via outbox)

`QuoteComposed`, `DocumentNumbered`, `QuoteSent`, `QuoteViewed`, `QuoteSigned`, `QuoteRefused`, `QuoteExpired`, `InvoiceIssued`, `InvoicePartiallyPaid`, `PaymentReceived`, `InvoiceLate`, `InvoiceCancelled`, **`CreditNoteIssued`** (M11), **`InvoiceTransmitted`**, **`InvoiceReceived`** (M1), `InvoiceAccepted`, `InvoiceRefused`, `RelanceScheduled`, `RelanceSent`, `CustomerScored`, `CompanyVatRegimeChanged`, `DocumentClassified`, `DiagnosticCompleted`.

Cohérence **intra-agrégat synchrone** ; **inter-agrégats via events** (ex. `InvoiceIssued` → handler → `Customer.increaseOutstanding`). Le domaine **émet**, n'**écoute** pas. Tout handler est **idempotent par contrat** (M11) : reçoit un `ProcessedEventStore`, clé `(eventId, handlerName)`, `event.version` pour l'évolution de schéma.

---

## 5. Application (use cases + ports)

CQRS léger : `interface UseCase<In, Out> { execute(input: In): Promise<Result<Out, AppError>> }`. In/Out = DTOs plats, jamais d'entités exposées. **Les outils de Bob = wrappers stricts de ces use cases (B3, cf. §7).**

### 5.1 Catalogue de use cases (tranche 1)

**Billing** : `CreateQuoteCommand`, `UpdateQuoteLinesCommand`, `SuggestVatRateQuery`, `SendQuoteCommand` (alloue le n° devis), `SignQuoteCommand`, `RefuseQuoteCommand`, `GenerateInvoiceFromQuote` (handler de `QuoteSigned`), `IssueInvoiceCommand` (alloue le n° facture), `IssueBalanceInvoiceCommand`, `IssueCreditNoteCommand`, `BuildMentionsQuery`, `GetQuoteByIdQuery`, `ListQuotesQuery`, `GetInvoiceByIdQuery`, `ListInvoicesQuery`.
**Compliance** : `TransmitEInvoiceCommand`, `PollEInvoiceStatusQuery`, `RunDiagnostic2026` (reporté UI).
**Payments & Cashflow** : `RegisterPaymentCommand`, `GetCashflowProjectionQuery`, `GetRealAvailableQuery` (« le solde ment »), `ComputePayoutQuery` (« te verser »), `ToggleVatReserveCommand`.
**Customers & Relance** : `CreateCustomerCommand`, `UpdateCustomerCommand`, `ScoreCustomerQuery`, `ListCustomersQuery`, `GetCustomerFileQuery`, `ScheduleRelanceCommand`, `PreviewRelanceQuery`, `SendRelanceCommand`.
**Documents & Auth** : `ScanDocumentCommand` (stub), `GetVaultQuery`, `GetDocumentQuery`, `LoginCommand`, `GetSessionQuery`.

> `AskBob` **n'est pas ici** (B3) — c'est l'orchestrateur de `packages/ai` (§7).

### 5.2 Ports — repositories (write-side, un par agrégat — M3)

```ts
export interface CompanyRepository       { findById(id): Promise<Company|null>; save(c: Company): Promise<void>; }
export interface CustomerRepository      { findById(id); save(c: Customer): Promise<void>; }
export interface QuoteRepository         { findById(id): Promise<Quote|null>; save(q: Quote): Promise<void>; }      // type Quote (M3)
export interface InvoiceRepository       { findById(id): Promise<Invoice|null>; save(i: Invoice): Promise<void>; }  // type Invoice (M3)
export interface PaymentRepository       { save(p: Payment): Promise<void>; }
export interface RelancePlanRepository   { findByDoc(docId); save(p: RelancePlan): Promise<void>; }
export interface EinvoiceTransmissionRepository { findByInvoice(id); save(t: EinvoiceTransmission): Promise<void>; }

// Read-side (CQRS) — queries spécialisées, séparées du write-side (M3)
export interface BillingReadModel  { listQuotes(companyId, f?); listInvoices(companyId, f?); findOverdue(companyId, asOf); }
export interface CustomerReadModel { listByCompany(companyId, f?); getFile(customerId); }
export interface DocumentReadModel { listFolders(companyId); findById(id); }

// Allocation de numéro — atomique en infra, appelée par le USE CASE (B1)
export interface SequenceCounterPort {
  allocate(input: { companyId; counterKey: 'quote'|'invoice'|'credit'; fiscalYear: number })
    : Promise<{ sequence: number; formatted: DocumentNumber }>;     // FOR UPDATE
}
// counterKeyFor(kind: DocKind): 'quote'|'invoice'|'credit'  (M12 — mapping 5→3)

// Transaction SANS fuite de tx (M4) — propagation implicite via AsyncLocalStorage côté infra
export interface UnitOfWork { run<T>(work: () => Promise<Result<T,AppError>>): Promise<Result<T,AppError>>; }

// Idempotence des handlers d'events — contrat de port (M11)
export interface ProcessedEventStore {
  alreadyProcessed(eventId: string, handlerName: string): Promise<boolean>;
  markProcessed(eventId: string, handlerName: string): Promise<void>;
}
```

### 5.3 Ports — services externes & capacités (chacun a un mock branchable)

```ts
// Canaux e-invoice : UNE interface + Strategy par map (M5) — plus d'héritage PdpPort/ChorusProPort/EReportingPort
export interface EInvoiceChannel {
  readonly channel: 'pdp' | 'chorus_pro' | 'ereporting';
  transmit(p: EInvoicePayload): Promise<Result<ChannelReceipt, EInvoiceError>>;
  getStatus(id): Promise<EInvoiceStatus>;
}
export interface EInvoiceChannelStrategy { select(profile: EinvoiceProfile): EInvoiceChannel; } // map channel→adapter

export interface BankAggregationPort { getBalance(companyId); listTransactions(companyId, since); } // DSP2
export interface PaymentLinkPort  { createPaymentLink(invoiceId, amount: Money); capture(ref); }
export interface OcrPort          { extract(fileRef): Promise<Result<OcrResult,OcrError>>; }
export interface PdfFacturXPort   { render(model): Promise<StorageRef>; }
export interface ESignaturePort   { createSession(quoteId); finalize(sessionId, sig); }
export interface NotificationPort { send(n: Notification): Promise<void>; }
export interface StoragePort      { put(file); getUrl(ref); }
export interface AuthPort         { verify(token): Promise<Session|null>; }
export interface ClockPort        { now(): Instant; today(): DateOnly; }
export interface IdGeneratorPort  { newId(): string; }                  // uuid v7
export interface SchedulerPort    { schedule(job); cancel(id); }        // BullMQ
export interface EventBusPort     { publish(events: DomainEvent[]): Promise<void>; }  // outbox → Redis/WS, at-least-once
// Store IA/audit (Mongo) :
export interface ThreadRepository { append(threadId, msg); load(threadId); }
export interface AgentTraceStore  { record(trace: AgentTrace): Promise<void>; }
```

### 5.4 Erreurs typées (`Result`, pas d'exceptions de flux)

```ts
export type Result<T,E> = { ok:true; value:T } | { ok:false; error:E };
export type DomainError =
  | { code:'MISSING_SIREN_FOR_EINVOICE'; customerId:string }
  | { code:'QUOTE_ALREADY_SIGNED'; quoteId:string }
  | { code:'VAT_RATE_NOT_APPLICABLE'; rate:number; reason:'franchise_293B'|'autoliquidation'|'unknown' } // M8/M9
  | { code:'DOCUMENT_NUMBER_GAP'; expected:string; got:string }
  | { code:'INVALID_TRANSITION'; from:string; to:string }
  | { code:'INSUFFICIENT_CASHFLOW'; available:number; required:number };
export type AppError =
  | { kind:'domain'; error:DomainError } | { kind:'not_found'; entity:string; id:string }
  | { kind:'forbidden'; reason:string } | { kind:'validation'; issues:ValidationIssue[] }
  | { kind:'dependency'; port:string; cause:string };
```
Mapping (couche Interface) : `validation`→422, `not_found`→404, `forbidden`→403, `domain`→409 (+ microcopy Bob non culpabilisante), `dependency`→502/503 (retryable), exception non typée→500.

---

## 6. Infrastructure (NestJS, Prisma/Postgres, Mongo, Redis/BullMQ)

Un module NestJS par bounded context. Le domaine ne contient aucun décorateur Nest ; les ports sont liés aux adapters via **tokens d'injection** (`Symbol`), basculables mock/réel par env.

```ts
// apps/api/src/billing/billing.module.ts (extrait)
{ provide: QUOTE_REPOSITORY,   useClass: cfg.fixtures ? FixtureQuoteRepository   : PrismaQuoteRepository },
{ provide: INVOICE_REPOSITORY, useClass: cfg.fixtures ? FixtureInvoiceRepository : PrismaInvoiceRepository },
{ provide: LLM_PORT,           useClass: cfg.aiDemo   ? DemoLlmAdapter           : ClaudeGlmRouterAdapter },
{ provide: EINVOICE_STRATEGY,  useClass: EInvoiceChannelStrategyImpl },  // map channel→adapter (M5)
{ provide: UNIT_OF_WORK,       useClass: PrismaUnitOfWork },             // AsyncLocalStorage (M4)
{ provide: PROCESSED_EVENTS,   useClass: MongoProcessedEventStore },     // idempotence (M11)
{ provide: CLOCK_PORT,         useClass: SystemClock },
```
Un `InfrastructureModule` `@Global` fournit les ports techniques transverses (`ClockPort`, `IdGeneratorPort`, `EventBusPort`, `SchedulerPort`, `StoragePort`, `UnitOfWork`, `ProcessedEventStore`). Controllers : valident le DTO (Zod) → instancient la command → `handler.execute()` → `Result` mappé par un `ResultInterceptor`. **Aucune règle métier dans le controller.**

### 6.1 Postgres (Supabase) = vérité financière

- Argent en `Int` (centimes). Multi-tenant par `company_id` + RLS (option **b**, respectée sur chemins user ; workers service-role + filtrage applicatif strict par `companyId` de l'event). Pas de `DELETE` sur docs émis (`cancel` + avoir). Totaux & mentions **figés** à l'émission + revalidés au load (anti-corruption repo). IDs `uuid` v7 via `IdGeneratorPort`.

**Numérotation sans trou (B1, M12)** : **pas** de `serial`/`IDENTITY`. Le **use case** appelle `SequenceCounterPort.allocate` → `SELECT … FOR UPDATE` sur `document_counters` **dans le `UnitOfWork`**, puis `aggregate.assignNumber(n)` (pure), puis `save` + outbox **dans la même transaction**. Numéro attribué à la **1re sortie de `draft`**. `FOR UPDATE` sérialise les émissions concurrentes. Politique **no-gap > no-waste** : un numéro alloué est consommé (tracé en audit) même si l'émission échoue. Mapping `counterKeyFor(kind)` : `quote→'quote'` ; `invoice|deposit_invoice|situation|credit_note → 'invoice'` (série factures unique) — sauf si la company configure une série `credit` distincte (M12).

### 6.2 Extrait `schema.prisma` (aligné VO — M13)

```prisma
datasource db { provider="postgresql"; url=env("DATABASE_URL"); directUrl=env("DIRECT_URL") }

enum LegalForm { EI EURL SASU SARL SAS micro }
enum VatRegime { franchise reel_simpl reel_normal }
enum CustomerType { b2c b2b b2g }
enum DocKind { quote invoice deposit_invoice credit_note situation }
enum QuoteStatus { draft sent viewed signed refused expired }
enum InvoiceStatus { draft issued partially_paid paid late cancelled }              // commercial (M1)
enum TransmissionStatus { issued transmitted received accepted refused paid }        // Compliance (M1)
enum LineCategory { labor supply travel disbursement subscription }
enum PaymentMethod { card transfer cash }
enum EinvoiceChannel { pdp chorus_pro ereporting }
enum DunningStep { j7_cordial j15_neutre j30_ferme mise_en_demeure }
enum Role { admin member }

model Company {
  id String @id @default(dbgenerated("gen_random_uuid()")) @db.Uuid
  ownerUserId String @db.Uuid
  name String; legalForm LegalForm; siren String @db.Char(9); siret String @unique @db.Char(14)
  apeCode String?; trade String; vatRegime VatRegime; rcsOrRm String?
  addrLine1 String; addrZip String; addrCity String; iban String?; bic String?
  insurerName String?; policyNo String?; coverage String?; policyExpiresAt DateTime?
  customers Customer[]; quotes Quote[]; invoices Invoice[]; payments Payment[]; counters DocumentCounter[]
  @@index([ownerUserId]) @@map("companies")
}

model Customer {
  id String @id @default(dbgenerated("gen_random_uuid()")) @db.Uuid
  companyId String @db.Uuid; type CustomerType; name String; siren String? @db.Char(9); isInternational Boolean @default(false)
  addrLine1 String; addrZip String; addrCity String; email String?; phone String?
  ptDays Int @default(30); ptEndOfMonth Boolean @default(false); ptLabel String @default("Paiement à 30 jours") // PaymentTerms VO (M13)
  score Int @default(0); avgDelayDays Int @default(0); outstanding Int @default(0)   // projections dérivées
  @@unique([companyId, siren], name:"uniq_customer_siren_per_company")
  @@index([companyId]) @@index([companyId, type]) @@map("customers")
}

model Quote {
  id String @id @default(dbgenerated("gen_random_uuid()")) @db.Uuid
  companyId String @db.Uuid; customerId String @db.Uuid; status QuoteStatus @default(draft)
  number String?; fiscalYear Int?; sequence Int?            // NULL tant que draft
  sentAt DateTime?; validUntil DateTime?; depositPct Int?    // depositPct via Percentage (M13)
  totalsHt Int @default(0); totalsVat Int @default(0); totalsTtc Int @default(0); totalsNetToPay Int @default(0)
  vatByRate Json @default("{}"); legalMentions String[] @default([])
  lines LineItem[] @relation("QuoteLines"); signature Signature?
  @@unique([companyId, "quote", fiscalYear, sequence], name:"uniq_quote_seq")  // série devis
  @@unique([companyId, number], name:"uniq_quote_number")
  @@index([companyId, status]) @@index([companyId, customerId]) @@map("quotes")
}

model Invoice {
  id String @id @default(dbgenerated("gen_random_uuid()")) @db.Uuid
  companyId String @db.Uuid; customerId String @db.Uuid; kind DocKind; status InvoiceStatus @default(draft)
  number String?; fiscalYear Int?; sequence Int?            // série FACTURE unique (M12)
  issuedAt DateTime?; dueAt DateTime?; parentQuoteId String? @db.Uuid; depositPct Int?; creditOfInvoiceId String? @db.Uuid
  totalsHt Int @default(0); totalsVat Int @default(0); totalsTtc Int @default(0); totalsNetToPay Int @default(0)
  vatByRate Json @default("{}"); legalMentions String[] @default([])   // figés à l'émission
  lines LineItem[] @relation("InvoiceLines"); payments Payment[]; transmission EinvoiceTransmission?
  @@unique([companyId, fiscalYear, sequence], name:"uniq_invoice_seq")  // chaîne factures sans trou
  @@unique([companyId, number], name:"uniq_invoice_number")
  @@index([companyId, status]) @@index([companyId, customerId]) @@index([dueAt]) @@map("invoices")
}

model LineItem {
  id String @id @default(dbgenerated("gen_random_uuid()")) @db.Uuid
  quoteId String? @db.Uuid; invoiceId String? @db.Uuid; position Int; label String; category LineCategory
  qty Decimal @db.Decimal(12,3); unit String?; unitPriceHt Int
  vatRate Decimal @db.Decimal(4,2)   // CHECK (vatRate IN (0,2.1,5.5,10,20)) en migration SQL (M13)
  @@index([quoteId]) @@index([invoiceId]) @@map("line_items")
}

model Payment {
  id String @id @default(dbgenerated("gen_random_uuid()")) @db.Uuid
  companyId String @db.Uuid; invoiceId String @db.Uuid; amount Int; method PaymentMethod; receivedAt DateTime
  @@index([invoiceId]) @@index([companyId, receivedAt]) @@map("payments")
}

model EinvoiceTransmission {                  // Compliance — cycle de transmission (M1)
  id String @id @default(dbgenerated("gen_random_uuid()")) @db.Uuid
  invoiceId String @unique @db.Uuid; channel EinvoiceChannel; status TransmissionStatus @default(issued)
  ereportingKind String?; scope String?; receiptRef String?; transmittedAt DateTime?; receivedAt DateTime?
  @@index([status]) @@map("einvoice_transmissions")
}

model DocumentCounter {                       // 3 clés conformes au modèle (M12)
  companyId String @db.Uuid; counterKey String; fiscalYear Int; nextValue Int @default(1)  // 'quote'|'invoice'|'credit'
  @@id([companyId, counterKey, fiscalYear]) @@map("document_counters")
}

model OutboxEvent {                           // transactional outbox
  id String @id @default(dbgenerated("gen_random_uuid()")) @db.Uuid
  companyId String @db.Uuid; type String; version Int @default(1); payload Json
  createdAt DateTime @default(now()); processedAt DateTime?
  @@map("outbox_events")
}

model ProcessedEvent {                        // idempotence handlers (M11)
  eventId String @db.Uuid; handlerName String; processedAt DateTime @default(now())
  @@id([eventId, handlerName]) @@map("processed_events")
}
// + Signature, DunningSchedule, Document, Folder, ComplianceItem, Membership, User.
```
Index partiels (migration SQL brute) : `CREATE INDEX idx_outbox_unprocessed ON outbox_events(created_at) WHERE processed_at IS NULL;` ; `… ON dunning_schedules(next_run_at) WHERE status='pending';` ; CHECK `vatRate IN (0,2.1,5.5,10,20)`.

### 6.3 MongoDB = store IA/audit (jamais de vérité financière)

Collections : `ai_threads`, `ai_messages`, `agent_runs`, `agent_traces` (TTL 30j), `context_snapshots` (TTL 30j), `routing_decisions`, `tool_invocations`, `ocr_traces`, `audit_log`. **`processed_events` peut aussi vivre côté Postgres** (choisi ici pour cohérence transactionnelle des projections, cf. M11). Lien Postgres↔Mongo faible et unidirectionnel (ex. `documents.ocrRawRef` = `_id` Mongo opaque) ; aucune FK cross-store, cohérence éventuelle. Multi-tenant : `companyId` obligatoire + filtre systématique.

### 6.4 Redis = BullMQ + cache + rate-limit + pub/sub WS

- **Cache** (TTL, invalidé par events) : `cashflow:{companyId}:{scenario}:{horizon}` (15 min), `score:{companyId}:{customerId}` (1 h), `today:{companyId}` (5 min), `siren:{siren}` (24 h).
- **Queues BullMQ** : `q:dunning`, `q:einvoice`, `q:ocr`, `q:ai`, `q:projections`, `q:pdf`, `q:notifications`, `q:outbox`.
- **Rate-limit** : `rl:ai:{companyId}` (quota LLM + garde coût), `rl:auth:{ip}`, `rl:ocr:{companyId}`.
- **Pub/Sub** : `@socket.io/redis-adapter` pour scaler les instances NestJS (Railway).

### 6.5 Jobs BullMQ (déclenchés par events via outbox)

Idempotence par `jobId` déterministe (`dunning:{docId}:{step}`, `einvoice:{invoiceId}`, `ocr:{documentId}`) **ET** par `ProcessedEventStore` côté handler (M11) ; retries `attempts:5, backoff exp 30s` ; dead-letter `q:dead` + alerte sur jobs légaux/financiers. Jobs : `ScheduleDunning`, `RunDunningStep` (MED → L441-10), `TransmitEinvoice`, `PollEinvoiceStatus` (issued→…→received→accepted), `ProcessOcr`, `RecalcProjections` (score/encours/cashflow + invalidation cache, idempotent), `GeneratePdf`, `RunAiTask` (fallback démo si LLM indispo), `SendNotification`, `MarkOverdue`/`ExpireQuotes` (cron 06:00 Europe/Paris), `RelayOutbox`.

### 6.6 Topologie de déploiement

```
Mobile (Expo, api-client transport + TanStack Query dans l'app + Socket.IO)
        │ HTTPS / WSS
        ▼
Cloudflare (DNS · CDN · WAF · DDoS · rate-limit edge · TLS)
        ▼
Railway — NestJS API (N instances) : REST + Socket.IO gateway + workers BullMQ
   ├─ Prisma (pooled DATABASE_URL) → Supabase Postgres (vérité) + Auth + Storage (RLS option b)
   ├─ MongoDB Atlas (store IA/audit, TTL natifs)
   └─ Redis (BullMQ + cache + rate-limit + pub/sub WS)
LLM (Anthropic / GLM) : appelés UNIQUEMENT depuis Railway, jamais sur device.
```

**Flux « Émettre la facture via Bob » (streamé, corrigé B1/M4)** : Mobile → `POST /billing/invoices/:id/issue` (JWT) → Cloudflare → AuthGuard (JWKS) → `Principal{userId,companyId,role}` → `IssueInvoiceCommand` dans `UnitOfWork.run(() => …)` : recalcule `computeTotals`+`buildMentions`+`einvoiceFor` (domaine), **use case** `await SequenceCounterPort.allocate(...)` (FOR UPDATE, no-gap), `invoice.assignNumber(n)` (pure), `invoice.issue(...)`, `save` (gèle totaux/mentions, statut `issued`) + `outbox_events(InvoiceIssued)` **même transaction (tx ambiant, M4)** → COMMIT → réponse HTTP (TanStack Query met à jour). `RelayOutbox` → enqueue `TransmitEinvoice` (ouvre `EinvoiceTransmission`) / `ScheduleDunning` / `GeneratePdf` / `RecalcProjections` / `SendNotification`. Workers publient sur Redis pub/sub → Socket.IO room `company:{companyId}` → « Facture transmise ✓ », tréso à jour. Trace Mongo, **aucun montant calculé côté IA**.

---

## 7. Couche IA Bob (au-dessus de l'Application — B3)

Orchestrateur agentique mince dans `packages/ai`, **séparé de la couche Application**. `ai` connaît `core` (use cases), jamais l'inverse. Adapters LLM + store Mongo en infra (`apps/api`).

### 7.1 Parité structurelle — un Tool ne peut exister sans use case (B3)

```ts
interface Tool<In, Out> {
  readonly name: string; readonly description: string;
  readonly argsSchema: z.ZodType<In>;              // .strict() → rejet de tout argument inventé
  readonly mutating: boolean; readonly compliance: 'low'|'medium'|'high';
  readonly usecase: UseCase<In, Out>;              // ★ wrapper STRICT — la parité est typée (B3)
  toJsonSchema(): LlmToolSpec;
}
// Un Tool DÉLÈGUE toujours à usecase.execute(); il n'a aucune logique métier propre.
// Construction garantie: defineTool(name, usecase, { argsSchema, mutating, compliance }).
```

`AskBob` (orchestrateur, **pas un use case**) ne dépend que du **registre de Tools**. Comme chaque Tool encapsule un `UseCase` du catalogue §5.1, toute capacité de Bob a un équivalent manuel par construction. Mode `BOB_AI_MODE=off` masque l'onglet Assistant **sans retirer aucune fonctionnalité**.

### 7.2 Model Router (décision déterministe, table-driven, auditée)

```ts
type TaskType = 'intent.detect'|'agent.plan'|'agent.summarizeResult'|'relance.draft'
  |'mentions.phrase'|'diagnostic.explain'|'cashflow.narrate'|'ocr.extract.postprocess'|'customer.classify';
interface ModelRouter { route(taskType: TaskType, ctx: RoutingContext): RoutingDecision; }
```
- **Claude** : raisonnement multi-étapes, planification, mentions sensibles, diagnostic (criticité haute).
- **GLM** : classification, extraction, brouillons de relance, intention simple (fort volume).
- **Demo** : déterministe, sans clé — dev/CI, fallback de panne, démo. Mêmes types de sortie.
- Règle conformité : tout `taskType` HAUTE criticité voit sa sortie **post-validée par un garde-fou déterministe** ; échec → rendu **Demo** (gabarit conforme). Chaque décision persistée dans `routing_decisions`.

```ts
interface LlmPort {
  generate(p: LlmGenerateParams): Promise<LlmResult>;
  stream(p: LlmGenerateParams, onEvent: (e: LlmStreamEvent)=>void): Promise<LlmResult>;
  health(): Promise<{ healthy: boolean; latencyMs?: number }>;
  readonly capabilities: { supportsTools: boolean; supportsStreaming: boolean };
}
// impl: AnthropicAdapter, GlmAdapter, DemoAdapter
```

### 7.3 Anti-hallucination (garde-fous + types)

(1) `argsSchema.strict()` → pas d'arguments inventés ; (2) **aucun champ « montant/total » dans les schémas mutants** — seulement `unitPriceHT` saisi + bornes ; (3) tous les agrégats financiers calculés par le domaine et renvoyés comme `ResolvedValue { cents; display; kind }` ; (4) mentions/légaux = `buildMentions`/`buildRelance` canoniques ; (5) scoping tenant (`*Id` ∈ `companyId`) ; (6) la rédaction finale ne contient que des jetons `{{value:totals.ttc}}` résolus par le domaine — tout nombre monétaire libre hors placeholder (regex) → **REJET** + re-render Demo. Outils mutants = `mode:'preview'` par défaut ; commit exige `confirm: z.literal(true)` d'un tap UI.

### 7.4 Context Builder, Agent Loop, mémoire & streaming WS

- **Context Builder** : n'injecte que ce que l'intent exige (profil société compact + entités ciblées + slice d'intent + digest glissant ≤~200 tokens), le reste via tool-calls de lecture. PII minimisée, troncatures notées, snapshot dans `context_snapshots`.
- **Agent Loop** : `intent.detect` → `build` → `agent.plan` (streamé) → exécution outils (Zod + scoping ; mutant non confirmé → `preview`) → observe/itérer (`maxIterations=6`, 1 self-repair) → **ActionCard** (montants exclusivement issus des `ResolvedValue`). Idempotence `runId+toolName+argsHash`. Exécuté dans un **worker BullMQ** découplé du socket.
- **Mémoire Mongo** (`AgentMemoryPort`) : threads, messages, runs, traces, snapshots, routing, tool-invocations. Aucune vérité financière ; référence les `invoiceId`/`quoteId` sans dupliquer.
- **Socket.IO** namespace `/bob`, room `thread:{threadId}` (scopée `companyId` via JWT), Redis adapter. Events `bob:plan|plan_step|token|tool|awaiting_confirmation|card|done|error` portent `runId`+`seq` → **replay** à la reconnexion ; run = job (survit à la chute du socket) ; fallback polling `GET /ai/runs/:id` ; backpressure par coalescence des tokens.

### 7.5 Parité sans IA (structurelle)

Chaque Tool enveloppe un use case que l'UI manuelle appelle aussi (`relance.send` ↔ « Relancer » ; `cashflow.computePayout` ↔ « Te verser » ; `billing.generateInvoiceFromQuote` ↔ flux Devis→facture). `DemoAdapter` = parité de démonstration ; `BOB_AI_MODE=off` = parité fonctionnelle pure.

---

## 8. Sécurité, auth, config env

- **Auth** : Supabase (SSO Google/Apple, magic link, OTP) ; tokens en `expo-secure-store`. JWT sur chaque requête HTTP + handshake Socket.IO.
- **Validation NestJS** : `SupabaseJwtGuard` vérifie la signature via **JWKS public** (`aud`/`iss`/`exp`), `sub` → `memberships` → `companyId` + rôle. **Les use cases reçoivent `companyId` du `Principal`, jamais du body** (anti-IDOR).
- **Autorisation** : rôles `admin`/`member` (team reporté) via `@RequireRole`/`@RequireMembership` ; politiques fines dans les use cases.
- **RLS Postgres** (option **b**, défense en profondeur) : `USING (company_id IN (SELECT company_id FROM memberships WHERE user_id = auth.uid()))` sur chemins user ; workers service-role + filtrage applicatif strict. Storage : buckets privés, chemins `{companyId}/…`, URLs signées.
- **Secrets** : clés LLM **jamais sur device**, tout appel LLM depuis Railway ; env Railway chiffrées ; mobile ne reçoit que `EXPO_PUBLIC_*`. TLS partout.

```bash
NODE_ENV=production  PORT=3000  APP_BASE_URL=https://api.bobpro.fr  TZ=Europe/Paris
DATABASE_URL=postgresql://...pooler.supabase.com:6543/postgres?pgbouncer=true
DIRECT_URL=postgresql://...supabase.com:5432/postgres
SUPABASE_URL=...  SUPABASE_ANON_KEY=...  SUPABASE_SERVICE_ROLE_KEY=...  (backend only)
SUPABASE_JWKS_URL=.../auth/v1/.well-known/jwks.json  SUPABASE_JWT_AUD=authenticated
MONGODB_URI=...  MONGODB_DB=bobpro_ai
REDIS_URL=rediss://...  REDIS_TLS=true
DEMO_MODE=false   # true → fallback déterministe, sans Mongo ni LLM ni intégrations
ANTHROPIC_API_KEY=...  GLM_API_KEY=...  AI_ROUTER_DEFAULT=claude  AI_MONTHLY_BUDGET_CENTS=...
BOB_AI_MODE=on    # off → onglet Assistant masqué, parité fonctionnelle conservée
PDP_API_URL=  CHORUS_PRO_API_URL=  SIRENE_API_URL=   # tranche 1 = stubs
EXPO_ACCESS_TOKEN=  SMTP_URL=  RATE_LIMIT_AI_PER_MIN=20  SENTRY_DSN=
# mobile: EXPO_PUBLIC_API_URL, EXPO_PUBLIC_WS_URL, EXPO_PUBLIC_SUPABASE_URL, EXPO_PUBLIC_SUPABASE_ANON_KEY
```
Validation env au démarrage (Zod) ; l'app refuse de démarrer si une variable requise manque — sauf `DEMO_MODE=true`.

---

## 9. Périmètre tranche 1 + ordre de construction

### 9.1 Périmètre exact

**INCLUS** : monorepo + tokens + theming 4 thèmes + format argent + préférences ; `core` domaine+application testé (TVA + **test d'or chauffe-eau 488,40 €** + **tests franchise/autoliquidation**, totaux, mentions, e-invoice routing, scoring, cashflow, relances, machines `Quote`/`Invoice`/`EinvoiceTransmission`, fixtures) ; UI primitives ; écrans **Aujourd'hui / Argent / Clients(+fiche) / Assistant(Bob)** ; flux **Devis→signature→facture** ; backend NestJS (auth, customers, billing, compliance, documents, cashflow, ai) ; IA Bob **mode démo** ; couche données (`api-client` transport + TanStack Query dans l'app).

**REPORTÉ** (modélisé, non implémenté ; stubs derrière ports) : onboarding adaptatif, auth UI complète, diagnostic 2026 UI, documents/OCR complet, compte/abo/équipe/paywall, facture-à-la-voix, **`apps/web` (Next.js)**, page signature web (Vercel), intégrations externes réelles (PDP/Chorus/DSP2/OCR/e-sign), e-reporting paiement réel, situation/retenue de garantie.

### 9.2 Ordre de construction recommandé

1. **Fondations** : monorepo pnpm+Turborepo, `tokens`, `i18n`, `core/shared-kernel` (`Money` neutre, `Percentage`, `Siren`, `Siret`, `PaymentTerms`, `Result`, `AggregateRoot`, `Clock`), format `fr-FR`.
2. **Domaine pur testé** : VO (`VatRate`, `DocNumber`, `Quantity`…), services purs (`computeTotals`+`roundVatForBase`, `suggestVatRate`, `buildMentions`, `scoreCustomer`, `einvoiceFor`, `projectCashflow`, `buildRelance`), agrégats (`Company` sans allocateNumber, `Customer`, `Quote`, `Invoice`, `Payment`, `RelancePlan`, `EinvoiceTransmission`), 3 machines à états. **100 % testé, zéro I/O, zéro Promise.**
3. **Application + ports** : use cases + ports write/read/idempotence + `Result/AppError` + `fixtures`.
4. **Adapters mock + api-client** : `Fixture*Repository`, `DemoLlmAdapter`, mocks ACL ; `api-client` **transport pur**.
5. **UI + écrans mobile** : primitives `ui`, `ThemeProvider` 4 thèmes, hooks TanStack Query (app), écrans + flux Devis→signature→facture — **fonctionnels hors-ligne sur fixtures**.
6. **Couche IA Bob (démo)** : `ai` (router, Tools=wrappers de use cases, context builder, agent loop, garde-fous), streaming WS simulé.
7. **Backend réel** : NestJS modules, adapters Prisma (+ `document_counters` FOR UPDATE, `UnitOfWork` AsyncLocalStorage), Mongo stores, Redis/BullMQ, outbox + `ProcessedEventStore`, Supabase Auth/Storage, RLS ; bascule `API_MODE=http` / `AI_MODE` réel ; Socket.IO + Redis adapter.
8. **Durcissement** : eval harness IA (CI sur DemoAdapter, 0 violation montant), rate-limit, dead-letter+alertes, observabilité (coût/latence/routing), validation env.

Migration monotone fixtures → mock → HTTP → Prisma/intégrations réelles : un adapter à la fois, sans toucher domaine/use cases/UI.

---

## 10. Risques & décisions ouvertes

| # | Risque / décision | Statut | Recommandation |
|---|---|---|---|
| 1 | **Numérotation cross-couche** | Résolu (B1) | Allocation = responsabilité du **use case** (`SequenceCounterPort.allocate` dans `UnitOfWork`), `assignNumber` **pure** côté agrégat. No-gap > no-waste. |
| 2 | **God-aggregate Billing** | Résolu (B2) | Scindé `Quote` / `Invoice` ; `Payment` & `RelancePlan` ARs séparés ; transmission e-invoice → `EinvoiceTransmission` (Compliance). |
| 3 | **Parité IA non typée** | Résolu (B3) | `AskBob` hors Application ; `Tool<In,Out>{usecase}` wrapper strict d'un use case. |
| 4 | **`received` perdu / enum fusionné** | Résolu (M1) | Trois enums séparés ; `received` réintroduit dans `TransmissionStatus`. |
| 5 | **`UnitOfWork` fuit `tx`** | Résolu (M4) | Propagation implicite AsyncLocalStorage ; aucun type ORM dans `core`. |
| 6 | **Canaux e-invoice par héritage** | Résolu (M5) | Une interface `EInvoiceChannel` + Strategy par map. |
| 7 | **api-client couple TanStack** | Résolu (M6) | Transport pur dans le package ; hooks TanStack dans `apps/*`. |
| 8 | **`apps/web` supprimé vs README** | Résolu (M7) | Restauré dans l'arbre, **reporté** ; `core`/ports présentation-agnostiques. V1 implémente mobile seul. |
| 9 | **Idempotence handlers** | Résolu en V1 (M11) | `ProcessedEventStore` (port) + clé `(eventId,handlerName)` + `event.version` ; effet avoirs spécifié. |
| 10 | **Arrondi TVA double source** | Résolu (M10) | `Money.applyRate` supprimé ; arrondi unique dans `computeTotals`. |
| 11 | **Séries de compteurs 5→3** | Résolu (M12) | `counterKeyFor(kind)` ; série facture unique (invoice+deposit+situation+credit). |
| 12 | **VO repassés en primitives** | Résolu (M13) | `PaymentTerms` structuré, `vatRate` CHECK fermé, `depositPct` Percentage, `DocNumber` VO. |
| 13 | **Autoliquidation BTP** | Résolu (M8) | Invariant taux 0 + mention + rejet `vatRate≠0` ; test d'or. |
| 14 | **Franchise non verrouillée** | Résolu (M9) | `addLine` force 0 sinon `VAT_RATE_NOT_APPLICABLE reason='franchise_293B'` ; mention 293 B ; test d'or. |
| 15 | Coût/quota LLM | Ouvert | `AI_MONTHLY_BUDGET_CENTS` + `rl:ai:{companyId}` ; routing GLM volume ; alerte budget. |
| 16 | Exactitude Factur-X/UBL/CII | Ouvert (reporté) | `PdfFacturXPort`+`EInvoiceChannel` stubés ; valider avec un PDP agréé avant prod ; tests de conformité dédiés. |
| 17 | Cas `situation` (avancement, retenue de garantie) | Reporté | Listé dans `DocKind` ; règles de cumul/retenue non implémentées V1 (langage posé). |
| 18 | OCR/VLM & RGPD des prompts | Ouvert (reporté) | `OcrPort` stub ; TTL Mongo ; minimisation PII ; droit à l'effacement par `companyId`/`userId`. |
| 19 | Millésime des compteurs | Décision | `fiscalYear` = année civile d'émission (configurable) ; remise à zéro annuelle explicite, sans régression ; invariant testé. |

---

**Synthèse exécutive** : Bob Pro tranche 1 est un monorepo où `packages/core` (domaine + application, 0 framework, 0 Promise dans le domaine) est la seule source des règles métier françaises, déterministe et 100 % testé. Le God-aggregate Billing est scindé en `Quote`/`Invoice` ; la transmission e-invoice (`issued→transmitted→received→accepted/refused→paid`) vit dans son propre agrégat `EinvoiceTransmission` (Compliance). L'allocation de numéro est orchestrée par le use case (no-gap), l'agrégat ne fait que valider. La parité IA/manuel est désormais **structurelle** : chaque outil de Bob est un wrapper typé d'un use case, et `AskBob` vit au-dessus de l'Application, dans `packages/ai`. Le LLM n'invente jamais un montant ni une mention (placeholders résolus par le domaine + garde-fous). Postgres est la vérité financière (numérotation verrouillée, totaux/mentions figés, VO alignés), Mongo l'audit IA, Redis les jobs/cache/pub-sub. Chaque intégration externe est un port avec mock branchable, rendant la tranche 1 livrable et démontrable sans aucun back tiers réel.

Fichiers sources canoniques lus : `/Users/limameghassene/development/Bob Pro/_design_extract/design_handoff_bob_pro/{README.md, DOMAIN_MODEL.md, SCREENS.md, VOICE_AND_TONE.md, tokens.ts, CLAUDE_CODE_PROMPTS.md}`.
