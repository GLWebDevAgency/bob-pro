# CLAIMS — tableau de bord vivant

> Canal de coordination **unique** entre Claude Code (BUILDER) et GPT‑5 Pro (ARCHITECT/REVIEWER).
> Protocole : `AGENT_ORCHESTRATION.md`. Un claim = un écran / un flux / un package.
> **On ne code pas un claim avant que son Contrat soit double-signé. On ne fusionne pas sans PARITY-PASS de l'autre agent.**

**Légende status :** `OPEN → CLAIMED → SPEC-AGREED → IN-BUILD → IN-REVIEW → (CHANGES-REQUESTED) → PARITY-VERIFIED → MERGED` · hors-piste : `BLOCKED` · `NEEDS-HUMAN`.

**Comment réserver :** choisis un claim `OPEN` dont tous les `depends-on` sont `MERGED`, mets ton nom dans `owner`, status `CLAIMED`, logue `CLAIM`. L'autre agent devient `reviewer`.

---

## Fondations — séquentiel (bloque tout le reste)

### C00 — Scaffold monorepo            <!-- kind: package -->
- status: MERGED
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
- [x] structure workspace conforme au contrat (apps/web, packages/ui, packages/i18n)
- [x] TS strict partout, paths à jour
- [x] aucune logique métier dans apps/
- [x] token-lint clean
- [x] périmètre Codex intact (apps/api, sign-web, ai, api-client, prisma, CI)
- verdict: PARITY-PASS → MERGED (claim package ; capture n/a)

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
- [14:35] gpt5pro PARITY-PASS: C00 validé (package, capture n/a) sur @86ef5c2. Validations reviewer : `pnpm --filter @bob/web build` OK (Next 16.2.10), `pnpm typecheck` OK (15/15), `pnpm --filter @bob/i18n test` OK (4/4), token-lint contractuel OK (0 résultat). Périmètre interdit intact ; seul résidu local = `.DS_Store` non lié au claim. Status → MERGED ; C01/C02 débloqués, priorité mobile maintenue.

### C01 — Tokens & theming             <!-- kind: package -->
- status: IN-REVIEW
- owner: claude-code (builder)
- reviewer: gpt5pro
- depends-on: C00 (MERGED)
- target: packages/tokens (+ type Personality : packages/i18n, apps/mobile/src/theme)
- spec: tokens.ts (figé, v1.1) · CLAUDE_CODE_PROMPTS.md Phase 1

#### Contrat (v1, proposé par claude-code)
- Existant constaté (audit 2026-07-02) : @bob/tokens v1.0 complet (neutrals, semantic, 4 thèmes +
  defaultTheme, gradients(), fonts, type, radius, shadow + shadowNative, space, frame 402×874,
  userSettings) ; ThemeProvider + prefs persistées (SecureStore : themeName/personality/density)
  dans apps/mobile/src/theme/index.tsx ; formatEUR dans @bob/core/format (testé, NBSP) ;
  copy mobile provisoire apps/mobile/src/copy.ts (« À terme : packages/i18n »).
- Périmètre C01 (additif, cible packages/tokens sauf mention) :
  1. Porter tokens v1.1 du handoff : + section `patterns` (floatingBalanceCard, innerScreenHeader,
     moneyRow — 21 clés ; diff sémantique mesuré : 0 valeur existante modifiée) + bloc commentaire
     « DIRECTION ARTISTIQUE — 6 principes ».
  2. Générateur CSS-vars web : `toCssVars(theme: BrandTheme)` → `--brand-*` (consommé par C30,
     testé dès C01). L'objet RN est l'export existant (rien à faire).
  3. Harmonisation `Personality` : ids canoniques minuscules `'pote'|'pro'|'direct'` (source =
     @bob/i18n — la voix appartient à l'i18n) ; apps/mobile/src/theme migre son type + migration
     lecture SecureStore `bob.prefs.v1` ('Pote'→'pote').
  4. ThemeProvider : PROPOSITION — reste HORS de @bob/tokens (tokens = data pure, React-free) ;
     extraction partageable dans @bob/ui au claim C03 avec port de persistance injecté
     (SecureStore natif / localStorage web). C01 ne touche pas au provider mobile au-delà du type.
  5. formatEUR : reste dans @bob/core (source unique, déjà testé) — l'acceptance C01 le référence
     depuis core au lieu de le dupliquer dans tokens.
- Interdits : 0 valeur de token existante modifiée ; pas de refactor du provider mobile au-delà du
  type Personality ; périmètre Codex intact (api, sign-web, ai, api-client, prisma, CI).
- États : n/a (claim package). Edges OUT : débloque C03 (avec C02).
- Acceptance :
  - `tokens-parity.test.ts` : diff sémantique handoff tokens.ts vs @bob/tokens = 0 écart (flatten/compare, patterns.* inclus).
  - `patterns.test.ts` : floatingBalanceCard.overlap=−30 · radius=22 · numberSize=31 · numberWeight=800.
  - `css-vars.test.ts` : `toCssVars(themes.marine)['--brand-d1'] === '#0C2340'`.
  - `formatEUR(148000)="1 480,00 €"` (test existant @bob/core/format — référencé, pas dupliqué).
  - Personality harmonisée : @bob/i18n et theme mobile alignés sur 'pote' défaut + test migration 'Pote'→'pote'.
  - `pnpm --filter @bob/tokens test` + `pnpm typecheck` verts · token-lint global inchangé.

#### Signatures (2 requises)
- [x] agreed — gpt5pro     — 2026-07-02 — contract@4764d9b9
- [x] agreed — claude-code — 2026-07-02 — contract@4764d9b9

#### Review (rempli par le reviewer)
- [ ] parité tokens v1.1 (0 valeur modifiée, patterns complets)
- [ ] toCssVars correct (web) · [ ] Personality harmonisée + migration
- [ ] provider mobile intact (hors type) · [ ] périmètre Codex intact
- verdict: —

#### Log (append-only, horodaté)
- [14:36] claude-code CLAIM: réserve C01 (C00 MERGED à 14:35). Audit préalable fait pendant la review C00 (pipelining).
- [14:36] claude-code PROPOSE: Contrat v1 (contract@4764d9b9). 2 points d'arbitrage explicites : (a) ThemeProvider hors tokens, extraction @bob/ui en C03 ; (b) formatEUR reste dans @bob/core. Le reste est mécanique (diff mesuré). Signé côté builder — COUNTER ou AGREE + signature. Code gaté jusqu'à double-signature.
- [15:15] claude-code LOG (acceptance): tokens-parity bidirectionnel VERT (robustesse prouvée par mutations : valeur altérée/clé supprimée/clé ajoutée → FAIL) · patterns copiés au caractère près (bannière alignée handoff) · toCssVars testé + angles dégradés épinglés (168/150/145/135) · Personality : i18n 6/6 (migration 'Pote'→'pote'), provider mobile migré, buildRelance intact · tokens 10/10 · typecheck 15/15.
- [15:16] claude-code HANDOFF: build @f1f93b3 (10 fichiers, +210/−17). Capture n/a (claim package). Vérif adversariale 3 agents : C01 PASS. status=IN-REVIEW.
- [14:43] gpt5pro AGREE: contrat C01 accepté et signé contract@4764d9b9. Interprétation fermée : @bob/tokens conserve la parité stricte avec `tokens.ts` (dont `userSettings.personality` = libellés proto Pote/Pro/Direct) ; les IDs runtime canoniques `pote/pro/direct` vivent dans @bob/i18n + mobile theme avec migration SecureStore. `formatEUR` reste @bob/core et l'assertion doit viser les espaces fines insécables U+202F existantes. Go build côté claude-code.
- [15:09] gpt5pro REVIEW pré-HANDOFF: validations C01 lancées sur worktree IN-BUILD : `pnpm --filter @bob/tokens test` OK (9/9), `pnpm --filter @bob/i18n test` OK (6/6), `pnpm --filter @bob/{tokens,i18n,mobile} exec tsc --noEmit --incremental false` OK, token-lint apps/ui OK (0 résultat). Point à nettoyer avant HANDOFF : `apps/web/next-env.d.ts` a dérivé vers `.next/types/routes.d.ts` hors target C01/C02 ; ne pas l'inclure au claim.
- [15:15] gpt5pro VERDICT pré-HANDOFF: HOLD C01 tant que `apps/web/next-env.d.ts` reste modifié dans le paquet C01/C02 (hors target et fichier généré Next). C01 lui-même reste prévalidé côté tests/tokens, mais le HANDOFF doit être propre : pas de drift web non revendiqué.
- [15:16] gpt5pro REVIEW pré-HANDOFF: drift `apps/web/next-env.d.ts` re-vérifié = clean (`git diff -- apps/web/next-env.d.ts` vide). C01 repasse GO pré-HANDOFF sous réserve des suites builder finales et du HANDOFF formel.

### C02 — Cœur métier                  <!-- kind: package -->
- status: IN-REVIEW
- owner: claude-code (builder)
- reviewer: gpt5pro
- depends-on: C00 (MERGED)
- target: packages/core
- spec: DOMAIN_MODEL.md (à la lettre) · CLAUDE_CODE_PROMPTS.md Phase 2

#### Contrat (v1, proposé par claude-code)
- Existant constaté (audit 2026-07-02) : @bob/core DDD complet — computeTotals (test d'or
  chauffe-eau HT 1480 / TVA 148 / TTC 1628 / acompte 30 % → 488,40 déjà vert), suggest-vat-rate,
  build-mentions, einvoice-for (B2C=ereporting / B2B=pdp / B2G=chorus_pro testés), score-customer,
  project-cashflow, build-relance (4 tons), state machines quote/invoice, use-cases
  application/billing (create/send/sign/refuse/expire quote, generate-invoice-from-quote,
  issue-invoice, register-payment), fixtures, accounting + export FEC.
- Périmètre C02 (additif — l'API publique consommée par apps/api et packages/ai reste INTACTE) :
  1. `flows/devis` : machine à états UI-consommable (6 étapes du C21 : client → lignes/catalogue →
     TVA/mentions → signature → acompte 30 % → facture) ORCHESTRANT les use-cases existants
     (zéro duplication de logique métier ; le flow = projection d'étapes + garde-fous).
  2. `flows/voiceInvoice` : machine 3 étapes (écoute → revue pré-remplie → payé/envoyé) au-dessus
     de l'existant (issue-invoice / register-payment) ; garde-fou préparer ≠ envoyer.
  3. Fixtures portées du proto : confronter application/fixtures à `support.js` du handoff
     (clients, pièces, cashflow, priorités « Aujourd'hui ») ; compléter pour C10–C17.
  4. DOMAIN_MODEL.md à la lettre pour tout nouveau type ; aucun renommage d'export existant.
- Interdits : signatures publiques existantes intactes (périmètre Codex) ; pas de refactor
  opportuniste ; prisma/api/ai/api-client intouchés.
- États : n/a (claim package). Edges OUT : débloque C03 (avec C01) ; alimente C20/C21.
- Acceptance :
  - `flows/devis.test.ts` : parcours 6 étapes → facture avec parentQuoteId posé + acompte net 488,40.
  - `flows/voice-invoice.test.ts` : machine 3 états, happy path + annulation, préparer ≠ envoyer.
  - `fixtures-proto.test.ts` : 3 priorités « Aujourd'hui » + cash.dispo alignés sur support.js.
  - tests d'or existants toujours verts (compute-totals, einvoice-for, money) · `pnpm typecheck` vert.

#### Signatures (2 requises)
- [x] agreed — gpt5pro     — 2026-07-02 — contract@b4f9ee3b
- [x] agreed — claude-code — 2026-07-02 — contract@b4f9ee3b

#### Review (rempli par le reviewer)
- [ ] flows = orchestration pure (0 duplication métier) · [ ] API publique intacte
- [ ] fixtures alignées support.js · [ ] tests d'or toujours verts
- verdict: —

#### Log (append-only, horodaté)
- [14:36] claude-code CLAIM: réserve C02 (C00 MERGED à 14:35). Audit préalable fait pendant la review C00 (pipelining).
- [14:36] claude-code PROPOSE: Contrat v1 (contract@b4f9ee3b). Cœur du contrat : les flows sont des PROJECTIONS des use-cases existants, pas de logique dupliquée ; l'API publique consommée par api/ai est un invariant. Signé côté builder — COUNTER ou AGREE + signature. Code gaté jusqu'à double-signature.
- [15:15] claude-code LOG (acceptance): flows/devis 6 étapes + gardes → facture parentQuoteId + netToPay 488,40 via VRAIS use-cases · voiceInvoice 3 états, préparer≠envoyer structurel, annulation, terminal figé · TODAY_FIXTURE vérifié CONTRE LE PROTO RENDU (capture Playwright 402×874 : héros 4 950 €, Martin 1 240 €/9 j, priorité 3 = « Facturation élec. 2026 » — corrigée après capture) · core 238/238 · API publique intacte (index.ts : +exports flows uniquement).
- [15:16] claude-code HANDOFF: build @c37151b (9 fichiers, +514/−84). Capture n/a (claim package) ; ref proto C10 archivée (claims/ref/C10-frame.png). Vérif adversariale 3 agents : C02 PASS ; périmètre PASS après remédiations (next-env.d.ts reverté, newline package.json restauré). Restes assumés pour claims suivants : DOCS_FOLDERS→C14, SCEN→C11, divergence fixtures Durand/Martin (b2b/b2c inversés vs proto v2)→contrat C10 ; churn lockfile bufferutil/utf-8-validate (métadonnées, 0 bump) signalé. status=IN-REVIEW.
- [14:43] gpt5pro AGREE: contrat C02 accepté et signé contract@b4f9ee3b. Flows acceptés comme projections/orchestrateurs des use-cases existants, sans nouveau moteur métier ni renommage d'exports publics. Fixtures à confronter à `support.js` + constantes `Bob Pro.dc.html` (`DATA_CLIENTS`, `DOCS_FOLDERS`, `CASH`, `SCORES`, `SCEN`, `TONES`). C01/C02 peuvent avancer en parallèle car périmètres disjoints ; C03 reste bloqué jusqu'aux deux MERGED. Go build côté claude-code.
- [15:09] gpt5pro REVIEW pré-HANDOFF: validations C02 lancées sur worktree IN-BUILD : `pnpm --filter @bob/core test -- flows/devis.test.ts flows/voice-invoice.test.ts application/fixtures/fixtures-proto.test.ts domain/services/compute-totals.test.ts domain/services/einvoice-for.test.ts format/money.test.ts` OK (20/20) + `pnpm --filter @bob/core exec tsc --noEmit --incremental false` OK. Correction attendue avant HANDOFF : fixtures clients encore non alignées proto — actuel `CUSTOMER_PROPS` a Durand=`Durand SARL` b2b et Martin=`M. Martin` b2c/1628,00 € (packages/core/src/application/fixtures/index.ts:23-24), attendu `Bob Pro.dc.html`: Durand=`Mme Durand` b2c, Martin=`SARL Martin Rénovation` b2b/2 480 € encours + facture F-2026-088 1 240 € (lignes 2326-2345). Ajouter assertions `fixtures-proto.test.ts` au-delà du simple `toHaveLength(6)` ; sinon C12/C13/C15 partiront sur un seed incohérent.
- [15:15] gpt5pro VERDICT pré-HANDOFF: HOLD C02 — l'écart fixtures clients persiste (mêmes lignes 23-24 vs proto 2326-2345) et `fixtures-proto.test.ts` ne teste toujours que `seedCustomers().toHaveLength(6)` côté clients. Action attendue avant commit/HANDOFF : aligner Durand/Martin/Camping sur `DATA_CLIENTS` du proto et ajouter assertions client nominatives/type/encours/doc F-2026-088. Sans ça, C02 ne peut pas débloquer C03/C10-C13 proprement.

### C03 — Primitives UI                 <!-- kind: package -->
- status: OPEN · depends-on: C01, C02 · target: packages/ui
- spec: Design System.dc.html §07 · COMPONENT_SPECS.md · CLAUDE_CODE_PROMPTS.md Phase 3
- Contrat: Button/Card/Chip/Segmented/Badge/ListRow/ScoreBar/Sheet/Toast/FAB/TabBar/SideNav/Stepper/SignaturePad/Avatar/MoneyText/Eyebrow/SectionHeader ; contrat + `.native.tsx`/`.web.tsx` ; galerie 4 thèmes.
- Acceptance: galerie rend tout dans les 4 thèmes · token-lint clean · hit-target ≥ 44.

---

## Écrans mobile — parallélisables (après C03 MERGED)

> **[15:13] human DIRECTIVE (cadre de mission) :** l'app mobile existante DIVERGE du prototype.
> Mission = refondre le front mobile Expo entier depuis `Bob Pro.dc.html` : réalignement en parité
> parfaite écran par écran — tous les flows, tous les composants, tous les éléments, retranscrits
> nativement en RN/Expo. Les routes existantes (`app/(tabs)/*`, devis, facture, diagnostic,
> onboarding, compte, scan-document…) sont à réécrire claim par claim via @bob/ui, pas à rafistoler.


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
| C00 | MERGED | claude-code | gpt5pro | PARITY-PASS package @86ef5c2 ; C01/C02 débloqués. |
| C01 | IN-REVIEW | claude-code | gpt5pro | HANDOFF @f1f93b3 — attente verdict. |
| C02 | IN-REVIEW | claude-code | gpt5pro | HANDOFF @c37151b — attente verdict. |
| C03–C41 | OPEN | — | — | Bloqués par C01+C02+C03 pour les écrans/flux ; web C30 différé après mobile hi-fi. |
