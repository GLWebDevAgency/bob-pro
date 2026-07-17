# Audit — Retrait des mocks/fixtures et branchement BDD réelle (Bob Pro mobile)

## 0. Contexte git important

Le repo est actuellement **en plein chantier non commité** sur la branche `hardening/integrity-rls-conformite-deps` : des dizaines de fichiers modifiés/ajoutés touchent exactement la couche data (`apps/mobile/src/data/`, `packages/api-client/src/`, `apps/api/src/persistence/`, `packages/core/src/application/`). Deux fichiers de garde-fou anti-mock sont **non trackés par git** (jamais commités) :
- `apps/mobile/src/data/mobile-runtime-data-boundaries.test.ts` — grep-ban toute importation de fixtures/local-client/in-memory dans le runtime mobile.
- `packages/api-client/src/production-entrypoint.test.ts` — vérifie que `LocalBobClient`/`FixtureClock`/`InMemory*` ne sont pas exportés en prod.

Ces deux tests sont d'excellente facture, mais **ils ne protègent pas encore CI/main** tant qu'ils ne sont pas committés — à faire avant de considérer le chantier terminé.

## 1. Lane identifiée

Pas un chantier ponctuel : un effort continu sur ~50+ commits (C10→C27, E2-E6, B9…), avec un fichier pivot commité : `apps/mobile/src/data/mobile-data-mode.ts` (ajouté au commit `f1459b9`) qui **interdit tout flag démo au runtime** (`demo_forbidden`, `static_token_forbidden`). Commits clés : `e4c6664` (clé anon Supabase, « la garde BDD-only l'exige »), `c35173b` (options réelles signature), `9b49a22` (auth 100% prod), `217e70b` (fiche société BDD, compte/abo honnête), `1aebd16`/`f3f03a7`/`3cdc9ec` (vatDue/TVA réels).

## 2. Inventaire des mocks

**Verdict : propre.** Tous les hits `mock|fixture` dans `apps/mobile/src`, `apps/mobile/app`, `packages/ui/src` sont des **commentaires documentant l'absence de repli** (« AUCUN repli fixtures », « zéro fixture »), pas du code de mock actif. `Math.random` restant est légitime (génération d'ID, jitter de backoff). `packages/ui/src` : zéro hit. Le mode démo légitime `LocalBobClient` (`packages/api-client/src/local-client.ts`) est correctement isolé : non exporté en prod, non importable depuis le runtime mobile (tests dédiés, cf. §0). Les fixtures core (`packages/core/src/application/fixtures/index.ts`) ne sont consommées par aucun fichier runtime mobile — confirmé par grep.

## 3. Tableau par surface

| Surface | Source réelle | Agrégation | États | Note |
|---|---|---|---|---|
| **Home** (`app/(tabs)/index.tsx`) | `useTodayPriorities` (`hooks.ts:552-588`) compose invoices/quotes/customers/diagnostic non paginés → `deriveTodayPriorities` (`packages/core/.../today/derive-today-priorities.ts:189`) ; cashflow via `GetCashflow` **serveur** avec gardes `Number.isSafeInteger` (`backend.service.ts:849-900`) | Centimes entiers, UTC-anchored, agrégation centralisée core | Skeletons, `ErrorRetry` combiné, vide honnête (`index.tsx:656-663,739-744,797-801`) | **Intelligent** |
| **Argent** (`app/(tabs)/argent.tsx`) | `buildLedgerView` (`packages/core/.../argent/build-ledger-view.ts:161`) sur invoices/expenses/entries/payments complets | Centimes, null-safe, pas de `-0` piège — MAIS `localToday()` device (`argent.tsx:220-225,450`) vs `SystemClock.today()` UTC serveur (`shared-kernel/time.ts:13-15`) coexistent sur le même écran | Riches (EmptyMoneyRow, calendrier fiscal 3 états) mais **pas de RefreshControl** | **Mixte** |
| **Pilotage** (`app/pilotage.tsx`) | Pas d'endpoint dédié : `deriveBusinessReview` (`packages/core/.../pilotage/derive-business-review.ts:245`) côté client, mais alimenté par listes **non tronquées** (`findMany({where:{companyId}})` sans `take`, `repositories.ts:228-231,132-135`) | SIG (`derive-sig.ts:123-173`) et top clients (`derive-business-review.ts:384-420`, vrai GROUP BY sur dataset complet, testé avec avoirs/concentration) formellement corrects | `ErrorRetry` avant état vide, vide propre si pas d'historique (`pilotage.tsx:363-369,682-686`) | **Mixte** |
| **Digest hebdo** | Cron ET mobile appellent la **même** `buildValueDigest` (`packages/core/.../engagement/value-ledger.ts:66`) via `collectValueEvents` (`digest.service.ts:488`) — recalculé à la volée, pas de table dédiée | Centimes, fenêtre Paris DST-aware testée (`digest.service.ts:89-116`) | `ValueDigestCard` : erreur réseau = carte invisible, même état que « rien à montrer » | **Intelligent** (avec réserve UX) |
| **Compte/Abonnement** (`app/compte.tsx`) | `useSubscription` → `get-subscription-status.ts:39-64` (`source:'db'`) ← webhooks Stripe réels (`stripe-billing.service.ts:513-613`) | Idempotence par `eventId`, mapping tier↔price réel | Skeleton + `ErrorRetry` avec retry (`compte.tsx:574-580`) | **Intelligent** (doc obsolète, cf. §4) |
| **Fiche entreprise** | `CompanyFicheCard` (onboarding) ← SIRENE live (`recherche-entreprises.adapter.ts:61-146`, cache 24h) ; `profil-fiscal.tsx` ← `PrismaFiscalProfileRepository` (pas la variante in-memory) | — | Exemplaire : loading / erreur pure / erreur+cache-stale distincts (`profil-fiscal.tsx:148-156`) | **Intelligent** |

## 4. Verdict global : **MIXTE, tirant nettement vers intelligent**

Le socle est sérieux : agrégations dans des use cases `@bob/core` purs et testés (jamais réinventées dans l'écran), argent en centimes entiers de bout en bout, `DateOnly` en slicing de string plutôt que `Date.getMonth()` local (évite l'essentiel des pièges timezone), parité serveur/mobile assurée par partage de fonction pure (digest, SIG), états loading/error/empty honnêtes partout, garde-fous automatisés anti-fuite de fixtures. Ce n'est clairement pas un débranchement naïf — mais il reste des trous concrets, précisément dans les mécanismes de fraîcheur/synchronisation attendus d'un vrai branchement BDD.

## 5. Corrections prioritaires

1. **Invalidation de cache manquante après écriture comptable** — `useIssueInvoice` (`hooks.ts:960-974`), `useGenerateInvoice` (`hooks.ts:882-893`) et `useRecordExpense` (`hooks.ts:377-391`) n'invalident jamais `['accounting-entries']`/`['cashflow']` alors que ces actions postent des écritures serveur (`RecordIssuedInvoiceAccountingEntry`, `RecordExpenseAccountingEntries`). Conséquence démontrable : Pilotage (SIG) et Argent (grand-livre/trésorerie) affichent des chiffres périmés après émission de facture ou saisie de dépense, jusqu'à 30 s (`_layout.tsx:129`) ou une autre action.
2. **Absence de pull-to-refresh sur Argent** (`argent.tsx`, contrairement à `index.tsx:685-691`) — aggrave le point 1 : aucun échappatoire manuel pour l'utilisateur.
3. **Incohérence timezone locale/UTC sur le même écran Argent** — `localToday()` (device) pour le grand-livre/URSSAF vs `SystemClock.today()` (UTC serveur) pour cashflow/échéances : proche de minuit en France, les deux blocs peuvent raisonner sur des « aujourd'hui » différents.
4. **Committer les deux tests garde-fous** (`mobile-runtime-data-boundaries.test.ts`, `production-entrypoint.test.ts`) — actuellement untracked, donc CI ne les fait pas encore respecter.
5. **Écart de parité voix/écran sur Pilotage** — le commentaire `pilotage.tsx:5` promet la parité avec Bob via `getBusinessReview`, mais cette action n'est implémentée que dans `LocalBobClient` (démo), jamais dans `backend.service.ts::buildBobActions()`. En prod, `bob-agent.ts:1330-1338` renvoie proprement « je n'ai pas accès à la revue de pilotage sur cet appareil » — fail-safe honnête, mais fonctionnalité vocale absente en réalité malgré le commentaire.

Mineur (non bloquant) : commentaire obsolète `compte.tsx:4-16` (« aucun billing, pas de Stripe ») alors que Stripe est réellement branché ; `findMany` sans pagination sur invoices/customers/expenses/payments/accounting-entries (`repositories.ts`) — correct aujourd'hui mais dette de scalabilité à mesure que l'historique des tenants grossit.
