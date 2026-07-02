# CLAIMS — tableau de bord vivant

> Canal de coordination **unique** entre Claude Code (BUILDER) et GPT‑5 Pro (ARCHITECT/REVIEWER).
> Protocole : `AGENT_ORCHESTRATION.md`. Un claim = un écran / un flux / un package.
> **On ne code pas un claim avant que son Contrat soit double-signé. On ne fusionne pas sans PARITY-PASS de l'autre agent.**

**Légende status :** `OPEN → CLAIMED → SPEC-AGREED → IN-BUILD → IN-REVIEW → (CHANGES-REQUESTED) → PARITY-VERIFIED → MERGED` · hors-piste : `BLOCKED` · `NEEDS-HUMAN`.

**Comment réserver :** choisis un claim `OPEN` dont tous les `depends-on` sont `MERGED`, mets ton nom dans `owner`, status `CLAIMED`, logue `CLAIM`. L'autre agent devient `reviewer`.

---

## Fondations — séquentiel (bloque tout le reste)

### C00 — Scaffold monorepo            <!-- kind: package -->
- status: IN-REVIEW
- owner: claude-code (builder)
- reviewer: gpt5pro
- depends-on: —
- target: (racine)
- spec: README.md § Architecture · CLAUDE_CODE_PROMPTS.md Phase 0

#### Contrat (v1, proposé par claude-code)
- Existant constaté (2026-07-02, branche hardening/integrity-rls-conformite-deps) :
  pnpm 9.12 + Turborepo 2 ; workspace `packages/* + apps/*` ; TS strict global
  (tsconfig.base.json : strict + noUncheckedIndexedAccess + exactOptionalPropertyTypes) ;
  apps/mobile (Expo 56, expo-router, React 19.2.3) ; apps/api (NestJS, prod Railway) ;
  apps/sign-web (Vercel) ; packages @bob/tokens, @bob/core, @bob/ai, @bob/api-client.
- Périmètre C00 (écart à combler — additif uniquement) :
  1. apps/web — scaffold Next App Router minimal (@bob/web), TS strict, page racine placeholder.
     Next ≥ 16 (React 19) — amendement A1, décision humaine du 2026-07-02 (remplace la
     proposition Next 15 acceptée par gpt5pro ; alignement React 19 avec Expo 56 conservé).
  2. packages/ui — scaffold @bob/ui (tsup + vitest + structure src/ avec index vide) ; contenu = C03.
  3. packages/i18n — scaffold @bob/i18n (dictionnaire fr typé, `t(key)`, personnalité défaut « Pote ») ;
     remplissage des clés = au fil des claims d'écran.
  4. tsconfig.base.json — paths @bob/ui + @bob/i18n ; turbo.json inchangé (tasks déjà génériques).
  5. `pnpm dev` lance Expo (mobile) + Next (web) ; filtrage `--filter` préservé.
- Interdits : ne pas toucher apps/api, apps/sign-web, packages/ai, packages/api-client, prisma, CI
  (périmètre Codex/production) ; aucune logique métier dans apps/ ; C00 ne style rien (0 valeur design).
- États : n/a (claim package — pas d'UI).
- Edges IN : — (racine du graphe). Edges OUT : débloque C01 (tokens) et C02 (core).
- Acceptance :
  - `pnpm typecheck` clean sur le workspace entier (web + ui + i18n inclus).
  - `pnpm dev` démarre Expo et Next sans erreur (smoke loggé dans le claim).
  - `pnpm --filter @bob/web build` OK.
  - `packages/i18n/src/i18n.test.ts` : `t('bob.greeting')` → chaîne fr non vide ; clé inconnue → erreur compile-time.
  - token-lint : `grep -REn '#[0-9a-fA-F]{3,8}|rgba?\(' packages/ui apps/web/app` → 0 résultat.

#### Signatures (2 requises)
- [x] agreed — gpt5pro     — 2026-07-02 — contract@4496f952
- [x] agreed — claude-code — 2026-07-02 — contract@4496f952

#### Review (rempli par le reviewer)
- [ ] structure workspace conforme au contrat (apps/web, packages/ui, packages/i18n)
- [ ] TS strict partout, paths à jour
- [ ] aucune logique métier dans apps/
- [ ] token-lint clean
- [ ] périmètre Codex intact (apps/api, sign-web, ai, api-client, prisma, CI)
- verdict: —

#### Log (append-only, horodaté)
- [13:48] claude-code CLAIM: réserve C00 (premier OPEN sans depends-on). Constat : monorepo déjà largement en place — le contrat cible l'écart réel (apps/web, @bob/ui, @bob/i18n), pas un scaffold from scratch.
- [13:50] claude-code PROPOSE: Contrat v1 (contract@4496f952 = sha256 tronqué de la section Contrat). Point d'arbitrage unique : Next 15 vs Next 14 — Expo 56 est sur React 19.2.3, Next 14 plafonne à React 18, or C03/C30 partagent @bob/ui `*.web.tsx` entre les deux apps. J'ai signé ; COUNTER ou AGREE + signature de ton côté. AUCUN CODE ne sera écrit avant double-signature.
- [13:52] gpt5pro AGREE: contrat C00 accepté et signé contract@4496f952. Next 15 est accepté pour alignement React 19 avec Expo 56 et avec `apps/sign-web` déjà en Next 15 ; C00 reste additif, sans logique métier ni valeur design. Go build côté claude-code.
- [13:56] human DECISION (A1): « pour next js on utilise v16 et plus » — apps/web passe en Next ≥ 16. Contrat amendé (point 1), nouveau hash contract@1f3a7f64. Alignement React 19 inchangé ; signatures v1 maintenues, l'humain tranche (§5). Build démarré (status IN-BUILD).
- [14:00] gpt5pro REVIEW: A1 pris comme autorité humaine ; Next 16 OK (registre npm lu : 16.2.10). Préflight non bloquant avant HANDOFF : `@bob/web` importe `@bob/i18n` alors que `@bob/i18n` exporte `dist/*`; vérifier que `pnpm --filter @bob/web build` passe sans build manuel préalable des deps, ou ajuster résolution/source avant livraison.
- [14:03] gpt5pro REVIEW: prévalidation légère pendant IN-BUILD : `pnpm --filter @bob/web exec tsc --noEmit --incremental false` OK ; token-lint contractuel `grep -REn '#[0-9a-fA-F]{3,8}|rgba?\(' packages/ui apps/web/app` OK (0 résultat). Checklist finale non cochée avant HANDOFF.
- [14:05] human PRIORITY: priorité produit = mobile React Native Expo. Conséquence opérationnelle : C00 garde `apps/web` strictement minimal (scaffold), aucun polish web/C30 avant les fondations C01+C02+C03 et les premiers écrans mobile ; les prochains contrats doivent optimiser le chemin vers l'app mobile hi-fi.
- [14:09] gpt5pro REVIEW: logs locaux observés : `@bob/web build` OK sous Next 16.2.10, `@bob/web typecheck` OK, `@bob/i18n`/`@bob/ui` build+typecheck OK ; artefacts `.next/dist/.turbo/node_modules/tsbuildinfo` ignorés. En attente du HANDOFF formel (status `IN-REVIEW` + validations + éventuel commit/sha). À corriger au handoff : journal global encore `C00 | CLAIMED`.
- [14:10] gpt5pro REVIEW: validations reviewer lancées sans cocher la review finale : `pnpm typecheck` OK (15/15 tasks) ; `pnpm --filter @bob/i18n test` OK (4 tests). Toujours en attente du HANDOFF formel pour verdict.
- [14:16] claude-code LOG (smoke acceptance): `pnpm dev` → Metro/Expo « Waiting on http://localhost:8081 » + `packager-status:running` ✓ · @bob/web « ▲ Next.js 16.2.10 (Turbopack) ✓ Ready in 424ms » sur :3010, page racine servie avec `t('bob.tagline')` (curl vérifié) ✓ · sign-web Ready ✓. Hors périmètre : `apps/api` en EADDRINUSE :3000 (collision préexistante avec sign-web, signalée à Codex via .agent-sync).
- [14:16] claude-code LOG (préflight 14:00 traité): build @bob/web = `pnpm --filter @bob/i18n build && next build`, vérifié à froid après `rm -rf packages/i18n/dist apps/web/.next` → OK. Dette assumée : énumération manuelle des deps ; à remplacer avant C30 (condition d'export `development` → src ou acceptance `--filter @bob/web...`).
- [14:16] claude-code LOG (vérif adversariale pré-HANDOFF, 3 agents indépendants): contrat ✓ (5 points + acceptance re-exécutée à froid, garde compile-time i18n prouvée sous tsc) · périmètre ✓ (interdits intacts ; pnpm-lock 100 % additif, importers ajoutés = web/i18n/ui seulement) · qualité ✓ (mineurs actés : dette build ci-dessus ; piège expo-cli — tout `pnpm dev`/`typecheck` régénère `apps/mobile/expo-env.d.ts` + `.gitignore`, nettoyés avant commit, à gitignorer dans un claim mobile).
- [14:17] claude-code HANDOFF: build @86ef5c2 (15 fichiers, +414/−1). Capture n/a — claim package sans UI ; preuves = acceptance ci-dessus. status=IN-REVIEW. Pipelining (priorité humaine mobile actée) : contrats C01 et C02 prêts à PROPOSER dès ton verdict — C01 : écart mesuré tokens v1.1 purement additif (21 clés `patterns.*` : floatingBalanceCard/innerScreenHeader/moneyRow, 0 valeur existante modifiée) ; C02 : core couvre ~90 % (test d'or 488,40 déjà vert), écart = flows devis/voiceInvoice consommables UI + fixtures proto vs support.js.

### C01 — Tokens & theming             <!-- kind: package -->
- status: OPEN · depends-on: C00 · target: packages/tokens
- spec: tokens.ts (figé) · CLAUDE_CODE_PROMPTS.md Phase 1
- Contrat: copier tokens.ts sans altérer une valeur ; générateur CSS-vars (web) + objet RN ; 4 thèmes (marine/foret/graphite/indigo) + ThemeProvider ; polices (expo-font / next/font) ; `formatEUR` fr-FR ; store prefs (personality/density/brand).
- Acceptance: `formatEUR(148000)="1 480,00 €"` · switch de thème live · 0 valeur modifiée vs tokens.ts.

### C02 — Cœur métier                  <!-- kind: package -->
- status: OPEN · depends-on: C00 · target: packages/core
- spec: DOMAIN_MODEL.md (à la lettre) · CLAUDE_CODE_PROMPTS.md Phase 2
- Contrat: types (Company…BillingDoc) ; tva · totals · mentions · einvoice · scoring · cashflow · relance ; flows/devis · flows/voiceInvoice ; fixtures portées du proto.
- Acceptance: test d'or `computeTotals` chauffe-eau → HT 1480 / TVA 148 / TTC 1628 / acompte 30 %→net 488,40 · `einvoiceFor(B2C)=ereporting`, `(B2B)=pdp`, `(B2G)=chorus_pro`.

### C03 — Primitives UI                 <!-- kind: package -->
- status: OPEN · depends-on: C01, C02 · target: packages/ui
- spec: Design System.dc.html §07 · COMPONENT_SPECS.md · CLAUDE_CODE_PROMPTS.md Phase 3
- Contrat: Button/Card/Chip/Segmented/Badge/ListRow/ScoreBar/Sheet/Toast/FAB/TabBar/SideNav/Stepper/SignaturePad/Avatar/MoneyText/Eyebrow/SectionHeader ; contrat + `.native.tsx`/`.web.tsx` ; galerie 4 thèmes.
- Acceptance: galerie rend tout dans les 4 thèmes · token-lint clean · hit-target ≥ 44.

---

## Écrans mobile — parallélisables (après C03 MERGED)

### C10 — Aujourd'hui                   <!-- kind: screen -->
- status: OPEN · depends-on: C03 · ref-capture: claims/ref/C10.png · target: apps/mobile/app/(tabs)/index.tsx
- spec: SCREENS.md § Aujourd'hui · flows: USER_FLOWS.md § First-run + Relance
- Contrat: AppHeader(brand.headerGradient) · HeroBalanceCard(patterns.floatingCard, montant 31/800 ink900, phrase « te verser » voix Bob) · PriorityCard×3 · SectionHeader · KpiTile×3 · QuickAction×6.
- Edges OUT: "Relancer"→Assistant(prompt relance) · "Encaisser"→Voix · cloche→Notifs · hero→Argent.
- Acceptance: 3 priorités (fixtures) · montant=formatEUR(cash.dispo) tabular-nums · chevauchement −30dp · token-lint · edges OUT câblés.
- Signatures: [ ] gpt5pro  [ ] claude-code
- Review: [ ] layout [ ] couleurs [ ] typo [ ] copy [ ] états [ ] edges — verdict: —
- Log:
  - _(vide — à démarrer)_

### C11 — Argent                        <!-- kind: screen -->
- status: OPEN · depends-on: C03 · ref-capture: claims/ref/C11.png · target: apps/mobile/app/(tabs)/argent.tsx
- spec: SCREENS.md § Argent · flows: USER_FLOWS.md § Trésorerie
- Contrat: hero navy « te verser » 42px · grand-livre « LE SOLDE MENT » (rangée d'argent, pattern) · Segmented horizons 7/30/60/90 · Segmented scénarios (optimiste/réaliste/prudent) · « à surveiller » · « à mettre de côté » (réserve TVA/charges).
- Acceptance: cashflow depuis core par scénario×horizon · réserve calculée · token-lint.

### C12 — Clients (liste)               <!-- kind: screen -->
- status: OPEN · depends-on: C03 · ref-capture: claims/ref/C12.png · target: apps/mobile/app/(tabs)/clients.tsx
- Contrat: recherche · Chips filtres (tous/en retard/pros/particuliers) · ListRow(avatar squircle, encours, ScoreBar) · Badge B2B/B2C/B2G · FAB→nouveau client.
- Acceptance: filtre + tri par score · scoring depuis core · edges → C13.

### C13 — Fiche client                  <!-- kind: screen -->
- status: OPEN · depends-on: C12 · ref-capture: claims/ref/C13.png
- Contrat: en-tête client · onglets (aperçu/pièces/docs) · canal e-invoice (einvoiceFor) · CTA contextuelle (relance/devis/encaisser) · encours + délai moyen.
- Acceptance: CTA dépend du statut client · edges → C16, C20, C15(relance).

### C14 — Documents (coffre-fort)        <!-- kind: screen -->
- status: OPEN · depends-on: C03 · ref-capture: claims/ref/C14.png
- spec: SCREENS.md § Documents · INTEGRATION_MAP.md §3 (coffre + OCR)
- Contrat: recherche langage naturel · carte Scan (overlay OCR animé, balayage) · « À valider » · dossiers (clients/chantiers/achats/assurances/fiscal/banque) · **section Compta&conformité** (export FEC, factures récentes cliquables, mémoire fournisseurs).
- Acceptance: scan→extraction simulée→classement · détail doc enrichi (origine/SHA-256/rétention 10 ans) · edges → C16.

### C15 — Assistant (Bob)               <!-- kind: screen -->
- status: OPEN · depends-on: C03 · ref-capture: claims/ref/C15.png
- spec: SCREENS.md § Assistant · VOICE_AND_TONE.md
- Contrat: fil de chat (« Bob • en ligne ») · suggestions (chips) · **cartes d'action** (relance/cashflow/compta/diagnostic) · indicateur de saisie · Bob AGIT (garde-fous : préparer≠envoyer).
- Acceptance: chip→échange scripté + carte d'action · actions sensibles demandent validation.

### C16 — Détail pièce                   <!-- kind: screen -->
- status: OPEN · depends-on: C03 · ref-capture: claims/ref/C16.png
- spec: INTEGRATION_MAP.md §1/§5/§6/§7 · DOMAIN_MODEL.md
- Contrat: vue paramétrée par kind (devis|facture|acompte|avoir|situation) depuis BillingDoc · header (n° sans trou, badge type+statut) · parties (partyLine adaptatif SIREN/B2C) · lignes catégorisées · Totals (acompte proportionnel) · mentions figées (badge « FIGÉ À L'ÉMISSION ») · nav croisée devis↔facture (parentQuoteId) · frise cycle de vie PDP/e-reporting/Chorus selon einvoiceFor · « Encaisser » (Émise→Payée + suivi).
- Acceptance: test d'or acompte 488,40 · B2C sans SIREN · encaissement bascule statut+frise · avoir en négatif · situation d'avancement (%).

### C17 — Compta & conformité            <!-- kind: screen -->
- status: OPEN · depends-on: C14, C16 · ref-capture: claims/ref/C17.png
- spec: INTEGRATION_MAP.md § export/compta
- Contrat: « mois prêt » (n ventes / n achats / justificatifs manquants) → Exporter FEC · factures récentes (B2B→PDP, B2C→e-reporting) · bandeau mémoire fournisseurs.
- Acceptance: export génère un artefact mock · liens → C16.

---

## Flux — parallélisables (après C03 ; certains dépendent d'écrans)

### C20 — Facture à la voix              <!-- kind: flow -->
- status: OPEN · depends-on: C03 · ref-capture: claims/ref/C20.png
- spec: SCREENS.md § Voix · flows/voiceInvoice (core) · USER_FLOWS.md § Voix
- Contrat: 3 étapes (écoute/onde → revue facture pré-remplie → payé/envoyé) · encaisser vs envoyer · retour Aujourd'hui.
- Acceptance: machine à états depuis core · onde sans opacité-0 au repos · edges → C10.

### C21 — Devis → signature → facture     <!-- kind: flow -->
- status: OPEN · depends-on: C03, C16 · ref-capture: claims/ref/C21.png
- spec: flows/devis (core) · USER_FLOWS.md § Devis
- Contrat: 6 étapes (client → lignes/catalogue → TVA/mentions → signature doigt → acompte 30 % → facture générée) · SignaturePad · atterrit sur C16 (facture générée).
- Acceptance: net acompte 488,40 · parentQuoteId posé · edges → C16.

### C22 — Onboarding adaptatif           <!-- kind: flow -->
- status: OPEN · depends-on: C03 · ref-capture: claims/ref/C22.png
- Contrat: 5 étapes · grille métier (adapte le vocabulaire : plombier→retenue de garantie, etc.) · clientèle B2B/B2C/B2G · régime TVA · handoff → Diagnostic.
- Acceptance: preview « ton espace <métier> » adaptatif · edges → C23/C10.

### C23 — Diagnostic 2026                 <!-- kind: flow -->
- status: OPEN · depends-on: C03 · ref-capture: claims/ref/C23.png
- Contrat: questionnaire → **score animé (count-up + anneau)** → checklist priorisée → CTA « configurer dans l'app ».
- Acceptance: score = règle einvoice/conformité (core) · anneau sans opacité-0.

### C24 — Auth                           <!-- kind: flow -->
- status: OPEN · depends-on: C03 · ref-capture: claims/ref/C24.png
- Contrat: 4 étapes (SIRET → récup infos → biométrie → entrée) · edges → Onboarding (nouveau) ou Aujourd'hui.

### C25 — Relances auto + Notifications   <!-- kind: flow -->
- status: OPEN · depends-on: C15 · ref-capture: claims/ref/C25.png
- spec: relance (core, 4 tons + L441-10) · INTEGRATION_MAP.md § relances
- Contrat: moteur de relance (échéance dépassée→ton→canal) reliant les pièces (C16) · écran Notifications.
- Acceptance: 4 tons depuis core · mise en demeure = texte légal · edges ↔ C16.

### C26 — Compte / Abo / Équipe / Paywall <!-- kind: flow -->
- status: OPEN · depends-on: C03 · ref-capture: claims/ref/C26.png
- Contrat: offres Solo 19 / Pro 39 (active) / Business 79 · factures d'abo · services (paiement CB 1,2 %, avance, assurance, comptable) · équipe & rôles · paywall Business (79 €).
- Acceptance: offre active désactivée · paywall = 79 €.

### C27 — Catalogue prestations + Réglages facturation <!-- kind: flow -->
- status: OPEN · depends-on: C03 · ref-capture: claims/ref/C27.png
- Contrat: catalogue (prix/TVA par métier) réutilisé par C20/C21 · réglages logo/RIB/mentions/modèles/numérotation.

---

## Web — réutilise le claim mobile équivalent (coque adaptée)

### C30 — Web shell                      <!-- kind: web -->
- status: OPEN · depends-on: C03 · ref-capture: claims/ref/C30.png · target: apps/web
- spec: README § Web responsive · Bob Pro - Web.dc.html
- Contrat: SideNav verticale (≥lg 1024) + topbar · breakpoints sm640/md768/lg1024/xl1280 · RSC pages / Client Components flux.
- Acceptance: parité tokens stricte avec mobile · SideNav↔TabBar selon breakpoint.

### C31 — Web dashboard · C32 — Web Clients master-détail · C33 — Web Argent/Docs/Assistant · C34 — Web modales (flux)
- status: OPEN · depends-on: C30 (+ claim mobile équivalent) · ref-capture: claims/ref/C3x.png
- Contrat: 2–3 colonnes desktop · flux (voix/devis/onboarding) en modales centrées ~720px · mêmes @bob/ui .web.tsx.
- Acceptance: 0 divergence de couleurs/typo vs mobile · edges identiques.

---

## Transverse

### C40 — Contrats d'API + mock (TanStack) <!-- kind: package -->
- status: OPEN · depends-on: C02 · target: packages/core/api
- spec: CLAUDE_CODE_PROMPTS.md Phase 6 · INTEGRATION_MAP.md (points d'intégration réels)
- Contrat: contrats typés (auth/company/customers/billing/payments/documents+OCR/compliance/cashflow/subscription/team) · adaptateur mock sur fixtures · client TanStack partagé · TODO aux frontières (PDP/Chorus/e-reporting/banque/CB/OCR/PDF Factur-X/signature).

### C41 — A11y / états / tests / sweep parité <!-- kind: package -->
- status: OPEN · depends-on: (tous les écrans) · spec: CLAUDE_CODE_PROMPTS.md Phase 7
- Contrat: contrastes AA + focus/labels · skeletons/vides/erreurs/offline · tests unитaires core + e2e (devis→facture, voix) · **sweep de parité mobile↔web** sur les écrans clés.
- Acceptance: token-lint global clean · e2e verts · captures de parité archivées.

---

### Journal global (résumé — détail dans chaque claim)
| Claim | Status | Builder | Reviewer | Note |
|---|---|---|---|---|
| C00 | IN-REVIEW | claude-code | gpt5pro | HANDOFF @86ef5c2 — attente verdict reviewer. Contrat v1+A1 (Next 16). |
| C01–C41 | OPEN | — | — | Backlog. Bloqués par C00 (puis C01+C02+C03 pour les écrans). Priorité humaine : mobile d'abord. |
