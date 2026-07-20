# Orchestration bi-agent — Claude Code ⨯ GPT‑5 Pro

> **But :** deux agents IA construisent Bob Pro **en synergie**, se coordonnent via un système de **claims** (tickets réservables + auditables), **se mettent d'accord sur un contrat avant de coder**, puis se relisent jusqu'à obtenir **exactement les mêmes écrans** que les prototypes de référence — au pixel, en suivant les user flows.
>
> Ce document est la **constitution** de l'équipe. `CLAIMS.md` en est le tableau de bord vivant.

---

## 0. Principe fondateur

> **Spec d'abord, double-signature, relecture obligatoire.**
> Aucune ligne de code de production n'est écrite avant que **les deux agents aient signé le contrat** d'un claim. Aucun claim n'est fusionné avant qu'il soit **vérifié en parité** par l'agent qui ne l'a pas construit.

Les agents ne « discutent » pas librement : ils échangent des **messages structurés append-only dans le claim** (section `## Log`). Le claim EST le canal de communication — traçable, rejouable, sans dérive.

La **vérité visuelle est figée** : `Bob Pro.dc.html` (mobile, 402×874) et `Bob Pro - Web.dc.html` (web) sont les références. `Design System.dc.html` + `tokens.ts` sont la loi. On **recrée nativement** (RN/Expo + Next), on ne copie pas le HTML.

---

## 1. Les deux agents et leurs rôles

| | **Claude Code** (dans VS Code) | **GPT‑5 Pro** |
|---|---|---|
| Surnom | **BUILDER** (les mains) | **ARCHITECT/REVIEWER** (les yeux + le cerveau spec) |
| Accès | Filesystem du repo, terminal, build Expo/Next, tests, captures d'écran | Raisonnement spec, revue de diffs, contrôle de parité sur captures + tokens |
| Écrit dans | le **repo** (code) + le `## Log` de ses claims | le **contrat** + le `## Review` + le `## Log` des claims |
| Produit | code natif, tests, captures de l'écran natif | contrat gelé, checklist de parité, verdict PASS/FAIL |

**Rotation (recommandé, classe mondiale) :** les rôles **alternent par claim**. Sur un claim donné il y a un `owner (builder)` et un `reviewer` ; sur le claim suivant ils permutent. Ainsi aucun agent n'est cantonné aux mains ou aux yeux, et chacun relit le style de l'autre.

**Alternative (lanes fixes) :** si tu préfères, garde Claude Code toujours builder (il a le filesystem) et GPT‑5 Pro toujours architecte/reviewer. Le protocole est identique — seule la permutation saute.

> **Règle du writer unique :** pour un claim donné, **seul l'`owner` modifie des fichiers du repo.** Le reviewer ne touche qu'au `## Review` et au `## Log` du claim. Zéro collision d'écriture.

---

## 2. Anatomie d'un claim

Un claim = un bloc markdown dans `CLAIMS.md` (ou un fichier `claims/C10.md`). Un claim = **un écran OU un flux OU un package**. Format canonique :

```md
### C10 — Écran « Aujourd'hui »        <!-- kind: screen -->
- status:      OPEN
- owner:       —                       (builder ; se remplit à la réservation)
- reviewer:    —
- depends-on:  C01, C02, C03
- ref-capture: claims/ref/C10-aujourdhui.png
- spec:        SCREENS.md § Aujourd'hui   ·   flows: USER_FLOWS.md § First-run
- target:      apps/mobile/app/(tabs)/index.tsx

#### Contrat (gelé avant build — voir §3)
- Tokens ....................................................
- Composants (@bob/ui) ......................................
- États (default/loading/empty/error/offline) ..............
- Edges IN  (qui amène ici) .................................
- Edges OUT (où l'on part, + action) .......................
- Acceptance (= noms des tests) ............................

#### Signatures (2 requises)
- [ ] agreed — gpt5pro     — <date> — contract@<hash>
- [ ] agreed — claude-code — <date> — contract@<hash>

#### Review (rempli par le reviewer)
- [ ] parité layout (paddings/rayons/ombres = tokens, ±1px)
- [ ] parité couleurs (= valeur token, 0 hex brut)
- [ ] parité typo (familles + échelle)
- [ ] copy = clés i18n (VOICE_AND_TONE)
- [ ] tous les états présents
- [ ] edges IN/OUT câblés
- verdict: —

#### Log (append-only, horodaté)
- [hh:mm] <agent> <TYPE>: <message>
```

**Cycle de vie (status) :**

```
OPEN → CLAIMED → SPEC-AGREED → IN-BUILD → IN-REVIEW
                                   ↑            │
                                   └─ CHANGES-REQUESTED ◄┘
IN-REVIEW → PARITY-VERIFIED → MERGED
(à tout moment) → BLOCKED | NEEDS-HUMAN
```

**Types de message (`## Log`) :** `CLAIM` · `PROPOSE` · `COUNTER` · `AGREE` · `HANDOFF` · `REVIEW` · `PARITY-PASS` · `PARITY-FAIL` · `BLOCKED` · `ESCALATE`.

---

## 3. Le protocole, pas à pas

**① Réserver (mutual exclusion).** Un agent choisit un claim `OPEN` dont les `depends-on` sont `MERGED`, écrit son nom dans `owner`, passe le status à `CLAIMED`, logue `CLAIM`. L'autre agent devient automatiquement `reviewer`. → deux agents ne codent jamais le même écran.

**② S'accorder (double-signature).** L'`owner` **ou** le `reviewer` rédige le **Contrat** (tokens exacts, liste de composants `@bob/ui`, tous les états, edges IN/OUT tirés de `USER_FLOWS.md` + `NAVIGATION_MAP.md`, et l'acceptance = les **noms de tests**). L'autre répond `COUNTER` (désaccord précis) ou `AGREE`. Quand **les deux cases `Signatures` sont cochées** avec le même `contract@<hash>`, status = `SPEC-AGREED`. **Le code ne commence pas avant.**

**③ Construire.** L'`owner` (builder) code nativement en consommant `@bob/tokens`, `@bob/core`, `@bob/ui`. Status `IN-BUILD`. À la fin : commit, **capture de l'écran natif** à 402×874, `HANDOFF` dans le log avec le SHA + le chemin de la capture. Status `IN-REVIEW`.

**④ Relire en parité (barrière).** Le `reviewer` compare la capture native à `ref-capture` selon §4, coche `## Review`, et logue :
- `PARITY-PASS` → status `PARITY-VERIFIED`, puis `MERGED`.
- `PARITY-FAIL` → écarts **précis et actionnables** (« ombre = e2, attendue e3 » ; « padding top 20, attendu 24 » ; « #0C2340 en dur → doit être `brand.ink900` »). Status `CHANGES-REQUESTED` → retour ③.

**⑤ Fusionner.** Un claim `MERGED` débloque ses dépendants. On avance en respectant l'ordre du §6.

---

## 4. Barrière de parité pixel — « exactement les mêmes écrans »

La référence est le prototype rendu **à taille réelle mobile (402×874)**. Chaque claim d'écran embarque une **capture de référence** dans `claims/ref/` (le builder la génère depuis `Bob Pro.dc.html`). Le verdict de parité coche :

1. **Métriques de layout** — paddings, gaps, rayons, tailles : tolérance **±1px** sur l'échelle de `tokens.spacing/radius`. La carte flottante suit `patterns.floatingCard` (chevauchement −30dp, radius 22, ombre e3).
2. **Couleurs** — chaque couleur = **une valeur de token** (thème actif). **Zéro hex brut** dans les composants (`token-lint`, §5).
3. **Typo** — `Schibsted Grotesk` (chiffres/titres 700/800) + `Hanken Grotesk` (texte 500/600/700), échelle de `tokens.type`. Montants en `tabular-nums`.
4. **Copy** — chaîne = **clé i18n** exacte, ton conforme à `VOICE_AND_TONE.md` (Bob, « Pote » par défaut, tutoiement).
5. **États** — default / loading (skeleton) / empty / error / offline tous présents.
6. **Flow** — edges IN/OUT câblés et vérifiés (spies de navigation) contre `USER_FLOWS.md` + `NAVIGATION_MAP.md`.
7. **Interdits de la charte** — aucune apparition à opacité 0 sur du contenu au repos ; hit-target ≥ 44 ; icônes filaires trait 2–2.4.

> **`token-lint` (gate automatique) :** `grep -REn '#[0-9a-fA-F]{3,8}|rgba?\(' packages/ui apps/*/app` ne doit **rien** retourner hors `packages/tokens`. Toute couleur/ombre vient du thème. C'est la condition sine qua non de la parité entre les deux apps et entre les deux agents.

---

## 5. Résolution de conflit (anti-boucle)

- Désaccord sur le contrat : **2 tours de `COUNTER` maximum**. Sans accord → `ESCALATE`, status `NEEDS-HUMAN`, chaque agent **résume sa position en 2 lignes**. L'humain tranche.
- Parité : après **3 `PARITY-FAIL`** sur le même claim → `ESCALATE`. Souvent le contrat était ambigu : on le raffine, on re-signe, on repart.
- **Autorité de la source :** en cas de doute, l'ordre de vérité est `tokens.ts` > `Design System.dc.html` > `SCREENS.md` > le `.dc.html` de l'écran > l'opinion d'un agent. Un agent ne « préfère » jamais sa version à un token.

---

## 6. Ordre de construction (dépendances)

```
Fondations (séquentiel, un build / une revue) :
  C00 scaffold → C01 tokens+theming → C02 core → C03 primitives UI
Puis, en parallèle (chaque paire builder/reviewer prend un claim) :
  Écrans mobile : C10 Aujourd'hui · C11 Argent · C12 Clients · C13 Fiche client
                  C14 Documents · C15 Assistant(Bob) · C16 Détail pièce · C17 Compta&conformité
  Flux :         C20 Voix · C21 Devis→signature→facture · C22 Onboarding · C23 Diagnostic
                  C24 Auth · C25 Relances+Notifs · C26 Compte/Abo/Équipe/Paywall · C27 Catalogue+Réglages
  Web :          C30 shell(SideNav) · C31 dashboard · C32 Clients master-détail · C33 Argent/Docs/Assistant · C34 modales
  Transverse :   C40 API contracts + mock (TanStack) · C41 A11y/états/tests/sweep de parité
```

Règle : un claim d'écran ne démarre pas tant que `C01+C02+C03` ne sont pas `MERGED`. Un claim web réutilise le claim mobile équivalent (même contrat, coque adaptée — cf. README §Web responsive).

---

## 7. Definition of Done (par claim)

Un claim est `MERGED` **seulement si** : contrat double-signé ✅ · code natif via `@bob/ui`/`@bob/core`/`@bob/tokens` (0 logique métier dans l'app) ✅ · `token-lint` clean ✅ · tests d'acceptance verts (les noms = l'acceptance du contrat) ✅ · tous les états ✅ · edges IN/OUT câblés ✅ · **`PARITY-PASS` par l'autre agent** ✅.

---

## 8. Prompts de démarrage (à coller tels quels)

### 8.1 — Kickoff **Claude Code** (dans VS Code)

```
Tu es BUILDER sur le projet Bob Pro, en binôme avec GPT‑5 Pro (ARCHITECT/REVIEWER).
Vous vous coordonnez EXCLUSIVEMENT via design_handoff_bob_pro/CLAIMS.md selon le protocole
de design_handoff_bob_pro/AGENT_ORCHESTRATION.md. Lis ces deux fichiers en entier, puis :

1. Prends le premier claim OPEN dont les depends-on sont MERGED. Écris ton nom dans `owner`,
   status=CLAIMED, logue [hh:mm] claude-code CLAIM.
2. N'ÉCRIS AUCUN CODE tant que le Contrat n'est pas double-signé. Rédige/complète le Contrat
   (tokens exacts, composants @bob/ui, états, edges IN/OUT depuis USER_FLOWS.md + NAVIGATION_MAP.md,
   acceptance = noms de tests). Attends l'AGREE de GPT‑5 Pro et signe.
3. Construis nativement (Expo/RN) en consommant @bob/tokens, @bob/core, @bob/ui. Zéro hex brut
   (token-lint doit passer). Reproduis la référence au pixel (§4).
4. Génère la capture de l'écran natif à 402×874, commit, puis logue
   [hh:mm] claude-code HANDOFF: build @<sha>; capture claims/shots/<claim>.png. status=IN-REVIEW.
5. Sur PARITY-FAIL, corrige les écarts cités un par un et refais un HANDOFF. Sur PARITY-PASS,
   passe au claim suivant.
Règle d'or : les *.dc.html sont des références de design, pas du code à copier. Identité figée = tokens.ts.
```

### 8.2 — Kickoff **GPT‑5 Pro**

```
Tu es ARCHITECT/REVIEWER sur Bob Pro, en binôme avec Claude Code (BUILDER, il a le filesystem).
Vous vous coordonnez EXCLUSIVEMENT via CLAIMS.md selon AGENT_ORCHESTRATION.md (lis les deux).
Tu n'écris jamais dans le repo : tu écris le Contrat, le ## Review et le ## Log des claims.

1. Pour le claim que Claude Code vient de CLAIMER, vérifie/complète le Contrat : tokens tirés de
   tokens.ts, composants existants dans @bob/ui, TOUS les états, edges IN/OUT cohérents avec
   USER_FLOWS.md + NAVIGATION_MAP.md, acceptance testable. Réponds COUNTER (précis) ou AGREE, puis signe.
2. À réception du HANDOFF, compare la capture native à ref-capture selon la barrière de parité (§4) :
   layout ±1px vs tokens, couleurs = valeur token (0 hex), typo, copy = clés i18n, états, edges, interdits charte.
   Coche ## Review et logue soit PARITY-PASS (→ MERGED) soit PARITY-FAIL avec des écarts CHIFFRÉS et
   ACTIONNABLES (ex. « ombre e2, attendue e3 » ; « #0C2340 en dur → brand.ink900 » ; « padding 20→24 »).
3. Max 2 COUNTER sur le contrat et 3 PARITY-FAIL par claim, sinon ESCALATE (NEEDS-HUMAN) en résumant
   ta position en 2 lignes. Autorité : tokens.ts > Design System.dc.html > SCREENS.md > .dc.html > opinion.
```

---

## 9. Gabarits de prompt par écran (pixel-perfect)

Chaque claim d'écran se lance avec ces deux gabarits (remplace `<Cxx>` / `<Écran>`). Ils s'appuient sur `SCREENS.md`, `COMPONENT_SPECS.md`, `RN_EXPO_GUIDE.md`, `USER_FLOWS.md` — **source unique de vérité**, on ne recopie pas les specs ici.

**Gabarit BUILDER (Claude Code) :**
```
Claim <Cxx> — <Écran>. Contrat double-signé dans CLAIMS.md : respecte-le à la lettre.
Implémente apps/mobile/<target> en RN/Expo, hi-fi vs claims/ref/<Cxx>.png.
- Layout/tokens : suis COMPONENT_SPECS.md § <Écran> et RN_EXPO_GUIDE.md (ombres iOS+elevation,
  dégradés angle→start/end, safe-area, tabular-nums). Rien en dur : tout depuis @bob/tokens.
- Composants : réutilise @bob/ui (<liste du contrat>). Ne recrée pas un composant existant.
- Données : @bob/core (fixtures + règles). Copy : @bob/i18n (VOICE_AND_TONE, Bob « Pote »).
- Edges : câble IN/OUT exactement comme USER_FLOWS.md § <flow> et NAVIGATION_MAP.md.
- États : default/loading/empty/error/offline.
- Tests : un test par ligne d'acceptance du contrat. token-lint doit passer.
Puis capture 402×874, commit, HANDOFF.
```

**Gabarit REVIEWER (GPT‑5 Pro) :**
```
Claim <Cxx> — <Écran>. Compare claims/shots/<Cxx>.png à claims/ref/<Cxx>.png via la barrière §4.
Passe la checklist ## Review point par point. Vérifie que chaque composant vient de @bob/ui,
que toute couleur = un token (0 hex/rgba hors packages/tokens), que la copy = des clés i18n,
et que les edges correspondent à USER_FLOWS.md § <flow>. Rends PARITY-PASS ou PARITY-FAIL
avec des écarts chiffrés et actionnables. Ne fusionne jamais un écran non conforme aux tokens.
```

**Exemple rempli — C10 « Aujourd'hui »** *(builder)* : `AppHeader` (dégradé `brand.headerGradient`) + `HeroBalanceCard` (pattern `patterns.floatingCard`, montant `formatEUR` en 31/800 `ink900`, phrase « te verser » à la voix de Bob) + 3 `PriorityCard` (badge statut, CTA contextuelle) + `SectionHeader`« En un coup d'œil » + `KpiTile`×3 + `QuickAction`×6. Edges OUT : PriorityCard "Relancer" → Assistant(prompt `relance`), "Encaisser" → Voix, cloche → Notifs, hero → Argent. Acceptance : (1) 3 priorités depuis fixtures ; (2) montant = `formatEUR(cash.dispo)` tabular-nums ; (3) chevauchement −30dp ; (4) token-lint clean ; (5) edges OUT câblés.

**Exemple rempli — C16 « Détail pièce »** *(builder)* : vue unique paramétrée par `kind` (devis | facture | acompte | avoir | situation) rendue depuis `@bob/core` (`BillingDoc`). Header (numéro sans trou, badge type + statut), bloc parties (partyLine **adaptatif** : SIREN si B2B, rien si B2C), lignes catégorisées, `Totals` (acompte proportionnel), **mentions figées** (badge « FIGÉ À L'ÉMISSION »), nav croisée devis↔facture (`parentQuoteId`), puis **frise cycle de vie** : PDP (B2B) vs **e-reporting** (B2C) vs Chorus Pro (B2G) selon `einvoiceFor(customer)`. Acceptance : test d'or acompte = `488,40 €` ; B2C ne montre pas de SIREN ; « Encaisser » fait `Émise→Payée` (suivi + frise) ; avoir en montants négatifs.
