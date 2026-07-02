# Domaine & règles métier — Bob Pro

Tout ce qui suit vit dans **`packages/core`** (zéro UI). C'est le cœur partagé mobile + web. Les types sont indicatifs (TypeScript) ; adapte-les à ton ORM/back.

---

## 1. Entités

```ts
// ——— Entreprise de l'utilisateur (l'artisan) ———
interface Company {
  id: string;
  name: string;                 // "Mercier Plomberie"
  legalForm: 'EI' | 'EURL' | 'SASU' | 'SARL' | 'SAS' | 'micro';
  siren: string;                // 9 chiffres
  siret: string;                // 14 chiffres (établissement)
  apeCode?: string;             // ex. "4322A"
  trade: Trade;                 // métier (pilote le vocabulaire — cf. onboarding)
  vatRegime: VatRegime;
  rcsOrRm?: string;             // "RM 92" (artisans) ou "RCS Nanterre"
  address: Address;
  iban?: string; bic?: string;  // pour les RIB sur facture (Brique 3)
  decennale?: InsurancePolicy;  // assurance décennale (BTP)
  logoUrl?: string;
  invoiceCounters: { quote: number; invoice: number; credit: number }; // numérotation séquentielle
}

type Trade =
  | 'plombier' | 'electricien' | 'macon' | 'peintre' | 'paysagiste'
  | 'consultant' | 'photographe' | 'coach' | 'autre';

type VatRegime =
  | 'franchise'   // franchise en base (art. 293 B) — pas de TVA facturée
  | 'reel_simpl'  // réel simplifié
  | 'reel_normal';

// ——— Client ———
interface Customer {
  id: string;
  type: 'b2c' | 'b2b' | 'b2g';  // particulier / entreprise / public
  name: string;
  siren?: string;               // requis B2B/B2G pour l'e-invoicing
  address: Address;
  email?: string; phone?: string;
  paymentTerms: string;         // "Paiement à 30 jours", "Mandat administratif"…
  // métriques (calculées, cf. §6)
  score: number;                // 0–100
  avgDelayDays: number;
  outstanding: number;          // encours en cents
  einvoice: EinvoiceProfile;    // dérivé du type (cf. §5)
}

// ——— Devis / Facture (cycle de vie commun) ———
type DocKind = 'quote' | 'invoice' | 'deposit_invoice' | 'credit_note' | 'situation';

interface BillingDoc {
  id: string;
  kind: DocKind;
  number: string;               // "D-2026-014", "F-2026-118" — séquentiel, jamais de trou
  customerId: string;
  status: BillingStatus;
  lines: LineItem[];
  issuedAt?: string; dueAt?: string;
  validUntil?: string;          // devis
  signature?: Signature;        // devis signé
  parentQuoteId?: string;       // facture issue d'un devis
  depositPct?: number;          // facture d'acompte (ex. 30)
  totals: Totals;               // calculés (cf. §3)
  legalMentions: string[];      // générées (cf. §4)
}

type BillingStatus =
  | 'draft' | 'sent' | 'viewed' | 'signed' | 'refused'   // devis
  | 'issued' | 'transmitted' | 'accepted' | 'paid' | 'late' | 'cancelled'; // facture / e-invoice

interface LineItem {
  id: string;
  label: string;                // "Chauffe-eau 200 L"
  category: LineCategory;       // pour tri & analytique
  qty: number; unit?: string;   // "j", "h", "u", "forfait"
  unitPriceHT: number;          // cents
  vatRate: VatRate;             // cf. §2
  catalogItemId?: string;       // si issu du catalogue (Brique 2)
}

type LineCategory = 'labor' | 'supply' | 'travel' | 'disbursement' | 'subscription';

interface Totals { ht: number; vatByRate: Record<string, number>; vat: number; ttc: number; netToPay: number; }

interface Signature { signerName: string; signedAt: string; method: 'draw'; ip?: string; accepted: true; }

// ——— Paiement / Trésorerie / Documents ———
interface Payment { id: string; docId: string; amount: number; method: 'card' | 'transfer' | 'cash'; receivedAt: string; }
interface Doc { id: string; name: string; kind: 'quote'|'invoice'|'receipt'|'photo'|'doc'; folderId: string; date: string; amount?: number; ocr?: OcrResult; }
interface Folder { id: string; name: string; count: number; }
interface ComplianceItem { id: string; label: string; applies: boolean; done: boolean; dueDate?: string; }
interface InsurancePolicy { insurer: string; policyNo: string; coverage: string; expiresAt: string; }
interface Address { line1: string; zip: string; city: string; }
```

---

## 2. TVA — taux & sélection (France)

```ts
type VatRate = 20 | 10 | 5.5 | 2.1 | 0;
```

| Taux | Usage typique pour la cible |
|---|---|
| **20 %** | Taux normal — prestations & ventes par défaut. |
| **10 %** | Travaux d'**amélioration/entretien** d'un **logement achevé depuis +2 ans**. *(C'est le cas du devis chauffe-eau du proto.)* |
| **5,5 %** | Travaux de **rénovation énergétique** (isolation, PAC…). |
| **2,1 %** | Cas particuliers (rare pour la cible). |
| **0 %** | **Franchise en base** (`vatRegime: 'franchise'`) → aucune TVA facturée + mention obligatoire (cf. §4). |

> **Règle produit (« Bob choisit le bon taux ») :** proposer le taux selon `Company.trade` + nature du logement (>2 ans) + catégorie de ligne, et laisser l'utilisateur surcharger. Implémente `suggestVatRate(company, customer, line, context): VatRate`.

---

## 3. Calcul des totaux

```ts
function computeTotals(lines: LineItem[], opts?: { depositPct?: number }): Totals {
  const ht = sum(lines.map(l => l.qty * l.unitPriceHT));
  const vatByRate: Record<string, number> = {};
  for (const l of lines) {
    const base = l.qty * l.unitPriceHT;
    vatByRate[l.vatRate] = (vatByRate[l.vatRate] ?? 0) + Math.round(base * l.vatRate / 100);
  }
  const vat = sum(Object.values(vatByRate));
  const ttc = ht + vat;
  const netToPay = opts?.depositPct ? Math.round(ttc * opts.depositPct / 100) : ttc;
  return { ht, vatByRate, vat, ttc, netToPay };
}
```

**Facture d'acompte** : applique `depositPct` proportionnellement à chaque base (HT, TVA, TTC). Ex. proto : HT 1 480 € · TVA 10 % 148 € · TTC 1 628 € → acompte 30 % = HT 444 € · TVA 44,40 € · **net 488,40 €**. Le **solde** est facturé en facture finale (TTC − acompte déjà facturé).

---

## 4. Mentions légales obligatoires (générateur)

`buildMentions(company, customer, doc): string[]` doit composer dynamiquement :

- Identité émetteur : raison sociale, **SIREN/SIRET**, forme juridique, adresse.
- **RCS** (ville) pour commerçants **ou RM** (n° répertoire des métiers) pour artisans.
- **TVA** : n° de TVA intracom **ou**, si franchise, la mention exacte *« TVA non applicable, art. 293 B du CGI »*.
- N° de facture **séquentiel**, date d'émission, date de vente/prestation.
- Désignation, quantité, PU HT, **taux de TVA par ligne**, totaux HT/TVA/TTC.
- Conditions de règlement + **pénalités de retard** + **indemnité forfaitaire de recouvrement 40 €** (réf. L441-10 c. com.).
- **BTP** : **assurance décennale** — assureur, n° de police, couverture géographique.
- **Autoliquidation** de TVA si sous-traitance BTP B2B (mention « Autoliquidation »).
- Devis : « Devis gratuit », durée de validité (ex. 30 j), « Bon pour accord ».

Le proto montre ces mentions condensées en puce verte « Mentions légales ajoutées » sur le devis et la facture.

---

## 5. Facturation électronique 2026/2027 (routage)

```ts
interface EinvoiceProfile { channel: 'pdp' | 'chorus_pro' | 'ereporting'; label: string; ready: boolean; }

function einvoiceFor(customer: Customer, company: Company): EinvoiceProfile {
  if (customer.type === 'b2g') return { channel: 'chorus_pro', label: 'Client public · Chorus Pro', ready: true };
  if (customer.type === 'b2b') return { channel: 'pdp', label: 'Facture électronique requise', ready: !!customer.siren };
  return { channel: 'ereporting', label: 'Vente à un particulier · e-reporting', ready: true }; // B2C
}
```

**Calendrier (à afficher dans le diagnostic) :**
- **1ᵉʳ sept. 2026** — **réception** des factures électroniques obligatoire pour **toutes** les entreprises ; **émission** obligatoire pour les **grandes entreprises & ETI**.
- **1ᵉʳ sept. 2027** — **émission** obligatoire pour les **PME & TPE** (la cible de Bob).
- **B2B domestique** → via une **PDP** (Plateforme de Dématérialisation Partenaire). Formats **Factur-X / UBL / CII**.
- **B2C & international** → **e-reporting** (transmission des données de transaction/paiement).
- **B2G** → **Chorus Pro** (déjà en place).

Cycle de vie e-invoice (statuts) : `issued → transmitted → received → accepted/refused → paid`. Le proto matérialise « plateforme détectée · SIREN vérifié ✓ ».

---

## 6. Scoring client (mauvais payeur)

```ts
function scoreCustomer(c: { avgDelayDays: number; outstanding: number; history: Payment[] }): number { /* 0–100 */ }
```
Bandes : **≥ 85** vert « Bon payeur » · **65–84** orange « Payeur correct » · **< 65** rouge « À surveiller ». Affiché en barre de progression colorée sur la fiche client + repris dans « À surveiller ».
Seed proto : `durand 96 · martin 62 · sevres 78 · lefevre 99 · bernard 88 · camping 50`.

---

## 7. Trésorerie prédictive

3 scénarios sur 4 horizons. Le **prudent** applique ~20 % de risque d'impayé aux encours.

```ts
type Scenario = 'optimiste' | 'realiste' | 'prudent';
type Horizon = 7 | 30 | 60 | 90;
// dispo prévisionnel = solde banque + encaissements probables(scénario, horizon) − charges/TVA prévues
```
Seed proto (réaliste) : 7j 5 400 € · 30j 4 950 € · 60j 3 100 € (creux) · 90j 7 200 €.
« Te verser » = montant qu'on peut se payer sans risque (proto : ~2 000 €), distinct du **solde bancaire qui « ment »** (proto : 6 820 € banque, mais 1 240 € TVA à reverser + charges).

---

## 8. Relances — tons & cadre légal

```ts
type RelanceTone = 'cordial' | 'neutre' | 'ferme' | 'miseendemeure';
```
4 niveaux ; le message se réécrit selon le ton. La **mise en demeure** ajoute la base légale **L441-10** (pénalités + **indemnité forfaitaire 40 €**). Idéal en cadence auto (Brique « relances programmées ») : J+7 cordial → J+15 neutre → J+30 ferme → mise en demeure.

---

## 9. Machines à états des flux (à porter tel quel)

**Devis → signature → facture** (`packages/core/flows/devis.ts`), reproduit dans le proto :
```
compose → sent → (viewed) → signed → invoice(deposit|final) → paid
```
- `compose` : lignes + totaux + toggle acompte 30 % + mentions générées.
- `sent` : timeline Envoyé ✓ / Vu / Signé ; relance auto si pas de réponse < 3 j.
- `sign` (vue client) : récap + « Bon pour accord » + **signature dessinée** (`Signature`).
- `signed` : devis accepté & classé → génère la facture (acompte ou finale selon toggle).
- `invoice` : facture conforme (mentions + routage e-invoice) → encaissement.
- `paid` : encaissé, classé, tréso mise à jour.

**Facture à la voix** (`flows/voiceInvoice.ts`) : `listening → review(prérempli) → done(encaissé|envoyé)`.

---

## 10. Données de seed (depuis le proto, pour mocks/tests)

Reprends `DATA_CLIENTS`, `DOCS_FOLDERS`, `CASH`, `SCORES`, `SCEN`, `TONES` du fichier `Bob Pro.dc.html` (cherche ces constantes dans la classe `Component`). Elles forment un jeu de données cohérent (Mercier Plomberie + 6 clients : Durand, Martin, Mairie de Sèvres, Lefèvre, Bernard, Camping Les Pins) à utiliser comme fixtures tant que l'API n'est pas branchée.
