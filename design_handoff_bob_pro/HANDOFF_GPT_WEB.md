# PASSATION — Session C (GPT) : espace expert-comptable WEB (claim C-WEB-EC)

> Rédigé le 2026-07-09 par la session B (Claude). Tu es la **session C**. Ce document contient
> TOUT ce qu'il te faut pour travailler sans jamais entrer en collision avec les deux autres
> sessions actives sur ce monorepo. Lis-le en entier avant d'écrire une ligne.

---

## 1. Le produit, en trois phrases

**Bob Pro** est le copilote administratif, financier et comptable des indépendants français
(artisans BTP, consultants, freelances IT, photographes, coachs). Vision fondatrice : « Bob,
c'est ton expert-comptable de poche — il gère ta compta mieux que ton comptable ; à la fin,
un expert-comptable associé signe le bilan. Ça fait partie du cercle. » L'app mobile produit
une **vraie comptabilité en partie double** (PCG, journaux, FEC, balance, compte de résultat,
bilan, dossier de clôture) — pas de la pré-compta.

**Ta mission ferme le « cercle » côté cabinet** : l'espace web où l'expert-comptable RÉCEPTIONNE
et CONTRÔLE le dossier de son client. Analyse concurrentielle à l'appui (voir
`docs/strategy/2026-concurrence-axonaut.md`) : le canal expert-comptable est LE moat du leader
Axonaut, et Bob n'a rien aujourd'hui. C'est la priorité produit n°1 réalisable sans partenariat.

## 2. Le monorepo (pnpm + turbo)

```
packages/core        ← domaine + use cases PURS (la vérité comptable) — INTERDIT EN ÉCRITURE
packages/ui          ← design system React Native (mobile)            — INTERDIT
packages/i18n        ← copy ×3 humeurs (pote/pro/direct)              — INTERDIT
packages/tokens      ← tokens design (couleurs, patterns)             — lecture/import OK, édition INTERDITE
packages/ai          ← agent IA « Bob »                               — INTERDIT
packages/api-client  ← contrat client + client démo local             — INTERDIT
apps/mobile          ← app Expo/React Native (le produit principal)   — INTERDIT
apps/api             ← API NestJS (Railway)                           — INTERDIT
apps/sign-web        ← page signature de devis (déployée Vercel)      — INTERDIT
apps/web             ← coque Next 16 (placeholder C00)                — ✅ TON PÉRIMÈTRE EXCLUSIF
design_handoff_bob_pro/CLAIMS.md                                      — ✅ journal partagé (append-only)
```

Commandes (depuis la racine) :
```bash
pnpm install
pnpm --filter @bob/core build        # OBLIGATOIRE avant d'importer @bob/core (dist/)
pnpm --filter @bob/i18n build
pnpm --filter @bob/web dev           # Next sur http://localhost:3010
pnpm --filter @bob/web typecheck && pnpm --filter @bob/web build
```

État actuel d'`apps/web` : un placeholder (`app/page.tsx` affiche le tagline). Next **16**
(App Router), React 19. Dépendances actuelles : `@bob/i18n` seulement — tu peux ajouter
`"@bob/core": "workspace:*"` (et `@bob/tokens` si utile) dans `apps/web/package.json` : c'est
DANS ton périmètre.

## 3. Protocole multi-sessions — NON NÉGOCIABLE

Trois sessions travaillent EN PARALLÈLE sur le MÊME working tree git :
- **Session A (Claude)** : Factur-X réception, API serveur, Prisma — a du WIP non commité dans
  `packages/core`, `packages/api-client`, `apps/api`. NE TOUCHE À RIEN de tout ça.
- **Session B (Claude, moi)** : moteurs comptables (`packages/core/application/accounting`,
  `pilotage`), écrans mobiles, `packages/ai`. Même règle.
- **Session C (TOI, GPT)** : `apps/web/**` UNIQUEMENT + tes entrées dans `CLAIMS.md`.

Règles :
1. **Avant de commencer** : lis `design_handoff_bob_pro/CLAIMS.md` (journal du projet), puis
   ajoutes-y une entrée datée : `- [HH:MM] gpt (session C) C-WEB-EC IN-BUILD : <une ligne>`.
   Commit immédiat de cette entrée seule (`chore(claims): ...`).
2. **Commits fréquents et SCOPÉS** : `git add apps/web/... design_handoff_bob_pro/CLAIMS.md`
   — JAMAIS `git add -A` ni `git commit -a` (tu embarquerais le WIP des sessions A/B).
   Vérifie chaque périmètre avec `git diff --cached --stat` avant de committer.
3. **Un besoin hors périmètre** (export manquant de `@bob/core`, clé i18n, endpoint API) :
   tu ne modifies PAS le package — tu le NOTES dans ton entrée CLAIMS (« SUIVI (session B) : … »)
   et tu contournes proprement côté web.
4. **Jamais de secrets** en clair, **jamais de deploy** (Vercel/Railway) sans demande humaine
   explicite, jamais d'invention d'identifiants.
5. À la fin : entrée CLAIMS `C-WEB-EC MERGE (commit <sha>)` décrivant ce qui est livré,
   vérifications passées, et suivis.

## 4. Ta mission : C-WEB-EC — « le cabinet reçoit le dossier »

### Le scénario utilisateur (réel, pas démo)
L'artisan, depuis l'app mobile, envoie à son expert-comptable **deux fichiers** produits par
Bob : le **dossier de clôture** (note de synthèse `.txt` lisible) et le **FEC** (fichier des
écritures comptables, format réglementaire, encodage **ISO 8859-15**, arrêté du 29/07/2013).
L'EC ouvre l'espace web Bob, **dépose le FEC**, et obtient instantanément : balance générale,
compte de résultat, bilan, contrôles de cohérence — recalculés par LES MÊMES moteurs que
l'app mobile. Zéro upload : **tout le parsing et les calculs se font DANS le navigateur**
(argument RGPD/confiance : « le FEC de votre client ne quitte jamais votre poste »).

### Spécification v1 (dans l'ordre de valeur)
1. **Route `/cabinet`** (App Router) : page d'accueil de l'espace EC — pitch sobre une phrase
   + zone de dépôt de fichier FEC (`.txt`), drag & drop + input file.
2. **Parsing FEC côté client** :
   - Décodage : `new TextDecoder('iso-8859-15')` sur l'ArrayBuffer du fichier.
   - Format : colonnes séparées par TABULATION, 1re ligne = en-têtes. Les colonnes EXACTES
     sont définies dans `packages/core/src/application/accounting/export-fec.ts` (lignes ~10-30 :
     `JournalCode`, `JournalLib`, `EcritureNum`, `EcritureDate`, `CompteNum`, … `Debit`, `Credit`,
     `EcritureLet`, `DateLet`, …). **Lis ce fichier** (lecture seule) et calque ton parser dessus.
   - Montants : format français avec virgule décimale (`1234,56`) → convertis en **centimes
     entiers** (les moteurs core travaillent exclusivement en centimes).
   - Dates : `AAAAMMJJ` → `AAAA-MM-JJ`.
   - Ton parser vit dans `apps/web/` (ex. `apps/web/src/fec/parse-fec.ts`) avec ses tests si
     tu ajoutes vitest — PAS dans packages/core (note en CLAIMS qu'il pourra y être remonté).
3. **Re-dérivation des états via `@bob/core`** (import du workspace, après build) :
   regroupe les lignes par `EcritureNum` en écritures `{ lines: [{ account, debitCents,
   creditCents }] }` puis appelle :
   - `deriveTrialBalance(entries)` → balance générale (rows par compte, totaux, `balanced`,
     résultat provisoire) ;
   - `deriveIncomeStatement(entries)` → compte de résultat en cascade (exploitation/financier/
     exceptionnel/net) ;
   - `deriveBalanceSheet(entries)` → bilan actif/passif (`balanced`, `ecartCents`).
   Affiche les trois états + les équilibres (Débit=Crédit ✓, Actif=Passif ✓, résultat identique
   dans les trois états). `formatEUR(cents)` est exporté par `@bob/core` pour l'affichage.
   - NOTE : un moteur `deriveClosingReview` (diligences de révision : comptes d'attente,
     caisse créditrice, cohérence inter-états…) est en cours côté session B — quand il sera
     commité dans `@bob/core`, branche-le tel quel en encart « Revue de Bob » (vérifie
     `git log packages/core` ; s'il n'est pas là, livre sans, note-le en CLAIMS).
4. **Affichage du dossier de clôture `.txt`** (optionnel v1) : seconde zone de dépôt qui
   affiche le document en `<pre>` propre (police mono, largeur lisible). Pas de parsing.
5. **États vides/erreurs honnêtes** : fichier non-FEC → message clair (« Ce fichier ne
   ressemble pas à un FEC : … ») ; jamais d'écran cassé, jamais de données inventées.

### Design
- Référence de DA : `design_handoff_bob_pro/Bob Pro.dc.html` (ouvre-le dans un navigateur) —
  fond clair `#EFF2F7`, encre `#0F1A2B`, vert succès, cartes blanches arrondies 18px, chiffres
  en tabular-nums. Reste SOBRE et professionnel (le lecteur est un expert-comptable) :
  pas d'emoji dans les états financiers, densité élevée, hiérarchie claire.
- Tu peux importer `@bob/tokens` pour les couleurs, ou reprendre les valeurs du dc.html en
  CSS custom properties locales à apps/web. Pas de lib UI externe lourde ; CSS modules ou
  styles inline React suffisent.
- Textes : FRANÇAIS impeccable (accents corrects). Le web v1 n'est pas branché sur les
  3 humeurs i18n — chaînes locales à apps/web acceptées (note-le en CLAIMS).

### Definition of Done
- [ ] `pnpm --filter @bob/web typecheck` et `build` verts.
- [ ] Test manuel avec un FEC réel : génère-le depuis les moteurs (script Node ponctuel dans
      `apps/web/scripts/` qui importe `@bob/core`/`@bob/api-client` en LECTURE pour produire un
      FEC de démo, ou demande à l'humain d'exporter depuis l'app mobile).
- [ ] Les 3 états s'affichent, les équilibres sont verts sur le FEC de démo.
- [ ] Capture(s) écran dans `design_handoff_bob_pro/captures/` (préfixe `web-cabinet-`).
- [ ] Entrée CLAIMS `C-WEB-EC MERGE` + commits scopés apps/web uniquement.

### Pièges connus (vécus sur ce repo)
- Toujours **rebuilder `@bob/core`** (`pnpm --filter @bob/core build`) après un `git pull` —
  le typecheck web consomme `dist/`, pas `src/`.
- Le FEC seedé de démo contient des écritures **lettrées** (colonnes EcritureLet/DateLet non
  vides) et des comptes auxiliaires — ton parser doit les accepter sans s'en servir.
- `EcritureNum` est séquentiel **PAR JOURNAL** — n'utilise pas ce champ comme id global :
  groupe par `(JournalCode, EcritureNum)`.
- Next 16 : pas de `use client` oublié sur les composants interactifs (drag & drop).
- La racine du monorepo a des fichiers `.dc.html` volumineux : ne les importe jamais dans le
  bundle web.

## 5. Où en est le produit (pour ta culture, et tes textes d'interface)

Livré côté mobile/core (commits récents) : états de synthèse complets (balance/CR/bilan),
dossier de clôture partageable, FEC ISO 8859-15 lettré, TVA sur encaissements, provision
URSSAF micro (ACRE), balance âgée + relances L441, moteur de pilotage (séries CA facturé/
encaissé, SIG, DSO, top clients), verticale freelance IT, agent IA avec parité d'action.
Pricing : Découverte 0 € / Solo 19 € / Pro 39 € / Business 79 €/mois, sans engagement.

Ton espace `/cabinet` est la **première brique** du canal expert-comptable : v2 probables
(PAS dans ton périmètre v1) : compte cabinet multi-dossiers, annuaire, marque blanche.
Écris-le petit, juste, et vrai — comme le reste du produit.
