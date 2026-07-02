# Prompts de construction — Claude Code

> Séquence de prompts **prêts à coller** dans Claude Code, dans l'ordre. Chacun est autonome ; exécute-les un par un, vérifie, commit, puis passe au suivant. Garde ce dossier (`design_handoff_bob_pro/`) ouvert dans le repo : les prompts y renvoient (`tokens.ts`, `DOMAIN_MODEL.md`, `SCREENS.md`, `VOICE_AND_TONE.md`, et les `*.dc.html` de référence).

**Règle d'or rappelée à chaque phase :** les `*.dc.html` sont des **références de design hi-fi**, pas du code à copier. On **recrée nativement** (React Native + Next.js) en s'appuyant sur les tokens et le domaine. Direction visuelle **figée** — ne pas réinventer.

---

## Phase 0 — Scaffold du monorepo

```
Crée un monorepo pnpm + Turborepo nommé "bob-pro" :
- apps/mobile : Expo (React Native, TypeScript, expo-router).
- apps/web : Next.js 14 (App Router, TypeScript).
- packages/tokens : module TS des design tokens, zéro dépendance.
- packages/core : domaine + logique métier, zéro UI, zéro import RN/Next.
- packages/ui : primitives partagées avec implémentations par plateforme (fichiers .native.tsx et .web.tsx résolus par le bundler).
- packages/i18n : copy FR centralisée.
Configure : tsconfig.base.json (paths @bob/tokens, @bob/core, @bob/ui, @bob/i18n), turbo.json (build/lint/typecheck/dev), pnpm-workspace.yaml, ESLint + Prettier + TypeScript strict.
Ne mets aucune logique métier dans les apps : elles n'orchestrent que de l'UI + l'état d'écran.
Vérifie que `pnpm dev` lance mobile (Expo) et web (Next) en parallèle.
```

## Phase 1 — Tokens & theming

```
Copie design_handoff_bob_pro/tokens.ts dans packages/tokens/src/index.ts. C'est la source unique de vérité ; ne modifie aucune valeur (identité figée).
Ajoute :
- packages/tokens : un générateur qui produit, à partir des tokens, (a) un fichier de CSS custom properties pour le web et (b) un objet de styles pour RN.
- 4 thèmes de marque (marine défaut, foret, graphite, indigo) + un ThemeProvider :
  • Web : applique les variables du thème sur :root ; les dégradés (header/hero/fab/cta) via background-image.
  • RN : Context qui expose le thème courant ; dégradés via expo-linear-gradient (parse les linear-gradient en {colors, start, end}).
- Charge les polices Schibsted Grotesk (700/800) et Hanken Grotesk (500/600/700) : expo-font côté mobile, next/font côté web.
- Un helper d'argent core/format/money.ts : fr-FR, espace fine insécable pour les milliers, virgule décimale, tabular-nums. formatEUR(148000) -> "1 480,00 €".
Expose aussi les 3 réglages utilisateur (personality, density, brand) dans un store de préférences persistant (mobile: AsyncStorage, web: cookie/localStorage).
```

## Phase 2 — Cœur métier (packages/core)

```
Implémente packages/core en suivant design_handoff_bob_pro/DOMAIN_MODEL.md À LA LETTRE.
- Types : Company, Customer, BillingDoc, LineItem, Totals, Signature, Payment, Doc, Folder, ComplianceItem (§1).
- Règles :
  • tva.ts : VatRate + suggestVatRate() (20/10/5,5/2,1/0 selon métier, logement >2 ans, catégorie de ligne) (§2).
  • totals.ts : computeTotals() avec acompte proportionnel (§3). Teste sur l'exemple chauffe-eau (HT 1480 / TVA10% 148 / TTC 1628 ; acompte 30% -> net 488,40).
  • mentions.ts : buildMentions(company, customer, doc) -> string[] (SIREN/RCS/RM, TVA ou art. 293 B, pénalités + indemnité 40€ L441-10, décennale BTP, autoliquidation, validité devis) (§4).
  • einvoice.ts : einvoiceFor(customer) -> {channel: pdp|chorus_pro|ereporting} + calendrier 2026/2027 (§5).
  • scoring.ts : scoreCustomer() 0–100 + bandes vert/orange/rouge (§6).
  • cashflow.ts : projection par scénario (optimiste/réaliste/prudent) × horizon (7/30/60/90) (§7).
  • relance.ts : 4 tons (cordial→mise en demeure) + texte légal L441-10 (§8).
  • flows/devis.ts et flows/voiceInvoice.ts : machines à états (§9), framework-agnostiques (réutilisables RN + web).
- Fixtures : porte les constantes DATA_CLIENTS, DOCS_FOLDERS, CASH, SCORES, SCEN, TONES depuis "Bob Pro.dc.html" vers core/fixtures (§10).
- Couvre tva/totals/mentions/scoring de tests unitaires.
```

## Phase 3 — Primitives UI (packages/ui)

```
Construis la bibliothèque de composants d'après design_handoff_bob_pro/Design System.dc.html (section 07) et tokens.ts. Chaque composant = un contrat partagé + impl. .native.tsx / .web.tsx, stylé uniquement via les tokens/thème.
Composants : Button (primaire dégradé cta / secondaire / IA / danger), Card (e1/e2), Chip (filtre on/off), Segmented (7/30/60/90, scénarios), Badge (statut + type B2B/B2C/B2G), ListRow (avatar squircle + titre + montant), ScoreBar, Sheet (bottom sheet mobile / modale centrée web), Toast, FAB, TabBar (mobile) + SideNav (web), Stepper (1·2·3 des flux), SignaturePad (dessin au doigt -> image), Avatar, MoneyText (tabular-nums), Eyebrow, SectionHeader.
Contraintes : rayons & ombres des tokens, hit-target ≥ 44, icônes filaires (Lucide), AUCUNE couleur de marque en dur, PAS d'animation d'entrée à opacité 0 sur contenu au repos. Anime via reanimated (RN) / framer-motion (web) : sheet up, fade .2–.25s, score count-up, onde voix.
Monte une "galerie" (storybook-like) qui rend tous les composants dans les 4 thèmes.
```

## Phase 4 — Écrans & flux (mobile d'abord)

```
Implémente les écrans de design_handoff_bob_pro/SCREENS.md dans apps/mobile avec expo-router, en consommant @bob/ui, @bob/core, @bob/tokens. Fidélité hi-fi (compare à "Bob Pro.dc.html").
Navigation : tab bar 5 destinations (Aujourd'hui, Clients, Argent, Documents, Assistant) + FAB central -> feuille de création.
Ordre conseillé :
1) Aujourd'hui (en-tête dégradé, dispo réel + "te verser", 3 priorités, coup d'œil, vite fait, pied).
2) Argent (te verser, grand-livre "le solde ment", scénarios × horizons, à surveiller, mise de côté).
3) Clients (liste + filtres + score) et fiche client (onglets, e-invoice, CTA contextuelle).
4) Documents (dossiers, scan OCR animé, détail).
5) Assistant = Bob (chat + suggestions + cartes d'action ; "Bob • en ligne").
6) Flux : Facture à la voix (3 étapes) ; Devis→signature→facture (6 étapes, depuis flows/devis) ; Onboarding adaptatif (5) ; Diagnostic 2026 (score animé) ; Auth (4) ; Compte/Abo ; Équipe ; Paywall.
Toute la copy passe par @bob/i18n et respecte design_handoff_bob_pro/VOICE_AND_TONE.md (Bob, défaut "Pote", tutoiement). Câble les 3 réglages (personality/density/brand) sur l'UI réelle.
Prévois loading/empty/error/offline pour chaque écran.
```

## Phase 5 — Web responsive (apps/web)

```
Implémente apps/web (Next.js App Router) en réutilisant @bob/ui (.web.tsx), @bob/core, @bob/tokens. Mêmes écrans, coque adaptée (cf. README §Web responsive) :
- Navigation : SideNav verticale à gauche dès lg (1024). Tab bar/menu en mobile web.
- Layout : passe en 2–3 colonnes sur desktop (Aujourd'hui = priorités | trésorerie ; Clients = liste maître | fiche détail côte à côte).
- Flux (voix, devis→signature, onboarding) : modales centrées (~720px) sur desktop, plein écran en mobile web.
- Breakpoints sm640/md768/lg1024/xl1280, mobile-first.
- Rendu : RSC pour les pages de contenu, Client Components pour les flux interactifs.
Garde une parité visuelle stricte avec le mobile (mêmes tokens). Aucune divergence de couleurs/typo.
```

## Phase 6 — Couche données

```
Définis des contrats d'API typés dans packages/core/api (auth, company, customers, billing docs (devis/factures/acomptes), payments, documents+OCR, compliance, cashflow, subscription, team). 
- Démarre sur les fixtures (§10) via un adaptateur "mock" pour que mobile + web tournent sans back.
- Couche de données partagée (TanStack Query) avec le même client pour les deux apps.
- Points d'intégration réels à brancher plus tard : PDP (e-invoicing B2B), Chorus Pro (B2G), e-reporting (B2C), banque (DSP2/agrégation), paiement (CB), OCR/VLM (scan), génération PDF Factur-X, signature électronique.
Laisse des TODO clairs à chaque frontière externe.
```

## Phase 7 — Qualité

```
- Accessibilité : contrastes AA, focus visibles (web), labels (RN), tailles de police dynamiques.
- États : skeletons de chargement, vides, erreurs réseau, hors-ligne, échec OCR/signature.
- i18n prêt (FR par défaut ; structure pour l'international "Back Office Buddy").
- Tests : unitaires core (tva/totals/mentions/scoring), e2e des flux devis→facture et facture-à-la-voix.
- Perf : FlashList pour les listes, images optimisées, code-splitting web.
Vérifie la parité mobile/web sur les écrans clés via captures.
```

---

### Rappels permanents
- **Identité figée** : couleurs/typo/rayons/ombres = `tokens.ts`. Ne pas dériver de nouvelles couleurs.
- **Bob** : assistant + voix ; défaut Pote (tutoiement). Bob **agit**, jamais culpabilisant.
- **Conformité réelle** : la valeur produit tient aux règles de `DOMAIN_MODEL.md` (TVA, mentions, e-invoicing 2026/2027). À implémenter sérieusement, pas en façade.
- **Argent** : `tabular-nums`, format fr-FR, partout.
