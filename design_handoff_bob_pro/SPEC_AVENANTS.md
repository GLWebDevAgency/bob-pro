# SPEC — Gestion des avenants (devis signés)

> **Statut** : spécification exécutable, prête pour arbitrage fondateur+GPT puis découpage en lots agents.
> **Périmètre** : conception uniquement — aucun code modifié. Toutes les références fichier:ligne ci-dessous ont été vérifiées dans le repo au 2026-07-19 (branche `hardening/integrity-rls-conformite-deps`).
> **Feature universelle** : l'avenant n'est **pas** gaté par secteur ni par module (`TRADE_PROFILES` n'active/désactive rien ici) — seul l'habillage (vocabulaire, exemples, sous-titres) se sectorise via la terminologie chantier/mission existante.

---

## 1. Socle métier & juridique (condensé)

### 1.1 Ce qu'est un avenant

Un avenant est une convention écrite qui **modifie un contrat existant sans le remplacer** :

- **Art. 1193 C. civ.** — modification du contrat = consentement mutuel ⇒ **signature des deux parties** (la signature client est le point critique).
- **Art. 1103 C. civ.** — le marché consolidé (devis + avenants signés) « tient lieu de loi ».
- **Art. 1793 C. civ.** (marché à forfait, construction) — les travaux supplémentaires **ne sont pas payables sans écrit signé AVANT exécution**. C'est la raison d'être économique de la feature pour la verticale artisan : sans avenant signé, l'artisan travaille gratuitement.
- **Pas de novation** — l'avenant s'incorpore au contrat : toutes les clauses non modifiées demeurent (acompte %, garanties, pénalités). Clause de continuité obligatoire sur le document.

**Prérequis absolu** : un avenant n'existe **que sur un devis `signed`** (contrat formé). Un devis `sent`/`viewed` se corrige par révision/nouveau devis ; `refused`/`expired` ne porte jamais d'avenant. Cela s'aligne exactement sur la machine à états existante (`QUOTE_TRANSITIONS`, `packages/core/src/domain/billing/shared/state-machines.ts:14` — `signed`/`refused`/`expired` terminaux) et sur l'invariant R6 (« un devis signé est un contrat », lignes gelées — `packages/core/src/domain/billing/quote/quote.ts`).

**Modifiable par avenant** : périmètre (lignes en plus **et** en moins), prix, délais (un avenant purement calendaire à montant nul est valide), conditions de paiement.
**Jamais par avenant** : changement de partie, objet radicalement différent (⇒ nouveau contrat), correction d'une facture émise (⇒ **avoir**, exclusivement).

### 1.2 Ce que l'avenant n'est PAS

| | **Avenant** | **Nouveau devis** | **Avoir** |
|---|---|---|---|
| Nature | Document **contractuel** modificatif | Contrat autonome | Document **comptable** (art. 289 CGI) |
| Rattachement | Référence obligatoire au devis parent | Indépendant | Référence une **facture** émise |
| Moment | Avant/pendant exécution, **avant** facturation de l'élément modifié | N'importe quand | **Après** facturation |
| Effet | Recalcule le **nouveau montant du marché** (agrégation) | Totaux séparés | Corrige le facturé, jamais le contrat |

**Critère de qualification** (Bob devra le faire à la voix) : prestation techniquement dépendante du même chantier/mission et voulue comme partie du même marché ⇒ avenant. Prestation autonome ⇒ nouveau devis. Élément déjà facturé ⇒ avoir. L'avoir existe déjà dans Bob (`InvoiceKind = 'credit_note'`, séquence `A-` — `packages/core/src/domain/billing/invoice/invoice.ts`, `shared/doc-number.ts`) : **la frontière avenant/avoir est avant/après facturation** de l'élément concerné.

### 1.3 Par secteur (universel, habillage adapté)

| Secteur (`TRADE_PROFILES`) | Vocabulaire terrain | Fréquence | Cas canoniques |
|---|---|---|---|
| **Bâtiment** (plombier, électricien, maçon, peintre, paysagiste) | « travaux supp », « plus-value », « moins-value », « avenant au devis » | **Très élevée** (la rénovation découvre l'imprévu) | Colonne vétuste, tableau non conforme, reprise d'enduit ; renoncement client ; prolongation intempéries ; changement de matériau |
| **IT / conseil** (freelance_it, consultant) | « avenant de prolongation », « extension de périmètre », « CR », « revalorisation TJM » | **Systématique en régie** (chaque prolongation = un avenant) | Prolongation de mission (nouvelle date de fin, montant estimatif TJM × jours) ; revalorisation TJM à date d'effet ; lot supplémentaire au forfait ; changement de rythme |
| **Services récurrents** (entretien, TMA, coach) | « avenant au contrat d'entretien », « révision de prix », « indexation » | À chaque évolution du parc/périmètre | Ajout d'un site/équipement, fréquence, revalorisation annuelle — **date d'effet** : échéances futures seulement |
| **Commerce / prestation ponctuelle** (photographe, pose) | « modification de commande », « complément » | Ponctuelle | Cuisine après métré ; extension de cession de droits ; heures de couverture ajoutées |

### 1.4 Numérotation et mentions du document

- **Numérotation** : aucune séquence légale no-gap n'est imposée aux avenants (ce n'est pas une facture, art. 242 nonies A CGI inapplicable). L'usage français dominant est le **rang par devis parent** : « **Avenant n° 2 au devis D-2026-0042** ». Contrainte existante : `DocNumber` réserve `^[DFA]-\d{4}-\d{4,}$` (`shared/doc-number.ts:7`) et **`A-` est déjà pris par l'avoir** ⇒ jamais de préfixe « A » pour l'avenant (voir décision DEC-1).
- **Mentions obligatoires/attendues** : identification des parties (reprise du parent) + mentions entreprise (assurance décennale si bâtiment) · référence explicite au devis parent (numéro, date, date de signature) · objet de la modification ligne par ligne (désignation, qté, PU HT, **taux de TVA par ligne**) · **récapitulatif financier qui fait foi** : montant initial → avenants antérieurs signés → présent avenant (signé ±, TVA par taux) → **NOUVEAU MONTANT TOTAL DU MARCHÉ** · conditions d'acompte le cas échéant · clause de continuité · validité de l'offre · date, lieu, signatures des deux parties (même niveau de preuve que le devis : `Signature{method, proof SHA-256}` — `shared/signature.ts`, circuit sign-web existant).
- **B2C hors établissement** : un avenant signé au domicile du client rouvre un **délai de rétractation de 14 jours** sur les prestations nouvelles (art. L221-18 s. C. conso) — voir DEC-9.
- **Immuabilité** : le devis signé n'est **jamais réécrit**. Le « marché courant » est une **agrégation calculée** (devis + avenants signés), jamais une mutation du devis — cohérent avec le pattern B8 (`purchaseOrder`/`revision` sur l'agrégat Quote).

### 1.5 Interaction acompte / facturation (règles d'or)

1. **Une facture émise est intangible** — l'avenant ne touche jamais rétroactivement l'acompte ni une situation émise. Correction = avoir.
2. **Facture finale = agrégation** : total facturable = devis + Σ avenants **signés** ; la finale déduit tout le déjà-facturé — c'est exactement la mécanique `depositDeduction` composite existante (`generate-invoice-from-quote.ts:32-66`, `invoice.ts:275` : `netToPay = max(0, ttc − depositDeductionCents)`).
3. **Plafond netToPay déplacé, jamais aboli** : l'avenant déplace le plafond d'encaissement (hausse OU baisse) ; jamais encaisser au-delà du netToPay (`invoice.ts:307`, `RegisterPayment`).
4. **Moins-value sous le déjà-facturé** : si le déjà-facturé/encaissé dépasse le nouveau TTC, l'écart se traite par **avoir** (+ remboursement ou imputation) — jamais de netToPay négatif, jamais de mutation de facture.

---

## 2. MVP délimité (V1 honnête) vs options ultérieures

### 2.1 DANS la V1

- Avenant sur devis **`signed` uniquement**, tant qu'aucune facture **finale** non annulée n'existe.
- Lignes **en plus ET en moins** (moins-values), TVA héritée du devis parent par défaut.
- Wizard mobile 3 étapes (lignes → récap marché → signature/envoi) + **dictée vocale des lignes** (réutilisation `parseVoiceQuoteLine`).
- **Signature sur place** (`SignOnsiteSheet`, cas majoritaire BTP — art. 1793 impose l'écrit AVANT travaux) + **lien sign-web** (scope dédié, TTL 30 j) + relances.
- **Agrégation marché à la facturation** : la finale intègre les avenants signés d'office, avec mention explicite du non-inclus.
- Outils Bob `creer_avenant` / `envoyer_avenant` (parité humain↔Bob, mêmes use cases).
- Carte « Marché » sur le devis, chip « +N avenant(s) » en liste, rappels brouillon/envoyé non signé (Today priorities).
- PDF d'avenant dédié (pièce contractuelle, pas de Factur-X).

### 2.2 PAS dans la V1 (dit clairement, jamais simulé)

| Exclusion | Raisonnement |
|---|---|
| Acompte propre à l'avenant | Le supplément rejoint le solde ; la déduction composite existante fonctionne inchangée. Ajouter un 2e acompte = complexité `depositPct` × avenant sans demande terrain avérée. Réponse Bob : « le montant s'ajoutera au solde ». |
| « Modification de ligne existante » exposée en UX | Une modif = ligne en moins + ligne en plus (2 lignes, dictable). L'op `modify` reste **modélisée** au domaine/schéma pour V1.x (DEC-3) — pas d'UI. |
| Avenant sur avenant | Chaîne plate : tous pointent le devis parent, rangs 1..n. |
| Avenant après facture finale émise | Cul-de-sac pédagogique → avoir ou nouveau devis (message type `QUOTE_INVOICED_MESSAGE` de B8). |
| Avenant purement calendaire (0 ligne) | Fréquent en IT (prolongation) mais exige deux dates (effet ≠ signature) et un rendu sans tableau financier — V1.x (DEC-5). |
| Situations de travaux inter-avenants | Module `situations_travaux` tier pro : la bascule d'assiette (avancement en % du **nouveau** marché) est spécifiée (§3.6) mais livrée avec le module. |
| Régénération du PDF du devis / « PDF du marché consolidé » | Immutabilité documentaire ; le marché est une VUE. |
| Date d'effet / proratisation abonnements | V1.x avec le calendaire (mêmes champs). |
| Signataire distinct du contact de facturation (IT tripartite) | V1.x — le circuit token le permettra sans refonte (le lien est portable). |

### 2.3 Anticipations structurantes (conçues pour ne pas se peindre dans un coin)

- **Franchise en base (art. 293 B CGI)** : rejouer la règle cross-agrégat `suggestVatRate` à la création d'avenant (un avenant peut faire franchir le seuil).
- **Autoliquidation sous-traitance BTP** : les lignes d'avenant héritent du régime du marché parent (aucun champ nouveau : hérité du devis).
- **Snapshot de signature** : archiver au moment de la signature le récapitulatif figé (marché avant/après) — la preuve en litige est ce que le client a vu, pas un recalcul (champ `marketBefore/marketAfter`, §3.2).
- **Factur-X / e-invoicing** : la finale devra référencer devis + avenants (champ contract/order reference) — extension `facturx.ts` en V1.x, la donnée (liste des avenants signés) existe dès la V1.
- **Bon de commande (B8)** : lien avenant ↔ `purchaseOrder` prévu en V1.x — le champ et la mécanique `revision` existent déjà sur Quote.

---

## 3. Architecture domaine

### 3.0 Décisions structurantes

- **D1 — L'Avenant est un agrégat séparé, jamais une mutation du Quote.** Doctrine R6 du repo (`assertDraft` partout dans `quote.ts`). L'avenant référence le devis et porte son propre cycle de signature — comme l'avoir référence la facture (`creditNoteFor`).
- **D2 — Un seul avenant non terminal par devis** (`draft|sent|viewed`) — voir DEC-2 pour la variante. Ordre total des avenants, base de calcul des deltas stable, pas de fusion concurrente. Imposé par index unique partiel SQL (précédent : anti-doublon TOCTOU C-EXP-FIX1 dans `schema.prisma`).
- **D3 — Le marché courant est TOUJOURS recalculé depuis les lignes effectives, jamais sommé depuis des deltas.** `computeTotals` arrondit la TVA **par taux sur les bases agrégées** (`packages/core/src/domain/services/compute-totals.ts:14`) : la somme des deltas TVA par ligne diverge du recalcul (centimes). Les `deltaHt` par ligne ne sont que de l'affichage.
- **D4 — Avenant interdit si une facture finale non annulée existe.** Refus avec message de redirection (nouveau devis / avoir).
- **D5 — Identité documentaire double** (sous réserve DEC-1) : `orderIndex` 1..n par devis (titre légal, monotone y compris refusés/expirés) + `DocNumber` société `AV-AAAA-NNNN` no-gap alloué à l'**envoi** (counterKey `'amendment'` sur la table `document_counters` générique — aucun DDL de compteur).

### 3.1 Fichiers du domaine (`packages/core/src/domain/billing/avenant/`)

**Value object delta — `avenant-line.ts`**

```ts
export type AvenantLineOp =
  | { op: 'add'; line: LineInput }                       // nouvelle ligne (id frais)
  | { op: 'modify'; targetLineId: string;                // modélisé, non exposé en V1 (DEC-3)
      patch: Partial<Pick<LineInput,'label'|'qty'|'unitPriceHT'|'vatRate'>> }
  | { op: 'remove'; targetLineId: string };              // moins-value : retrait d'une ligne effective

export interface AvenantLine { id: string; opData: AvenantLineOp; }
```

Fabrique `makeAvenantLine` réutilisant les validations existantes de `Quote.updateLine` (`quote.ts`) : `Quantity.of`, `isVatRate`, `MAX_BILLING_AMOUNT_CENTS`, `hasBillingControlCharacter`. Règle TVA : une ligne `remove` porte implicitement le taux de la ligne d'origine (symétrie de taux — sinon la TVA du marché consolidé est fausse) ; une ligne `add` porte son propre taux (DEC-4).

**Entité — `avenant.ts`**

```ts
export class Avenant extends AggregateRoot<string> {
  readonly companyId: string;
  readonly quoteId: string;                 // devis parent SIGNÉ
  readonly orderIndex: number;              // rang par devis, figé à la création
  private _status: AvenantStatus = 'draft'; // = QuoteStatus (mêmes 6 états)
  private _lines: AvenantLine[] = [];
  private _number: DocNumber | null = null; // AV-AAAA-NNNN, alloué à l'envoi
  private _signature: Signature | null = null;          // shared/signature.ts tel quel
  private _frozenMarket: { before: Totals; after: Totals } | null = null; // figé à la signature
  private _revision = 1;
  private readonly _validUntil: DateOnly | null;        // DEC-6
}
```

- **Machine d'états** : `AVENANT_TRANSITIONS = QUOTE_TRANSITIONS` (alias typé dans `state-machines.ts` ; côté Prisma, réutilisation de l'enum `QuoteStatus` — aucun nouvel enum de statut).
- **Méthodes** : `compose` · `addDelta/updateDelta/removeDelta` (garde `assertDraft`) · `assignNumber` (immuable, événement `DocumentNumbered` — même contrat que Quote/Invoice) · `send/markViewed/sign/refuse/markExpired` (miroirs de `quote.ts`, événements `AvenantSent`, `AvenantSigned`…) · `toSnapshot/rehydrate` (champs optionnels compat ascendante, doctrine B8).
- **`sign(signature, marketBefore, marketAfter, at)`** fige `_frozenMarket` — trace légale du marché avant/après, analogue à `Invoice._frozenTotals` figé à l'émission.

**Service de domaine — `domain/services/derive-market-state.ts`** (LA source unique du marché courant, pur) :

```ts
export interface MarketState {
  effectiveLines: QuoteLine[];   // lignes du devis + avenants SIGNÉS appliqués par orderIndex
  marketTotals: Totals;          // computeTotals(effectiveLines) — TVA par taux correcte
  appliedAvenantIds: string[];
}
export function deriveMarketState(quote: Quote, signedAvenants: Avenant[]): DomainResult<MarketState>
```

`add` → append (id de ligne = id de l'AvenantLine, stable) ; `modify` → patch ; `remove` → retrait. Erreur `VALIDATION` si une cible n'existe pas dans l'état effectif. Consommé par : validation des deltas en édition, garde plancher I6, facturation, projections, PDF. **Aucun autre calcul de marché n'existe nulle part.**

### 3.2 Invariants

| # | Invariant | Point d'application |
|---|---|---|
| I1 | Avenant uniquement sur devis `signed` | `CreateAvenant` (cross-agrégat, use case) |
| I2 | Un seul avenant non terminal par devis (DEC-2) | Index unique partiel SQL + vérif use case (belt & braces) |
| I3 | Deltas édités en `draft` seulement | `Avenant.assertDraft` (entité) |
| I4 | Cibles des deltas ∈ lignes effectives (devis + avenants signés antérieurs) | `deriveMarketState` dans `UpdateAvenantDraft`, **revérifié à `send`** |
| I5 | Immuable après signature (deltas, numéro, marché figé) | Gardes entité + trigger DB de traçabilité (précédent `invoices_legal_traceability`) |
| I6 | **Plancher moins-value** : `marketAfter.ttc ≥ Σ netToPay des pièces émises non annulées / non totalement avoirées du devis` | `SendAvenantForSignature` **ET re-vérifié dans la transaction de `SignAvenant`** (le déjà-facturé peut bouger entre envoi et signature) |
| I7 | Marché soldé (finale non annulée) ⇒ pas de nouvel avenant | `CreateAvenant` (D4) |
| I8 | Numéro AV no-gap, un seul par avenant | `assignNumber` + transaction compteur (pattern `SendQuote`) |

**I6 est la cohérence exacte avec le plafond netToPay** : puisque la finale calcule `netToPay = max(0, ttc − déjàFacturé)` (`invoice.ts:275`) et que `registerPayment` borne au netToPay (`invoice.ts:307`), garantir `marché ≥ déjà facturé` garantit qu'aucune finale ne naît écrasée à 0 avec du trop-perçu structurel. La moins-value sous le déjà-facturé reste possible dans la vraie vie → réponse produit : **avoir** (flux existant), jamais l'avenant — message Bob explicite avec les montants.

### 3.3 Use cases (`packages/core/src/application/billing/` + `public-access/`)

| Use case | Contenu, réutilisation |
|---|---|
| `CreateAvenant` | Vérifie I1, I7, I2 ; `orderIndex = max+1` ; idempotence par l'index partiel (la course perd en conflit → relire l'avenant en vol) |
| `UpdateAvenantDraft` | add/remove (modify V1.x) ; valide via `makeAvenantLine` + `deriveMarketState` (I4) ; clone-avant-mutation + révision optimiste (pattern `attach-purchase-order.ts`) |
| `SendAvenantForSignature` | Transaction UoW, verrous **company SHARE → quote UPDATE → avenant UPDATE → compteur** (ordre global anti-deadlock documenté `send-quote.ts:34`) ; alloue `AV-` (fiscalYear `parisDateOnly`), vérifie I6, `send()`, révoque + crée jeton `amendment_signature` TTL 30 j — copie structurelle `SendQuote` + `CreateQuoteSignatureToken` |
| `CreateAvenantSignatureLink` | Wrapper sans effet sortant (philosophie `create-quote-signature-link.ts` : préparer ≠ envoyer) |
| `SignAvenant` | Miroir `sign-quote.ts` : `normalizeSignerName` (à extraire en helper partagé), revalidation du grant DANS la transaction, re-vérif I6 sous verrous, `sign()` avec marché figé, révocation de TOUS les jetons `amendment_signature` de l'avenant |
| `RefuseAvenant` | Miroir `refuse-quote.ts` + révocation jetons ; **n'affecte JAMAIS le statut du devis parent** |
| `ExpireAvenant` | Si `validUntil` posé (DEC-6) — sinon l'expiration du jeton suffit en V1 |

### 3.4 Facturation — points d'extension EXACTS

1. **`generate-invoice-from-quote.ts:66`** — `Invoice.fromSignedQuote(quote, mode, id, opts)` copie `quote.lines` (`invoice.ts:70`). Extension retenue : **nouvelle factory `Invoice.fromMarket(quote, market: MarketState, mode, id, opts)`** ; `fromSignedQuote` délègue avec un marché vide (compat totale des tests existants). Nouvelle dep `avenants: AvenantRepository` dans `GenerateInvoiceFromQuote`, lecture des avenants signés, `deriveMarketState`.
2. **`generate-invoice-from-quote.ts:32-64`** — la déduction « déjà facturé » **ne change pas** : elle somme les `netToPay` des pièces réellement émises (source de vérité = factures, pas le devis). C'est ce qui rend l'avenant post-acompte correct sans rétro-ajustement.
3. **Acompte** : mode `deposit` sur les lignes effectives ⇒ un acompte généré APRÈS un avenant signé porte sur le marché courant ; un acompte déjà émis reste figé (`frozenTotals`). Cohérent, à documenter dans le code.
4. **`issue-invoice.ts`** — aucun changement (totaux figés depuis les lignes de la facture).
5. **`list-invoiceable-quotes.ts:63`** — `totalTtcCents: q.totals().ttc` → `marketTotals.ttc` ; ajouter `hasPendingAvenant` (inviter à attendre la signature avant la finale).
6. **`build-piece-view.ts`** — `PieceQuoteData` + `market?: { totals: Totals; avenants: {id, orderIndex, number, status, deltaTtcCents}[] }` ; `parentQuote.ttcCents` (nextStep « créer la finale », `build-piece-view.ts:304-317`) et `situationProgressPct` (`:320`) doivent lire le **ttc marché**, pas le ttc devis seul.
7. **`deriveQuoteInvoiceCtaState`** (CTA 3 états de `QuoteActions`) se calcule sur le MARCHÉ.

### 3.5 API, api-client (×3), sign-web

- **`packages/api-client/src/client.ts`** : `QuoteView` + `marketTotals?: Totals` et `avenants?: AvenantSummaryView[]` (optionnels ⇒ compat ascendante) ; `AvenantView { id, quoteId, orderIndex, status, number, lines, marketBefore, marketAfter, deltaTtcCents, signedAt, revision }` ; méthodes `createAvenant / getAvenant / updateAvenantDraft / sendAvenant(→{number, signUrl?}) / createAvenantSignatureLink / refuseAvenant`.
- **`http-client.ts`** : codec défensif `avenant-codec.ts` calqué sur `purchase-order-codec.ts` (absent ⇒ défaut, difforme ⇒ fail-closed) ; endpoints `POST /quotes/:id/avenants`, `GET/PATCH /avenants/:id`, `POST /avenants/:id/send`, `POST /avenants/:id/signature-link`, `POST /avenants/:id/refuse`.
- **`local-client.ts`** : nouveaux use cases sur `InMemoryAvenantRepository` (`in-memory/repositories.ts`), projection miroir du pattern purchaseOrder.
- **API NestJS** : `AvenantsController` + extension `PublicSignatureController` — le GET/POST `/public/sign/:token` **dispatche par `grant.scope`** (le token est opaque ; le backend résout `quote_signature` vs `amendment_signature`) ; `SignatureView` enrichie d'un discriminant `kind: 'quote' | 'avenant'` **optionnel** (rétro-compatible avec la page déployée). `apps/api/src/backend.service.ts` : `publicAvenantForSignature` / `publicSignAvenant`, copies structurelles des handlers quote existants (mêmes verrous, même anti-énumération `appNotFound('public-signature-token','redacted')`).
- **sign-web** (`apps/sign-web/app/sign/[token]/page.tsx`, 179 L) : branche `kind === 'avenant'` → en-tête « Avenant n°X au devis D-… », bloc repliable de rappel du devis signé, tableau du delta (moins-values en rouge), « Total de l'avenant : ± X € » puis « **Nouveau total du marché : Y € TTC** », bouton « Signer l'avenant », microcopy légale d'engagement, mêmes états normés (signé/expiré/indisponible). **Ordre de déploiement : sign-web AVANT toute activation mobile** (ou release-flag `avenants` — DEC-10).

### 3.6 Situations de travaux (spécifié, livré avec le module)

À compter de la signature d'un avenant : l'avancement s'exprime en % du **nouveau montant du marché** ; le cumul facturé (acomptes + situations) ne dépasse jamais ce nouveau total. La retenue de garantie 5 % a pour assiette le nouveau montant. Aucune situation émise n'est retouchée.

### 3.7 Migration Prisma (`apps/api/prisma/schema.prisma`)

```prisma
model QuoteAmendment {
  id             String      @id
  companyId      String
  quoteId        String
  quote          Quote       @relation("QuoteAmendments", fields: [quoteId, companyId],
                               references: [id, companyId], onDelete: Restrict, onUpdate: Restrict) // anti-IDOR composite (précédent Invoice.parentQuote)
  orderIndex     Int
  status         QuoteStatus @default(draft)   // enum RÉUTILISÉ
  number         String?
  signerName     String?
  signedAt       DateTime?
  signatureProof Json?                          // même contrat que quotes.signatureProof (R4)
  marketBefore   Json?                          // Totals figés à la signature — NULL avant
  marketAfter    Json?
  revision       Int         @default(1)
  createdAt      DateTime    @default(now())
  lines          AmendmentLine[]
  @@unique([companyId, number],              map: "uniq_amendment_number")
  @@unique([companyId, quoteId, orderIndex], map: "uniq_amendment_order")
  @@unique([id, companyId],                  map: "uniq_amendment_id_company")
  @@index([companyId, quoteId])
  @@map("quote_amendments")
}
model AmendmentLine {
  id           String  @id @default(uuid())
  amendmentId  String
  amendment    QuoteAmendment @relation(fields: [amendmentId], references: [id])
  position     Int
  op           AmendmentLineOp   // add | modify | remove (nouvel enum)
  targetLineId String?           // FK line_items(id), onDelete Restrict — NULL pour add
  label String? ; qty Decimal? @db.Decimal(12,3) ; unit String? ; unitPriceHt Int? ; vatRate Decimal? @db.Decimal(4,2)
  @@index([amendmentId]) @@map("amendment_lines")
}
```

Compléments impératifs :
1. **SQL pur** (le DSL Prisma ne l'exprime pas — précédent documenté C-EXP-FIX1) : `CREATE UNIQUE INDEX uniq_amendment_in_flight ON quote_amendments("quoteId") WHERE status IN ('draft','sent','viewed');`
2. **Valeurs d'enum en migration SÉPARÉE et ANTÉRIEURE** (Postgres interdit d'utiliser une valeur d'enum ajoutée dans la même transaction ; les migrations Prisma sont transactionnelles) : `ALTER TYPE "PublicAccessResourceType" ADD VALUE 'amendment'; ALTER TYPE "PublicAccessScope" ADD VALUE 'amendment_signature';` (enum existant : `schema.prisma:91`).
3. **RLS** : politiques tenant sur `quote_amendments` / `amendment_lines` dans `rls.sql` — le test `rls-schema-coverage.test.ts` échoue sinon.
4. **Trigger de traçabilité** interdisant la mutation des colonnes signées (précédent `invoices_legal_traceability`).
5. **`DocNumber`** : regex → `^(D|F|A|AV)-\d{4}-\d{4,}$` (`doc-number.ts:7`) + mapping préfixe `repositories.ts:2945-2946` (`counterKey === 'amendment' → 'AV'`) + équivalent in-memory.
6. **Persistance** : `AvenantRepository` (`findById / lockById / listByQuoteId / save`) dans `repositories.ts` + mappers snapshot↔rows.

### 3.8 PDF (`apps/api/src/documents/pdf-renderer.ts`, 225 L)

`renderAvenant(data: AvenantPdfData)` — même famille visuelle que `renderQuote` (pdf-lib, A4, accent navy). Pas de Factur-X (pièce contractuelle, pas comptable). Contenu : titre « Avenant n° {orderIndex} au devis {quoteNumber} » + numéro AV · lignes delta préfixées (+ / − retirée) · bloc « Marché initial {ht/ttc} → Marché après avenant {ht/ttc} » · clause de continuité · bloc signature (« Signé par … » comme renderQuote). Extension `PdfRendererPort` + `AvenantPdfData` dans `application/ports/output.ts`. ~90 L par mimétisme.

---

## 4. UX — manuel + vocal

### 4.1 Principes (hérités du code réel)

1. **Un devis signé est un contrat** : `editableLines={q.status === 'draft'}` (`apps/mobile/app/devis/[id].tsx`) — l'avenant est la SEULE porte de modification post-signature.
2. **La voix dit et montre, le tap écrit** (plancher R7) : les affordances vocales ouvrent les Sheets préremplies ; seul le tap Confirmer/Envoyer déclenche le use case.
3. **Parité humain↔Bob** : chaque action a son outil typé (`packages/ai/src/tools/registry.ts`) qui délègue au MÊME use case `@bob/core` — zéro logique métier dans l'outil.
4. **Le marché est une VUE agrégée, jamais un document.**
5. **LIENS CROISÉS ENTRE PIÈCES (exigence fondateur 19/07, référence proto F-2026-118)** : le
   pattern visuel des pièces liées est un CONTRAT — carte VIOLETTE (famille `semantic.ai`,
   icône lien) pour la filiation devis↔facture (« Issue du devis D-2026-014 », et côté devis :
   « Facture émise F-2026-118 ») ; carte AMBRE (famille warning, icône flèche-retour circulaire)
   pour les pièces rectificatives (« Avoir émis sur cette facture — AV-… · −montant »).
   Les AVENANTS suivent le MÊME système dans le devis parent : carte(s) « Avenant n°N — {état} ·
   {±montant} » avec le récapitulatif « Marché : devis + N avenants = X € » au-dessus, chaque
   carte navigue vers l'avenant ; et l'avenant affiche sa carte retour « Avenant au devis D-… ».
   COULEURS DISTINCTES D'UN COUP D'ŒIL (décision fondateur 19/07) : trois familles jamais
   confondables — filiation devis↔facture = VIOLET/indigo (`semantic.ai`, inchangé) ;
   AVOIR sur facture = AMBRE chaud (famille warning du proto — rectification, argent rendu) ;
   AVENANT sur devis = TEAL/vert sarcelle (NOUVEAU token `piece.avenant*` à créer dans
   packages/tokens — évolution du contrat, ni une filiation ni une rectification). L'icône
   diffère aussi : lien (filiation), flèche-retour circulaire (avoir), plus/delta contractuel
   (avenant). Test de conformité : les trois cartes côte à côte doivent être identifiables
   sans lire le texte.
   LISTES devis/factures : tags/badges complétés — un devis avec avenant(s) porte le tag
   « Avenant ×N », une facture avec avoir porte le tag « Avoir », un avoir en liste est
   identifiable (badge dédié) — mêmes composants Badge/tones que les statuts existants.

### 4.2 Entrée manuelle — depuis le devis signé (`/devis/[id]`)

- Dans `QuoteActions` (`apps/mobile/src/components/DocumentActions.tsx`), visible uniquement si `status === 'signed'` ET `!linked.hasFinalInvoice`.
- **Poids visuel SECONDAIRE** : le CTA facturation (3 états) reste PRIMAIRE ; « Créer un avenant » = bouton ghost sous le CTA, icône `file-plus`.
- Dès ≥ 1 avenant : carte **« Marché »** dans le slot `extra` de `PieceDetailView` (pattern `PurchaseOrderCard`) listant les avenants avec `StatusBadge` (mêmes tons que `QUOTE_BADGE`), tap → détail.
- **Redirection pédagogique** : toute tentative de modification d'un devis signé est réorientée, jamais un cul-de-sac — vocal : affordance `devis.editRedirectAvenant` (mêmes regex que `devis.editLineByOrdinal`, testée quand `status === 'signed'`) : *« Ce devis est signé, on n'y touche plus — c'est ton contrat. Ce qui change passe par un avenant, je te le prépare ? »*

### 4.3 Entrée vocale — assistant global

« Le client veut ajouter la reprise du mur, fais un avenant au devis Durand » :

1. **Résolution** : devis RÉELS du tenant filtrés `status === 'signed'` (pattern `classer_document` — jamais un id inventé), via `matchSpokenCustomers` + `chercher_document` scope `quote`.
2. **Désambiguïsation** : options « D-2026-042 · Salle de bain · 12 480 € » (`QuestionSheet`). Devis non signé → *« Le devis Durand n'est pas encore signé — pas besoin d'avenant, je peux le modifier directement. »* (enchaîne sur l'édition draft existante).
3. **Dictée des lignes** : `parseVoiceQuoteLine` / `completePendingQuoteLinePrice` (`packages/core/src/flows/voice-quote-line.ts`) TEL QUEL : catalogue d'abord, prix jamais inventé (`missing_price`), ambiguïté → question. **Extension** : moins-values (« enlève la dépose du carrelage ») → nouveau kind `deduction`.
4. **Outils typés** :
   - `creer_avenant` — `mutating: true, outbound: false, riskTier: 'draft'`, PAS de safetyFloor (miroir exact `creer_devis`, `registry.ts:219-224` : « brouillon interne réversible ») ;
   - `envoyer_avenant` — `outbound: true, safetyFloor: true, riskTier: 'outbound'` (miroir `envoyer_devis`, `registry.ts:145`).
5. **Enchaînement** : Bob propose SANS déclencher : *« Avenant prêt en brouillon : +612 €. Je l'envoie à M. Durand pour signature ? »* → confirmation typée OUTBOUND.

### 4.4 Édition — le delta, jamais la re-saisie

Écran `/devis/[id]/avenant/new` — wizard modal COURT, machine `@bob/core` `flows/avenant` (modèle `flows/devis`, l'état des étapes n'existe QUE dans la machine) : **1. Lignes** (pas d'étape client/TVA/acompte — hérités ou exclus) → **2. Récap marché** → **3. Signature/envoi** (sur place / lien / plus tard).

```
┌ Devis initial — D-2026-042 · signé le 12/06 ──────── 12 480,00 € ┐  (replié, tap = déplier)
│ CE QUI CHANGE                                                     │
│  + Reprise du mur pignon — 2 j × 380,00 € HT        + 912,00 €    │
│  − Dépose carrelage (retirée)                        − 300,00 €   │  ← semantic.danger
│  ─────────────────────────────                                    │
│  Avenant n°1                                         + 612,00 €   │
│  NOUVEAU TOTAL MARCHÉ                             13 092,00 € TTC │  ← MoneyText, graisse max
└───────────────────────────────────────────────────────────────────┘
```

- Saisie ligne = formulaire de l'étape 2 du wizard devis (suggestions `searchCatalogue`) + toggle « Travaux en plus / Travaux en moins » (libellé sectorisé §4.7) ; moins-values TOUJOURS en rouge, signe « − » explicite ; total d'avenant négatif possible (borné par I6 à l'envoi).
- Totaux par `computeTotals` sur les lignes effectives — **jamais un calcul local d'écran**.
- Brouillon persisté via le pattern `quote-draft-slot` (commit « persister les brouillons de devis ») : un avenant commencé au chantier survit à la fermeture de l'app.
- Parité vocale in-wizard : mêmes affordances de dictée (`isVoiceAddLineUtterance`) + « enlève / retire / annule X » → ligne en moins.

### 4.5 Envoi / signature

- Numéro alloué à l'ENVOI (jamais à la création — pas de trous sur brouillons supprimés). Affichage : « Avenant n°1 au devis D-2026-042 ».
- Gate entreprise complète : non re-testé (vérifiée au premier envoi du parent — doctrine des renvois).
- Jeton `PublicAccessToken` scope **`amendment_signature`** (TTL 30 j, rotation, révocation) — scope séparé pour que la révocation d'un lien d'avenant ne touche jamais le lien du devis.
- Signature sur place : `SignOnsiteSheet` réutilisée (pad `@bob/ui`, échec réseau ne vide jamais le pad) — cas MAJORITAIRE en BTP.
- Relances : mêmes statuts que le devis ; l'avenant envoyé non signé remonte dans `derive-today-priorities` comme un devis envoyé.

### 4.6 Après — le marché agrégé

1. **Détail devis** : header « **Marché : 13 092,00 € — devis + 1 avenant** » (`buildPieceView` + `linkedAvenants`, pattern `linkedInvoices`). Seuls les SIGNÉS comptent ; un envoyé s'affiche « en attente de signature — non compté » ; un refusé reste visible **sans peindre le devis en rouge**.
2. **Liste ventes** : chip « +1 avenant ».
3. **Facturation** : agrégation d'office des signés (§3.4) ; le CTA se calcule sur le marché ; `depositPct` reste assis sur le devis initial (pas de re-déclenchement d'acompte).
4. **Vocal** : « facture le devis Durand » → diff de confirmation (safetyFloor fiscal existant) : *« Solde : devis D-2026-042 + 1 avenant signé (+612 €) = 13 092 € − acompte 3 744 € = 9 348 €. Avenant n°2 non signé — non inclus. »* **La mention du non-inclus est obligatoire** (jamais de silence sur un montant absent).

### 4.7 Vocabulaire sectorisé (via `tradeToWorksiteTerminology` / `worksiteParamsFor`)

Le mot « **avenant** » est LE terme légal — identique partout (c'est ce que le client voit à la signature). Se sectorise : le toggle (« Travaux en plus / en moins » ↔ « Ajouté / Retiré du périmètre »), le sous-titre (« Ce qui change sur le chantier » ↔ « …sur la mission »), les exemples, et la traduction « papa vocal » du jargon (*« une moins-value, c'est des travaux qu'on enlève du devis — le total baisse »*).

### 4.8 i18n ×3 tons (échantillon)

- `avenant.create` — pote : « Faire un avenant » · pro : « Créer un avenant » · direct : « Avenant »
- `avenant.explainSignedEdit` — pote : « Ce devis est signé, on n'y touche plus — c'est ton contrat. Ce qui change passe par un avenant, je te le prépare ? » · pro : « Un devis signé ne se modifie plus. Les changements passent par un avenant — en créer un ? » · direct : « Devis signé = intouchable. On fait un avenant ? »
- `avenant.sentBody` — pote : « C'est parti ! {customer} a reçu le lien pour signer l'avenant. » · pro : « L'avenant a été envoyé à {customer} pour signature. » · direct : « Avenant envoyé. »
- `avenant.reminderDraft` — pote : « Ton avenant pour {customer} dort depuis {days} jours — on l'envoie ? » · pro : « L'avenant pour {customer} est en brouillon depuis {days} jours. L'envoyer ? » · direct : « Avenant {customer} : brouillon depuis {days} j. Envoyer ? »
- `avenant.voice.notIncluded` — pote : « Attention, l'avenant n°2 n'est pas signé, je ne le compte pas dans la facture. » · pro : « L'avenant n°2 non signé n'est pas inclus dans la facture. » · direct : « Avenant n°2 non signé : exclu. »

### 4.9 Pièges → réponses de conception

| Piège | Réponse |
|---|---|
| « Je veux modifier le devis signé » | Redirection pédagogique systématique, jamais « impossible » sec. |
| Avenant brouillon oublié | Today priorities + notification J+3 (`avenant.reminderDraft`). |
| Client signe l'avenant mais pas le devis | Impossible PAR CONSTRUCTION : création uniquement sur `signed`, revalidé par le use case. |
| Facturer avec un avenant non signé en l'air | Facture = signés uniquement, mention explicite du non-inclus (diff + vocal). |
| Avenant refusé | Marché inchangé, devis JAMAIS peint en échec ; statut visible sur la carte Marché. |
| Moins-value > déjà facturé | Garde I6 à l'envoi ET à la signature — erreur réelle avec montants expliqués, redirection avoir. |
| Latence de signature vs urgence chantier (art. 1793) | Signature sur place privilégiée (première option du wizard). |
| Deux avenants « en vol » | Sérialisation stricte (DEC-2) ; le récapitulatif « nouveau montant » reste univoque. |

---

## 5. Estimation par couche et ordre des lots

Calibrage : B8 ≈ 900 L core / 17 fichiers ; `quote.test.ts` 224 L pour 353 L d'entité ; `sign-quote.test.ts` 253 L. 1 jour-agent ≈ un lot cohérent testé.

| Lot | Contenu | Taille | ~j-agents |
|---|---|---|---|
| **0** | Migrations préalables : valeurs d'enum (`amendment`, `amendment_signature`) en migration séparée, regex `DocNumber` + mapping `AV`, RLS | S | 0,5 |
| **1** | Domaine core : `Avenant`, `AvenantLine`, `deriveMarketState`, alias transitions, événements (~700 L src + ~800 L tests) | M | 2 |
| **2** | Use cases : Create/Update/Send/Sign/Refuse (+ helper `normalizeSignerName` partagé), tokens `amendment_signature`, in-memory repos | M | 2,5 |
| **3** | Persistance Prisma (modèles, index partiel SQL, trigger, mappers, `AvenantRepository`) + `AvenantsController` + dispatch `PublicSignatureController` + `backend.service.ts` | M | 2 |
| **4** | api-client ×3 : `client.ts` views, `avenant-codec.ts`, `http-client.ts`, `local-client.ts` | S | 1 |
| **5** | sign-web (branche `kind==='avenant'`) + `renderAvenant` PDF — **déployé avant activation mobile** | M | 1,5 |
| **6** | Mobile : wizard `/devis/[id]/avenant/new` (machine `flows/avenant`), carte Marché, détail avenant, CTA/redirections, draft-slot | L | 3 |
| **7** | Vocal : outils `creer_avenant`/`envoyer_avenant`, affordances (`editRedirectAvenant`, dictée deductions dans `voice-quote-line.ts`), i18n ×3 tons | M | 2 |
| **8** | Facturation agrégée : `Invoice.fromMarket`, `generate-invoice-from-quote`, `list-invoiceable-quotes`, `build-piece-view`, diffs de confirmation | M | 1,5 |

**Total : ≈ 16 jours-agents (fourchette 14–18).** Dépendances : 0 → 1 → 2 → {3, 4} → 5 → {6, 7, 8} ; 5 (sign-web) doit être EN PROD avant que 6/7 n'activent l'envoi (ou release-flag, DEC-10).

---

## 6. Décisions à trancher (liste fermée — fondateur + GPT)

| # | Décision | Options | Recommandation |
|---|---|---|---|
| **DEC-1** | Identité documentaire | (a) `orderIndex` par parent seul (« Avenant n°2 au devis D-… ») ; (b) double : orderIndex + `DocNumber` société `AV-AAAA-NNNN` no-gap alloué à l'envoi | **(b)** — l'orderIndex parle à l'humain, le `AV-` donne une identité machine/archivage sans coût (compteur générique existant) |
| **DEC-2** | Sérialisation des avenants | (a) strict : un seul non terminal (`draft|sent|viewed`) par devis, index partiel ; (b) souple : brouillons multiples, un seul `sent|viewed` | **(a)** en V1 — base de deltas stable, récapitulatif univoque ; relâcher ensuite = drop d'index, l'inverse serait douloureux |
| **DEC-3** | Op `modify` | (a) modélisée au domaine/schéma mais non exposée (UX = remove+add) ; (b) retirée partout | **(a)** — évite une migration d'enum en V1.x ; l'UX reste simple |
| **DEC-4** | TVA des lignes ajoutées | (a) taux libre par ligne (défaut = taux du devis) ; (b) taux du parent imposé, taux différent ⇒ « nouveau devis » | **(a)** — cas réel bâtiment (5,5 % énergie sur devis à 10 %) ; `remove` porte toujours le taux d'origine (non négociable) |
| **DEC-5** | Avenant sans lignes (calendaire) | (a) V1 = lignes ≥ 1, calendaire en V1.x (avec `effectiveDate`/`newEndDate`) ; (b) V1 accepte 0 ligne + champ délais texte | **(a)** — artisans d'abord ; le modèle (lignes en table séparée) l'accepte déjà sans migration |
| **DEC-6** | `validUntil` propre à l'avenant | (a) V1 sans (TTL 30 j du jeton = seule horloge) ; (b) champ dès la V1 (deux horloges : validité de l'offre ≠ TTL du lien) | **(b) champ nullable dès la V1, UI en V1.x** — un client qui signe des mois plus tard un prix devenu faux est un risque réel |
| **DEC-7** | Acompte sur l'avenant | (a) aucun acompte propre (supplément → solde), mention sur le document ; (b) même % que le parent sur le supplément | **(a)** en V1 — confirmé par la mécanique de déduction existante qui fonctionne inchangée |
| **DEC-8** | Moins-value sous le déjà-facturé | (a) refus dur I6 + redirection avoir avec montants ; (b) autoriser et générer l'avoir automatiquement | **(a)** — jamais de netToPay négatif ; l'avoir reste un acte explicite de l'utilisateur |
| **DEC-9** | Rétractation B2C hors établissement (14 j) | (a) mention légale + bordereau sur le PDF dès la V1 ; (b) V1.x | À trancher juridiquement — **(a)** si la cible V1 inclut les particuliers (c'est le cas artisans) |
| **DEC-10** | Déploiement | (a) ordre strict sign-web → API → mobile ; (b) release-flag `avenants` (infra `release-flag.ts` existante) | **(b)** — décorrèle le déploiement de l'activation, filet en cas de rollback |

---

## 7. Critères d'acceptation binaires

**Domaine / invariants**
1. Créer un avenant sur un devis `draft|sent|viewed|refused|expired` échoue avec le message de redirection ; sur `signed` sans finale, réussit.
2. Créer un avenant quand une facture finale non annulée existe échoue (message avoir/nouveau devis).
3. Deux créations concurrentes d'avenant sur le même devis ⇒ une seule ligne en base (index partiel), l'autre relit l'avenant en vol.
4. Un avenant signé refuse toute mutation de deltas/numéro/marché (entité ET trigger DB).
5. `deriveMarketState` sur devis 2 lignes (10 % et 20 %) + avenant retirant la ligne à 20 % et ajoutant une ligne à 5,5 % rend une TVA STRICTEMENT égale à `computeTotals(lignes effectives)` — pas à la somme des deltas.
6. Un `remove` ciblant une ligne inexistante dans l'état effectif échoue en `VALIDATION`.
7. Envoi d'un avenant dont `marketAfter.ttc <` Σ netToPay déjà émis échoue avec les deux montants dans le message ; idem re-vérifié DANS la transaction de signature.
8. Le refus d'un avenant laisse le devis parent `signed` et le marché inchangé.
9. `DocNumber.parse('AV-2026-0001')` passe ; `'A-2026-0001'` reste un avoir ; la séquence `amendment` est no-gap par société.

**Signature / sécurité**
10. Le jeton d'avenant a le scope `amendment_signature` ; sa révocation ne révoque aucun jeton `quote_signature` du même devis (et réciproquement).
11. La signature d'un avenant fige `marketBefore/marketAfter` identiques à ce que la page sign-web affichait au moment du POST.
12. Un token inconnu/expiré/révoqué sur `/public/sign/:token` répond indistinctement (anti-énumération) pour quote ET avenant.
13. RLS : un tenant B ne lit ni n'écrit `quote_amendments`/`amendment_lines` d'un tenant A ; `rls-schema-coverage.test.ts` passe.
14. La page sign-web déployée AVANT le backend avenant continue de signer les devis (le discriminant `kind` est optionnel).

**Facturation**
15. Facture finale après avenant signé : totaux = marché consolidé, déduction = Σ netToPay des pièces émises ; `netToPay` jamais négatif.
16. Facture finale avec un avenant `sent` non signé : l'avenant est EXCLU et la mention « non inclus » figure dans le diff de confirmation ET la réponse vocale.
17. Acompte généré après avenant signé : assis sur le marché consolidé ; facture d'acompte émise AVANT l'avenant : inchangée au centime.
18. `RegisterPayment` refuse toujours tout encaissement au-delà du netToPay de chaque facture (non-régression).

**UX / vocal**
19. Sur devis signé, « modifie la deuxième ligne » (vocal) déclenche `devis.editRedirectAvenant` (proposition d'avenant), jamais une édition ni un échec sec.
20. « Fais un avenant au devis Durand » avec deux devis signés Durand ⇒ question à options « numéro · objet · montant » ; avec un devis Durand non signé ⇒ bascule pédagogique vers l'édition draft.
21. `creer_avenant` n'a pas de safetyFloor ; `envoyer_avenant` est OUTBOUND avec confirmation typée ; aucun des deux ne contient de logique métier (délégation au use case).
22. Une moins-value s'affiche en rouge avec « − » explicite sur : wizard, détail, sign-web, PDF.
23. Un brouillon d'avenant survit à la fermeture de l'app (draft-slot) et remonte en rappel à J+3.
24. Toutes les clés i18n avenant existent dans les 3 tons ; le libellé du toggle suit la terminologie secteur.
