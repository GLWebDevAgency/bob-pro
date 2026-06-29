# Bob Pro — Plan 2 : Agrégats Billing + machines à états + couche Application

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development ou executing-plans.

**Goal :** Donner vie au flux Devis→signature→facture avec des agrégats DDD à invariants protégés, des machines à états séparées, et une couche Application (use cases + ports) testée de bout en bout sur des fakes in-memory.

**Architecture :** suite du Plan 1. Domaine (`packages/core/src/domain`) : agrégats + state machines, toujours **0 `Promise`**. Application (`packages/core/src/application`) : use cases `async` retournant `Result<Out, AppError>`, dépendant de **ports** (interfaces). Les adapters concrets (Prisma, etc.) sont Plan 3/7 ; ici on teste avec des fakes in-memory.

**Tech Stack :** TypeScript strict, Vitest. Référence : `docs/architecture/architecture-blueprint.md` §4-5.

## Global Constraints
- Reprend celles du Plan 1 (centimes, VatRate fermé, DomainResult, etc.).
- **Frontière d'invariant** : franchise 293B / autoliquidation BTP → appliquées au **use case** via `suggestVatRate` (cf. Plan 1). Les agrégats valident le **structurel** (taux ∈ ensemble fermé, édition draft-only, transitions légales, numéro immuable).
- **Numérotation no-gap** : `allocateNumber` = responsabilité du **use case** (`SequenceCounterPort`) ; `aggregate.assignNumber(n)` est **pure** (valide + fige).
- **Gel à l'émission** : `Invoice.issue()` fige `totals` + `legalMentions` (les mentions sont calculées par le use case via `buildMentions` et passées à `issue`).
- **V1 (YAGNI)** : pas d'outbox/idempotence/EventBus distribué — les agrégats émettent des events (en mémoire via `pullEvents()`), le use case les applique en synchrone dans le même `UnitOfWork`. Queries via repos (pas de read-side séparé).

## File Structure (ajouts)
```
packages/core/src/
├─ domain/
│  ├─ billing/
│  │  ├─ shared/ signature.ts · line.ts (QuoteLine) · state-machines.ts
│  │  ├─ quote/ quote.ts (+test)
│  │  └─ invoice/ invoice.ts (+test)
│  ├─ payment/ payment.ts (+test)
│  ├─ dunning/ relance-plan.ts (+test)
│  └─ compliance/ einvoice-transmission.ts (+test)
└─ application/
   ├─ result.ts                 # AppError + helpers de mapping DomainError->AppError
   ├─ ports/ repositories.ts · services.ts
   ├─ billing/ create-quote.ts · update-quote-lines.ts · send-quote.ts · sign-quote.ts ·
   │           refuse-quote.ts · generate-invoice-from-quote.ts · issue-invoice.ts · register-payment.ts
   ├─ queries/ list-customers.ts · get-cashflow.ts
   ├─ fixtures/ index.ts        # Mercier Plomberie + 6 clients (DATA_CLIENTS, CASH, SCEN…)
   └─ billing/flow.integration.test.ts   # compose→send→sign→invoice→issue→pay
```

## Tasks (résumé — chaque task finit par tests verts + commit)

1. **VO/entités support** : `Signature` (signerName, signedAt, method:'draw', accepted:true), `QuoteLine = LineInput & {id}`, `state-machines.ts` (`assertTransition(table, from, to): DomainResult<void>` + tables `QUOTE_TRANSITIONS`, `INVOICE_TRANSITIONS`, `TRANSMISSION_TRANSITIONS`).
2. **Quote** (`AggregateRoot<string>`) : `compose`, `addLine`/`removeLine` (draft-only, valide qty+VatRate), `setDeposit`, `totals()` (via computeTotals), `assignNumber` (pure), `send`(draft→sent, exige numéro+≥1 ligne), `markViewed`, `sign`(→signed), `refuse`, `markExpired`. Events: QuoteComposed, DocumentNumbered, QuoteSent, QuoteSigned… **Tests** : édition interdite hors draft ; transition invalide → INVALID_TRANSITION ; deposit 30% ; sign exige sent/viewed.
3. **Invoice** : `fromSignedQuote(quote, mode, )`, `composeStandalone`, `addLine`(draft-only), `totals()`, `assignNumber`(pure), `issue({mentions, terms, issuedAt})` (fige totals+mentions, calcule dueAt, draft→issued), `registerPayment(amount, at)` (→partially_paid|paid), `markLate`, `cancel`. **Tests** : pas d'édition après issue ; acompte = net ; registerPayment partiel puis complet → paid ; dueAt = issuedAt+terms.
4. **Payment / RelancePlan / EinvoiceTransmission** : `Payment.record`, `RelancePlan.defaultCadence`/`escalate`, `EinvoiceTransmission.open/transmit/acknowledgeReceived/accept/refuse` (transitions). Tests des transitions.
5. **Application — result.ts + ports** : `AppError` (domain|not_found|forbidden|validation|dependency), `toAppError(DomainError)`. Ports : `CompanyRepository`, `CustomerRepository`, `QuoteRepository`, `InvoiceRepository`, `PaymentRepository`, `SequenceCounterPort`, `ClockPort`, `IdGeneratorPort`, `UnitOfWork`.
6. **Use cases billing** : implémentent le flux ; `SendQuote`/`IssueInvoice` allouent le numéro ; `GenerateInvoiceFromQuote` lit le devis signé et crée la facture (mode deposit si depositPct sinon final).
7. **Fixtures** : Mercier Plomberie + 6 clients (Durand 96, Martin 62, Mairie Sèvres 78, Lefèvre 99, Bernard 88, Camping 50), tréso seed (7j 5400/30j 4950/60j 3100/90j 7200).
8. **Test d'intégration du flux** : in-memory repos + SequenceCounter → compose quote (chauffe-eau) → send (n° D-2026-0001) → sign → generate invoice (deposit 30%) → issue (n° F-2026-0001, mentions figées) → registerPayment(488,40) → paid. Assertions sur numéros séquentiels, totaux, statut.
9. **Verrou qualité** : typecheck + lint + test verts, commit.

## Self-Review
Couvre DoD #2 (no-gap numbering prouvé) + amorce #3 (flux, hors UI). Cohérence types : `Result`/`DomainResult`/`AppError`, `DocNumber`, `Totals`, `PaymentTerms` réutilisés du Plan 1.
