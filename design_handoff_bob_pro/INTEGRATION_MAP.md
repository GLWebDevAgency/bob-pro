# Carte d'intégration maquette ↔ code — Bob Pro

Analyse du monorepo `Bob Pro/` (NestJS + Expo + `packages/core` domaine pur) confronté à notre maquette `Bob Pro.dc.html`. Objectif : **compléter la maquette avec ce que le back-end sait déjà faire**, et **compléter le code avec ce que la maquette a déjà conçu**.

---

## 1. Ce que le back-end implémente vraiment (au-delà du README)

Domaine déterministe et testé (`packages/core`), exposé via NestJS (`apps/api`) :

- **Facturation** : agrégats `Quote` / `Invoice` avec machines à états strictes, numérotation **séquentielle sans trou** (`D-AAAA-NNNN` / `F-AAAA-NNNN`), totaux + mentions **figés à l'émission**.
- **TVA & mentions** : moteur 20/10/5,5/2,1/0, `suggest-vat-rate` par métier, `build-mentions` (L441-10 + indemnité 40 €, décennale BTP, autoliquidation, franchise 293 B). Test d'or : chauffe-eau acompte 30 % = **488,40 €**.
- **Conformité e-facture** : `einvoice-for` route **PDP (B2B) / Chorus Pro (B2G) / e-reporting (B2C)** ; agrégat `EinvoiceTransmission` (cycle de vie) ; **Factur-X** réel (PDF/A-3 + XML **CII** BASIC attaché) via `pdf-renderer.ts` + `facturx.ts`.
- **Coffre-fort** : agrégat `Document` versionné (SHA-256, `byteSize`, motif), **rétention 10 ans**, origine (generated/uploaded/ocr), rattachement métier, jobs d'**archivage**.
- **OCR** : `ocr-extraction` (domaine) + `apps/api/src/ocr` + **mémoire fournisseurs** (apprend d'un reçu scanné).
- **Trésorerie** : `project-cashflow` (prévision), `score-customer` (scoring payeur).
- **Relances** : `relance-plan` + `build-relance` + `jobs/relance.service` (cadence auto) + notifications.
- **Compta** : `chart-of-accounts`, `accounting-entry`, `invoice-accounting`, `payment-accounting`, persistance dédiée (export).
- **Paiements** : `payment` (agrégat, paiements **partiels**), `payment-gateway`.
- **Abonnement** : `subscription` + `plan` (Solo/Pro/Business), `autonomy-entitlements` (droits IA par offre).
- **Chantier / dépense** : agrégats `chantier`, `expense`.
- **Enrichissement** : adapters **BAN** (adresse), **recherche-entreprises** (SIREN), **VIES** (TVA UE).
- **IA Bob** : `ModelRouter` (Claude/GLM + démo déterministe), garde-fous (aucun montant non calculé), parité IA/manuel garantie par le typage.
- **Multi-tenant** : RLS Postgres (certifié), interceptors, observabilité (logs, métriques, correlation-id).

---

## 2. Data pour les vues de détail (champs exacts à afficher)

**Quote** — statut `draft → sent → viewed → signed | refused | expired` ; `number` (D-AAAA-NNNN), `lines[]`, `depositPct`, `signature`, `totals`, `mentions`, `customerId`.

**Invoice** — statut `draft → issued → partially_paid | paid | late | cancelled` ; `kind` **final | deposit | credit_note | situation** ; **`parentQuoteId`** (lien devis↔facture) ; `number` (F-AAAA-NNNN) ; `frozenTotals` + `mentions` **figés à l'émission** ; `issuedAt`, `dueAt` ; `paid` (centimes cumulés) ; `netToPay`, `depositPct`.

**Totals** — `{ ht, vat, ttc, netToPay }` (centimes). Toujours afficher en `tabular-nums`.

**Transmission (e-facture)** — statut `issued → transmitted → received → accepted → paid | refused`. À montrer sur les factures **B2B** (suivi PDP) et **B2G** (Chorus).

**Document** — `kind` invoice_pdf | quote_pdf | facturx_xml | expense_receipt | signed_quote | other ; `origin` generated | uploaded | ocr ; `versions[]{ version, sha256, byteSize, reason, createdAt }` ; `retentionUntil` (≈ +10 ans) ; `linkedEntityType/Id` ; `documentDate`, `issuedAt`.

**InvoicePdfData (rendu PDF)** — `number`, `companyName`, `companyAddress`, `companyRcsOrRm`, `customerName`, `customerAddress`, `issuedAt`, `dueAt`, `lines[]{ label, qty, unitPriceHT, vatRate }`, `totals{ ht, vat, ttc, netToPay }`, `mentions[]`. **+ pièce jointe `factur-x.xml`** (CII, profil BASIC), métadonnées XMP PDF/A-3.

---

## 3. Écarts — qui est en avance ?

**La MAQUETTE est en avance (→ à porter dans le CODE, listé « reporté » au README) :**
- Facture **à la voix** (dictée → devis).
- **Onboarding adaptatif métier** (SIRET → entreprise, vocabulaire par métier).
- **Diagnostic conformité 2026** (score /100 + checklist).
- **Scan/OCR** côté UI (le domaine OCR existe, pas l'écran).
- **Compte / abonnement / équipe & rôles**, **paywall** contextuel.
- **Notifications** & **relances auto** (UI de réglage).
- **Auth** (email, SSO, Face ID, 2FA), **tweaks** (personnalité / densité / thème).
- **App web** Next.js + **page de signature client** (`sign-web`).

**Le CODE est en avance (→ à porter dans la MAQUETTE) — plan §4.**

---

## 4. Plan : compléter la maquette avec le back-end (rangé par impact)

1. **Vue détail Devis / Facture** (lecture) — n°, kind, statut, parties, lignes, totaux figés, mentions figées, dates (émise/échéance). ★★★
2. **Navigation croisée devis ↔ facture** — depuis une facture « Issue du devis D-… », depuis un devis signé « Facture générée F-… ». *(idée que tu as aimée)* ★★★
3. **Aperçu PDF / Factur-X** — rendu A4 fidèle à `pdf-renderer.ts` + badge « Factur-X · XML CII joint » + note e-reporting/PDP. ★★★
4. **Cycle de vie e-facture** (B2B/B2G) — frise `Émise → Transmise → Reçue → Acceptée → Payée` sur la fiche facture. ★★
5. **Détail document enrichi** — versions + **empreinte SHA-256**, **conservé jusqu'au (10 ans)**, origine (généré/importé/OCR), rattachement métier. ★★
6. **Paiements partiels** — statut `partiellement payé`, « reste dû », historique. ★★
7. **Types de facture** — **avoir** (credit_note) + **situation de travaux** (BTP). ★
8. **Mémoire fournisseurs** (après scan) + **export compta** (FEC / plan comptable). ★

---

## 5. Détails d'implémentation maquette (pour rester fidèle au domaine)

- **Numéros** : `D-2026-014` (devis), `F-2026-118` (facture) — jamais de trou, croissants.
- **Gelé à l'émission** : afficher un cadenas/mention « figé le … » sur totaux + mentions d'une facture émise (immuable).
- **Acompte** : `deposit` = 30 % ; sur le chauffe-eau, acompte = **488,40 €** (test d'or — utiliser ce chiffre pour l'authenticité).
- **Statuts → couleurs** (tokens) : signé/payé = success ; en retard = danger ; émis/transmis = b2b ; en attente = warning ; refusé/annulé = slate.
- **e-facture** : B2B → PDP ; B2G → Chorus Pro ; B2C → e-reporting (pas de transmission, juste déclaration).
- **Actions sensibles** (émettre, encaisser, transmettre, avoir) = confirmation utilisateur (garde-fou).
