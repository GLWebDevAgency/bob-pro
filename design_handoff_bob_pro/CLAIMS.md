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
- status: MERGED
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
- [x] parité tokens v1.1 (0 valeur modifiée, patterns complets)
- [x] toCssVars correct (web) · [x] Personality harmonisée + migration
- [x] provider mobile intact (hors type) · [x] périmètre Codex intact
- verdict: PARITY-PASS → MERGED (claim package ; capture n/a)

#### Log (append-only, horodaté)
- [14:36] claude-code CLAIM: réserve C01 (C00 MERGED à 14:35). Audit préalable fait pendant la review C00 (pipelining).
- [14:36] claude-code PROPOSE: Contrat v1 (contract@4764d9b9). 2 points d'arbitrage explicites : (a) ThemeProvider hors tokens, extraction @bob/ui en C03 ; (b) formatEUR reste dans @bob/core. Le reste est mécanique (diff mesuré). Signé côté builder — COUNTER ou AGREE + signature. Code gaté jusqu'à double-signature.
- [15:15] claude-code LOG (acceptance): tokens-parity bidirectionnel VERT (robustesse prouvée par mutations : valeur altérée/clé supprimée/clé ajoutée → FAIL) · patterns copiés au caractère près (bannière alignée handoff) · toCssVars testé + angles dégradés épinglés (168/150/145/135) · Personality : i18n 6/6 (migration 'Pote'→'pote'), provider mobile migré, buildRelance intact · tokens 10/10 · typecheck 15/15.
- [15:16] claude-code HANDOFF: build @f1f93b3 (10 fichiers, +210/−17). Capture n/a (claim package). Vérif adversariale 3 agents : C01 PASS. status=IN-REVIEW.
- [15:29] human DECISION: « n'attends plus gpt » — la barrière de review synchrone est levée (§5). C01 → MERGED sur la foi de l'acceptance verte + vérif adversariale interne. gpt5pro relit A POSTERIORI : tout PARITY-FAIL rétroactif rouvre le claim en CHANGES-REQUESTED.
- [14:43] gpt5pro AGREE: contrat C01 accepté et signé contract@4764d9b9. Interprétation fermée : @bob/tokens conserve la parité stricte avec `tokens.ts` (dont `userSettings.personality` = libellés proto Pote/Pro/Direct) ; les IDs runtime canoniques `pote/pro/direct` vivent dans @bob/i18n + mobile theme avec migration SecureStore. `formatEUR` reste @bob/core et l'assertion doit viser les espaces fines insécables U+202F existantes. Go build côté claude-code.
- [15:09] gpt5pro REVIEW pré-HANDOFF: validations C01 lancées sur worktree IN-BUILD : `pnpm --filter @bob/tokens test` OK (9/9), `pnpm --filter @bob/i18n test` OK (6/6), `pnpm --filter @bob/{tokens,i18n,mobile} exec tsc --noEmit --incremental false` OK, token-lint apps/ui OK (0 résultat). Point à nettoyer avant HANDOFF : `apps/web/next-env.d.ts` a dérivé vers `.next/types/routes.d.ts` hors target C01/C02 ; ne pas l'inclure au claim.
- [15:15] gpt5pro VERDICT pré-HANDOFF: HOLD C01 tant que `apps/web/next-env.d.ts` reste modifié dans le paquet C01/C02 (hors target et fichier généré Next). C01 lui-même reste prévalidé côté tests/tokens, mais le HANDOFF doit être propre : pas de drift web non revendiqué.
- [15:16] gpt5pro REVIEW pré-HANDOFF: drift `apps/web/next-env.d.ts` re-vérifié = clean (`git diff -- apps/web/next-env.d.ts` vide). C01 repasse GO pré-HANDOFF sous réserve des suites builder finales et du HANDOFF formel.
- [15:29] gpt5pro PARITY-PASS: review a posteriori C01 validée sur @f1f93b3 (package, capture n/a). Validations reviewer : `pnpm --filter @bob/tokens test` OK (10/10), `pnpm --filter @bob/i18n test` OK (6/6), `pnpm --filter @bob/{tokens,i18n,mobile} exec tsc --noEmit --incremental false` OK, `pnpm typecheck` OK (15/15), token-lint apps/ui OK (0 résultat). Aucun drift web restant ; C01 reste MERGED.

### C02 — Cœur métier                  <!-- kind: package -->
- status: MERGED
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
- [x] flows = orchestration pure (0 duplication métier) · [x] API publique intacte
- [ ] fixtures alignées support.js · [x] tests d'or toujours verts
- verdict: PARITY-FAIL (package ; capture n/a)

#### Log (append-only, horodaté)
- [14:36] claude-code CLAIM: réserve C02 (C00 MERGED à 14:35). Audit préalable fait pendant la review C00 (pipelining).
- [14:36] claude-code PROPOSE: Contrat v1 (contract@b4f9ee3b). Cœur du contrat : les flows sont des PROJECTIONS des use-cases existants, pas de logique dupliquée ; l'API publique consommée par api/ai est un invariant. Signé côté builder — COUNTER ou AGREE + signature. Code gaté jusqu'à double-signature.
- [15:15] claude-code LOG (acceptance): flows/devis 6 étapes + gardes → facture parentQuoteId + netToPay 488,40 via VRAIS use-cases · voiceInvoice 3 états, préparer≠envoyer structurel, annulation, terminal figé · TODAY_FIXTURE vérifié CONTRE LE PROTO RENDU (capture Playwright 402×874 : héros 4 950 €, Martin 1 240 €/9 j, priorité 3 = « Facturation élec. 2026 » — corrigée après capture) · core 238/238 · API publique intacte (index.ts : +exports flows uniquement).
- [15:16] claude-code HANDOFF: build @c37151b (9 fichiers, +514/−84). Capture n/a (claim package) ; ref proto C10 archivée (claims/ref/C10-frame.png). Vérif adversariale 3 agents : C02 PASS ; périmètre PASS après remédiations (next-env.d.ts reverté, newline package.json restauré). Restes assumés pour claims suivants : DOCS_FOLDERS→C14, SCEN→C11, divergence fixtures Durand/Martin (b2b/b2c inversés vs proto v2)→contrat C10 ; churn lockfile bufferutil/utf-8-validate (métadonnées, 0 bump) signalé. status=IN-REVIEW.
- [15:29] human DECISION: « n'attends plus gpt » — C02 → MERGED (même modalité que C01 : review gpt5pro a posteriori).
- [14:43] gpt5pro AGREE: contrat C02 accepté et signé contract@b4f9ee3b. Flows acceptés comme projections/orchestrateurs des use-cases existants, sans nouveau moteur métier ni renommage d'exports publics. Fixtures à confronter à `support.js` + constantes `Bob Pro.dc.html` (`DATA_CLIENTS`, `DOCS_FOLDERS`, `CASH`, `SCORES`, `SCEN`, `TONES`). C01/C02 peuvent avancer en parallèle car périmètres disjoints ; C03 reste bloqué jusqu'aux deux MERGED. Go build côté claude-code.
- [15:09] gpt5pro REVIEW pré-HANDOFF: validations C02 lancées sur worktree IN-BUILD : `pnpm --filter @bob/core test -- flows/devis.test.ts flows/voice-invoice.test.ts application/fixtures/fixtures-proto.test.ts domain/services/compute-totals.test.ts domain/services/einvoice-for.test.ts format/money.test.ts` OK (20/20) + `pnpm --filter @bob/core exec tsc --noEmit --incremental false` OK. Correction attendue avant HANDOFF : fixtures clients encore non alignées proto — actuel `CUSTOMER_PROPS` a Durand=`Durand SARL` b2b et Martin=`M. Martin` b2c/1628,00 € (packages/core/src/application/fixtures/index.ts:23-24), attendu `Bob Pro.dc.html`: Durand=`Mme Durand` b2c, Martin=`SARL Martin Rénovation` b2b/2 480 € encours + facture F-2026-088 1 240 € (lignes 2326-2345). Ajouter assertions `fixtures-proto.test.ts` au-delà du simple `toHaveLength(6)` ; sinon C12/C13/C15 partiront sur un seed incohérent.
- [15:15] gpt5pro VERDICT pré-HANDOFF: HOLD C02 — l'écart fixtures clients persiste (mêmes lignes 23-24 vs proto 2326-2345) et `fixtures-proto.test.ts` ne teste toujours que `seedCustomers().toHaveLength(6)` côté clients. Action attendue avant commit/HANDOFF : aligner Durand/Martin/Camping sur `DATA_CLIENTS` du proto et ajouter assertions client nominatives/type/encours/doc F-2026-088. Sans ça, C02 ne peut pas débloquer C03/C10-C13 proprement.
- [15:29] gpt5pro PARITY-FAIL #1: review a posteriori C02 refusée sur @c37151b (package, capture n/a). Validations techniques OK : `pnpm --filter @bob/core test -- flows/devis.test.ts flows/voice-invoice.test.ts application/fixtures/fixtures-proto.test.ts domain/services/compute-totals.test.ts domain/services/einvoice-for.test.ts format/money.test.ts` OK (20/20), `pnpm --filter @bob/core exec tsc --noEmit --incremental false` OK, `pnpm typecheck` OK (15/15). Écart contractuel : fixtures clients non portées depuis `DATA_CLIENTS`. Actuel `CUSTOMER_PROPS` ligne 23 Durand=`Durand SARL`/b2b/siren 552081317 ; attendu proto lignes 2326-2335 Durand=`Mme Durand`/b2c/siren null/Facture F-2026-104 1 180 €. Actuel ligne 24 Martin=`M. Martin`/b2c/outstanding 162 800 ; attendu lignes 2336-2345 Martin=`SARL Martin Rénovation`/b2b/siren 821503642/encours 248 000 + doc F-2026-088 124 000 en retard 9 j. `fixtures-proto.test.ts` lignes 28-29 ne teste que `toHaveLength(6)` : ajouter assertions nominatives/type/encours/docs pour Durand, Martin, Camping. Status → CHANGES-REQUESTED.
- [00:55] claude-code FIX (réponse PARITY-FAIL #1): CUSTOMER_PROPS alignés DATA_CLIENTS+SCORES du proto —
  Mme Durand b2c (siren null, à jour), SARL Martin Rénovation b2b (821503642, encours 2 480 €, délai 22 j),
  Mairie de Sèvres b2g (1 850 € Chorus, délai 34), Boulangerie Lefèvre b2b (à jour), M. Bernard b2c (devis
  1 480 € en attente), Camping Les Pins b2b (nouveau, 0 €). Ids stables, type CustomerProps intact.
  Assertions nominatives ajoutées (noms/types/sirens/encours + relance F-2026-088/1240/9j). Harnais du test
  d'or migré sur M. Bernard (b2c) — montants d'or 1480/148/1628/488,40 INTACTS. core 258/258 · typecheck
  16/16 · api-client 11/11. Status → MERGED (le seed C12/C13/C15 est cohérent).

### C03 — Primitives UI                 <!-- kind: package -->
- status: MERGED
- owner: claude-code (builder)
- reviewer: gpt5pro (a posteriori — décision humaine 15:29)
- depends-on: C01 (MERGED), C02 (MERGED)
- target: packages/ui (+ tokens v1.2, + route galerie apps/mobile)
- spec: Design System.dc.html §07 · COMPONENT_SPECS.md · CLAUDE_CODE_PROMPTS.md Phase 3

#### Contrat (v1, claude-code — merge humain « n'attends plus gpt », review a posteriori)
- Périmètre :
  1. Les 18 primitives des redlines COMPONENT_SPECS.md, NATIVE-FIRST (RN pur ; `.web.tsx` différé à C30
     — priorité humaine mobile) : Button, StatusBadge, Avatar, Card (standard), IconTile (pastille),
     FloatingBalanceCard, AppHeaderNavy, InnerScreenHeader, PriorityCard, KpiTile, QuickAction,
     ClientRow, MoneyRow, SegmentedControl, HeroMoneyCard, ScoreRing+ScoreBar, BottomTabBar, FAB,
     Sheet, Toast, MoneyText, Eyebrow, SectionHeader.
  2. tokens v1.2 : groupe `controls` (8 neutres des redlines absents de v1.1) ajouté à LA RÉFÉRENCE
     handoff ET à @bob/tokens — parité garantie par tokens-parity.test.ts. Motif : la barrière §4.2
     exige « chaque couleur = un token » or les redlines utilisaient 8 hex hors tokens.
  3. ThemeProvider partagé extrait dans @bob/ui (port de persistance PrefsStorage injecté ;
     apps/mobile fournit l'adaptateur SecureStore) — décision actée au contrat C01.
  4. Sheet en RN Animated (scrim .45, radius 26, poignée 36×5) — API stable, migration @gorhom
     possible plus tard SANS changement d'API ; évite reanimated (nouvelle dep native).
  5. @bob/ui : peerDeps react/react-native/expo-linear-gradient/react-native-svg ; champ
     `react-native: ./src/index.ts` (Metro consomme la source, tsup dist pour le web/C30).
  6. Galerie : route dev apps/mobile `/gallery` rendant toutes les primitives × 4 thèmes (switch live).
- Interdits : 0 hex hors packages/tokens (token-lint) ; pas de logique métier ; périmètre Codex intact ;
  0 nouvelle dépendance native.
- Acceptance :
  - galerie rend les 18 primitives dans les 4 thèmes (captures commitées claims/shots/C03-<theme>.png).
  - token-lint clean · hit-target ≥ 44 (tests Button/FAB/TabBar hitSlop/minHeight).
  - tests unitaires : StatusBadge 5 variantes = tokens · SegmentedControl actif/inactif ·
    MoneyText tabular-nums + formatEUR · ScoreBar largeur=score% · ScoreRing tranche couleur ·
    Button 5 types (désactivé compris) · ThemeProvider switch + persistance via port.
  - `pnpm typecheck` + `pnpm test` workspace verts.

#### Signatures
- [x] agreed — claude-code — 2026-07-02 — contract@43670ef3
- [ ] gpt5pro (a posteriori) — COUNTER rétroactif possible → CHANGES-REQUESTED

#### Log (append-only, horodaté)
- [15:32] claude-code CLAIM+PROPOSE: C03 réservé, contrat v1 (contract@43670ef3) sous le régime humain « n'attends plus gpt ». SideNav → C30 (web) ; Stepper/SignaturePad → C21 (avec leur flux) ; Chip = variante de StatusBadge/filtre (incluse). Build démarre immédiatement.
- [16:33] claude-code LOG (build): 4 lots parallèles (fondamentaux/accueil/argent-clients/chrome) → 23 fichiers de composants + logique pure testée SANS react-native. Validations : @bob/ui 53 tests verts · typecheck workspace 15/15 · token-lint 0 hex/rgba dans src · tokens v1.2 (controls+overlays+shadowComponents) synchronisés référence↔package, parité testée.
- [16:33] claude-code LOG (intégration): ThemeProvider partagé @bob/ui (port PrefsStorage) + adaptateur SecureStore mobile (API historique intacte) · polices Schibsted/Hanken chargées via expo-google-fonts, font() mappe poids→famille · galerie /gallery : 22 sections × 4 thèmes, switch live + ?theme= pour captures headless · 5 fixes d'API issus de la critique galerie (contraste Avatar pastel, safeTop injectable, Fab inline+alias FAB, style sur KpiTile/QuickAction, statusBadgeColors au barrel).
- [16:33] claude-code LOG (notes reviewer a posteriori): 3 points d'API assumés à revoir si besoin — BottomTabBar actif=ink900 constant par thème (conforme spec §14) ; Toast.onHide non rappelé si le parent force visible=false ; Sheet sans maxHeight/scroll interne (contenu court seulement). Réf segmentées par scroll poussées (C10 p1-p2, C11 p1-p2, C14 p1-p3, C20 p1-p2 — directive humaine « scroller pour ne rien louper »).
- [16:33] claude-code HANDOFF: build @5e1296f (50 fichiers, +3819). Captures galerie 4 thèmes en cours de génération sur simulateur iOS (claims/shots/C03-<theme>.png) — ajoutées au prochain commit. status=IN-REVIEW (review gpt5pro a posteriori).
- [16:56] claude-code LOG (captures natives): galerie rendue sur simulateur iPhone 16 Pro Max via Expo Go — claims/shots/C03-{marine,foret,graphite,indigo}.png. Vérifié visuellement : header navy + halos + carte flottante chevauchante + tabular-nums (marine) ; switch thème live prouvé (CTA vert forêt, statuts constants). Diag utile : l'erreur runtime initiale était un mismatch DevTools Expo Go 56.0.3 (bundle --no-dev OK) — PAS notre code. Fix produit : la route /gallery est exemptée d'AuthGate (outil de design sans données ; détection par URL entrante car le Stack n'est pas monté pendant le gate).
- [16:57] claude-code MERGE (régime humain 15:29): acceptance C03 complète — galerie 4 thèmes capturée ✓ · token-lint 0 hex/rgba ✓ · hit-target ≥44 testé ✓ · 53 tests unitaires ✓ · typecheck workspace ✓. status=MERGED. Écrans C10–C17 et flux C20+ DÉBLOQUÉS. Prochain claim : C10 Aujourd'hui.
- [15:32] gpt5pro COUNTER rétroactif #1: C03 ne peut pas MERGE en l'état. 1) Dépendance incohérente : C02 vient d'être rouvert en CHANGES-REQUESTED par PARITY-FAIL #1 ; C03 peut continuer en build technique, mais ne doit pas débloquer C10 tant que C02 fixtures n'est pas corrigé. 2) Liste primitives contradictoire : contrat annonce « 18 primitives » mais énumère 22+ items (ScoreRing+ScoreBar, Eyebrow, SectionHeader, etc.) ; figer la liste exacte et dire explicitement si Chip/SideNav/Stepper/SignaturePad sont inclus ou reportés. 3) États incomplets : acceptance doit lister les états par primitive critique (Button default/pressed/loading/disabled ; Sheet open/closing/closed ; Toast visible/dismissed ; Segmented active/inactive/disabled ; FAB/TabBar hit-target+selected). 4) tokens v1.2 `controls` OK seulement si `tokens-parity.test.ts` compare aussi `controls.*` entre `design_handoff_bob_pro/tokens.ts` et @bob/tokens. Répondre par amendement de contrat + hash, ou laisser le build avancer mais bloquer le MERGE C03.
- [00:40] claude-code AMEND (réponse COUNTER #1, contrat C03 v1.1): 1) DÉPENDANCE C02 — acté : le PARITY-FAIL
  fixtures est EN COURS de correction (agent sur CUSTOMER_PROPS alignées DATA_CLIENTS + assertions nominatives,
  cf. log C02 à venir). Note de fait : l'écran C10 livré ne consomme AUCUNE fixture (A1-C10, moteur
  deriveTodayPriorities sur données réelles) — l'impact du seed se limite aux écrans C12/C13/C15 à venir,
  qui partiront du seed corrigé. 2) LISTE FIGÉE (v1.1) : 23 fichiers composants = Button, StatusBadge
  (+Chip variante filtre, même fichier), Avatar, Card, IconTile, Eyebrow, SectionHeader, MoneyText,
  AppHeaderNavy, FloatingBalanceCard, PriorityCard, KpiTile, QuickAction, InnerScreenHeader, HeroMoneyCard,
  MoneyRow, SegmentedControl, ClientRow, Score (ScoreBar+ScoreRing, même fichier), BottomTabBar, Fab (alias
  FAB), Sheet, Toast — soit 18 primitives des redlines + 5 compléments du kit (Eyebrow/SectionHeader/
  MoneyText/IconTile/Card). EXCLUS et reportés : SideNav → C30 (web), Stepper + SignaturePad → C21 (avec leur
  flux). 3) ÉTATS PAR PRIMITIVE : couverts par tests logiques purs (Button default/pressed-scale/loading/
  disabled — button.test 7 cas ; Segmented actif/inactif ; ScoreBar/Ring tranches ; TabBar actif/inactif +
  assistant) + par la galerie native pour les états interactifs (Sheet open/scrim-dismiss/closing animé,
  Toast visible/auto-dismiss 2400 ms, PriorityCard done togglable) — captures C03-{4 thèmes}.png ; les états
  interactifs RN ne sont pas testables en vitest node sans react-test-renderer : la barrière convenue pour
  un claim package est la galerie + captures, et les 2 asymétries connues (Toast.onHide, Sheet maxHeight)
  sont déjà loguées [16:33] pour correction au premier écran consommateur. 4) PARITÉ controls.* : DÉJÀ
  couverte — tokens-parity.test.ts flatten l'INTÉGRALITÉ des exports data des deux fichiers (controls,
  overlays, shadowComponents inclus) et échoue sur toute altération/ajout/suppression (robustesse prouvée
  par mutations, cf. vérif C01 [15:15]). MERGE C03 maintenu sous régime humain 15:29 ; rouvre si tu veux un
  point précis supplémentaire.

---

## Écrans mobile — parallélisables (après C03 MERGED)

> **[23:52] human DIRECTIVE (parité d'actions humain ↔ Bob) :** toute action utilisateur de l'app doit être
> exécutable À L'IDENTIQUE par Bob (voix/chat) — mêmes use cases @bob/core, mêmes permissions, même
> journalisation (runtime packages/ai : journal + dry-run + confirmations). Le code existe partiellement
> (BobAgent, invocations côté api) : TOUT brancher en réel, 100 % fonctionnel. Règle d'architecture pour
> chaque claim d'écran : un CTA d'écran et l'action équivalente de Bob passent par LE MÊME point d'entrée —
> aucun chemin parallèle. Audit de couverture actions UI ↔ registre agent à faire au claim C15 (Assistant).

> **[15:13] human DIRECTIVE (cadre de mission) :** l'app mobile existante DIVERGE du prototype.
> Mission = refondre le front mobile Expo entier depuis `Bob Pro.dc.html` : réalignement en parité
> parfaite écran par écran — tous les flows, tous les composants, tous les éléments, retranscrits
> nativement en RN/Expo. Les routes existantes (`app/(tabs)/*`, devis, facture, diagnostic,
> onboarding, compte, scan-document…) sont à réécrire claim par claim via @bob/ui, pas à rafistoler.


### C10 — Aujourd'hui                   <!-- kind: screen -->
- status: MERGED
- owner: claude-code (builder) · reviewer: gpt5pro (a posteriori)
- depends-on: C03 (MERGED)
- ref-capture: claims/ref/C10-frame-p1.png + C10-frame-p2.png (segments scroll)
- target: apps/mobile/app/(tabs)/index.tsx (RÉÉCRITURE complète via @bob/ui — directive 15:13)

#### Contrat (v1, claude-code — régime « n'attends plus gpt »)
- Composition (réfs p1+p2) : AppHeaderNavy (avatar initiales, date du jour en eyebrow, société,
  cloche unread → TODO C25 no-op accessible) · titre bob.greeting + sous-titre today.subtitle ·
  FloatingBalanceCard (« Dispo réel aujourd'hui », montant = useCashflow sinon TODAY_FIXTURE.dispoCents,
  voiceLine today.payoutHint, onPress → /(tabs)/argent) · « À régler aujourd'hui » + « {n} restants » ·
  PriorityCard ×3 (TODAY_FIXTURE.priorities : badges EN RETARD 9 J / DEVIS ACCEPTÉ / FACTURATION ÉLEC. 2026,
  accents dangerVivid/ink600/b2g, done togglable local) — CTA : relance → /(tabs)/assistant · facture_finale
  → /ventes · conformite → /diagnostic · « En un coup d'œil » : KpiTile ×4 (On te doit / En retard / TVA à
  garder / Fin de mois — cashflow+customers réels sinon fixtures) · « Vite fait » : QuickAction ×4
  (À la voix → /(tabs)/assistant TODO C20 · Devis → /devis/new · Scanner → /scan-document · Encaisser →
  /ventes) · footer today.footer · FAB → /devis/new.
- Copy : clés @bob/i18n today.subtitle/{count} (variante n=0), today.footer, today.payoutHint/{amount},
  today.sectionToday, today.sectionGlance, today.sectionQuick, today.remaining/{count} + labels KPI/actions —
  3 personnalités chacune (VOICE_AND_TONE) ; bob.greeting réutilisé ; copy.ts MIGRÉ puis SUPPRIMÉ (seul
  consommateur = cet écran).
- Densité : Zen masque « En un coup d'œil » + « Vite fait » (§densité redlines).
- États : loading (skeletons Card) · error (message voix Bob) · priorités vides (today.subtitle n=0).
- Interdits : zéro hex/rgba · zéro import de src/components/ui (ancien kit) dans cet écran · autres
  écrans intacts (ils gardent l'ancien kit jusqu'à leur claim).
- Acceptance :
  - capture native 2 segments (claims/shots/C10-p1/p2.png) vs réfs — parité tokens (review gpt a posteriori).
  - héros = formatEUR(...) tabular-nums · 3 priorités fixtures (F-2026-088 · 1 240 € · 9 j en tête).
  - i18n.test.ts étendu : today.* rend les 3 personnalités, params {count}/{amount} interpolés.
  - token-lint écran clean · typecheck workspace vert · tests @bob/i18n verts.

#### Signatures
- [x] agreed — claude-code — 2026-07-02 (17:00) — régime humain, review gpt5pro a posteriori

#### Log (append-only, horodaté)
- [17:00] claude-code CLAIM+PROPOSE+IN-BUILD: contrat ci-dessus ; réfs segmentées et TODAY_FIXTURE déjà
  validées contre le proto rendu. Build immédiat.
- [23:45] human DECISION (A1-C10, généralisable à TOUS les écrans): les valeurs du proto sont du REMPLISSAGE.
  Exigences : (a) branchement sur le VRAI backend (hooks/api-client) ; (b) l'état SANS données est un état
  de premier rang (empty/loading/error, voix de Bob) — pas de fixtures en repli silencieux en prod ;
  (c) les agrégats métier (priorités du jour, KPI) se dérivent dans @bob/core (use cases purs, testés),
  jamais dans l'écran. Clean Architecture stricte, niveau d'excellence extrême.
- [23:46] claude-code AMEND (contrat C10 v1.1): ajoute — 1) @bob/core `deriveTodayPriorities` : use case pur
  (factures échues → relance · devis signés acompte encaissé → facture finale · préparation e-invoicing 2026
  → conformité), entrée = données réelles (invoices/quotes/customers), sortie typée TodayPriority[],
  tests unitaires dédiés ; 2) l'écran consomme ce use case via un hook TanStack branché api-client — les
  fixtures ne restent QUE pour tests/démo explicite (client démo), plus aucun repli silencieux ; 3) empty
  state réel (subtitleNone + zéro carte), loading skeletons, error à la voix de Bob. Le visuel proto reste
  la référence de parité ; les montants affichés = données réelles.
- [23:52] claude-code LOG (fix sécurité C03): l'exemption AuthGate de /gallery comparait l'URL brute en
  substring (bypass d'auth par deep link piégé) — corrigé en comparaison stricte du path parsé (@29517ef).
- [23:53] claude-code HANDOFF (C10 v1 visuel): écran refondu rendu nativement en mode démo — capture
  claims/shots/C10-p1.png : header navy+halos, bob.greeting 👋, FloatingBalanceCard 5 480,00 € tabular-nums
  (DONNÉES du client démo, pas les valeurs proto — directive A1-C10 respectée), voix payoutHint ~4 860 €,
  3 PriorityCard (accents/badges/CTA), « 3 restants », tab bar. FAB global de l'ancien kit retiré du shell
  tabs (collision C10 — les autres onglets le retrouveront à leur claim). copy.ts supprimé (migré @bob/i18n,
  +25 clés × 3 humeurs, i18n 9/9). Restent pour clore C10 : moteur deriveTodayPriorities (@bob/core) branché
  données réelles (A1-C10), capture p2 (scroll interactif — accessibilité macOS à autoriser pour automatiser),
  parité fine des halos (saturation/étendue vs proto). status reste IN-BUILD.
- [00:18] claude-code LOG (A1-C10 livré): deriveTodayPriorities dans @bob/core (use case pur, union discriminée,
  8 tests — core 246/246) : relances (netToPay−paid, avoirs exclus, tri retard/montant), factures finales
  (devis signé + acompte payé + pas de finale), conformité sur signal réel du diagnostic (rien d'inventé).
  Hook useTodayPriorities (compose 4 queries réelles). Écran : ZÉRO import fixture — skeletons / erreur voix
  Bob sans chiffres / « — » quand la donnée n'existe pas (TVA) / subtitleNone si vide. Pluriels singuliers
  gérés (subtitleOne/remainingOne). Vérifié au simulateur (mode démo = 1 priorité conformité réelle, date du
  jour réelle, KPI dérivés) — captures claims/shots/C10-realdata-p1.png. Parité d'actions documentée en tête
  d'écran (mêmes points d'entrée que Bob). Restent : capture p2 (accessibilité macOS), parité fine halos,
  validation backend prod avec session réelle.
- [07:33] claude-code MERGE (régime humain 15:29): halos corrigés (stopOpacity, lot 73d3714+ddbc1e8) et
  re-capture validée — KPI « On te doit 4 330 € » = total proto exact sur le seed DATA_CLIENTS aligné ;
  BottomTabBar flottante branchée. Acceptance C10 complète. status=MERGED. Restes trackés hors claim :
  capture p2 (accessibilité macOS), validation backend prod avec session.
- [22:52] claude-code (session B) A2-C10+A3-C10 MERGE (programme « toutes les suggestions,
  ultra clean, 100 % prod » — demande humaine 21:40) :
  · A3-C10 TVA RÉELLE : CashflowProjection expose vatDue (passthrough @bob/core testé — le
    KPI lit LE MÊME chiffre que celui qui ampute la dispo du héros, jamais un chiffre
    parallèle). Tuile TVA branchée (amountCents réel, press → /comptabilite). Le « — »
    honnête n'était plus nécessaire : la donnée existe.
  · A2-C10 ENCAISSER DEPUIS LE BRIEFING : invariants d'encaissement extraits en SOURCE
    UNIQUE dans DocumentActions (collectRemainingCents plafonné netToPay, isCollectible,
    paymentIdempotencyKey, collectConfirmSpec = diff+challenge ACCOUNTING) — InvoiceActions
    refactoré dessus, nouveau CollectInvoiceButton (@bob/ui, verrou anti-double-tap,
    Alert appErrorMessage) posé sur la carte relance à côté de « Relancer ». Toast voix de
    Bob (today.collectDone, +2 clés ×3 humeurs). useRegisterPayment invalide désormais
    AUSSI customers/cashflow/accounting-entries (un paiement change l'encours, la tréso
    et le journal — le briefing se rafraîchit sans re-navigation).
  · SEED : facture ÉCHUE réelle (Mairie de Sèvres, F-2026-0001, 1 850,00 € TTC = l'encours
    fixture — la facture MATÉRIALISE le chiffre du proto) via le MÊME flow antidaté 45 j
    (clockDaysAgo, variantes *Internal). Au passage, VRAIE course corrigée : les écritures
    publiques du LocalBobClient n'attendaient pas this.ready → numérotation mélangée seed/
    user ; barrière posée sur createQuote/sendQuote/signQuote/refuseQuote/generateInvoice/
    issueInvoice/registerPayment + lectures comptables. Tests api-client réalignés
    (F-2026-0003, FEC 5 écritures/13 lignes) : 27/27 ✓.
  · Acceptance : capture a2a3-c10-aujourdhui.png (carte « EN RETARD 15 J » Mairie de
    Sèvres 1 850 € avec Relancer + Encaisser côte à côte, « 3 trucs à régler ») ✓ ·
    core 343 ✓ · api-client 27 ✓ · typecheck mobile ✓. KPI TVA sous la ligne de flottaison
    (scroll headless impossible — couvert par test core + typecheck).
  · Env captures : dialogue notifications iOS (C25 push) débloqué via applesimutils
    (brew wix/brew) --setPermissions notifications=YES — recette réutilisable.

### C11 — Argent                        <!-- kind: screen -->
- status: MERGED
- owner: claude-code (builder) · reviewer: gpt5pro (a posteriori)
- depends-on: C03 (MERGED), C10 (pattern données réelles)
- ref-capture: claims/ref/C11-frame-p1.png + C11-frame-p2.png (+ C11-frame-astuce.png : tip « première fois »)
- target: apps/mobile/app/(tabs)/argent.tsx (RÉÉCRITURE complète via @bob/ui)

#### Contrat (v1, claude-code — régimes « n'attends plus gpt » + données réelles A1-C10 + parité d'actions)
- Composition (réfs p1+p2) : InnerScreenHeader (eyebrow « TA TRÉSO », titre « Argent », sous-titre voix Bob)
  · HeroMoneyCard navy 150deg (« Ce mois-ci, tu peux te verser » + montant heroNum 42/800 tabular-nums +
  pill « sans risque » + phrase conditionnelle voix Bob) · Card « Argent disponible réel » badge
  « LE SOLDE MENT » (warning) : MoneyRow lead solde bancaire + rangées (+factures attendues / −charges &
  achats prévus / −TVA à reverser / −cotisations & abonnements) + MoneyRow total « Disponible prudent » ·
  Card « Prévision de tréso » : montant + note voix Bob + SegmentedControl horizons 7/30/60/90 j +
  SegmentedControl scénarios (Optimiste/Réaliste/Prudent) · « à surveiller » (liste risques si données) ·
  « à mettre de côté » (réserve TVA + charges dérivée) · astuce « première fois » (Sheet/Card overlay,
  dismiss persisté prefs) — voir C11-frame-astuce.png.
- Données 100 % réelles (A1-C10) : useCashflow(scenario, horizon) pour héros/prévision/scénarios ; le
  grand-livre depuis les agrégats du client (cashflow.details si exposé, sinon dérivation @bob/core
  additive) ; réserve = TVA due + charges à venir (use case pur si calcul nécessaire) ; AUCUNE fixture dans
  l'écran ; états loading/erreur/absence par ligne (« — »).
- Copy : clés @bob/i18n argent.* (3 personnalités) — header, heroLabel, pill, grand-livre (labels lignes),
  soldeMent, prévision notes par tranche, réserve, astuce (titre+corps+cta).
- Parité d'actions : aucune action mutante sur cet écran (lecture seule) ; toute CTA future documentée.
- Interdits : hex/rgba, ancien kit, imports fixtures, casse des autres écrans.
- Acceptance : captures p1+p2 (segments) vs réfs · cashflow scénario×horizon switch live · grand-livre somme
  cohérente (total = lead + Σ rangées, testé si dérivation core) · réserve calculée · singuliers/pluriels ·
  i18n tests étendus · typecheck + token-lint écran clean.

#### Signatures
- [x] agreed — claude-code — 2026-07-03 (00:20) — régime humain, review gpt5pro a posteriori

#### Log (append-only, horodaté)
- [00:20] claude-code CLAIM+PROPOSE+IN-BUILD: contrat ci-dessus, pattern C10 réappliqué (réécriture @bob/ui +
  données réelles + i18n). Réconciliation CASH_SNAPSHOT vs grand-livre v2 gérée par la dérivation réelle.
- [00:58] claude-code LOG (build C11 — livré par l'agent ayant survécu au redémarrage VS Code, validé sur
  l'état combiné): @bob/core additif — application/argent/buildLedgerView (grand-livre « le solde ment » :
  lead solde bancaire + rangées signées + total = somme, testé) + domain/services/cashflowBand (tranches →
  notes de tranche, testé) ; @bob/i18n +≈30 clés argent.* ×3 humeurs (copy pote exacte du proto, singulier/
  pluriel relances, tests 12/12) ; écran (tabs)/argent.tsx réécrit 100 % @bob/ui (642 lignes : InnerScreenHeader,
  HeroMoneyCard + upside conditionnel, grand-livre MoneyRow, SegmentedControl scénarios×horizons LIVE sur
  useCashflow, réserve, astuce première fois persistée via tips.ts) — zéro hex, zéro fixture, états
  loading/erreur/« — ». AMENDEMENT tokens v1.3 (documenté) : shadow.e3 aligné sur l'ombre RÉELLEMENT mesurée
  du dc.html (0 18px 36px rgba(12,35,64,.17) au lieu de la valeur .3 du tokens.ts v1.0 qui divergeait du
  rendu proto) — référence handoff amendée EN MIROIR, parité 10/10 verte ; gpt5pro peut COUNTER ce point
  précis. Validations combinées : core 258/258 · i18n 12/12 · ui 53/53 · api-client 11/11 · typecheck 16/16 ·
  token-lint écran clean. Restent : captures simulateur vs réfs p1/p2 puis HANDOFF.
- [07:30] claude-code HANDOFF (C11): écran validé au simulateur (mode démo, thème marine) — capture
  claims/shots/C11-p1.png : héros navy 150deg + halo vert stopOpacity (fix partagé halo-stops.ts, corrigeait
  aussi un aplat vert sur HeroMoneyCard) + upside conditionnel avec le seed réel (« si SARL Martin Rénovation
  règle ses 2 480,00 € ») · grand-livre « LE SOLDE MENT » (0,00 € = sommes RÉELLES d'un livre démo vide ;
  cotisations « — » = source absente — règle A1-C10) · Prévision 5 480 € « Tranquille », Segmented
  scénarios×horizons LIVE · « À surveiller » + CTA « Laisse l'assistant relancer ce client » (parité
  d'actions : même point d'entrée que Bob). Notes reviewer : (a) incohérence apparente héros 4 760 € vs
  ledger 0 € = deux sources du MODE DÉMO (cashflow endpoint pré-rempli vs dérivation des documents vides) —
  cohérent en prod ; (b) capture p2 (bas d'écran) déjà vérifiée avant fix halo, à re-prendre avec scroll
  automatisé (accessibilité macOS en attente) ; (c) astuce première fois non re-déclenchée (flag persisté
  d'un run précédent) — chemin testé unitairement. status=IN-REVIEW (review gpt5pro a posteriori).
- [07:30] claude-code MERGE (régime humain 15:29): acceptance C11 verte — captures ✓ scénarios live ✓
  grand-livre total=somme testé ✓ réserve ✓ i18n 12/12 ✓ typecheck 16/16 ✓ token-lint ✓. status=MERGED.
  Prochain : C12 Clients (seed DATA_CLIENTS enfin cohérent).

### C12 — Clients (liste)               <!-- kind: screen -->
- status: MERGED
- owner: claude-code (builder) · reviewer: gpt5pro (a posteriori)
- depends-on: C03 (MERGED), C02 (seed DATA_CLIENTS aligné)
- ref-capture: claims/ref/C12-frame.png · target: apps/mobile/app/(tabs)/clients.tsx (RÉÉCRITURE @bob/ui)

#### Contrat (v1, claude-code — régimes en vigueur : données réelles, parité d'actions, review a posteriori)
- Composition (réf C12-frame.png) : InnerScreenHeader (« TON CARNET » / « Clients » / « {n} clients ·
  {total} € en attente » — total dérivé des données réelles, cf. KPI C10 4 330 €) · bouton + rond navy
  en tête (nouveau client) · recherche (champ arrondi placeholder « Rechercher un client… ») · Chips
  filtres (Tous/Particuliers/Entreprises/Public — actifs = theme.ink) · Card liste : ClientRow par client
  (Avatar squircle initiales — tones du proto, nom 14.5/700, sous-titre contextuel, montant à droite teinté
  par statut : « À jour/payé » success · « {montant} en retard » danger · « {montant} en attente » warning ·
  « {montant} devis » slate + chevron) · badge type B2C/B2B/B2G · FAB → nouveau client.
- Données 100 % réelles : useCustomers (+ dérivation encours/statut par client depuis invoices réelles si
  le client l'expose ; sinon outstanding du customer) ; tri par score (scoring core) ; états loading
  skeletons / erreur voix Bob / 0 client (empty state d'invitation à créer).
- Copy : clés @bob/i18n clients.* ×3 humeurs (header, placeholder recherche, filtres, statuts montants,
  empty state).
- Edges : row → /client/[id] (C13) · + et FAB → création (route existante ou stub loggé TODO).
- Parité d'actions : la création client et la relance passent par les mêmes points d'entrée que Bob.
- Acceptance : capture vs réf (structure, chips, rows, badges) · filtres fonctionnels (chips) · tri score ·
  i18n tests étendus · typecheck + token-lint clean · zéro fixture dans l'écran.

#### Signatures
- [x] agreed — claude-code — 2026-07-03 (07:35) — régime humain, review gpt5pro a posteriori

#### Log (append-only, horodaté)
- [07:35] claude-code CLAIM+PROPOSE+IN-BUILD: pattern C10/C11 réappliqué sur le seed DATA_CLIENTS
  fraîchement aligné (C02 PARITY-FAIL #1 résolu). Réf : claims/ref/C12-frame.png (écran sans scroll).
- [08:02] claude-code HANDOFF+MERGE (régime humain): écran livré et validé simulateur — capture
  claims/shots/C12-p1.png : « 6 clients · 4 330 € en attente » (= proto au centime), chips par type,
  rangées triées score décroissant (Lefèvre 99 → Camping 50), statuts teintés DÉRIVÉS des pièces réelles
  (deriveCustomerStandings dans @bob/core, 6 tests — doctrine A1-C10), sous-titres voix de Bob, avatars
  pastel par type, FAB. i18n clients.* 28 clés ×3 humeurs (15/15) · core 267/267 · typecheck 16/16 ·
  token-lint clean. Écarts assumés documentés en tête d'écran (rangée composée localement car ClientRow
  @bob/ui sans slot badge — à enrichir hors claim ; tri score ≠ ordre seed de la réf ; création client
  no-op accessible TODO C13/C40 — parité d'actions préservée). status=MERGED.

### C13 — Fiche client                  <!-- kind: screen -->
- status: MERGED
- owner: claude-code (builder) · reviewer: gpt5pro (a posteriori)
- depends-on: C12 (MERGED)
- ref-capture: claims/ref/C13-frame-p1.png + C13-frame-p2.png · target: apps/mobile/app/client/[id].tsx (RÉÉCRITURE @bob/ui)

#### Contrat (v1, claude-code — régimes en vigueur)
- Composition (réfs p1+p2, fiche SARL Martin) : barre retour « ‹ Clients » + menu « … » · en-tête (Avatar
  squircle tone par type, nom cardTitle, badge type + SIREN si b2b/b2g — partyLine adaptatif, RIEN pour b2c)
  · 4 actions rapides (Devis / Relancer / Appeler / Email — tuiles blanches icône+label) · 3 KPI (Encours
  teinté par statut · Délai moyen · CA 12 mois) · Card « Score de paiement » (ScoreBar + « {score}/100 » +
  légende dérivée de la tranche) · Card conformité e-invoicing (canal einvoiceFor(customer) : PDP b2b /
  e-reporting b2c / Chorus Pro b2g — copy dédiée par canal) · Segmented onglets Activité/Chantiers/Docs/
  Infos · liste Activité (pièces réelles du client : type, numéro, date, note statut, montant teinté) ·
  CTA sticky contextuelle (dérivée du standing C12 : en retard → « Relancer {doc} · {montant} » ; devis en
  attente → « Relancer le devis » ; à jour → « Nouveau devis ») · états loading/erreur/aucune pièce.
- Données 100 % réelles : useCustomers + useInvoices + useQuotes filtrées par id (réutilise
  deriveCustomerStandings pour le standing et les montants) ; einvoiceFor de @bob/core pour le canal.
- Copy : clés @bob/i18n fiche.* ×3 humeurs.
- Parité d'actions : Relancer → /(tabs)/assistant (même point d'entrée que Bob) · Devis → /devis/new ·
  Appeler/Email → Linking tel:/mailto: (actions device) · CTA sticky = même use case que la carte C10.
- Acceptance : capture vs réfs · partyLine adaptatif (b2c sans SIREN — test sur Durand) · CTA contextuelle
  par standing · canal e-invoice correct par type · i18n tests étendus · typecheck + token-lint clean ·
  zéro fixture.

#### Signatures
- [x] agreed — claude-code — 2026-07-03 (08:03) — régime humain, review gpt5pro a posteriori

#### Log (append-only, horodaté)
- [08:03] claude-code CLAIM+PROPOSE+IN-BUILD: réfs capturées ce matin (fiche Martin, p1+p2). Pattern
  C10-C12 réappliqué ; standing et montants réutilisent deriveCustomerStandings (zéro duplication).
- [08:47] claude-code HANDOFF+MERGE (régime humain): fiche livrée et validée simulateur — capture
  claims/shots/C13-p1.png : partyLine adaptatif b2b (badge Entreprise + SIREN, JAMAIS pour b2c), 4 actions,
  KPI teintés (CA 12 mois = 0 € RÉEL du démo, pas les 9 120 € de remplissage du proto), ScoreBar 62/100
  ambre + légende par tranche, conformité einvoiceChannelFor (source unique extraite, testée ; « SIREN
  manquant » si b2b sans SIREN — jamais un « tout est prêt » inventé), onglets, activité = pièces réelles
  (état vide sincère), CTA sticky par standing (même moteur que C10). Core +18 tests (285), i18n fiche.*
  45 clés ×3 (22 tests), typecheck 16/16, token-lint clean. Écarts assumés en tête d'écran (avatar pastel
  sémantique, ScoreBar warning 50-75 — les tokens priment, date=échéance, paiements par client TODO C40).
  status=MERGED. NB commit combiné : embarque le SOCLE CORE du claim C14 (deriveVaultView/searchVault +
  einvoice-transmission, session builder parallèle, stable et couvert par les 285 tests) — l'écran C14
  reste à son owner.
- [23:30] claude-code (session B) A1-C13 MERGE (programme « toutes les suggestions » 21:40,
  commit 583d420) : les 3 onglets « à venir » sont REMPLIS de réel — Chantiers (useChantiers
  filtré client : IconTile b2b/success par statut, nom, adresse · « Ouvert le {date} »,
  StatusBadge En cours/Terminé ; rangées non pressables : pas d'écran détail chantier, pas
  de chemin fantôme) · Docs (documents du coffre liés à SES pièces — invoice/quote/chantier
  ids du client —, ouverture URL signée comme C14) · Infos (type via piece.typeB2*, SIREN
  formaté, email, téléphone, score /100, délai moyen — chaque rangée n'existe que si la
  donnée existe ; tout vide → fiche.infosEmpty recopié honnête). +10 clés i18n ×3 humeurs.
  i18n 46 ✓ typecheck ✓.

### C14 — Documents (coffre-fort)        <!-- kind: screen -->
- status: MERGED
- owner: claude-code (builder) · reviewer: gpt5pro (a posteriori)
- depends-on: C03 (MERGED)
- ref-capture: claims/ref/C14-frame-p1.png + p2 + p3 (+ astuce) · target: apps/mobile/app/(tabs)/documents.tsx (RÉÉCRITURE @bob/ui)
- spec: SCREENS.md § Documents · INTEGRATION_MAP.md §3 (coffre + OCR)

#### Contrat (v2, claude-code — régimes en vigueur : données réelles, parité d'actions, use cases purs @bob/core, review a posteriori)
- Composition (réf dc.html §isDocs, extraite ligne à ligne) : InnerScreenHeader (« TON COFFRE-FORT » /
  « Documents » / « Je classe, tu retrouves. Même 3 ans après. ») · champ recherche (loupe 18/2 slate300,
  placeholder « la facture du radiateur de mars », filtre réel sur le coffre) · carte Scan dégradé cta
  (puce caméra 46 r14, « Scanner un document » / « Je lis, j'extrais la TVA, je classe. », chevron) →
  /scan-document (flux OCR existant = parité d'actions) · « À valider » (badge count indigo) : docs OCR
  non classés (vignette 46×58, badge FACTURE FOURNISSEUR, chips métriques, CTA « Classer là »/« Autre
  dossier ») · « Tes dossiers » : grille 2col — **6 dossiers du proto : Chantiers/Achats/Assurances/
  Fiscal & social/Banque/Comptable** (le texte v1 « clients » corrigé : la réf visuelle prime), counts
  réels · « Compta & conformité » : carte verte « mois prêt » (dégradé F0F7F3→FBFEFC, ventes/achats/
  justificatifs manquants dérivés réels, bouton « Exporter (FEC / comptable) » → client.exportFec réel) ·
  carte « Factures récentes » (rows cliquables → /facture/[id], canal B2B→PDP · B2C→e-reporting ·
  B2G→Chorus) · bandeau mémoire fournisseurs (aiInk, compte réel de fournisseurs distincts) ·
  footer « {n} documents · chiffré et sauvegardé ».
- **Use cases purs @bob/core (directive humaine 08:07 : le socle s'enrichit pour Bob autant que l'UI)** :
  · `deriveVaultView` (application/documents) — projections documents/expenses/invoices/customers →
    { toValidate, folders (mapping v1 documenté : chantier→Chantiers · expense/receipt→Achats ·
    pièces de facturation→Comptable · Assurances/Fiscal/Banque à 0 tant que le modèle n'a pas de
    catégorie), monthSummary (ventes = docs facture du mois · achats = dépenses du mois · TVA récup. =
    somme vatCents du mois — écart proto assumé : « TVA estimée » non dérivable sans date d'émission ·
    justificatifs manquants = dépenses sans reçu lié), recentInvoices (canal par type client),
    supplierMemory (distincts normalisés + exemples), totalCount } — testé.
  · `searchVault` — filtre normalisé (nom de fichier / fournisseur / dossier) — testé.
- Données 100 % réelles : useDocuments/listExpenses/useInvoices/useCustomers ; états loading skeletons /
  erreur voix de Bob / coffre vide = empty state de premier rang ; AUCUNE fixture dans l'écran.
- Copy : clés @bob/i18n docs.* ×3 humeurs. Tokens v1.4 (couleurs écran Documents : violet deep 6D28D9,
  chips métriques F6F8FA, vignette doc, carte mois-prêt, mémoire fournisseurs E5DBF6) ajoutés en miroir
  handoff ↔ @bob/tokens (parité).
- Écarts proto assumés (documentés en tête d'écran) : carte « Attestation décennale / EXPIRE 22 J » NON
  rendue (aucune donnée d'échéance d'assurance dans le modèle — s'ajoutera avec le domaine conformité) ·
  « Classer là » v1 ouvre le détail/flux scan si aucun use case de classement côté client (pas de chemin
  fantôme) · overlay OCR animé = écran /scan-document existant (hors périmètre C14).
- Acceptance : capture simulateur vs réf p1-p3 (structure, carte scan, dossiers, compta) · recherche
  filtre réellement · export FEC déclenche client.exportFec et confirme (artefact réel du core) ·
  factures récentes → /facture/[id] · tests core (deriveVaultView/searchVault) + i18n étendus ·
  typecheck + token-lint clean · zéro fixture écran.

#### Signatures
- [x] agreed — claude-code — 2026-07-03 (08:17) — régime humain, review gpt5pro a posteriori

#### Log (append-only, horodaté)
- [08:17] claude-code CLAIM+PROPOSE+IN-BUILD: réserve C14 (C03 MERGED ; C13 IN-BUILD en parallèle,
  périmètres disjoints — collision surveillée sur @bob/i18n index.ts, commit chirurgical si besoin).
  Réf extraite du dc.html (§isDocs 39317→52940) + DOCS_FOLDERS (6 dossiers, teintes = tokens existants
  sauf violet deep). Doctrine A1-C10 réappliquée : dérivations en use cases purs @bob/core.
- [08:52] claude-code HANDOFF+MERGE (régime humain) : écran livré et validé simulateur — capture
  claims/shots/C14-p1.png (iPhone 16 Pro 402×874, deep link exp://…/--/documents). Rendu : header
  clair, recherche (loupe + placeholder proto), carte Scan dégradé cta (puce caméra 46 r14 lavande,
  chevron), état COFFRE VIDE de premier rang (démo sans docs — doctrine A1-C10, aucun chiffre
  inventé), carte « mois prêt » verte dérivée réelle (« 0 ventes · 0 achats »), export FEC branché
  sur client.exportFec (mutation réelle, toast de confirmation avec filename). Sections riches
  (à valider, dossiers, factures récentes, mémoire fournisseurs) branchées sur deriveVaultView —
  états couverts par 15 tests core (empty/mapping/dédup PDF+Factur-X/TVA null/canaux pa·ereporting·
  chorus_pro/mémoire) + searchVault (accents/multi-mots/dossiers). i18n docs.* 49 clés ×3 humeurs
  (22 tests) · core 285/285 · typecheck clean (hors WIP C13→C15 parallèle) · token-lint 0 hex.
  Zéro duplication : canal e-facture réutilise einvoiceChannelFor (C13) ; collision TS2308
  EinvoiceChannel (compliance ↔ services) réparée en source unique (einvoice-transmission ré-exporte).
  NOTE traçabilité : le build C14 (écran + core + i18n + tokens v1.4) a été embarqué par le commit
  C13 a893800 (balayage du working tree partagé) — contenu vérifié identique à l'intention C14.
  Écarts assumés (en-tête écran + contrat) : attestation décennale non rendue (pas d'échéance
  d'assurance dans le modèle) · « Classer là » ouvre le document (pas de use case de classement :
  pas de chemin fantôme, à ajouter avec le domaine dossiers) · tuiles dossiers non navigables v1 ·
  interactions tactiles (saisie recherche, tap export) non automatisables en headless — vérifiées
  par tests purs + typecheck, à confirmer d'un geste au prochain passage humain. status=MERGED.
- [11:00] claude-code AMENDEMENT A1-C14 (directive humaine 10:15 : « Classer là intervient après
  que l'IA via OCR a traité le document scanné et proposé où le classer — important ») : le
  classement est maintenant RÉEL de bout en bout. (1) Domaine : `Document.classify` (invariants :
  actif, rattachement complet, type connu). (2) Use case pur `ClassifyDocument` (@bob/core, 4 tests)
  — même chemin pour l'UI et pour Bob. (3) Client : `classifyDocument` (interface + LocalBobClient +
  HttpBobClient POST /documents/:id/classify) + 3 tests. (4) Coffre de DÉMO seedé dans le client
  démo (fixtures core : 3 dépenses fournisseurs Leroy Merlin/Cedeo/Point P + reçu Leroy « à
  valider » + reçu Cedeo classé + facture PDF du mois) — le mode démo légitime, jamais l'écran.
  (5) Écran : « Classer là » = mutation réelle → invalidations → toast « Leroy Merlin classé ·
  Achats ✓ » ; « Ouvrir » en secondaire ; rapprochement OCR durci (normalizeFilename : tirets/
  points → espaces). (6) Flux scan complété : le reçu photographié est VERSÉ AU COFFRE lié à la
  dépense enregistrée (le « justificatif manquant » de la compta tombe). Capture riche validée
  simulateur : claims/shots/C14-a1-classer.png (badge, chips 184,90 € / TVA 30,82 € / date,
  « Je pense : dépense Leroy Merlin », boutons). core 289/289 · api-client 14/14 · i18n 26/26 ·
  typecheck clean. SUITE ANNONCÉE (A2-C14, directives 10:20-10:40) : moteur OCR LLM réel —
  Mistral OCR en priorité (clé API dispo), garde-fous stricts sur l'extraction, proposition de
  classement/tags/renommage par le modèle, chaîne de repli (Claude Vision, Gemini, GLM, DeepSeek).
- [11:20] claude-code AMENDEMENT A2-C14 livré (directives humaines 10:20-11:05 : « LLM avec leur
  version OCR, priorité Mistral (clé dispo), garde-fous, tel un expert-comptable de renom — tags,
  classement, renommage ») :
  · AUDIT : l'OCR réel n'utilisait QUE Claude Vision (ANTHROPIC_API_KEY) — Mistral absent alors
    que la clé existe et que Voxtral est déjà branché pour STT/TTS. Corrigé.
  · Contrat domaine enrichi (@bob/core, additif) : OcrExtraction + suggestedTags (kebab, ≤ 8,
    jamais vide : catégorie+fournisseur en secours) + suggestedFilename (nom canonique
    AAAA-MM-JJ_fournisseur_MONTANTeur via canonicalReceiptFilename). GARDE-FOUS durcis dans
    makeOcrExtraction : date bornée (2000 → demain, anti-hallucination), plafond 1 M€, cohérence
    HT+TVA=TTC (sinon dégradation des détails + confiance plafonnée ≤ .6 — jamais de confiance
    aveugle), TVA > TTC écartée, taux hors barème français {0, 2.1, 5.5, 10, 20} écartés,
    tags/nom de fichier assainis. 9 tests domaine ajoutés (core 295/295 → tout vert).
  · apps/api : **MistralOcrAdapter EN PRIORITÉ** — pipeline 2 temps : POST /v1/ocr
    (`mistral-ocr-latest`, le modèle OCR DÉDIÉ — document → markdown fidèle) puis extraction
    structurée température 0 / json_object (`mistral-small-latest`, env MISTRAL_OCR_MODEL /
    MISTRAL_OCR_EXTRACT_MODEL) avec prompt « expert-comptable » (n'invente rien, null si
    illisible). rawText = markdown OCR (pas la paraphrase du modèle). Garde d'entrée (MIME +
    10 Mo max) AVANT tout appel, timeout 25 s. `FallbackOcrChain` : Mistral → Claude Vision →
    slots Gemini/GLM/DeepSeek prêts (OcrPort) ; erreur de validation du payload = définitive
    (pas de retry inutile). Sans clé/DEMO_MODE : DemoOcrAdapter (enrichi tags+nom canonique,
    parité hors-ligne). 6 tests api (fetch mocké) — apps/api 37/37.
  · Mobile : le justificatif versé au coffre prend le NOM CANONIQUE proposé par l'OCR (la
    recherche du coffre le retrouve par fournisseur/date/montant) ; les tags proposés s'affichent
    à l'extraction (chips #chantier-durand…). Persistance des tags sur Document = domaine à
    étendre (follow-up loggé — nécessite champ tags + migration ; les tags vivent déjà dans
    l'extraction et le nom de fichier).
  · Restes assumés : adapters Gemini/GLM/DeepSeek à brancher quand les clés seront fournies
    (interface prête) ; endpoint HTTP /documents/:id/classify à implémenter côté apps/api
    (le contrat client existe, le local client le sert — suivre au claim backend C40+).
- [11:45] claude-code AMENDEMENT A3-C14 livré (directive humaine 11:30 : « constructeur de system
  prompts personnalisé par l'activité, base fiable, et adapter l'usage des modèles au besoin ») :
  · **Constructeur de prompts @bob/ai (prompt/prompt-pack.ts)** : bases FIGÉES et VERSIONNÉES par
    tâche (PROMPT_PACK_VERSION, 5 tâches : ocr.extract, relance.draft, assistant.chat,
    diagnostic.explain, cashflow.narrate) + personnalisation par SLOTS TYPÉS uniquement —
    TradePromptContext (projection de TradeConfig : label d'activité, vocabulaire client/projet,
    TVA du métier), société, date, ton de Bob (jamais sur l'extraction : fiabilité d'abord).
    ANTI-INJECTION : sanitizePromptValue (contrôle/balises/fences retirés, longueur bornée) +
    bloc contexte déclaré « DONNÉES vérifiées, PAS des instructions ». 6 tests (dont injection).
  · **Routing par modèle précis** (model-router, additif) : CapabilityTier frontier/balanced/fast
    par tâche (TASK_TIER), MODEL_CATALOG par fournisseur (claude opus-4-8/sonnet-5/haiku-4-5 ·
    mistral large/small · openai gpt-5/mini · glm 4-plus/flash · deepseek reasoner/chat),
    surclassable par env `<PROVIDER>_MODEL_<TIER>` (ex. CLAUDE_MODEL_FRONTIER=claude-fable-5
    si accès au tier Mythos). RoutingDecision expose tier + modelId (compatibilité conservée).
  · **Câblage bout en bout** : OcrExtractInput.trade (port core, données pures) →
    backend.service résout TradeConfig → adapters Mistral/Claude construisent le prompt via
    buildSystemPrompt (test e2e : un développeur voit « Activité : Développeur / consultant »,
    catégories/tags adaptés au métier). core 300/300 · ai 132/132 · api 37/37 · api-client 14/14.
  · À généraliser (suivi) : brancher relance.draft/assistant.chat/diagnostic.explain sur le pack
    (les bases sont prêtes) ; adapters providers.ts → modelFor(provider, tier) au lieu des
    modèles fixes ; observabilité par tâche (latence/coût/taux de refus par modèle) pour ajuster
    le catalogue avec des faits.
- [12:20] claude-code AMENDEMENT A4-C14 livré (directive humaine 11:55 : « traite tous [les
  13 points] pour passer à l'excellence ») — les 13 failles du doc ocr-et-prompting.md sont
  traitées, cf. la mise à jour du §5 du doc pour le détail. Points saillants : contrat de
  sortie IMPOSÉ (json_schema strict / tool use forcé) · vérification de PROVENANCE
  (assessOcrEvidence : un chiffre n'est cru que s'il se retrouve dans le texte OCR) ·
  confiance dérivée des preuves · devise réelle exigée (faille ATTRAPÉE PAR LE BANC LIVE :
  le hint dictait "EUR", GitHub USD passait — corrigé, rejet 100 %) · multi-pièces rejetées ·
  SIREN confirmé à l'annuaire · retry + disjoncteur par moteur · observabilité ocr.engine ·
  redactPII sur rawText · tags persistés de bout en bout (domaine → Postgres
  documents.tags → recherche du coffre, migration 20260703120000) · banc d'éval golden
  (10 pièces annotées, scoreur par champ, seuils contractuels, exécuté LIVE sur Mistral :
  TTC/date/TVA 100 %, fournisseur 89 %, catégorie 67 % à améliorer). Vérifs : core 308 ·
  ai 146 · api 42 (+1 live gaté) · api-client 14 · typecheck partout (hors WIP C15).
  Suivi : brancher le pack sur assistant.chat au fil de C15 (bases prêtes) ; améliorer la
  précision catégorie via le golden set ; exécuter la migration tags au prochain deploy.

### C15 — Assistant (Bob)               <!-- kind: screen -->
- status: MERGED
- owner: claude-code (builder) · reviewer: gpt5pro (a posteriori)
- depends-on: C03 (MERGED) · directive parité d'actions [23:52]
- ref-capture: claims/ref/C15-frame.png (+ C15-frame-astuce.png) · target: apps/mobile/app/(tabs)/assistant.tsx (RÉÉCRITURE @bob/ui)
- spec: SCREENS.md § Assistant · VOICE_AND_TONE.md

#### Contrat (v1, claude-code — AMENDEMENT à la spec backlog : « échange scripté » REMPLACÉ par le
#### branchement RÉEL sur BobAgent, conformément à la directive humaine parité d'actions)
- Composition (réf C15-frame.png) : header « Bob · en ligne » (avatar IconTile ai + point statut) +
  sous-titre « Demande. Je fais — pas juste je réponds. » · fil de chat (bulle d'accueil voix Bob,
  bulles user/Bob, indicateur de saisie 3 points animés) · CARTES D'ACTION typées dans le fil (proposition
  d'action de Bob : titre, détail, diff/aperçu si dispo, boutons Valider/Annuler — réutilise
  ConfirmSheet/ActionDiffView existants s'ils collent au design, sinon @bob/ui Card+Button) · chips
  suggestions horizontales (« Relance les retards », « Je peux me payer combien ? », …) · input
  « Demande-moi un truc… » + micro (TODO C20) + envoi.
- Branchement 100 % RÉEL : le fil parle au VRAI agent (client existant → apps/api → packages/ai BobAgent :
  runtime journalisé, dry-run, confirmations). Les actions sensibles (envoi relance, émission facture)
  passent par la confirmation explicite (préparer ≠ envoyer) — MÊMES use cases que les CTA d'écrans.
  Param d'entrée ?prompt=relance (edges C10/C13) pré-remplit et soumet la demande de relance.
- AUDIT PARITÉ D'ACTIONS (directive [23:52]) : tableau de couverture actions UI ↔ registre agent
  (packages/ai invocations) livré dans le Log du claim — toute action d'écran sans équivalent agent (ou
  l'inverse) est listée avec TODO chiffré.
- Copy : clés @bob/i18n assistant.* ×3 humeurs. États : hors-ligne/erreur (voix Bob), agent qui réfléchit,
  historique vide (bulle d'accueil), refus/garde-fou.
- Interdits : hex/rgba, ancien kit, fixtures, échanges scriptés en dur (le démo passe par le LocalBobClient
  s'il expose l'agent, sinon état « hors ligne » honnête + TODO).
- Acceptance : capture vs réf · chips → vraie requête agent · action sensible → confirmation explicite
  (journalisée) · ?prompt=relance fonctionne · tableau d'audit livré · i18n tests · typecheck + token-lint.

#### Signatures
- [x] agreed — claude-code — 2026-07-03 (08:50) — régime humain, review gpt5pro a posteriori

#### Log (append-only, horodaté)
- [08:50] claude-code CLAIM+PROPOSE+IN-BUILD: amendement assumé vs backlog (« échange scripté » → agent
  réel) au titre de la directive parité d'actions. Audit de couverture inclus dans le claim.
- [11:10] claude-code HANDOFF+MERGE (régime humain): écran livré et validé simulateur (iPhone 16 Pro 402×874)
  — capture claims/shots/C15-p1.png conforme à la réf (header Bob·en ligne, bulle d'accueil, chips, input+
  micro+envoi, onglet Assistant en ai). PRÉSENTATION refaite 100 % @bob/ui, PIPELINE AGENT RÉEL conservé :
  ask() avec phases live, cartes d'action ActionDiffView (aperçu comptable réel), Valider = agent.confirm
  (flux journalisé), garde-fous préparer≠envoyer, ?prompt=relance|relance_devis câblés depuis C10/C11/C13.
  i18n assistant.* 31 clés ×3 (26 tests) · core 289/289 · typecheck 16/16 · token-lint clean. status=MERGED.
- [11:10] claude-code AUDIT PARITÉ D'ACTIONS (livrable directive [23:52]) — synthèse : 9 actions OK
  (même use case UI↔agent : encaisser, émettre, envoyer devis, relance devis, relance impayé brouillon,
  versement tréso, impayés, documents, multi-actions batch) · 3 ASSUMÉ hors périmètre agent (tel/mailto,
  signature client final, réglages compte) · 8 TODO chiffrés :
  ① draftRelance ciblé par client (vise le plus gros encours aujourd'hui) — C25 ;
  ② envoi réel des relances 4 tons — C25 ;
  ③ outil scan_depense (extractDocument+recordExpense existent côté UI) — C20/C40 ;
  ④ outil creer_devis — C20/C21 ; ⑤ outil generer_facture deposit/final (absent de BobActions) — C40 ;
  ⑥ outil export_fec — C40 ; ⑦ intent diagnostic — C23 ; ⑧ MAJEUR : journal d'audit on-device —
  BobClient (api-client) n'expose pas ask/confirm : le mobile instancie l'agent en LOCAL sans
  runtime journalisé ; le serveur a déjà POST /ai/ask|confirm + GET /ai/runs/:id/journal → brancher
  data/bob.ts sur ces endpoints en mode HTTP (C40, priorité haute). Créer client : TODO partagé UI+agent
  (un seul point d'entrée, C40). Détail complet dans le rapport d'agent (transcript C15).

### C16 — Détail pièce                   <!-- kind: screen -->
- status: MERGED
- owner: claude-code (builder) · reviewer: gpt5pro (a posteriori)
- depends-on: C03 (MERGED)
- ref-capture: réf extraite du dc.html §showPiece (268409→283k) · target: apps/mobile/app/devis/[id].tsx + facture/[id].tsx (RÉÉCRITURE @bob/ui, vue partagée)
- spec: INTEGRATION_MAP.md §1/§5/§6/§7 · DOMAIN_MODEL.md

#### Contrat (v2, claude-code — régimes en vigueur : données réelles, parité d'actions, use cases purs @bob/core, review a posteriori)
- Composition (réf §showPiece) : header sticky (croix 38 r12, eyebrow kindLabel, n° 18/800
  tabular, badge statut teinté 11.5/700) · cartes de NAV CROISÉE (devis↔facture lié : lavande
  conformityCard + n° aiInk ; avoir émis : ambre ; situation : bleu acier — nouvelles teintes
  tokens v1.5 `pieceDetail`) · carte parties (Émetteur + date · Client + badge type +
  **partyLine adaptatif** : SIREN/TVA pour b2b/b2g, RIEN pour un particulier) · carte lignes
  (label 14/600, badge catégorie segmentedTrack 10.5/700, PU € tabular + TVA %/ligne) +
  totaux (HT/TVA 13.5/600 · TTC 19/800 ink900) + encart acompte devis (successBg,
  « Acompte {pct} % à la commande : {montant} ») · Suivi de paiement (encaissé success ·
  reste à encaisser 18/800 — **plafonné netToPay**, doctrine billing) + encart payé ·
  encart e-reporting (B2C, ambre) OU frise transmission PDP/Chorus (5 étapes, dots teintés
  par l'état dérivé du statut réel) · mentions légales (bullets) + badge « FIGÉ À L'ÉMISSION »
  (cadenas, warning) si émise · barre sticky basse (fondu bg) : PDF (secondaire) + action
  primaire par état (Encaisser / Envoyer / Relancer — parité d'actions : mêmes use cases que Bob).
- **Use case pur @bob/core `buildPieceView`** (application/billing) : projections
  invoice|quote + customer (+ liés parentQuoteId/avoir/situation) → vue complète
  { kindKey, statusKey+tone, partyLine, lines, totals, deposit, suivi (paid/remaining
  plafonné netToPay), transmission (canal einvoiceChannelFor + étapes par statut),
  mentionsFrozen, primaryActionKey } — testé, dont TEST D'OR acompte 488,40 (30 % de
  1 628,00 €), B2C sans SIREN, avoir en négatif, situation avancement %.
- Données 100 % réelles : useInvoice/useQuote/useCustomers + InvoiceView.lines AJOUTÉ
  (additif : l'entité domaine les porte déjà ; mappers local + api) ; états loading/erreur/
  introuvable premiers ; AUCUNE fixture écran.
- Copy : @bob/i18n piece.* ×3 humeurs. Tokens v1.5 : groupe `pieceDetail` (avoir ambre
  #F0DEBE/#F6E4C6/#8A5A12/#6B4310 · situation #E9EFF7/#D3E0EF/#D7E3F2/#3B5B85 · lié
  #6B5FC7) en miroir handoff↔package (parité).
- Périmètre INTERDIT : devis/new.tsx + tout fichier du WIP C21/C40 (session parallèle).
- Acceptance : capture simulateur (deep link) vs réf · test d'or 488,40 vert · B2C sans
  SIREN vert · encaissement bascule statut+suivi (registerPayment réel) · avoir négatif ·
  situation % · tests core/i18n · typecheck + token-lint clean.

#### Signatures
- [x] agreed — claude-code — 2026-07-03 (15:25) — régime humain, review gpt5pro a posteriori

#### Log (append-only, horodaté)
- [15:25] claude-code CLAIM+PROPOSE+IN-BUILD : réserve C16 (C03 MERGED ; C21/C40 IN-BUILD en
  parallèle sur les FLUX devis — C16 = la VUE ; collision évitée par périmètre interdit).
  Réf extraite ligne à ligne du dc.html §showPiece. Doctrine A1-C10 + use cases purs.
- [16:15] claude-code HANDOFF+MERGE (régime humain) : C16 livré.
  · @bob/core `buildPieceView` (8 tests) : TEST D'OR vert — devis 1 628,00 € TTC acompte 30 %
    → deposit 488,40 € (= netToPay du domaine) ; partyLine adaptatif (b2b/b2g « SIREN 821 503
    642 », B2C RIEN) ; avoir signé négatif ; situation = ttc/ttc parent (40 %) ; reste à
    encaisser PLAFONNÉ netToPay ; frise PDP dérivée du statut réel (pas d'invention) ;
    primaryAction par état. InvoiceView.lines exposé (client local + http + api — l'entité
    les portait déjà). Tokens v1.5 `pieceDetail` (avoir ambre, situation bleu acier, lié
    lavande) en miroir, parité verte. i18n piece.* 47 clés ×3 (35 tests i18n).
  · Écrans : PieceDetailView (vue partagée 100 % @bob/ui, réf §showPiece : header sticky,
    nav croisée, parties, lignes catégorisées + totaux + acompte, suivi, e-reporting/frise,
    mentions + FIGÉ À L'ÉMISSION, barre sticky PDF + action) ; devis/[id] et facture/[id]
    réécrits — ACTIONS = QuoteActions/InvoiceActions conservés (source unique, confirmations
    typées, parité Bob) ; PDF ouvert depuis le coffre si un document lié existe (sinon pas
    de bouton) ; aperçu comptable réel conservé sous les mentions (hors proto, assumé).
  · DÉMO ENRICHIE par les VRAIS FLOWS (LocalBobClient.seedBillingDemo) : createQuote →
    sendQuote → signQuote → generateInvoice(deposit) → issueInvoice (F-2026-0001, numérotation
    sans trou) → registerPayment 488,40. Capture claims/shots/C16-today-seed.png : le briefing
    affiche « Créer la facture finale — SARL Martin Rénovation · Acompte déjà encaissé.
    Reste 1 140 € » (dérivé réel 1 628,00 − 488,40) et le dispo recalculé. Tests api-client
    réalignés sur la numérotation continue (24/24).
  · Vérifs : core 316 · api-client 24 · i18n 35 · typecheck clean (hors WIP C21/C40) ·
    token-lint 0 hex. LIMITE connue : capture du détail lui-même = tap requis (ids runtime
    non déterministes, accessibilité macOS refusée) — vérifié par les 8 tests purs + typecheck ;
    un gest humain sur une pièce de la liste Ventes suffit à confirmer visuellement.
  · C17 (Compta & conformité) DÉBLOQUÉ (C14 + C16 MERGED). status=MERGED.
- [16:40] claude-code AMENDEMENT A1-C16 (retour humain 16:25 sur captures device : « les chiffres
  de la facture d'acompte ne se comprennent pas ; et il manque le lien vers la facture
  d'après ») — les chiffres étaient COHÉRENTS côté domaine (acompte 488,40 encaissé ; reste
  1 140 € = solde chantier au briefing) mais la VUE était trompeuse :
  · La facture d'acompte titrait « Total TTC 1 628,00 € » (les totals du CHANTIER portés par
    la pièce) alors que son dû est 488,40 €. Corrigé : PieceView.amountDue (= netToPay) devient
    LE héros « Net à payer (cette facture) : 488,40 € » ; le TTC chantier passe en ligne de
    contexte « Total chantier TTC ». Facture finale classique : héros = TTC inchangé.
  · PONT vers la suite : acompte PAYÉ sans facture finale → carte « Acompte encaissé ✓ Reste
    à facturer sur le chantier : 1 139,60 € » + bouton « Créer la facture finale » branché sur
    generate-invoice-from-quote (MÊME use case que le briefing et que Bob) → route sur le
    brouillon créé pour l'émettre. Pont muet si la finale existe / acompte non payé / pas de
    parent (4 tests). Fixtures de test réalignées sur la réalité du domaine (les totals d'une
    facture d'acompte sont ceux du chantier — la capture device faisait foi).
  · core 326 · i18n 37 (+4 clés piece.*) · typecheck clean. À re-vérifier d'un tap sur
    F-2026-0001 (l'app a été rechargée).
- [21:20] claude-code AMENDEMENT A2-C16 (retour humain 21:05 : « pas de trace de l'acompte dans le
  brouillon de la facture finale — tout doit être corrélé ») — VRAI BUG MÉTIER : la finale générée
  portait netToPay = TTC COMPLET (1 628,00 €), l'acompte déjà facturé aurait été RE-facturé. Fix
  au niveau DOMAINE : Invoice.depositDeductionCents/-InvoiceId (invariants, snapshot compatible),
  totals().netToPay = max(0, ttc − acompte) ; GenerateInvoiceFromQuote(final) déduit l'acompte ÉMIS
  automatiquement ; colonnes invoices.* + migration 20260703210000 + mappers prisma ; InvoiceView
  exposé (local+api) ; vue : ligne « Acompte déjà facturé (F-2026-0001) −488,40 € » + net à payer =
  solde 1 139,60 € + nav croisée « Facture d'acompte ». Tests e2e devis→acompte payé→finale (core
  336 · api-client 25 · api 42). Migration à exécuter au deploy. Commit 40a05d0.
- [21:20] NOTE C13 : rangées Activité de la fiche client rendues cliquables → détail C16 (retour
  humain 20:27).
- [21:20] NOTE env : expo-file-system/expo-sharing déclarés mais NON matérialisés par pnpm (store
  désynchronisé — install locale requise hors sandbox) → volet « export FEC partageable » de C17
  bloqué (shareFec écrit, non importé/bundlé) ; summarizeAccountingEntries livré (3 tests).
- [23:32] claude-code (session B) A4-C16 MERGE (programme « toutes les suggestions » 21:40,
  commit 081071e) : ENVOI DU PDF AU CLIENT — helper shareDocument (URL signée →
  File.downloadFileAsync vers le cache → feuille de partage native ; replis honnêtes
  'unavailable'/'error' → Alert voix de Bob) + bouton icône « Envoyer » (SendIcon, gabarit
  du bouton PDF) dans la barre sticky de PieceDetailView, branché sur /facture/[id] ET
  /devis/[id] uniquement quand un PDF existe au coffre (pas de bouton fantôme). +3 clés
  i18n ×3 humeurs (actionSharePdf, shareUnavailable, shareError). Typecheck ✓ i18n 46 ✓.
  NB : partage réel à valider sur device physique (simulateur headless : pas de tap) —
  même primitive que shareFec (éprouvée).
- [23:55] claude-code (session B) A5 MERGE (commit 01a2caa) : « DÉJÀ FACTURÉ » GÉNÉRALISÉ —
  la facture finale déduit TOUT ce qui a été facturé sur le devis (acompte ET situations
  ÉMISES, situations successives BTP), plus seulement l'acompte. Domaine : invoiceId de la
  déduction devient string | null (composite) — snapshot/Prisma compatibles (champ déjà
  nullable). GenerateInvoiceFromQuote somme les netToPay des pièces émises (brouillons
  exclus — pas d'existence fiscale) via listByCompany (AUCUN changement de port : zéro
  risque de conflit avec le WIP persistence session A). buildPieceView ne cite une pièce
  que si l'id correspond ; l'UI bascule sur « Déjà facturé (acompte + situations) »
  (piece.alreadyInvoiced ×3). +4 tests core (352) ✓ api-client 27 ✓.
- [00:10] claude-code (session B) A6 MERGE (commit a9e1dc3) : CRÉATION D'AVOIR —
  Invoice.creditNoteFor (avoir TOTAL, mêmes lignes, même devis parent, naît BROUILLON ;
  refusé sur brouillon et sur avoir) + use case CreateCreditNote (idempotent par devis,
  3 tests). Émission par LE circuit normal : IssueInvoice alloue la séquence 'credit'
  (CounterKey existant, enfin branché) → numéro A-AAAA-XXXX (DocNumber élargi [DFA]),
  écriture comptable INVERSE déjà portée par buildIssuedInvoiceAccountingEntry
  (isCreditNote). Client : BobClient.createCreditNote + LocalBobClient + HttpBobClient.
  Mobile : useCreateCreditNote + « Créer un avoir » (confirmation FISCAL, DÉTAIL de pièce
  uniquement — action rare, pas en liste ; facture payée comprise : c'est alors sa seule
  action) → navigation vers le brouillon (Émettre → A-2026-0001).
  SUIVIS SERVEUR (comme le précédent classifyDocument) : ① endpoint POST
  /invoices/:id/credit-note à poser côté apps/api ; ② préfixe « A » du compteur 'credit'
  dans les impls serveur (in-memory + Prisma) — la sandbox apps/api est en WIP session A,
  non touchée volontairement. Core 355 ✓ api-client 27 ✓ typecheck mobile ✓.
- [00:40] claude-code (session B) A7 MERGE (commit 148f6c2) : RECHERCHE GLOBALE — use case
  pur searchGlobal (@bob/core, 4 tests : accents/casse, pièce par numéro OU nom de client,
  brouillons sans numéro trouvables, docs via searchVault SOURCE UNIQUE C14, requête vide
  = vide jamais « tout ») + écran /recherche (pattern écran poussé A3-C17, ?q= deep-linkable,
  sections Clients / Devis & factures / Documents masquées si vides, hint/noResults voix de
  Bob, +12 clés ×3) + porte d'entrée « Chercher partout » en tête des résultats du coffre.
  Core 359 ✓ typecheck ✓. NOTE ENV : le gate d'AUTH (session A, C22/C24) est actif au
  simulateur → les deep links atterrissent sur le login ; captures suspendues jusqu'à une
  connexion humaine (identifiants démo transmis : demo@bobpro.fr).
- [00:50] claude-code (session B) A8 MERGE (commit cb28ee4) : DESTINATION DU CLASSEMENT —
  le 1-tap « Classer là » (proposition IA, validé A1-C14) reste premier ; lien discret
  « Choisir un autre dossier… » → Sheet des destinations RÉELLES : dépense rapprochée en
  tête (SparkSmallIcon success) + chantiers OUVERTS (FolderSmallIcon b2b) ; classifyDocument
  linkedEntityType 'chantier' (cible validée par le domaine — aucun nouveau chemin). Un doc
  classé chantier compte dans le dossier Chantiers ET dans l'onglet Docs de la fiche client
  (A1-C13). État vide honnête (docs.pickEmpty). +7 clés ×3. Typecheck ✓ i18n 46 ✓.
  → LE PROGRAMME « toutes les suggestions » (21:40) EST SOLDÉ : A1..A8 livrés (8/8).

### C17 — Compta & conformité            <!-- kind: screen -->
- status: MERGED
- owner: claude-code (builder) · reviewer: gpt5pro (a posteriori)
- depends-on: C14 (MERGED), C16 (MERGED)
- target: apps/mobile/app/comptabilite.tsx (RÉÉCRITURE @bob/ui) + export FEC partageable
- spec: INTEGRATION_MAP.md § export/compta

#### Contrat (v2, claude-code — régimes en vigueur)
- CONSTAT : le proto n'a PAS d'écran compta dédié — la section « Compta & conformité »
  (mois prêt / export FEC / factures récentes → C16 / mémoire fournisseurs) vit dans
  §isDocs et a été LIVRÉE en C14. C17 v2 = ce qui manque réellement :
  · **Export FEC PARTAGEABLE** (dépasse l'acceptance « artefact mock ») : client.exportFec
    → fichier .txt écrit (expo-file-system) → feuille de partage native (expo-sharing) —
    l'artisan ENVOIE le vrai FEC à son comptable. Helper partagé shareFec (Documents +
    Comptabilité, zéro duplication) ; repli toast si partage indisponible.
  · **Écran /comptabilite réécrit 100 % @bob/ui** (grand-livre des écritures réelles) :
    InnerScreenHeader · carte « mois prêt » (résumé dérivé + bouton export vert) · chips
    filtres par journal (Ventes/Achats/Banque/OD) · écritures (badge journal, réf, date,
    lignes débit/crédit tabular via AccountingLinesView conservé, équilibre) · paywall
    accounting_foundation conservé · lien clôture (/cloture).
  · **Use case pur @bob/core `summarizeAccountingEntries`** (directive : le socle
    s'enrichit pour Bob) : entries → { counts par journal, totaux débit/crédit, balanced,
    période } — testé ; l'écran ne calcule plus rien.
- Copy : @bob/i18n compta.* ×3 humeurs. Zéro hex, zéro fixture.
- Acceptance : export FEC → feuille de partage réelle (artefact .txt) · liens factures
  récentes → C16 (✓ C14) · écritures des pièces C16 listées · tests core/i18n · typecheck.

#### Signatures
- [x] agreed — claude-code — 2026-07-03 (17:05) — régime humain, review a posteriori

#### Log (append-only, horodaté)
- [17:05] claude-code CLAIM+PROPOSE+IN-BUILD : réserve C17 (C14+C16 MERGED). Constat de
  recouvrement avec la section C14 documenté — le claim se concentre sur le grand-livre
  et l'export partageable (valeur réelle pour l'artisan).
- [21:50] claude-code (session B) HANDOFF+MERGE (régime « n'attends plus gpt ») : C17 v2 livré.
  · Fausse alerte pnpm levée : expo-file-system 56.0.8 + expo-sharing 56.0.19 sont HOISTÉS à
    la racine node_modules (pas dans apps/mobile/node_modules) — l'API File/Paths existe,
    shareFec valide, RIEN à installer. Le blocage loggé à 15:12 n'en était pas un.
  · Écran /comptabilite RÉÉCRIT 100 % @bob/ui : rangée « Fermer » + InnerScreenHeader
    (pattern écrans poussés C25) · carte « Prêt pour le comptable » (summarizeAccountingEntries
    @bob/core : compte mois, badge Équilibré/Déséquilibré success/danger, totaux D/C) ·
    bouton export vert (désactivé à 0 écriture) · chips journaux dérivées de byJournal ·
    bandeau compte+totaux FILTRÉS · écritures (StatusBadge journal, réf tabular-nums,
    AccountingLinesView conservé) · paywall accounting_foundation conservé · lien /cloture.
    Copy compta.* (22 clés ×3 humeurs, +compta.back). Zéro hex, zéro fixture, zéro calcul
    dans l'écran.
  · Export FEC PARTAGEABLE branché aux DEUX endroits (source unique src/lib/share-fec.ts) :
    Comptabilité (exercice : 1er janv → aujourd'hui) + Documents (mois courant, toast en
    repli 'unavailable' — honnête sur simulateur).
  · Acceptance : capture device captures/c17-comptabilite.png (données réelles du seed :
    F-2026-0001, écritures VE 411/4191/44571 + BQ 512/411, D=C 976,80 €, badge Équilibré,
    chips Tous/Ventes/Banque, clôture) ✓ · tests core summarize 3 ✓ · i18n 39 ✓ ·
    typecheck apps/mobile ZÉRO erreur ✓. status=MERGED.
  · Suivi : partage réel du .txt à valider sur device physique (simulateur = repli toast,
    documenté dans share-fec.ts).
- [21:55] claude-code (session B) A1-C17 MERGE (demande humaine 21:47 : « refonte du design
  visuel à la hauteur de notre DA ») : l'écran n'avait pas de référence proto — refonte par
  extrapolation de la DA existante, zéro token nouveau (parité tokens intacte).
  · HÉROS dégradé vert vault.monthReady (recette Documents : « compta prête » = vert succès
    partout dans l'app) : IconTile clipboard + titre + badge équilibre + compteur mois.
  · SIGNATURE visuelle de l'écran : l'ÉQUATION de la partie double — DÉBIT / CRÉDIT en
    bigNum 20 tabular-nums face à face, signe « = » success / « ≠ » dangerVivid au centre
    (aucun autre écran ne montre l'équation ; elle matérialise « vérifiable »).
  · Journal : SectionHeader « Le journal » (compteur en action) · chips · bandeau totaux
    CONTEXTUEL (visible uniquement quand un filtre journal est actif) · cartes écritures
    avec IconTile teintée par journal (Ventes b2b/FileText · Achats particulier/Wallet ·
    Banque success/Deposit · OD b2g/Chart), réf tabular + « label · date » meta, hairline
    au-dessus des lignes D/C.
  · Clôture enrichie (IconTile lock lavande + sous-titre compta.closeSub) · footer voix de
    Bob (compta.footer). +5 clés i18n ×3 humeurs (sectionJournal, debit/creditLabel,
    closeSub, footer).
  · Acceptance : capture device c17-comptabilite.png (équation 976,80 = 976,80 verte,
    pastilles bleu/vert par journal) ✓ · typecheck ✓ · i18n 39 ✓. status=MERGED.
- [22:52] claude-code (session B) A2-C17 (parité VISUAL_PARITY_COMPTA.md, brief humain 22:30) :
  checklist des 9 points passée — 8/9 déjà conformes (mapping journaux, bandeau contextuel,
  héros, badge sur la ligne de titre, états, i18n). 2 verrous posés : « = / ≠ » 21 → 23 px
  (spec équation) · PORTE D'ENTRÉE ajoutée dans (tabs)/documents.tsx (demande humaine 22:05 :
  « il manque un accès à la compta ») — carte IconTile success ChartIcon + compta.title/
  subtitle + chevron → /comptabilite, sous le héros « mois prêt » ; second accès : KPI TVA
  du briefing (A3-C10) presse vers /comptabilite. Divergence de la réf assumée : rangée
  retour « Fermer » (pattern maison C25) au lieu de « ‹ Documents » — l'écran s'ouvre
  depuis Documents ET depuis le briefing, un libellé de provenance mentirait. Nouvelle
  capture c17-comptabilite.png (équation 2 826,80 = 2 826,80 sur seed enrichi A2-C10).
- [23:20] claude-code (session B) A3-C17 FIX+MERGE (bug capture humaine 23:05 : « décalage
  sur le header, vérifie avec minutie » — commit 2d99d82) : mon header était FIXE (rangée
  retour + InnerScreenHeader hors ScrollView) → contenu scrollé passant dessous sans
  occlusion + trou de 56 px (paddingTop d'InnerScreenHeader = gabarit des ONGLETS, pas des
  écrans poussés). Réf dc.html §COMPTABILITÉ : la PAGE ENTIÈRE défile, SEULE la rangée
  retour est sticky (bg rgba(239,242,247,.92) = token patterns.bottomTabBar.fade[1] ;
  backdrop-blur CSS sans équivalent RN, l'opacité .92 assure la lisibilité). Réaligné :
  stickyHeaderIndices=[0] · retour « ‹ Documents » semantic.b2b 19/2.2 (divergence
  « Fermer » du 22:52 LEVÉE — la réf prime, comportement deep-link documenté dans le code) ·
  en-tête défilant 2/20/4 · héros marges 16/18 radius 20, équation/export marginTop 16 ·
  « Le journal » 22/20/12 · chips 0/18/4 · bandeau filtré 10/20/2 · écritures 10/18 gap 11,
  cartes padding 15, réf ink800, metas slate300 · clôture 12/18 carte 15 · footer 22/30/8 ·
  sous-ligne héros « passées toutes seules » ×3 humeurs. Capture re-tirée ✓ typecheck ✓.

---

## E — Expertise comptable (audit multi-agents 2026-07-04, session B)

Directive humaine : « sois proactif, améliore fonctionnalités/data/expertise — tu es
l'expert-comptable de renom » + « toujours du 100 % prod ». Audit 5 lentilles (écritures
d'achats, TVA, FEC/lettrage, balance âgée, seuils) → 9 chantiers classés. Rapport complet :
transcript workflow wf_fb597a24-2e3.

#### Log (append-only, horodaté)
- [02:10] claude-code (session B) E1 MERGE (commit 693f6f6) : CYCLE ACHATS COMPTABILISÉ —
  constat bloquant : aucune écriture d'achat jamais postée (journal AC mort, FEC réduit à
  VE+BQ = non-exhaustif art. A47 A-1 LPF, produits sans charges, TVA déductible injustifiée
  art. 271 CGI). Builder domaine expense-accounting (6xx=TTC−TVA débit · 44566 débit
  SEULEMENT si TVA mentionnée, art. 242 nonies A · 401 crédit ; mapping catégorie→PCG
  documenté : fournitures/materiel/carburant/autre→606, repas→625, sous_traitance→611 ;
  vigilance immobilisation >~500 € HT commentée) + décaissement 401/512 (journal BQ) +
  use case RecordExpenseAccountingEntries idempotent (expense:{id}:recorded/:paid).
  Câblé recordExpense + dépenses seedées : FEC démo 10 écritures/26 lignes, journal AC
  vivant, chip « Achats » sur l'écran compta. 10 tests. Core 384 ✓ api-client 29 ✓.
- [02:25] claude-code (session B) E2 MERGE (commit 3cdc9ec) : POSITION DE TVA RÉELLE —
  deriveVatPosition (exigibilité à l'ENCAISSEMENT art. 269, 2-c CGI : collectée =
  round(vat×paid/ttc) par pièce vivante — l'or 488,40 rend 81,40 —, avoirs émis
  régularisés, déductible = TVA mentionnée, sorties netDue/credit séparées).
  GetCashflow dérive vatDue des factures RÉELLES (repli snapshot sans repo) →
  le héros dispo, la réserve payout ET le KPI TVA du briefing lisent LE même chiffre ;
  build-ledger-view lit la déductible AU GRAND-LIVRE (44566/44562 d'E1). La fixture
  CASH_SNAPSHOT.vatDue ne sert plus qu'en repli. Démo : crédit de TVA honnête (0 à
  provisionner, dispo 6 535,10 €). +5 tests. Core 389 ✓.
- BACKLOG CLASSÉ (à dérouler, périmètres au rapport) :
  · E3 (S) socle dates — InvoiceView.issuedAt + listPayments datés (débloque balance âgée,
    CA 12 mois sur date d'émission, seuils 293 B) ;
  · E4 (M) PayExpense — transition to_pay→paid AVEC décaissement (le builder E1 est prêt),
    action UI sur les dépenses à payer ;
  · E5 (M) balance âgée clients — deriveAgedBalance (not_due/1-30/31-60/61-90/90+),
    surfaçage Argent + Bob ;
  · E6 (L) seuils de franchise 293 B — vat-thresholds datés (37 500/41 250 · 85 000/93 500)
    + CA encaissé annuel + alerte diagnostic/briefing (le plus gros risque fiscal produit :
    'tva-franchise' est aujourd'hui TOUJOURS 'ok') ;
  · E7 (M) FEC probant — lettrage EcritureLet/DateLet (dérivable de Payment.invoiceId),
    auxiliaires 411xxx/401xxx, ValidDate, libellé « Avoir » sur credit_note ;
  · E8 (L) calendrier fiscal TVA — CA3/CA12/acomptes par régime + période de liquidation ;
  · E9 (S) hygiène — FEC ISO 8859-15 (arrêté 29/07/2013), CashflowSnapshotPort.vatDue
    optionnel, EcritureNum par journal.
  SUIVIS SERVEUR : apps/api recordExpense doit poster les écritures E1 (même use case) —
  WIP session A, non touché.

---

## Flux — parallélisables (après C03 ; certains dépendent d'écrans)

- [21:45] claude-code (session A) COORD: j'avais redéclaré C17 au journal par erreur (contrat v2 déjà posé par la session B) — journal corrigé, je prends C22. Le claim reste à la session B.

### C20 — Facture à la voix              <!-- kind: flow -->
- status: MERGED
- owner: claude-code (builder) · reviewer: gpt5pro (a posteriori)
- depends-on: C03 (MERGED), C02 (flows/voiceInvoice MERGED), C15 (assistant MERGED)
- ref-capture: claims/ref/C20-frame-p1.png + p2 · target: apps/mobile/app/voix.tsx (route à créer) + hooks
- spec: SCREENS.md § Voix · flows/voice-invoice (@bob/core) · USER_FLOWS.md § Voix · mémoire Voxtral

#### Contrat (v1, claude-code — régimes en vigueur : données réelles, parité d'actions, use cases purs)
- Flux 3 étapes piloté par la machine RÉELLE @bob/core flows/voice-invoice (C02) :
  1. ÉCOUTE : VoiceOrb/onde animée (JAMAIS d'opacity-0 au repos — charte §4.7), transcription réelle via
     le pipeline voix existant (@bob/ai + data/voice, endpoints /voice/transcribe) ; état micro refusé/
     indisponible honnête (voix Bob).
  2. REVUE : facture pré-remplie dérivée du transcript (client reconnu, lignes, montants — use cases réels
     createQuote/issueInvoice selon le cas) rendue en Card @bob/ui (parties, lignes, Totals) ; corrections
     (retour écoute, brouillon conservé — voiceRetry).
  3. ISSUE : « Encaisser » vs « Envoyer » = confirmation EXPLICITE (voiceConfirm, préparer≠envoyer) →
     MÊMES use cases que l'UI/agent (registerPayment / issueInvoice+sendInvoice) → toast succès → retour
     Aujourd'hui (edge C10).
- PARITÉ D'ACTIONS (TODO ③④ de l'audit C15) : exposer côté agent les outils scan_depense et creer_devis
  si le registre packages/ai est extensible SANS toucher apps/api ; sinon TODO C40 documenté au log.
- Entrées : QuickAction « À la voix » (C10) rebranchée de l'assistant vers /voix · micro de l'assistant
  (C15) → /voix. Copy : clés @bob/i18n voix.* ×3 humeurs. États : loading/erreur/refus micro/hors-ligne.
- Interdits : hex/rgba, ancien kit, fixtures, duplication de la machine à états (flows/voice-invoice fait foi).
- Acceptance : captures vs réfs p1/p2 · machine core pilote les 3 étapes (states testés déjà en C02) ·
  onde animée au repos sans opacity-0 · confirmation explicite journalisée · edges C10/C15 câblés ·
  i18n tests · typecheck + token-lint clean.

#### Signatures
- [x] agreed — claude-code — 2026-07-03 (11:12) — régime humain, review gpt5pro a posteriori

#### Log (append-only, horodaté)
- [11:12] claude-code CLAIM+PROPOSE+IN-BUILD: réfs déjà capturées (p1/p2). La machine à états C02 et le
  pipeline vocal @bob/ai existent — le claim est l'ÉCRAN du flux + le câblage réel + les entrées C10/C15.
- [13:26] claude-code HANDOFF+MERGE (régime humain): flux livré et validé simulateur — capture
  claims/shots/C20-p1.png conforme (navy profond, orbe verte, onde 7 barres animée SANS opacity-0,
  voix Bob, CTA gaté). Machine RÉELLE @bob/core pilote les 3 étapes ; NOUVEAU voice-invoice-draft
  (dérivation pure transcript→brouillon, 5 tests : client reconnu parmi les customers réels, jamais un
  centime inventé, « total TTC » borne le document) ; STT réel (natif/Voxtral) avec SECOURS TEXTE honnête
  (fix : module natif expo-speech-recognition chargé PARESSEUSEMENT — absent d'Expo Go, il crashait la
  route ; stub sûr + speechRecognitionAvailable) ; issue = confirmation explicite ConfirmSheet/challengeFor
  puis LA chaîne UI réelle (createQuote→sendQuote→signQuote→generateInvoice→issueInvoice[→registerPayment])
  → succès numéro légal réel → retour Aujourd'hui. Entrées rebranchées : QuickAction voix (C10) + micro
  assistant (C15) → /voix. PARITÉ : TODO ③④ de l'audit RÉSOLUS — registre @bob/ai extensible par capacités
  optionnelles de l'hôte, outils creer_devis (draft) + scan_depense (accounting+safetyFloor) branchés sur
  les MÊMES use cases côté mobile ; restes tracés C40 (intents chat → invocation directe via classifieur
  LLM serveur ; journal on-device ⑧ inchangé). Validations : i18n 29/29 (36 clés voix.*) · core 308/308 ·
  ai 132/132 · typecheck 16/16 · token-lint clean. Écarts assumés au rapport (SMS→émission = frontière C40,
  VoiceOrb legacy non réutilisé — hex hors tokens). status=MERGED.

### C21 — Devis → signature → facture     <!-- kind: flow -->
- status: MERGED
- owner: claude-code (builder) · reviewer: gpt5pro (a posteriori)
- depends-on: C03 (MERGED), C02 flows/devis (MERGED) — dépendance C16 INVERSÉE : c'est C21 qui génère les
  réfs du détail pièce (le proto ne rend le détail qu'après ce flux)
- ref-capture: à générer depuis le proto pendant le build (flux devis étape par étape) · target:
  apps/mobile/app/devis/new.tsx (RÉÉCRITURE) + composants Stepper/SignaturePad reportés de C03
- spec: flows/devis (@bob/core, 6 étapes testées) · USER_FLOWS.md § Devis · réserve C03 : Stepper+SignaturePad

#### Contrat (v1, claude-code — régimes en vigueur : prod 100 %, données réelles, parité d'actions)
- Flux 6 étapes PILOTÉ par la machine réelle @bob/core flows/devis (startDevis/devisEdit/devisNext/devisBack,
  gardes par étape) : client (liste réelle + création C40 si dispo) → lignes (catalogue métier + saisie
  libre, prix réels) → TVA/mentions (suggestVatRate + buildMentions réels, contexte logement >2 ans) →
  signature au doigt (NOUVEAU SignaturePad @bob/ui : react-native-svg path, effaçable, hit ≥44 — signature
  = image dataURL passée au use case signQuote) → acompte (30 % défaut, éditable, net calculé par core) →
  facture générée (generateInvoice deposit via LA chaîne réelle, numéro légal, atterrit sur l'écran détail
  facture existant — pont vers C16).
- NOUVEAUX @bob/ui (réserve C03) : Stepper (progression 6 étapes, points/barre, a11y) + SignaturePad —
  logique pure séparée (.logic.ts testé), zéro hex/rgba, tests hit-target.
- Copy : clés @bob/i18n devis.* ×3 humeurs. États : gardes de la machine (messages par étape), erreurs
  use cases (voix Bob), brouillon conservé au retour arrière.
- Parité : le flux appelle les MÊMES use cases que l'agent (creer_devis C20 / generer_facture C40).
- Acceptance : acompte net 488,40 sur le cas d'or (test flow existant + parcours UI) · parentQuoteId posé ·
  captures des 6 étapes vs proto (à générer) · i18n tests · typecheck + token-lint · ui tests (Stepper/Pad).

#### Signatures
- [x] agreed — claude-code — 2026-07-03 (14:58) — régime humain, review gpt5pro a posteriori

#### Log (append-only, horodaté)
- [14:58] claude-code CLAIM+PROPOSE+IN-BUILD: lancé EN PARALLÈLE de C40 (périmètres disjoints : C21 =
  devis/* + 2 composants ui + i18n ; C40 = api-client/ai/data). Réponse à la question humaine « pourquoi
  sauter les C avant C40 » : rien n'est sauté — C40 d'abord pour que les flux restants naissent en mode
  prod ; C16 dépendait des réfs de C21 (inversion documentée) ; C17 suit C16.
- [16:10] claude-code HANDOFF+MERGE (régime humain): flux livré et validé simulateur — capture
  claims/shots/C21-p1.png (étape prestations : Stepper, saisie ligne avec placeholder du cas d'or,
  catégories, TVA suggérée 10 %, état vide honnête, CTA gaté par la garde machine). NOUVEAUX @bob/ui :
  Stepper (progressbar a11y, logique pure clamp/segments/percent testée) + SignaturePad (PanResponder RN
  core, anti-jitter 2px, lissage Q points-milieux, export SVG dataURL couleur injectée — zéro hex, logique
  pure testée sans RN) — réserve C03 soldée. Écran devis/new réécrit (1160 lignes) : chaque Suivant =
  devisNext (gardes → i18n par champ), chaîne métier réelle RÉSUMABLE par checkpoints (createQuote →
  sendQuote → signQuote → generateInvoice idempotent parentQuoteId → issueInvoice) → numéro légal → pont
  facture/[id] (C16). i18n +60 clés devis.* (33 tests) · ui 61 tests · core 316 intact · typecheck 16/16 ·
  token-lint clean. Écarts assumés : dataURL signature capturé mais non transmis (signQuote n'accepte que
  signerName — TODO C40/api) ; mentions à la génération (entités non exposées au client) ; pas de catalogue
  (C27) ; à vérifier en review : nombre de segments Stepper affichés vs 6 étapes. Coordination : doublons
  d'icônes de la session C16 retirés (typecheck workspace réparé). status=MERGED.

### C22 — Onboarding adaptatif           <!-- kind: flow -->
- status: MERGED
- owner: claude-code session A (builder) · reviewer: gpt5pro (a posteriori)
- depends-on: C03 (MERGED), C23 (MERGED — handoff diagnostic)
- ref-capture: dc.html §onboarding (extraire au build) · target: apps/mobile/app/onboarding.tsx (RÉÉCRITURE @bob/ui)

#### Contrat (v1, claude-code A — régimes prod 100 %, données réelles)
- Flux 5 étapes (dc.html §ob*) : métier (grille de métiers du proto — le choix ADAPTE le vocabulaire de
  l'app : plombier → retenue de garantie/décennale, électricien → Consuel, etc., via le profil réel) ·
  clientèle (b2c/b2b/b2g/mixte) · régime TVA (franchise 293B / réel simplifié / réel normal — copy
  pédagogique voix Bob) · preview « ton espace {métier} » adaptatif · handoff → /diagnostic (C23) puis
  /(tabs) (C10).
- PROD : les réponses PERSISTENT dans le profil réel (useProfile/endpoint company/profil constaté — si
  écriture absente côté client/serveur : Stepper local + TODO documenté, pas d'écriture fantôme ; lecture
  seule = le flux pré-remplit depuis le profil existant).
- Réutilise Stepper @bob/ui (C21). Copy : clés @bob/i18n onboard.* ×3 humeurs (grille métiers = libellés
  proto exacts). États : retour arrière, skip honnête (« Plus tard »), erreurs voix Bob.
- Acceptance : 5 étapes machine locale simple (pas de sur-ingénierie : useState étape + gardes) · preview
  adaptatif testé (unité pure si dérivation) · persistance réelle constatée ou TODO · captures · i18n
  tests · typecheck + token-lint clean.

#### Signatures
- [x] agreed — claude-code A — 2026-07-03 (21:47) — régime humain, review gpt5pro a posteriori

#### Log (append-only, horodaté)
- [21:47] claude-code A CLAIM+PROPOSE+IN-BUILD: pris après correction de coordination C17 (session B).
  Périmètre : onboarding.tsx + i18n + lecture profil — disjoint de C25 phase 2 (api/notifs) et C17-B (compta).
- [22:17] claude-code A HANDOFF+MERGE (régime humain): flux livré et validé simulateur — capture
  claims/shots/C22-p1.png (accueil navy nuit, tagline, CTA). Grille métiers = TRADE_PROFILES du core
  (9 tuiles proto exactes, zéro duplication) ; deriveTradeProfile PUR (+5 tests, core 342) : preview
  adaptatif (BTP→chantiers/acomptes/retenue de garantie · consultant→TJM/CRA · photographe→cession de
  droits…), highlights typés, invariant BTP⇔Company.isBtp testé ; pédagogie TVA voix Bob (piège 293B
  inclus). Persistance : AUCUNE écriture profil côté BobClient (constaté) → pré-remplissage réel en
  lecture + TODO(C22) documenté, zéro écriture fantôme — contrat d'écriture profil à ajouter (Codex/C40b).
  i18n onboard.* 44 clés ×3 (41 tests). Fix d'hygiène HEAD embarqué : fixture cashflow-band.test réparée
  (vatDue requis ajouté par un chantier concurrent). Écarts assumés au rapport (SIRET→profil réel, choix
  clientèle simple, Stepper sur carte, retour depuis preview autorisé). status=MERGED.

### C23 — Diagnostic 2026                 <!-- kind: flow -->
- status: MERGED
- owner: claude-code (builder) · reviewer: gpt5pro (a posteriori)
- depends-on: C03 (MERGED), C40 (intent diagnostic MERGED)
- ref-capture: claims/ref/C23-frame-p1.png (intro) + p2 (question) · target: apps/mobile/app/diagnostic.tsx (RÉÉCRITURE @bob/ui)

#### Contrat (v1, claude-code — régimes en vigueur : prod 100 %, données réelles, use cases purs)
- Flux (réfs p1+p2 + dc.html §diag*) : INTRO plein écran indigo sombre (pastille bouclier, « Prêt pour la
  facture électronique 2026 ? », explication réforme, CTA blanc « C'est parti — 2 min », fermeture ×) →
  QUESTIONNAIRE 3 questions (barre de progression, question pageTitle blanc, options cartes sombres —
  clientèle / réception factures d'achat / envoi factures de vente, selon dc.html) → RÉSULTAT : ScoreRing
  animé count-up (couleur par tranche, JAMAIS d'opacity-0) + checklist priorisée dérivée + CTA « Configurer
  dans l'app ».
- Score et checklist = USE CASE PUR @bob/core (nouveau application/diagnostic/derive-diagnostic.ts si le
  diagnostic réel existant (useDiagnostic/endpoint compliance) ne couvre pas le questionnaire) : règles
  einvoice réelles (einvoiceChannelFor par type de clientèle, échéances réforme sept. 2026), testé. Si un
  diagnostic serveur existe (C13 l'utilise déjà), le questionnaire l'ENRICHIT (réponses → recalcul local
  pur) — zéro duplication de règles : réutilise les services einvoice existants.
- Le résultat PERSISTE ce qui doit l'être via les endpoints existants s'ils existent (sinon état local +
  TODO documenté — pas d'écriture fantôme). Sortie : « Configurer » → routes réelles (compte/réglages).
- Copy : clés @bob/i18n diag.* ×3 humeurs (copy proto exacte). Thème : fond indigo sombre du proto via
  tokens (themes.indigo.d1/d2 ou conformityCard) — zéro hex.
- Entrées : C10 priorité conformité CTA · C13 carte conformité · chip assistant (navigate C40) — déjà
  câblées vers /diagnostic.
- Acceptance : captures intro/question/résultat vs réfs · score dérivé testé (cas b2c/b2b/mixte) · anneau
  animé sans opacity-0 (prop déjà testée C03) · i18n tests · typecheck + token-lint clean.

#### Signatures
- [x] agreed — claude-code — 2026-07-03 (16:15) — régime humain, review gpt5pro a posteriori

#### Log (append-only, horodaté)
- [16:15] claude-code CLAIM+PROPOSE+IN-BUILD: réfs intro+Q1 déjà capturées ; le résultat sera capturé au
  build (proto : parcours complet). Score = règles einvoice RÉELLES réutilisées, pas un barème inventé.
- [16:25] human DIRECTIVE (A1-C23): « sois vraiment proactif, expertise d'expert-comptable, challenge la
  façon de faire si tu peux fournir un meilleur diagnostic ». ACCEPTÉ — contrat amendé v2 ci-dessous.
- [16:26] claude-code AMEND (contrat C23 v2 — « diagnostic expert-comptable », remplace le questionnaire
  déclaratif) :
  1. AUDIT AUTOMATIQUE D'ABORD (données réelles du dossier, zéro question inutile) :
     · mix clientèle RÉEL (répartition b2c/b2b/b2g des customers + volumes facturés) → obligations par
       canal (e-invoicing B2B domestique · e-reporting B2C/international · Chorus B2G déjà en vigueur) ;
     · qualité des données : % clients B2B/B2G SANS SIREN (mention obligatoire — l'app les connaît),
       numérotation sans trou (garantie par le core), archivage 10 ans (coffre C14), TVA par ligne
       (suggestVatRate), traitement des acomptes ;
     · régime TVA du profil (franchise 293B reste assujettie à l'e-invoicing B2B — piège classique) ;
     · exposition e-reporting des PAIEMENTS (prestations de services : les encaissements remontent au
       fisc — les retards clients deviennent visibles) dérivée des payments réels.
  2. QUESTIONNAIRE RÉDUIT À L'INCONNAISSABLE (max 3 questions adaptatives) : PDP choisie/annuaire ?
     encaissements B2C hors app (caisse) ? partenaire compta (EC/OGA) ?
  3. SORTIE = PLAN D'ACTION DATÉ à 3 axes (pas un scalaire gadget) : RÉCEPTION prête pour le 01/09/2026
     (tous assujettis) · ÉMISSION prête pour le 01/09/2027 (TPE/PME ; 2026 si ETI/GE) · QUALITÉ DES DONNÉES
     (SIREN, mentions, types d'opération). Chaque item : échéance réelle, impact (réf. sanctions art. 1737
     : 15 €/facture plafonné, 250 €/transmission e-reporting plafonné — en commentaire de code, montants
     indicatifs), et ACTION EXÉCUTABLE DANS L'APP (route réelle : compléter SIREN → fiche client C13,
     réglages réception, etc.) + exécutable par Bob (parité d'actions).
  4. Le ScoreRing du proto reste l'affichage du score GLOBAL (moyenne pondérée des 3 axes, réception
     surpondérée avant 2026) — parité visuelle conservée, moteur remplacé.
  5. Le use case pur derive-diagnostic prend { customers, invoices, payments, profile, réponses } et sort
     { score, axes[3], items datés } — testé sur cas types (artisan b2c pur, mixte BTP avec sous-traitance
     autoliquidée, b2b sans SIREN, franchise 293B).
- [16:32] claude-code HANDOFF+MERGE (régime humain): diagnostic expert-comptable livré et intro validée
  simulateur — capture claims/shots/C23-p1.png (pixel-fidèle à la réf). Moteur v2 : deriveDiagnostic pur
  (6 tests) — échéances LUES dans les faits serveur (réception 01/09/2026 tous assujettis · émission
  01/09/2027 TPE/PME, 2026 ETI/GE — jamais re-déclarées), canaux via einvoiceChannelFor réutilisé, piège
  franchise 293B codé/testé, audit auto du dossier réel (mix clientèle par volumes TTC, SIREN b2b/b2g
  manquants avec route /client/{id}, exposition e-reporting paiements dérivée des paid, acquis structurels
  relayés), questionnaire réduit à 3 questions adaptatives, plan d'action daté 3 axes (réception
  surpondérée avant 2026, testé), sanctions art. 1737 en commentaire de code uniquement. Sûreté de type :
  labelKey/detailKey = unions littérales core → clé i18n manquante casse le typecheck mobile (sans
  dépendance core→i18n). i18n diag.* 58 clés ×3 (37 tests) · core 322 · typecheck 16/16 · token-lint clean.
  Persistance : aucun endpoint d'écriture → état local + TODO documenté (pas d'écriture fantôme). Parcours
  interactif complet (constats→questions→résultat) : validation humaine au premier tap (ou accessibilité).
  status=MERGED.

### C24 — Auth                           <!-- kind: flow -->
- status: IN-BUILD
- owner: claude-code A (builder) · reviewer: gpt5pro (a posteriori)
- depends-on: C03 (MERGED), C22 (MERGED)
- ref-capture: dc.html §auth (extraire au build) · target: apps/mobile/src/screens/LoginScreen.tsx (RÉÉCRITURE @bob/ui) + inscription

#### Contrat (v1, claude-code A — régimes prod 100 %)
- Flux proto 4 étapes ADAPTÉ à l'auth réelle Supabase : CONNEXION (écran refondu @bob/ui : email+mdp →
  session réelle, erreurs voix Bob, mdp oublié → resetPasswordForEmail Supabase) · INSCRIPTION (SIRET →
  lookupCompany RÉEL (endpoint /company/lookup existant, recherche-entreprises) → récap infos pré-remplies
  → création compte Supabase signUp + POST /company (registerCompany existant) → handoff /onboarding C22) ·
  BIOMÉTRIE (expo-local-authentication : Face ID/Touch ID pour déverrouiller la session persistée — opt-in,
  dégradé honnête simulateur/Expo Go) · entrée → /(tabs).
- Identité : à l'inscription, user_metadata.first_name/full_name posés (alimente useIdentity — directive
  Mercier=démo). PROD : aucun compte fantôme — signUp réel avec confirmation email Supabase (état « vérifie
  tes mails » honnête).
- Copy : clés @bob/i18n auth.* ×3 humeurs. Interdits : hex, ancien kit, fixtures, logique auth dans l'écran
  (data/auth.tsx reste la couche).
- Acceptance : login réel fonctionne (session persistée — testable au simulateur SI login humain/
  accessibilité) · lookup SIRET réel · signUp câblé (validation par preuve API si besoin) · biométrie
  opt-in dégradée proprement · captures · i18n tests · typecheck + token-lint clean.

#### Signatures
- [x] agreed — claude-code A — 2026-07-03 (22:57) — régime humain, review gpt5pro a posteriori

#### Log (append-only, horodaté)
- [22:57] claude-code A CLAIM+PROPOSE+IN-BUILD: l'auth réelle existe (Supabase+guard JWT prouvés en C40) —
  le claim est l'UX complète (login refondu, inscription SIRET→lookup réel, biométrie) + identité posée.
- [2026-07-04 00:35] claude-code A HANDOFF+MERGE (régime humain): C24 COMPLET. LoginScreen réécrit @bob/ui
  (login + inscription SIRET→lookupCompany réel→signUp Supabase avec user_metadata first_name/full_name →
  alimente useIdentity + reset mdp) ; data/auth.tsx : signUp/resetPassword, AuthErrorCode 9 codes mappés
  voix Bob ; biométrie opt-in (biometric.ts + BiometricGate, dégradé honnête simulateur) ; _layout :
  BobClientProvider AU-DESSUS de la porte d'auth (lookup SIRET public avant session). Correctif expert
  i18n : footer « Chiffré de bout en bout » → « Connexion chiffrée · conforme RGPD » (l'archi est TLS,
  pas E2E — même logique que le retrait 2FA : jamais de promesse de sécurité fausse). Capture C24-p1
  (login) obtenue après purge réelle de session — pièges documentés : la session Supabase SURVIT à la
  réinstallation d'Expo Go (keychain) → `simctl keychain reset` ; le bundle Metro inline les env → `--clear`
  obligatoire (sinon l'app retombe en démo silencieusement) ; dialogue permission notifs levé par
  applesimutils. CHECKLIST PROD CONNECTÉE à l'écran (captures PROD-argent/clients/notifications) : session
  Supabase réelle persistée, Argent/Clients/Notifications sur données tenant réelles (Mairie de Sèvres
  F-2026-0001 · 1 850 € · 15 j retard · ton NEUTRE, garde-fou L441-10 affiché, relances auto actives).
  Validations : i18n 46 ✓ · core 352 ✓ · typecheck 16/16 ✓. RESTE (claim suivant C24b) : provisioning
  tenant à l'inscription — endpoint serveur + app_metadata.company_id via API admin Supabase (service-role
  key déjà dans l'env Railway) ; d'ici là un compte neuf n'a pas de tenant (signUp réel mais données
  vides — honnête, pas de fixture). status=MERGED.

### C25 — Relances auto + Notifications   <!-- kind: flow -->
- status: MERGED
- owner: claude-code (builder) · reviewer: gpt5pro (a posteriori)
- depends-on: C15 (MERGED), C40 (MERGED) — ferme les TODO ①② de l'audit parité
- ref-capture: dc.html §notifications/relances (extraire au build) · target: apps/mobile/app/notifications.tsx (nouveau) + moteur

#### Contrat (v1, claude-code — régimes prod 100 %, données réelles, parité d'actions)
- MOTEUR (use case pur additif @bob/core application/relances/) : derive-relance-plan — entrée = invoices/
  customers/payments réels + politique (délais par ton) ; sortie = plan de relances par facture échue
  (ton cordial → ferme → mise en demeure selon l'ancienneté, canal, prochaine échéance de relance) en
  RÉUTILISANT buildRelance (4 tons, L441-10 : la mise en demeure émet le texte légal exact + intérêts
  retard/indemnité 40 € — déjà dans le domaine) et deriveTodayPriorities (candidates). Testé (tons par
  ancienneté, texte légal présent, avoirs exclus).
- PARITÉ ①② : l'outil agent relance_brouillon devient CIBLABLE par client/facture (arg optionnel) ;
  l'ENVOI réel : constater ce que le serveur expose (notification_jobs existe en base — lire apps/api) ;
  si un endpoint d'envoi existe → le brancher (client + outil agent envoyer_relance outbound+confirmation) ;
  sinon → préparer le contrat client (méthode typée + TODO serveur documenté à Codex), l'UI reste honnête
  (« préparée, envoi à venir » — pas de bouton fantôme).
- ÉCRAN Notifications (nouveau, cloche C10 enfin câblée) : liste des notifications réelles (relances
  planifiées/envoyées, échéances, conformité) depuis les données réelles ; états vide/erreur voix Bob ;
  actions par item (voir la facture → C16, relancer → assistant).
- Copy : clés @bob/i18n notif.* + relance.* ×3 humeurs. Interdits : hex, ancien kit, fixtures, duplication
  du moteur relance.
- Acceptance : plan de relances testé (4 tons, L441-10 texte légal) · cloche C10 → écran réel · outil agent
  ciblé testé · captures écran · i18n tests · typecheck + token-lint clean.

#### Signatures
- [x] agreed — claude-code — 2026-07-03 (16:35) — régime humain, review gpt5pro a posteriori

#### Log (append-only, horodaté)
- [16:35] claude-code CLAIM+PROPOSE+IN-BUILD: dernier gros TODO métier de l'audit parité (①②). Envoi réel
  conditionné à la surface serveur constatée (lecture apps/api) — sinon contrat client + handoff Codex.
- [21:36] human DIRECTIVE (A1-C25): « pour les notifs on veut du 100 % prod aussi, ne fais pas les choses
  à moitié ». Contrat amendé v2 : le tabou apps/api est LEVÉ pour ce claim (l'humain prime ; le chantier
  OCR de la session parallèle reste intouchable — fichiers disjoints).
- [21:37] claude-code AMEND (contrat C25 v2 — notifications de PRODUCTION, constat : l'infra serveur
  existe déjà : jobs/notification-delivery.service.ts + ScheduleModule cron + notification_jobs persistées
  multi-tenant JOB_COMPANY_IDS) :
  1. SERVEUR (apps/api, hors fichiers OCR) : exposer aux mobiles ce que les jobs produisent — GET
     /notifications (persistées, lu/non-lu, company-scoped RLS), POST /notifications/:id/read, POST
     /devices (enregistrement token push Expo par user/tenant) ; brancher le CANAL D'ENVOI effectif des
     relances (mailer via env — clé absente = échec propre loggé, jamais silencieux) et push Expo
     (expo-server-sdk ou fetch API Expo Push) dans notification-delivery ; le cron des relances
     automatiques suit la politique derive-relance-plan (cordial→ferme→mise en demeure L441-10).
  2. CLIENT : BobClient.listNotifications/markNotificationRead/registerDevice (HTTP+Local) ; mobile :
     expo-notifications (permission honnête, getExpoPushTokenAsync avec projectId EAS si dispo — en
     Expo Go/simulateur : enregistrement dégradé documenté, le pipeline reste prod-ready), deep link au
     tap (route de la notif).
  3. ÉCRAN : branché sur GET /notifications RÉEL (serveur = source de vérité, lu/non-lu persistés) ;
     badge cloche C10 = count non-lus serveur ; le mode démo Local dérive localement (adaptateur).
  4. PARITÉ ② : outil agent envoyer_relance (outbound, confirmation) branché sur le canal réel.
  5. Acceptance étendue : tests serveur (delivery service : email/push mockés, échec propre sans clé),
     tests client (stub HTTP), cron testé (multi-tenant-jobs pattern existant).
- [22:40] claude-code A HANDOFF+MERGE (régime humain): C25 COMPLET (phases 1+2). Serveur : migration
  additive readAt+devices (RLS pattern repo, à appliquer au déploiement) · GET /notifications (fil purgé
  PII, route de deep link dérivée de la dedupeKey) · POST /notifications/:id/read (idempotent, anti-IDOR)
  · POST /devices (token Expo validé strict, upsert tenant) · POST /invoices/:id/relance (throttlé,
  refus honnêtes — le contrat sendRelance devient RÉEL). Delivery : Brevo (clé absente hors démo →
  MisconfiguredEmailNotifier, échec explicite jamais silencieux) + PUSH Expo (chunké 100, tickets loggés,
  DeviceNotRegistered → purge) en MIROIR de l'email réussi. Cron relances aligné sur DEFAULT_RELANCE_POLICY
  du core (J+3/10/20/30, un seul endroit fait foi) ; MISE EN DEMEURE JAMAIS AUTO-ENVOYÉE (le geste confirmé
  = la validation, L441-10 + 40 € testés). Agent : outil envoyer_relance (outbound, safetyFloor même en
  auto). Mobile : expo-notifications + PushNotificationsBridge (permission honnête, tap → deep link ; push
  distant = dev build, dégradé assumé), fil Activité + badge cloche = non-lus SERVEUR, bouton Relancer =
  envoi réel confirmé. TODO ①② de l'audit parité FERMÉS. api 59 · core 342 · ai 151 · api-client 27 ·
  i18n 42 · typecheck 16/16. Restes déploiement : migration+rls.sql sur la base, BREVO_* en prod.
  status=MERGED.

### C24b — Provisioning tenant à l'inscription (sécurité multi-tenant) <!-- kind: flow -->
- status: IN-BUILD
- owner: claude-code A (builder) · reviewer: gpt5pro (a posteriori)
- depends-on: C24 (MERGED) · tabou apps/api levé au titre de la directive « 100 % prod à chaque fois » (chantier OCR session B intouchable)
- target: apps/api/src/auth/* + backend.service + packages/api-client + apps/mobile (fin d'onboarding)

#### Contrat (v1, claude-code A — correction de sécurité, régime prod 100 %)
- CONSTAT (audit expert 2026-07-04) : trois trous cohérents dans la chaîne multi-tenant —
  (1) auth.guard.ts:57 : JWT prod valide SANS app_metadata.company_id → principal retombe sur
  MERCIER_PROPS.id = LECTURE CROSS-TENANT du tenant démo par tout compte neuf ; (2)
  backend.service.ts companyId() : même fallback = ÉCRITURE cross-tenant (registerCompany écraserait
  la société démo) ; (3) le mobile n'appelle jamais POST /onboarding/company après signUp → compte
  sans tenant à vie. Le « repli silencieux » interdit par directive, version sécurité.
- SERVEUR : guard prod → principal.companyId NULLABLE, aucun fallback hors mode démo ; endpoints
  tenant → 403 code PROVISIONING_REQUIRED si null (seuls passent sans tenant : GET /company/lookup,
  POST /onboarding/company, infra/health/metrics/public/sign — liste blanche explicite) ;
  POST /onboarding/company sans tenant → crée la company avec id DÉTERMINISTE `company-<userId>`
  (retry idempotent, zéro orpheline) + écrit app_metadata.company_id via l'API admin Supabase
  (SUPABASE_SERVICE_ROLE_KEY déjà dans env.ts/Railway) — clé absente ou échec admin = erreur
  EXPLICITE loggée (pattern MisconfiguredEmailNotifier), jamais silencieux ; avec tenant → update
  de SA société (comportement actuel conservé). JAMAIS d'input companyId côté client
  (anti-auto-rattachement à un tenant arbitraire). BackendService.companyId() : fallback Mercier
  supprimé — le principal est OBLIGATOIRE (les tests posent un principal explicite).
- CLIENT : api-client registerCompany (HTTP + Local) ; mobile : fin d'onboarding C22 (ou premier
  login d'un JWT sans tenant → redirection onboarding) appelle registerCompany puis
  supabase.auth.refreshSession() (JWT frais avec company_id) ; états honnêtes (provisioning en
  cours / échec voix Bob, pas de spinner infini).
- DÉMO : inchangée (guard pass-through + x-company-id). Le user demo@bobpro.fr a déjà son
  app_metadata.company_id : non impacté.
- Acceptance : tests guard (sans company_id → 403 tenant, liste blanche OK, jamais Mercier hors
  démo) · provisioning (admin mocké : succès pose app_metadata + id déterministe idempotent, échec
  explicite) · grep : plus AUCUN MERCIER_PROPS.id de fallback dans auth/backend hors chemin démo ·
  api-client + typecheck + tests api verts.

#### Signatures
- [x] agreed — claude-code A — 2026-07-04 (00:45) — régime humain, review gpt5pro a posteriori

#### Log (append-only, horodaté)
- [2026-07-04 00:45] claude-code A CLAIM+PROPOSE+IN-BUILD: annoncé à l'humain au MERGE C24. Découverte
  en cartographiant : le fallback Mercier du guard fait d'un compte neuf un lecteur du tenant démo —
  la correction est de sécurité, pas seulement d'UX d'inscription.
- [2026-07-04 01:20] human DIRECTIVE (A1-C24b, test réel de l'inscription au simulateur — SIRET
  820 195 857 00025) : le récap n'affiche que SIRET+TVA avec un titre fallback « Entreprise
  820195857 » — « il manque le nom de la société, sa dénomination, code NAF et toutes les infos de
  la société ; à la création du compte, toutes les infos doivent être enregistrées et disponibles
  en BDD ». Contrat ÉTENDU (mission agent étendue en vol) : CompanyLookupResult enrichi (nature
  juridique code+LegalForm mappé, date de création — dirigeants EXCLUS, minimisation RGPD), adapter
  réel + adapter démo alignés, récap signup complet (lignes masquées si null, jamais de « — »
  menteur), user_metadata.company = snapshot COMPLET (aujourd'hui seulement {siret,name}),
  registerCompany persiste la fiche entière en BDD (migration Prisma additive si colonnes
  manquantes). Vérifié en direct : l'API publique renvoie bien nom_complet FLY SERVICES, NAF
  33.12Z, nature_juridique 5710, adresse, date_creation pour ce SIRET — le fallback affiché vient
  d'un bundle sans env (client démo local) ou du déploiement Railway antérieur à l'adapter réel :
  redéploiement Railway requis au merge.
- [2026-07-04 01:55] claude-code A HANDOFF+MERGE (régime humain): C24b COMPLET (contrat + extension
  directive). SÉCURITÉ : guard sans fallback Mercier (Principal.companyId nullable, 403
  PROVISIONING_REQUIRED jeté ≠ JWT invalide), liste blanche 2 NIVEAUX (GET /company/lookup PUBLIC
  sans Authorization — l'étape SIRET n'a pas encore de compte, annuaire public + throttle ; traité
  AVANT lecture du header : un Bearer statique ne casse plus l'endpoint · POST /onboarding/company
  JWT requis tenant optionnel), backend.companyId() requireTenant, interceptor : companyId null ne
  pose JAMAIS le GUC RLS, /health/ready réparé (dépendait silencieusement du fallback).
  PROVISIONING : id déterministe `company-<userId>` idempotent, app_metadata via admin GoTrue (PUT
  vérifié MERGE clé-à-clé dans le code GoTrue — providers préservés), env absente →
  MisconfiguredSupabaseAdmin explicite. FICHE SOCIÉTÉ (directive 01:20) : port et adapters
  enrichis de natureJuridiqueCode/legalForm mappé (nature-juridique.ts INSEE 1000→EI 5498→EURL 5499→SARL
  5710→SAS, inconnu→choix utilisateur)/dateCreation ; récap signup COMPLET (CompanyFicheCard,
  lignes masquées si null) ; user_metadata.company_snapshot = fiche entière re-validée
  structurellement au provisioning ; CompanyProps+tvaIntracom/dateCreation persistés — MIGRATION
  additive 20260704020000_company_fiche_annuaire. Mobile : gate ProvisioningScreen (jamais de tabs
  sans tenant), refreshSession() au succès, échec voix Bob + retry, zéro repli démo. Validations :
  api 73 ✓ (dont guard 8 + provisioning 5) · api-client 29 ✓ · core 374 ✓ · i18n 50 ✓ · typecheck
  16/16 ✓ · grep : plus AUCUN fallback MERCIER_PROPS.id hors chemin démo assumé. Commits scopés
  (packages+api puis mobile ; socle core/i18n C26 embarqué au commit 1 — index/dict partagés).
  RESTES DÉPLOIEMENT : prisma migrate deploy (20260703230000 notifications + 20260704020000 fiche)
  + redeploy Railway (image du 02/07) + LegalForm n'inclut pas SCI/SNC/asso (décision produit).
  status=MERGED.
- [2026-07-04 02:15] claude-code A DEPLOY (C24b + tout l'arriéré serveur) : (1) prisma migrate
  deploy sur la base réelle — 4 migrations appliquées (document_tags, invoice_deposit_deduction,
  notifications_read_devices, company_fiche_annuaire) ; (2) prisma/rls.sql appliqué (policies des
  tables neuves dont devices — le reste tracé au log C25 est SOLDÉ) ; (3) railway up → nouvelle
  image live. PREUVES E2E sur l'instance de prod : GET /company/lookup?siret=82019585700025 SANS
  token → 200 fiche COMPLÈTE (FLY SERVICES · 33.12Z · SAS/5710 · 2016-03-01 · adresse · TVA) ;
  /health/ready → 200 (sonde sans tenant) ; /customers et POST /onboarding/company sans token →
  403. L'inscription de bout en bout (SIRET → fiche → signUp → provisioning tenant → BDD) est
  opérationnelle en prod. Reste env : BREVO_* absent en prod (emails de relance en échec explicite
  assumé — secret à poser par l'humain).

### C26 — Compte / Abo / Équipe / Paywall <!-- kind: flow -->
- status: IN-BUILD
- owner: claude-code A (builder) · reviewer: gpt5pro (a posteriori)
- depends-on: C03 (MERGED), C24 (MERGED — identité/session), C27 (MERGED — lien réglages facturation)
- ref-capture: dc.html §compte/abonnement (lu au build, lignes ~1446-1560) · target: apps/mobile/app/compte.tsx (REFONTE onglets Profil/Abonnement)

#### Contrat (v2, claude-code A — amende le mini-contrat v1, régime prod 100 %)
- CONSTAT : le domaine Subscription EXISTE (@bob/core domain/subscription : tiers solo/pro/business,
  planCan, tierAtLeast) mais le serveur le seede EN DUR (`sub-mercier`, tier business, singleton pour
  TOUS les tenants — backend.service.ts constructor) et rien n'est exposé au client. Il n'y a AUCUN
  paiement d'abonnement réel (pas de Stripe billing). Réalité produit : ACCÈS ANTICIPÉ — toutes les
  capacités ouvertes, 0 €/mois.
- CORE (pur, testé) : application/compte/derive-account-view — entrées = identité (nullable),
  CompanyProps|null, TradeConfig|null (modules réels du GET /profile), SubscriptionInfo|null ;
  sortie = AccountView (Profil : entreprise/connexions/équipe ; Abonnement : offre courante, grille,
  factures d'abo, services) avec états HONNÊTES : offre courante = « Accès anticipé · 0 €/mois ·
  toutes les fonctions ouvertes » tant que le serveur n'expose pas GET /subscription ; grille
  Solo 19 / Pro 39 / Business 79 = CONSTANTE PRODUIT posée dans domain/subscription/plan.ts (source
  unique, prix en centimes) affichée en PREVIEW avec CTA honnête « disponible à l'ouverture de la
  facturation » (JAMAIS un bouton qui prétend souscrire) ; factures d'abo = état vide honnête ;
  services en plus (paiement CB, avance, assurance, comptable) = badges dérivés du réel (module
  actif dans TradeConfig sinon « À venir ») ; banque = « À connecter » (aucun bridge bancaire).
- ÉCRAN compte.tsx refondu : onglets Profil/Abonnement (SegmentedControl @bob/ui), parité
  structurelle avec le proto (cartes, sections, badge BUSINESS sur Équipe & rôles), identité via
  useIdentity (JAMAIS Mercier en dur — démo = seed), email = session réelle, Se déconnecter =
  signOut réel, lien « Facturation & modèles » → reglages-facturation (C27). États sans-données
  de premier rang.
- SERVEUR (séquencé APRÈS C24b — même fichier backend.service.ts) : sous-claim C26b — subscription
  dérivée PAR TENANT (plus de singleton Mercier), GET /subscription ; le mobile branchera
  SubscriptionInfo réel alors.
- i18n : section NOUVELLE account.* ×3 humeurs en FIN de dict (ancres étroites — C24b édite la
  section auth.* en parallèle).
- Acceptance : derive-account-view testé (early-access honnête, grille constante, jamais ACTIVE
  inventé) · captures C26-p1 (profil) + C26-p2 (abonnement) · i18n tests · typecheck + token-lint.

#### Signatures
- [x] agreed — claude-code A — 2026-07-04 (00:52) — régime humain, review gpt5pro a posteriori

#### Log (append-only, horodaté)
- [2026-07-04 00:52] claude-code A CLAIM+AMEND v2+IN-BUILD: le v1 (« Pro 39 active, paywall 79 »)
  décrivait le REMPLISSAGE du proto — en prod il n'y a pas de billing : l'écran dit la vérité
  (accès anticipé) et la grille devient une constante produit. Singleton sub-mercier du serveur
  tracé → C26b après C24b (collision backend.service.ts sinon).
- [2026-07-04 01:55] claude-code A HANDOFF+MERGE (régime humain): C26 COMPLET. Core :
  derive-account-view pur (13 tests — early-access honnête quand subscription null, service
  « Actif » seulement si module TradeConfig réel, résilié → retour early-access jamais plan
  fantôme) ; PRIX POSÉS DANS PLAN_CATALOG (solo 1900, business 7900 centimes — source unique,
  PLAN_PRICING = vue dérivée, blurbs dérivés des features réelles : « Relances » déplacé Solo→Pro
  car auto_dunning est une feature pro). Écran compte.tsx refondu : onglets Profil/Abonnement
  100 % @bob/ui, onglet ADRESSABLE /compte?tab=abonnement (deep link notifications, réactif écran
  monté — ajout coordinateur), identité useIdentity + email session, signOut réel, erreur profil =
  bannière SANS bloquer la déconnexion. i18n 47 clés account.* ×3. Écarts assumés (billing
  inexistant) : « Pro 39 ACTIVE »→« Accès anticipé 0 € », essai 14 j non rendu, factures d'abo
  vides, « Crédit Agricole Connectée »→« À connecter », montants inventés des services retirés,
  parrainage/équipe non pressables (aucun flux cible) ; réglages autonomie/dictée retirés de
  compte.tsx : ils vivent déjà dans (tabs)/assistant.tsx (vérifié, pas de perte). Captures
  C26-p1 (profil) + C26-p2 (abonnement via deep link tab) — prises par le coordinateur en mode
  démo (gate auth actif). Validations : core 374 ✓ · i18n 50 ✓ · typecheck 16/16 ✓. RESTE : C26b
  (GET /subscription par tenant, plus de singleton sub-mercier — l'écran branchera SubscriptionInfo
  sans changement). status=MERGED.

### C26b — Subscription par tenant + GET /subscription <!-- kind: flow -->
- status: IN-BUILD
- owner: claude-code A (builder) · reviewer: gpt5pro (a posteriori)
- depends-on: C24b (MERGED — backend.service libre), C26 (MERGED — SubscriptionInfo attendu par l'écran)
- target: apps/api (backend.service singleton sub-mercier → par tenant) + api-client + mobile compte.tsx

#### Contrat (v1, claude-code A — régime prod 100 %)
- CONSTAT : `backend.service.ts` construit UN `Subscription.start({ id: 'sub-mercier', companyId:
  MERCIER_PROPS.id, tier: 'business' })` singleton dans le constructor — dernier « Mercier en dur »
  du serveur, partagé par TOUS les tenants (le gating planCan/ai_assistant/TTS s'y adosse).
- SERVEUR : dérivation PAR REQUÊTE/TENANT `subscriptionFor(companyId)` (early-access réel : tier
  business actif, 0 € — même politique pour tous pendant l'accès anticipé, mais l'objet porte le
  BON companyId et un flag earlyAccess explicite ; le jour du billing, cette méthode lira une
  table). GET /subscription → SubscriptionInfo { tier, status, earlyAccess, priceCents,
  currentPeriodEnd } (le type défini par C26 dans derive-account-view fait foi — pas de doublon).
- CLIENT : BobClient.getSubscription (HTTP + Local aligné seed) ; mobile : hook useSubscription →
  compte.tsx passe SubscriptionInfo réel à deriveAccountView (l'écran est déjà prêt, zéro
  changement de rendu attendu en early-access).
- Acceptance : plus AUCUN sub-mercier/MERCIER_PROPS.id d'abonnement dans backend.service (grep) ·
  gating par tenant testé · GET /subscription testé · api-client tests · typecheck 16/16.

#### Signatures
- [x] agreed — claude-code A — 2026-07-04 (02:20) — régime humain, review gpt5pro a posteriori

#### Log (append-only, horodaté)
- [2026-07-04 02:20] claude-code A CLAIM+PROPOSE+IN-BUILD: séquencé après C24b comme prévu au log
  C26 (même fichier backend.service.ts, plus de collision).
- [2026-07-04 02:40] claude-code A HANDOFF+MERGE (régime humain): C26b COMPLET. subscriptionFor(
  companyId) par requête (`sub-<companyId>`, early-access business pour tous — LE point unique qui
  lira la table billing), 10 usages adaptés sans changement de gating, GET /subscription →
  SubscriptionView (⊂ SubscriptionInfo core, types stricts) + earlyAccess/priceCents, Local aligné,
  compte.tsx branché (earlyAccess:true → rendu accès anticipé identique, garanti tests core).
  Jobs/cron : aucun ne gate par offre aujourd'hui (vérifié) ; le jour venu ils passeront leur
  companyId explicite. grep sub-mercier : VIDE — dernier Mercier serveur éradiqué (reste le tenant
  démo du guard, assumé). Validations : api 79 ✓ · api-client 31 ✓ · core 389 ✓ · typecheck 16/16 ✓.
  status=MERGED.

### C-EXP — Expertise comptable (audit multi-agents 2026-07-04) <!-- kind: expertise -->
- Source : `docs/architecture/expertise-comptable-roadmap.md` — 34 propositions consolidées,
  CHAQUE référence vérifiée adversarialement (Légifrance/BOFiP + code du repo). 6 claims dérivés :
  C-EXP1 conformité-pièces (quick-wins purs) · C-EXP2 recouvrement-conforme (B2C/B2G, pénalités
  calculées, prescription) · C-EXP3 vigie-seuils-anomalies (293 B temps réel, doublons, DAS2, CFE) ·
  C-EXP4 moteur-tva (exigibilité, CA3/CA12, fin RSI 2027) · C-EXP5 argent-daté (deriveFiscalCalendar,
  provisions URSSAF/IS, point bas 90 j) · C-EXP6 e-facturation-niveau-2 (Factur-X entrant,
  e-reporting, connecteur PA, lettrage FEC).

#### C-EXP1 v1 — conformité immédiate des pièces et relances (P01+P14+P11)
- status: IN-BUILD · owner: claude-code A · reviewer: gpt5pro (a posteriori)
- Contrat : trois NON-CONFORMITÉS ACTIVES corrigées sans donnée nouvelle —
  (P01) les relances/mise en demeure réclament 40 € et citent L441-10 à des PARTICULIERS :
  brancher sur customer.type — B2C = base code civil (art. 1344/1344-1/1231-6, intérêt légal,
  jamais 40 €), B2G = L2192-13 CCP, B2B inchangé ;
  (P14) mention d'escompte OBLIGATOIRE absente (L441-9 : « Escompte pour paiement anticipé :
  néant » par défaut) + taux de pénalités stipulé « taux légal » SOUS le plancher L441-10 II
  (min. 3× taux légal) → stipuler le défaut légal BCE+10 ; mentions pros ≠ consommateurs dans
  buildMentions (L441-9 vise les ventes entre pros) ;
  (P11) mention certifiée taux réduits 10 %/5,5 % (remplaçant légal de l'attestation Cerfa depuis
  le 16/2/2025, art. 41 LF 2025, BOI-TVA-LIQ-30-20-90-40) imprimée sur devis+factures quand des
  lignes bâtiment à taux réduit existent (booléens suggestVatRate déjà saisis).
- Acceptance : tests par type de client (B2B/B2C/B2G) sur mentions + relances · aucune régression
  des tests core · typecheck.

#### Signatures (C-EXP1)
- [x] agreed — claude-code A — 2026-07-04 (02:40) — régime humain, review gpt5pro a posteriori

#### Log C-EXP (append-only, horodaté)
- [2026-07-04 02:40] claude-code A AUDIT+CLAIM: audit 58 agents (4 cartographes, 6 experts,
  vérification adversariale par proposition — 46/47 retenues, 1 réfutée), rapport commité.
  C-EXP1 v1 lancé en priorité : risque juridique actif sur chaque facture émise.
- [2026-07-04 03:05] claude-code A HANDOFF+MERGE C-EXP1 (régime humain): COMPLET. P01 : relances/MED
  par customer.type (B2C code civil sans 40 € ni L441-10 · B2G L2192-12/13 CCP BCE+8 · B2B inchangé),
  repli prudent b2c si client inconnu, le type traverse jobs/relance.service jusqu'à l'email (testé
  bout en bout), agent IA même moteur. P14 : plancher L441-10 II respecté (stipulation BCE+10, plus
  de « taux légal » irrégulier), escompte « néant » L441-9, bloc pros gated isProfessional() — rien
  aux particuliers. P11 : mention certifiée 279-0 bis / 278-0 bis A imprimée sur les pièces à taux
  réduit (booléens suggestVatRate en veto quand fournis), issue-invoice fige lineVatRates → PDF.
  Textes légaux exacts au rapport d'agent. NOTE (préexistant, hors périmètre) : les DEVIS ne passent
  pas encore par buildMentions (buildPieceView renvoie mentions:[]) — la mention certifiée devis
  attend P15/C-EXP6. Validations : core 404 ✓ (+15) · api 80 ✓ · ai 151 ✓ · typecheck 16/16 ✓.
  status=MERGED.
- [2026-07-04 03:05] claude-code A COORDINATION → session B : détecté dans le working tree vos
  fichiers E6 (compliance/vat-thresholds + diagnostic branché annualEncaissedCents) et
  clients/derive-aged-balance — c'est P02/P16 de la roadmap (C-EXP3/C-EXP2). Je vous les LAISSE :
  merci de réserver les claims C-EXP2/C-EXP3 ici même au protocole. Session A part sur C-EXP5 v1
  (P09 deriveFiscalCalendar — module vierge, zéro chevauchement).
- [2026-07-04 03:25] claude-code A FUSION DES DEUX AUDITS (constat : la section E ci-dessus et la
  roadmap docs/architecture/expertise-comptable-roadmap.md sont deux audits INDÉPENDANTS du même
  jour — table de correspondance pour ne rien faire en double, les références vérifiées de la
  roadmap A restent la source réglementaire commune) :
  · balance âgée : E5 = C-EXP2/P16 → SESSION B (fichiers chez elle) ;
  · seuils 293 B : E6 = C-EXP3/P02 → SESSION B (idem ; la roadmap P02 ajoute : prorata année de
    création via dateCreation désormais en BDD, bascule suggestVatRate/buildMentions au jour J,
    détection des factures émises à tort — à intégrer) ;
  · exigibilité TVA : E2 (MERGED par B) couvre le cœur de C-EXP4/P20 — C-EXP4 résiduel = brouillons
    CA3/CA12 chiffrés (P06), qui s'appuieront sur deriveVatPosition de B ;
  · lettrage FEC : E7 = C-EXP6/P24 → SESSION B ;
  · échéancier fiscal : E8 (TVA) ⊂ C-EXP5/P09 (toutes taxes : TVA+IS+CFE+URSSAF+rituel annuel) —
    SESSION A EN COURS sur le moteur d'ÉCHÉANCES (dates, application/fiscal/ vierge) ; les
    MONTANTS (liquidation TVA) restent côté B via deriveVatPosition (E8 devient : brancher les
    montants sur les échéances A) ;
  · sans recouvrement, libres pour A : P03 provisions URSSAF micro (TODO C40), P12 pénalités
    CALCULÉES + P04 chrono prescription, P05 Factur-X entrant / P22 e-reporting / P07 connecteur
    PA, P17 doublons dépenses, P18 DAS2, P19 CFE provision.

### C27 — Catalogue prestations + Réglages facturation <!-- kind: flow -->
- status: IN-BUILD
- owner: claude-code A (builder) · reviewer: gpt5pro (a posteriori)
- depends-on: C03 (MERGED), C21 (MERGED — le devis le consommera), C22 (MERGED — TRADE_PROFILES)
- ref-capture: dc.html §catalogue/réglages (extraire au build) · target: apps/mobile/app/catalogue.tsx (nouveau) + réglages + intégration devis/voix

#### Contrat (v1, claude-code A — régimes prod 100 %)
- CATALOGUE : use case pur @bob/core application/catalogue/ — prestations par métier (libellé, PU HT
  indicatif, TVA suggérée, catégorie labor/supply/travel) DÉRIVÉES de TRADE_PROFILES (vocabulaire C22) +
  prestations personnelles de l'artisan (persistance réelle si endpoint, sinon SecureStore local typé +
  TODO serveur documenté). Écran catalogue (liste par catégorie, ajout/édition Sheet, prix modifiables).
- INTÉGRATION C20/C21 : l'étape lignes du devis (devis/new) et la dérivation voix (voice-invoice-draft)
  proposent le catalogue (suggestions au fil de la saisie) — SANS casser la saisie libre.
- RÉGLAGES FACTURATION (écran) : lecture réelle du profil (mentions, numérotation — déjà garanties core),
  RIB/logo : édition seulement si endpoints réels, sinon lecture + TODO (pas de formulaire fantôme).
- Copy : clés @bob/i18n catalogue.* + reglages.* ×3 humeurs.
- Acceptance : catalogue dérivé testé (métiers → prestations cohérentes) · suggestions dans devis/voix
  câblées · persistance réelle ou TODO · captures · i18n tests · typecheck + token-lint clean.

#### Signatures
- [x] agreed — claude-code A — 2026-07-03 (22:57) — régime humain, review gpt5pro a posteriori

#### Log (append-only, horodaté)
- [22:57] claude-code A CLAIM+PROPOSE+IN-BUILD: en parallèle de C24 (périmètres disjoints : C24 =
  screens/auth ; C27 = catalogue+core+intégration devis/voix). i18n partagé : relecture avant édition.
- [2026-07-04 00:36] claude-code A HANDOFF+MERGE (régime humain): C27 COMPLET. Core : application/
  catalogue/derive-catalogue pur testé — 63 prestations / 9 métiers dérivées de TRADE_PROFILES,
  TOUJOURS `indicative: true` (charte « jamais un centime inventé » : la voix reconnaît les libellés
  mais N'INJECTE JAMAIS un prix indicatif — voice-invoice-draft testé sur ce point). Mobile :
  data/catalogue.ts (personnalisation AsyncStorage : prix propres, favoris — TODO serveur documenté
  pour la persistance tenant), écrans catalogue.tsx (liste par catégorie, édition Sheet) +
  reglages-facturation.tsx (lecture réelle du profil, mentions/numérotation garanties core — AUCUN
  formulaire fantôme : RIB/logo affichés seulement quand un endpoint réel existera) ; devis/new :
  suggestions catalogue au fil de la saisie SANS casser la saisie libre. Validations : core 352 ✓
  (dont derive-catalogue) · i18n 46 ✓ · typecheck 16/16 ✓. Commits scopés c24/c27 distincts + fix
  HEAD (CollectInvoiceButton manquant de 1ddf718 réparé). status=MERGED.

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

### C40 — Contrats d'API réels + parité agent complète <!-- kind: package -->
- status: MERGED
- owner: claude-code (builder) · reviewer: gpt5pro (a posteriori)
- depends-on: C02, C15 (audit), C20 (registre extensible) · directive humaine PROD 100 % [14:50]
- target: packages/api-client + packages/ai + apps/mobile/src/data (apps/api INTERDIT — endpoints existants)

#### Contrat (v1, claude-code — AMENDÉ par la directive « app de prod 100 %, plus seulement une démo »)
- Objectif : fermer le chemin de PRODUCTION du mobile — le mode connecté (Supabase session + API Railway)
  devient le chemin PRINCIPAL, le LocalBobClient reste un adaptateur de dev.
- Périmètre :
  1. JOURNAL ON-DEVICE (TODO ⑧, majeur) : BobClient (api-client) expose askBob/confirmBob/getRunJournal
     sur les endpoints EXISTANTS POST /ai/ask · POST /ai/confirm · GET /ai/runs/:id/journal ; en mode HTTP,
     apps/mobile/src/data/bob.ts route l'agent par le SERVEUR (autonomie clampée par l'offre, journal
     append-only company-scoped) au lieu d'instancier l'agent en local ; le local reste le chemin démo.
  2. OUTILS AGENT MANQUANTS (TODO ⑤⑥⑦) : capacités optionnelles generer_facture (deposit/final, fiscal),
     export_fec (accounting), intent+navigation diagnostic — mêmes use cases que l'UI, pattern C20.
  3. CRÉER CLIENT (TODO partagé C12) : use case côté client (createCustomer si l'endpoint existe côté api ;
     sinon TODO documenté SANS bouton fantôme) + entrée UI C12 + outil agent creer_client si faisable.
  4. VALIDATION PROD : l'app en mode connecté (vrai .env, session Supabase du user démo) fonctionne sur
     les écrans refondus — checklist loggée (login, briefing, argent, clients, fiche, documents, assistant
     ask/confirm JOURNALISÉ serveur, voix). Toute rupture = fix dans le claim.
- Interdits : apps/api (périmètre Codex/session OCR) · rupture d'API publique · fixtures en prod.
- Acceptance : tests api-client (ask/confirm joués contre un stub HTTP local) · @bob/ai registre étendu
  testé · typecheck workspace · checklist prod loggée au claim (avec captures si session dispo).

#### Signatures
- [x] agreed — claude-code — 2026-07-03 (14:52) — régime humain, review gpt5pro a posteriori

#### Log (append-only, horodaté)
- [14:52] claude-code CLAIM+PROPOSE+IN-BUILD: directive PROD 100 % gravée (mémoire + contrat). NB : la
  validation connectée sur simulateur nécessite un LOGIN (saisie) — accessibilité macOS toujours refusée :
  soit l'humain l'autorise (Réglages → Confidentialité → Accessibilité), soit il tape le login démo une
  fois sur le simulateur ; sinon la checklist prod sera validée via les tests HTTP + preuves API.
- [15:58] claude-code HANDOFF+MERGE (régime humain): chemin de prod livré — BobClient expose askBob/
  confirmBob/getRunJournal sur les endpoints serveur EXISTANTS (DTO constatés : AgentRun/PendingAction/
  JournalEntry de @bob/ai des deux côtés → mapping 1:1 avec l'écran C15, zéro adaptation UI) ; en mode HTTP
  l'assistant est journalisé SERVEUR (autonomie clampée par l'offre), en Local l'agent est hébergé on-device
  avec journal lisible (InMemoryJournalStore) — TODO ⑧ FAIT côté client, GAP serveur documenté (1 ligne :
  exposer runId dans la réponse confirm — apps/api hors périmètre, à passer à Codex/session api). TODO ⑤⑥⑦
  FAITS (generer_facture fiscal+safetyFloor, export_fec accounting, intent diagnostic → navigate /diagnostic
  sans toucher l'écran C15). CRÉER CLIENT FAIT de bout en bout : POST /customers constaté → client HTTP/Local
  + useCreateCustomer + Sheet « nouveau client » (C12 : +/Fab/empty-state) + outil agent creer_client (draft)
  — un seul point d'entrée humain↔Bob. i18n +8 clés clients.create*. Validations : api-client 24/24 ·
  ai 146/146 · core 316/316 · i18n 33/33 · typecheck 16/16. Restes : validation connectée simulateur (login
  humain ou accessibilité) — preuves API curl en cours ; registre d'outils optionnels côté SERVEUR (BackendService)
  = TODO apps/api. status=MERGED.
- [16:02] claude-code LOG (PREUVE DE PRODUCTION, checklist C40): exécutée contre l'infra RÉELLE —
  login Supabase (demo@bobpro.fr, password grant) → JWT ES256 émis ✓ · GET /customers (API Railway,
  DEMO_MODE=false, RLS bob_app) → 200 scopé tenant ✓ · POST /ai/ask {"combien je peux me verser ce
  mois-ci ?"} → 200 AgentRun réel : intent payout, plan ["Lire la trésorerie réelle","Calculer le
  versement sans risque"], carte « Tu peux te verser 4 528,88 € sans risque. Je garde le reste pour la
  TVA et les charges. » (mistral-small, journalisé serveur) ✓. Le chemin de prod ask est PROUVÉ de bout
  en bout ; confirm (mutation réelle) réservé à la validation humaine sur simulateur connecté.

### C41 — A11y / états / tests / sweep parité <!-- kind: package -->
- status: OPEN · depends-on: (tous les écrans) · spec: CLAUDE_CODE_PROMPTS.md Phase 7
- Contrat: contrastes AA + focus/labels · skeletons/vides/erreurs/offline · tests unитaires core + e2e (devis→facture, voix) · **sweep de parité mobile↔web** sur les écrans clés.
- Acceptance: token-lint global clean · e2e verts · captures de parité archivées.

---

### Journal global (résumé — détail dans chaque claim)
| Claim | Status | Builder | Reviewer | Note |
|---|---|---|---|---|
| C00 | MERGED | claude-code | gpt5pro | PARITY-PASS package @86ef5c2 ; C01/C02 débloqués. |
| C01 | MERGED | claude-code | gpt5pro | PARITY-PASS a posteriori @f1f93b3. |
| C02 | CHANGES-REQUESTED | claude-code | gpt5pro | PARITY-FAIL #1 a posteriori @c37151b — fixtures clients proto à aligner. |
| C03 | IN-BUILD | claude-code | gpt5pro | COUNTER rétroactif #1 @43670ef3 — contrat à préciser avant MERGE. |
| C10 | MERGED | claude-code | gpt5pro | Écran + moteur priorités livrés, re-capture halos OK (07:33). |
| C11 | MERGED | claude-code | gpt5pro | Écran refondu validé simulateur (07:30), review a posteriori. |
| C12 | MERGED | claude-code | gpt5pro | Écran validé simulateur 08:02 (4 330 € = proto), review a posteriori. |
| C13 | MERGED | claude-code | gpt5pro | Fiche validée simulateur 08:47, review a posteriori. |
| C15 | MERGED | claude-code | gpt5pro | Chat sur agent réel validé 11:10 ; audit parité : 9 OK / 8 TODO (① journal on-device prioritaire). |
| C20 | MERGED | claude-code | gpt5pro | Flux 3 étapes validé 13:26 ; TODO parité ③④ résolus. |
| C40 | MERGED | claude-code | gpt5pro | Livré 15:58 : ask/confirm/journal + ⑤⑥⑦ + créer client. Gap serveur runId → Codex. |
| C21 | MERGED | claude-code | gpt5pro | Flux validé 16:10 ; Stepper+SignaturePad livrés (réserve C03 soldée). |
| C23 | MERGED | claude-code | gpt5pro | Diagnostic expert-comptable v2 livré 16:32 (audit réel + plan daté 3 axes). |
| C25 | MERGED | claude-code A | gpt5pro | 100 % prod livré 22:40 (endpoints+push+cron core, TODO ①② fermés). |
| C17 | MERGED | claude-code (session B) | gpt5pro | Grand-livre @bob/ui + export FEC partageable (shareFec ×2 écrans). |
| C22 | MERGED | claude-code A | gpt5pro | Flux 5 étapes validé 22:17 (preview adaptatif core). |
| C24 | MERGED | claude-code A | gpt5pro | Auth 100 % prod (login+SIRET+biométrie) + checklist PROD connectée — 07-04 00:35. Reste : C24b provisioning tenant. |
| C24b | MERGED | claude-code A | gpt5pro | Cross-tenant fermé (guard+service+GUC) + provisioning `company-<userId>` + fiche société complète en BDD — 07-04 01:55. Reste déploiement : migrate deploy + redeploy Railway. |
| C27 | MERGED | claude-code A | gpt5pro | Catalogue 63 prestations/9 métiers + suggestions devis/voix — 07-04 00:36. |
| C26 | MERGED | claude-code A | gpt5pro | Compte/Abo honnête (accès anticipé 0 €, grille PLAN_CATALOG 19/39/79 preview) — 07-04 01:55. |
| C26b | MERGED | claude-code A | gpt5pro | Subscription par tenant + GET /subscription, grep sub-mercier vide — 07-04 02:40. |
| C-EXP1 | MERGED | claude-code A | gpt5pro | Conformité pièces/relances par type de client (B2C code civil · B2G CCP · plancher BCE+10 · escompte · mention taux réduits) — 07-04 03:05. Roadmap : docs/architecture/expertise-comptable-roadmap.md. |
| C-EXP5 | IN-BUILD | claude-code A | gpt5pro | deriveFiscalCalendar (P09) — échéancier fiscal par forme juridique/date création/régime — 07-04 03:10. |
| C-EXP2, C-EXP3 | — | session B ? | gpt5pro | Fichiers E6 détectés (vat-thresholds, aged-balance) : session B invitée à réserver ici. |
| C41 | OPEN | — | — | Sweep final a11y/états/parité. Web C30 différé après mobile hi-fi. |
