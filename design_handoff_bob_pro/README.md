# Handoff — Bob Pro

> **Bob Pro** — *« Ton bureau pro dans la poche. »*
> Le copilote administratif & financier des artisans, indépendants et TPE. Facture, encaisse, classe, suis ta trésorerie et reste conforme à la facturation électronique 2026/2027 — sans jargon ni paperasse. Dans l'app, l'assistant s'appelle **Bob**.

Ce dossier est un **package de handoff** destiné à un développeur travaillant avec **Claude Code**. Objectif : reconstruire le prototype dans une vraie base de code, en **deux applications qui partagent un cœur commun** :

- **`apps/mobile`** — React Native (Expo)
- **`apps/web`** — Next.js (App Router) — équivalent web/desktop responsive

---

## ⚠️ Lis ceci d'abord

Les fichiers `*.dc.html` de ce dossier sont des **références de design** : des prototypes HTML qui montrent l'apparence et le comportement voulus. **Ce ne sont PAS du code de production à copier.** La mission est de **recréer ces écrans nativement** (React Native pour le mobile, React/Next pour le web) en t'appuyant sur les tokens et les specs fournis ici.

**Fidélité : haute (hi-fi).** Couleurs, typographie, espacements, rayons, ombres et copally sont définitifs. Reproduis-les fidèlement via le package de tokens — ne réinvente pas la direction visuelle (elle est *figée*, cf. `Design System.dc.html`).

---

## Index des fichiers

| Fichier | Contenu |
|---|---|
| `README.md` | Ce document : vue d'ensemble, architecture, conventions, ordre de construction. |
| `tokens.ts` | **Source unique de vérité** des design tokens (couleurs, type, espacements, rayons, ombres, 4 thèmes). Partagé mobile + web. |
| `tokens.json` | Même chose, format machine (pour générer des CSS vars, du Tailwind config, etc.). |
| `DOMAIN_MODEL.md` | Entités métier (TS), **règles de conformité réelles** (TVA, e-invoicing 2026/2027, mentions, scoring, trésorerie, tons de relance) + données de seed du proto. |
| `SCREENS.md` | Spéc écran par écran : but, layout, composants, états, copy. |
| `VOICE_AND_TONE.md` | La personnalité de **Bob** : 3 humeurs, microcopy, do/don't. |
| `CLAUDE_CODE_PROMPTS.md` | **Le plan de construction** : une séquence de prompts prêts à coller pour Claude Code, phase par phase. |
| `AGENT_ORCHESTRATION.md` | **Mode deux agents** : protocole de synergie Claude Code ⨯ GPT‑5 Pro via *claims* (double-signature, barrière de parité pixel, résolution de conflit, prompts de démarrage). |
| `CLAIMS.md` | Le **tableau de bord vivant** des claims (backlog C00–C41 : fondations, écrans, flux, web, transverse). Canal de coordination unique entre les deux agents. |
| `NAVIGATION_MAP.md` | Carte de navigation : inventaire écrans/surcouches + z-index, graphe, mapping expo-router. |
| `USER_FLOWS.md` | Diagrammes de flux (Mermaid) + tables pas-à-pas des parcours critiques. |
| `COMPONENT_SPECS.md` | Anatomie redlinée des primitives (px/couleurs/rayons/ombres) + snippets RN. |
| `RN_EXPO_GUIDE.md` | Bible d'implémentation pixel-perfect RN/Expo : tokens→thème, table de traduction web→RN, polices, ombres, dégradés, safe-area, animations. |
| `INTEGRATION_MAP.md` | Cartographie back-end réel ↔ maquette : shapes de données, capacités, analyse d'écarts. |
| `Bob Pro.dc.html` | Prototype interactif **mobile** complet : Aujourd'hui, facture-à-la-voix, devis→signature→facture, **catalogue de prestations**, Argent, Clients, Documents, **Bob** (assistant), **notifications**, **relances auto**, **paramètres de facturation** (logo/RIB/mentions/modèles), compte/abonnement/équipe, onboarding adaptatif, diagnostic 2026, auth. |
| `Bob Pro — Web.dc.html` | Prototype interactif **web / desktop responsive** : shell sidebar + topbar, dashboard, Clients (master-détail), Argent, Documents, Assistant. Mêmes tokens, grilles fluides. C'est la cible de `apps/web` (Next.js). |
| `Design System.dc.html` | La charte figée (couleurs, type, composants, voix, écrans). |

---

## Architecture recommandée — monorepo

Un monorepo **pnpm + Turborepo** pour partager un maximum de code entre mobile et web :

```
bob-pro/
├─ apps/
│  ├─ mobile/            # Expo (React Native) — l'app principale
│  └─ web/               # Next.js 14 App Router — équivalent web responsive
├─ packages/
│  ├─ tokens/            # design tokens (depuis tokens.ts) — 0 dépendance
│  ├─ core/              # domaine + logique métier (types, TVA, scoring, tréso,
│  │                     #   mentions, e-invoice, tons de relance) — 0 UI, 0 RN/Next
│  ├─ ui/               # primitives partagées (contrats + impl. par plateforme)
│  └─ i18n/              # copy FR (Bob parle français), clés de microcopy
├─ package.json
├─ turbo.json
└─ tsconfig.base.json
```

**Principe directeur : tout ce qui n'est pas du rendu vit dans `packages/core`** (calcul de TVA, génération des mentions, scoring client, scénarios de trésorerie, état des machines de flux devis/facture). Les deux apps consomment ce cœur ; seules les couches de présentation diffèrent.

### Pourquoi ce découpage
- **`tokens` + `core` sont 100 % partagés** → une seule vérité pour le visuel ET les règles fiscales.
- **`ui` expose des contrats** (`<Button>`, `<Card>`, `<Sheet>`…) avec deux implémentations : RN (`*.native.tsx`) et web (`*.web.tsx`). Le code écran importe le contrat, le bundler résout la plateforme.
- **Mobile d'abord, web ensuite** : le proto est dessiné à 402×874 (iPhone). Le web reprend les mêmes composants mais réorganise la navigation (voir §Web responsive).

### Stack par app
- **Mobile** : Expo SDK récent, expo-router (file-based, miroir des flux), `react-native-reanimated` (animations), `expo-linear-gradient`, `@shopify/flash-list` (listes), `react-native-svg` (icônes), polices via `expo-font`.
- **Web** : Next.js App Router, React Server Components pour les pages statiques, Client Components pour les flux interactifs, CSS variables générées depuis les tokens (ou Tailwind avec preset dérivé de `tokens.json`), `framer-motion` pour les transitions.

---

## Web responsive — du mobile au desktop

Le proto est une app mobile. Pour le web, **garde les mêmes tokens, composants et logique**, mais adapte la coque :

- **Navigation** : la `TabBar` du bas (mobile) devient une **sidebar verticale** à gauche (desktop ≥ 1024px), et reste une tab bar/menu en mobile web.
- **Densité** : sur desktop, passe les écrans mono-colonne en **2–3 colonnes** (ex. Aujourd'hui = colonne priorités + colonne trésorerie ; Clients = liste maître + fiche détail côte à côte au lieu d'un push).
- **Largeur de contenu** : carte centrale ~720px pour les flux (devis, facture), pleine largeur en grille pour les tableaux de bord.
- **Les surcouches plein écran** (voix, devis→signature, onboarding) deviennent des **modales centrées** sur desktop, plein écran en mobile web.
- **Breakpoints** : `sm 640 / md 768 / lg 1024 / xl 1280`. Comportement mobile par défaut, on enrichit vers le haut.

---

## Conventions

- **Langue** : tout est en **français** (Bob tutoie par défaut — cf. `VOICE_AND_TONE.md`). Externalise la copy dans `packages/i18n`.
- **Argent** : format `fr-FR`, séparateur de milliers = espace fine insécable, décimales = virgule, `tabular-nums` partout. Ex. `1 628,00 €`. Centralise dans `core/format/money.ts`.
- **Polices** : `Schibsted Grotesk` (display : titres, chiffres, montants — 700/800) + `Hanken Grotesk` (texte : corps, boutons, labels — 500/600/700).
- **Icônes** : style filaire, trait 2–2.4, bouts arrondis, viewBox 24. (Lucide convient parfaitement, c'est le même langage.)
- **Thème** : 4 thèmes de marque (`marine` défaut, `foret`, `graphite`, `indigo`) pilotés par un `ThemeProvider`. Aucune couleur de marque en dur dans un composant — tout passe par le thème actif.
- **Pas d'animation d'entrée à opacité 0** sur du contenu au repos (règle de la charte).

---

## Par où commencer

Suis **`CLAUDE_CODE_PROMPTS.md`** : il enchaîne 7 phases (scaffold → tokens → core → primitives UI → écrans/flux → web responsive → données), chacune sous forme de prompt prêt à exécuter. Lis `DOMAIN_MODEL.md` avant la phase « core » et `SCREENS.md` avant la phase « écrans ».

### Mode deux agents (Claude Code ⨯ GPT‑5 Pro)

Pour construire à deux IA **en synergie** — mêmes écrans, au pixel, en suivant les flows — bascule sur **`AGENT_ORCHESTRATION.md`** + **`CLAIMS.md`**. Le principe : *spec d'abord, double-signature, relecture obligatoire*. Chaque écran/flux est un **claim** qu'un agent réserve (l'autre devient reviewer) ; les deux **signent le contrat** avant tout code ; le builder implémente puis livre une capture ; le reviewer valide en **parité pixel** contre la référence (`token-lint`, layout ±1px, copy = clés i18n, edges = `USER_FLOWS.md`). Colle les deux *prompts de démarrage* (§8 de l'orchestration) dans Claude Code et dans GPT‑5 Pro pour lancer.
