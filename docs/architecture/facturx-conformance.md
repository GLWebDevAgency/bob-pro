# Conformité Factur-X — stratégie de validation

Bob Pro génère des factures **Factur-X profil BASIC** (XML CII UN/CEFACT D16B embarqué dans un PDF, norme EN 16931). La conformité est garantie à trois niveaux.

## 1. À la construction (déterministe, dans le domaine)

`facturXDataFromInvoice()` projette l'agrégat `Invoice` + `Company` en `FacturXInvoiceData` avec une arithmétique alignée au centime sur `computeTotals` (règles BR-CO-10/13/15/16). Les catégories de TVA (S/E/Z), la franchise en base (293 B, jamais de TVA), l'acompte (TotalPrepaid/DuePayable) et l'identifiant vendeur (SIREN sous schemeID 0002) sont traités à la source.

## 2. Garde-fou en CI (« Schematron lite »)

`validateFacturXBasic(data)` (paquet `@bob/core`) vérifie un sous-ensemble des règles métier EN 16931 :

- **BR-CO-10/13/14/15/16/17** — cohérence des totaux et de la ventilation TVA, au centime.
- **BR-S-05 / BR-E-01/05/09/10 / BR-Z-05/09** — règles par catégorie de TVA (taux, montant, motif d'exonération).
- **BR-02/03/05/06/07/16/CO-26** — champs obligatoires.

Exécuté par les tests `facturx-conformance.test.ts` sur des factures réellement émises (réel mono-taux, réel multi-taux, franchise) → `pnpm test`. Tout écart casse la CI.

## 3. Conformité légale complète (à brancher en prod)

Le garde-fou interne ne remplace pas les validateurs officiels. Avant mise en production, ajouter au pipeline CI :

- **Schematron EN 16931** officiel (règles BR/BR-CO/BR-S… complètes) appliqué au XML CII généré
  (ex. `mustangproject` CLI, ou les XSLT de `ConnectingEurope/eInvoicing-EN16931`).
- **veraPDF** en profil **PDF/A-3b** sur le PDF hybride.

### Limites connues du PDF actuel (pdf-lib)

- Polices **non embarquées** (StandardFonts Helvetica) → non conforme PDF/A-3 strict.
- Pas d'**OutputIntent** sRGB ni d'`/ID` document.

Correctif prod : post-traiter le PDF (Ghostscript `-dPDFA=3` + profil ICC, ou un convertisseur PDF/A) après génération. Le **XML CII** (le payload e-invoicing) et l'**association de fichier** (`/AF`, `AFRelationship=Data`, arbre `/Names/EmbeddedFiles`, XMP Factur-X avec schéma d'extension) sont déjà corrects.
