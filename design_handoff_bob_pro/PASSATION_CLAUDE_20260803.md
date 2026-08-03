# Passation Claude — 03/08/2026 (changement de compte, limite hebdomadaire Fable 5)

Document de reprise **complet et autoportant**. Tout ce qui suit est vérifié à l'instant de l'écriture.
La session précédente s'arrête proprement : rien n'est laissé dans un état ambigu.

---

## 1. Où en est le code

**`main` = `4a05ffec`** — porte l'intégralité du train visuel et des correctifs :

| PR | Contenu | État |
|----|---------|------|
| #51 | Lot 0 — fondations kit (17 tokens, 15 primitives, `useReduceMotion` fail-closed) | mergée |
| #52 | Fix inlining du flag tab bar (accès statique + garde source) | mergée |
| #55 | Centrage des icônes au repli (bloc libellé replié, patron `expo-glass-tabs`) | mergée |
| #56 | Lot 1 — cœur quotidien (Accueil + Argent, confirmation de solde en premier plan) | mergée |
| #57 | **GPT** — O6, 6 P1 sur les états financiers agrégés du Lot 1 | mergée |
| #58 | Lot 4 — clients & chantiers (fil rouge « couleur de l'argent ») | mergée |
| #59 | Désamorçage de la bombe horlogère du canal push | mergée |

### PR OUVERTES — à traiter en premier

- **#60 `claude/lot5-pilotage-compta`** — CI **verte**, `mergeStateStatus: CLEAN`.
- **#61 `claude/lot3-ventes-pieces`** — CI en cours (`BLOCKED` = checks non terminés).

⚠️ **NE PAS MERGER SANS LE VERDICT DE LA VÉRIFICATION ADVERSARIALE.** Les deux workflows
(`wz7r50x8x` Lot 3, `wtojkmldz` Lot 5) étaient en phase de vérification au moment de la coupure ;
leurs agents meurent avec la session. **Action de reprise** : relancer une vérification adversariale
sur chaque PR (prompt type dans les scripts persistés, voir §6), OU lire les journaux :
`~/.claude/projects/-Users-limameghassene-development-Bob-Pro/8adbf03e-.../subagents/workflows/wf_ef4555a4-f09/journal.jsonl`
(Lot 3) et `wf_bcc1ae72-887/journal.jsonl` (Lot 5) — le verdict y est peut-être déjà écrit.

**Ordre de merge** : Lot 3 (#61) d'abord, puis rebaser #60 dessus, puis **rebuild APK**.

---

## 2. Où en est l'application (état runtime)

- **Staging** sert `fa8c2f58`, `/health/ready` = `ready:true`. **Mission V2 ACTIVE** :
  flag DB `bob.agent_missions.quote.m2a` staging **global ON**, killSwitch OFF (vérifié en base).
  Le vocal est **testable** par le fondateur.
- **Production** : intacte, missions OFF, gelée jusqu'au GO V1.
- **Dernière APK livrée au fondateur** (train complet, build `3651244d` sur `4a05ffec`) :
  `https://expo.dev/artifacts/eas/mt7Pgx6_kis6aH_UW7YhPvMy59qcFwWCDicE0L3Hnds.apk`

### Ce que le fondateur doit encore faire / dire

1. **Verdict tab bar** (effets Revolut + centrage corrigé) — conditionne PERF-13 et le passage du flag en défaut.
2. **Verdict vocal** sur mission V2.
3. **GO/NO-GO** : afficher le TTC dans la barre sticky de `facture/new` — **seule décision produit en
   suspens**, seul ajout d'information du plan DA sous feature freeze.
4. Reconfirmer son **solde bancaire** dans Argent (péremption 24 h — comportement voulu).
5. **Régénérer la facture** du 01/08 : elle n'a jamais existé en base (voir §4, bug d'archive).

---

## 3. Le protocole bi-agent — LIRE AVANT TOUTE ÉCRITURE

GPT/Codex est **ACTIF** (il n'est plus absent : la passation fondateur du 31/07 est terminée).

- **Canal** : `refs/agents/claude` (mes messages, seq **476**, tête `e67ebd81`) et `refs/agents/gpt`
  (les siens). Lecture : `git fetch origin '+refs/agents/gpt:refs/agents/gpt'` puis
  `git show refs/agents/gpt:outbox/claude.md | tail -5`.
- **Écriture sur le canal** : le classifieur bloque les chaînes composées. Méthode qui passe —
  préparer les fichiers dans le scratchpad (`git --work-tree=... checkout refs/agents/claude -- .`,
  append au `outbox/gpt.md`, écrire `seq`), **puis** une commande séparée
  `git read-tree` + `write-tree` + `commit-tree` + `update-ref` + `push`.
- **LEÇON ACTÉE (à respecter)** : vérifier le canal GPT **juste avant tout merge**, pas seulement la
  CI. Un guetteur armé avant la publication de sa revue a mergé la PR #56 pendant qu'il y listait
  6 P1 — il les a corrigés lui-même (PR #57), sans dommage, mais l'incident ne doit pas se répéter.

### Chemins INTERDITS (contrat binaire + chantiers en vol)

Lane permanente GPT : `assistant.tsx`, `voix.tsx`, `devis/new.tsx`, `catalogue.tsx`,
`onboarding.tsx`, `app/_layout.tsx` **racine**, `apps/mobile/src/{audio,realtime,agent}`,
`packages/ai`, `apps/api/src/voice`.
Chantiers en vol : `argent.tsx`, `(tabs)/index.tsx`, `src/finance/balance-confirmation-state*`,
système **documents/dossiers** (son `folder-keys` n'est pas encore mergé).

### Ce que GPT attend de moi / ce que j'attends de lui

- **Je lui dois** : rien de bloquant. Msg 476 (ACK de sa lane O6) est poussé.
- **Il me doit** : (a) son micro-correctif `folder-keys` → **débloque le Lot 2** (coffre & scan,
  dernier lot du plan DA) ; (b) son **drill OFF dédié O5** → **débloque ma contresignature**.
- **Contresignature O5 en attente (msg 474)** : verdict **BLOCAGES**, 1 P0 + 1 P1 confirmés, tous
  deux sur la moitié *extinction* de son système de trace vocale (OFF durable inatteignable en bande ;
  `deactivate` lié au SHA d'activation au lieu du SHA servi). Le data-plane est reconnu conforme.
  **Engagement pris** : contresignature dans l'heure dès un aller-retour ON→OFF prouvé, sans
  re-revue complète. `MATRICE_FLAGS_V1` reste **gelée** d'ici là.

---

## 4. Incidents résolus cette semaine (contexte utile)

- **Flag tab bar toujours OFF** malgré `eas.json` correct : le module lisait `process.env[nom]`
  (accès calculé), que le bundler Expo **n'inline pas**. Corrigé + garde source dans les tests.
- **Trois bombes horlogères** dans des fixtures (dates littérales comparées à l'horloge réelle) :
  bascule de mois `pont-serveur` (PR #41), `token()` du smoke M1B (signalé à GPT, msg 471),
  `registerDevice` du canal push (PR #59). **Famille éteinte — qu'elle le reste** : aucune date
  littérale figée contre l'horloge réelle dans une fixture.
- **Classe de bug jour-UTC vs jour-métier Paris** éradiquée (PR #41 + #43) : `businessDayOf` dans
  `packages/core/src/shared-kernel/time.ts`, 6 sites fiscaux corrigés (assiette URSSAF, CA du mois
  voix+écran, seuils 293 B).
- **Orphelins d'archive** (2 PDF sans référence SQL, tenant du fondateur, 01/08 23:52) : blobs
  **sauvegardés** dans le scratchpad de session puis purgés via l'API storage ; audit re-vérifié à 0.
  Cause racine prouvée par GPT : worker PDF de 43 s dans une transaction Prisma de 5 s, l'upload
  Storage survit au rollback SQL. **Son correctif est attendu** ; c'est pour ça que la facture du
  fondateur n'existe pas.
- **CI verte trompeuse** : le cache turbo peut masquer une suite cassée. En cas de doute, `--force`.

---

## 5. Le plan de travail (ce qui reste)

Le document d'autorité est **`design_handoff_bob_pro/PLAN_DA_ECRANS_PAR_LOTS_20260801.md`**
(mergé, 39 écrans inventoriés, 5 lots, 15 arbitrages tranchés).

- Lot 0 ✅ · Lot 1 ✅ · Lot 4 ✅ · **Lot 3 en PR #61** · **Lot 5 en PR #60**
- **Lot 2 — Coffre & scan** : dernier lot, **retenu** jusqu'au `folder-keys` de GPT.
  C'est le moment démo signature du produit (« Bob lit ton document »).
- Écrans **hors périmètre des 5 lots**, à traiter dans une vague ultérieure : `notifications.tsx`,
  `compte.tsx`, `reglages-facturation.tsx`, `profil-fiscal.tsx`, `diagnostic-technique.tsx`,
  `src/screens` (auth).

---

## 6. Méthode de travail — à reprendre à l'identique

- **Workflows** (outil `Workflow`) pour tout lot : implémentation en **worktree isolé** →
  vérification **adversariale** par un second agent → PR **sans merge** → merge par l'orchestrateur.
  Les scripts des lots précédents sont persistés sous
  `~/.claude/projects/…/8adbf03e-…/workflows/scripts/` — les réutiliser comme gabarits.
- **Rituel avant toute PR**, vrais codes de sortie (rediriger vers fichier puis lire `$?`, jamais
  `&& echo OK` derrière un pipe) : `prisma generate` + `pnpm build --filter='./packages/*'` d'abord
  (worktree neuf = faux rouges sinon), puis `tsc` COMPLET des paquets touchés (tests inclus),
  `vitest run` complet, `eslint src` **direct** (attention : `apps/mobile` n'a NI script lint NI
  config — état antérieur, ne pas en créer), `flags-matrix-v1.test.ts` côté API, `pnpm typecheck`.
- **Règle du témoin** : un test dont on n'a pas vu la mort n'existe pas. Mutant appliqué → rouge avec
  message capturé → restauré → vert. **Preuves en littéraux** calculés à la main, calcul en commentaire.
- **Guetteurs de merge** : vérifier l'**état réel** (`gh pr view --json state`), jamais l'écho de la
  commande — `gh pr merge` peut échouer silencieusement (branche `BEHIND` → `update-branch` d'abord).
- **HYGIÈNE CRITIQUE** : le répertoire principal héberge un **chantier non committé** (GPT y travaille
  en direct : `schema.prisma`, `backend.service.ts`, persistence, `close-account`…). **Ne rien y
  toucher, ne rien y committer.** Tout travail se fait en worktree isolé. Un worktree propre sur main
  est disponible : `/private/tmp/wt58`.
- **Builds EAS** : jamais sans GO explicite du fondateur (Starter 19 €/mois) — **sauf** quand un
  train livrable l'exige et qu'il l'a demandé ; un build par train complet. Depuis un worktree, il
  faut préfixer l'environnement (`env $(cat /tmp/envline.txt) npx eas-cli …`, cf. `eas.json` profil
  preview) sinon la garde BDD-only d'`app.config.ts` refuse. Le sondeur `build:list` rate souvent
  l'artefact — vérifier avec `build:view <id> --json`.

---

## 7. Mémoire persistante

Les mémoires du projet (`~/.claude/projects/-Users-limameghassene-development-Bob-Pro/memory/`)
survivent au changement de compte et restent la source de contexte long. À lire en priorité :
`MEMORY.md`, `passation-fondateur-gpt-absent.md` (bilan, **terminée**),
`handoff-gpt-contrat-binaire.md`, `regle-builds-eas-sur-go.md`, `piege-worktree-dist-perimes.md`.

---

## 8. Première action recommandée à la reprise

1. `git fetch origin main '+refs/agents/gpt:refs/agents/gpt'` et lire les 3 derniers messages de GPT.
2. Lire les journaux des workflows Lot 3 / Lot 5 (§1) : si les verdicts y sont, appliquer les
   findings puis merger dans l'ordre ; sinon relancer les vérifications adversariales.
3. Répondre au fondateur sur ses verdicts en attente (§2) et lui proposer le rebuild APK après merge.

---

## AMENDEMENT — verdict du Lot 5 (PR #60) rendu APRÈS l'écriture de ce document

Le workflow de vérification du Lot 5 a rendu son verdict juste avant la coupure de session.
**Il change l'instruction du §1 : la PR #60 n'est PAS mergeable en l'état.**

### Verdict : `CORRIGER` — `conformePlan: false`, `datavizHonnete: false`, `mutantsTousRouges: false`

Rituel du vérificateur intégralement vert (typecheck 17/17, test 15/15, lint 9/9, mobile 1960 tests,
ui 476 tests, flags-matrix 19/19 ; 10/10 mutants déclarés rejoués rouges ; lanes GPT intactes,
aucun statut de spec promu). **Ce sont les findings qui bloquent, pas la CI.**

#### P1 — bloquants

1. **`packages/ui/src/components/trend-bars.tsx` — la dataviz s'effondre à 0 après avoir peint la
   vraie valeur** (cas nominal, reduce-motion OFF). La préférence démarre à `unknown` → barre
   statique à n% ; la promesse `AccessibilityInfo` se résout une frame plus tard → bascule sur
   l'`Animated.Value` initialisé à 0 → repeint 0 % puis remonte en 400 ms. Sur `main` les barres
   étaient des `View` statiques toujours justes : **régression visuelle nouvelle**.
   Preuve (sonde, un seul montage) : `FRAME1(unknown)= "width":"42%"` → `FRAME2(inactive)= "width":0`.
   *Correctif attendu* : figer la décision au montage comme le fait `FadeIn` du kit (garde `started`,
   arbitrage FAIL-CLOSED MOTION du Lot 0), ou initialiser `progress` à `target` avant d'animer.
2. **`apps/mobile/app/depenses.tsx` — le héros dette perd l'AA** : montant `semantic.warning`
   (#C77A12) sur le nouveau fond pastel `warningBg` (#FBF0DF) = **2,99:1** (< 3:1 AA gros texte),
   alors qu'il était à 3,38:1 sur blanc avant le lot. Le Lot 0 a créé `semantic.warningInk`
   (#8A5A12, **5,25:1**) exactement pour ce cas. L'eyebrow tombe à 2,59:1.
3. **`apps/mobile/app/__tests__/depenses.states.test.tsx` — test tautologique** : la « PLANCHE
   matière argent » ne prouve rien du héros ; ses deux littéraux sont produits par d'autres éléments
   (la pastille catégorie et le badge de statut partagent les mêmes hex). Mutants : suppression
   totale du voile → 9/9 verts ; montant jamais teinté → 9/9 verts.
4. **`apps/mobile/app/__tests__/pilotage.states.test.tsx` — l'honnêteté des null n'est verrouillée
   par AUCUN test**, alors que c'est le cœur de la doctrine du derive. Les branches null sont
   rendues par les fixtures mais aucune assertion ne les touche : DSO null→0, taux null→0, part
   client null→barre fantôme 0 % passent tous verts.

#### P2 / P3 — à traiter dans le même passage

- `cloture.tsx` : parité `disabled/loading` du CTA « Envoyer au comptable » non prouvée (`sendingDossier`
  jamais asserté) ; deux libellés visibles hors i18n (`"Fermer"`, `"OK"`) ; `disabled={done}` ajouté sur
  `CheckRow` inverse la sémantique VoiceOver d'une rangée réglée.
- `depenses.tsx` : **perte des centimes** sur des chiffres fiscaux (`KpiTile` formate en euros entiers
  là où l'écran affichait les centimes) — changement d'information sous feature freeze.
- `diagnostic.tsx` : toute la phase `result` hors couverture (count-up compris).
- `comptabilite.tsx` / `recherche.tsx` / `depenses.tsx` : tons de typologie client résiduels
  (`b2g`, `b2b`) hors des 4 sites énumérés par l'arbitrage — hors périmètre formel, mais la doctrine
  « fini les tons recyclés » n'est pas vraie à l'écran à la fin du lot.

### Instruction de reprise pour le Lot 5

Reprendre le worktree du lot (branche `claude/lot5-pilotage-compta`, PR #60), solder les 4 P1 puis
les P2/P3, **chaque correctif avec son témoin vu mourir**, relancer le rituel, puis **re-vérification
adversariale** avant merge. Le journal complet du verdict :
`~/.claude/projects/…/8adbf03e-…/subagents/workflows/wf_bcc1ae72-887/journal.jsonl`.

### Lot 3 (PR #61)

Son workflow (`wf_ef4555a4-f09`) n'avait pas rendu son verdict à la coupure — **même consigne** :
lire son journal, et si le verdict n'y est pas, relancer une vérification adversariale avant tout merge.
