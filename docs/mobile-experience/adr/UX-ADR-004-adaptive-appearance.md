# UX-ADR-004 — Apparence adaptative et matières

> **Amendement A23 — 2026-07-30 · `ink` et `highContrast` ne se propagent pas**
> **Source.** Lecture directe de `packages/ui/src/components/bob-surface.tsx` et
> `bob-surface.logic.ts`.
> **Portée.** § Ancrage sur le code (ligne « Composant de surface » + sous-section nouvelle) et
> deux critères de vérification. La doctrine de matière, l'algorithme de surface et les rangs sont
> **inchangés** : ce qui change est la frontière exacte de ce que le composant garantit.
> **Pourquoi.** Le dossier décrivait une garantie AA « portée par la surface » ; elle est portée
> par un **couple** texte/fond, et le composant ne pose pas le texte. Un consommateur livré le
> démontre — sous AA.
>
> **Amendement A1 — 2026-07-29 · doctrine « matière Bob »**
> **Source.** Directive du fondateur redite le 2026-07-29 : « ce n'est pas forcément du verre
> liquide qu'on veut… en gardant NOS couleurs. **Je NE VEUX PAS une UI transparente à la iOS.** »
> **Autorité de matière citée.** Kit livré et testé : `packages/tokens/src/index.ts`
> (`surfaceTint`, l. 214-257) et `packages/ui/src/components/bob-surface.tsx` (+ `.logic.ts`,
> `.test.ts`), déjà consommés par `apps/mobile/app/equipements/[chantierId].tsx` et
> `apps/mobile/app/equipement/[id].tsx`.
> **Portée.** Remplace le § « Algorithme de surface », les points 5 et 6 de la décision proposée
> et deux critères de vérification. Le corps daté du 2026-07-23 n'est pas réécrit : les passages
> supersédés restent visibles sous la mention « Rédaction initiale 2026-07-23 ».
> **Légitimité.** Cet ADR est `Proposed` ; la règle « ne jamais réécrire silencieusement un ADR »
> ([README](../README.md) § Maintenance) vise les ADR `Accepted`. L'amendement en place est donc
> autorisé, daté et sourcé ; il ne change ni le statut, ni les décideurs attendus, ni les gates.

## Statut

Proposed — 2026-07-23 · amendé A1 le 2026-07-29 (doctrine « matière Bob »)

## Décideurs attendus

Design owner, Mobile tech lead, Product owner, Accessibility reviewer et QA. Décision initiale en
Vague 0 ; l'activation sombre complète exige une décision de rollout distincte après certification.

## Contexte

L'app déclare une apparence système automatique, mais les surfaces et la StatusBar ne suivent pas
un contrat clair/sombre complet. Les APIs blur/verre peuvent améliorer le chrome sur certains OS,
mais ne sont pas disponibles uniformément et peuvent réduire contraste et performance.

> **Note A13 · 2026-07-29.** Ce paragraphe décrit le contexte **du 2026-07-23**, avant décision. Il
> n'autorise rien : depuis A1, le verre système est hors doctrine quelle que soit sa disponibilité
> runtime (§ Algorithme de surface, rang 4, et § Pourquoi le verre système est exclu).

## Drivers

- lisibilité immédiate des barres système ;
- rôles sémantiques de couleur ;
- support Reduce Transparency/Increase Contrast ;
- identité Bob préservée ;
- fallback stable iOS/Android ;
- aucun glassmorphism de contenu.

## Options

### A — Forcer le mode clair

Rapide, cohérent et sûr ; ne satisfait pas une ambition sombre complète.

### B — Laisser `automatic` sans refonte des rôles

Rejeté : produit un pseudo-mode adaptatif et des contrastes non contrôlés.

### C — Thème adaptatif complet, livré par étapes

Rôles canvas/content/chrome/status et surfaces système, avec force-light possible jusqu'à
certification complète.

## Preuves minimales pour accepter la décision

- inventaire de chaque famille de surface et des ruptures StatusBar actuelles ;
- comparaison chiffrée force-light durable vs thème sémantique complet ;
- prototype de tokens canvas/content/chrome/status en clair, sombre et contraste augmenté ;
- **(amendé A9 · 2026-07-29)** démonstration Reduce Transparency montrant des captures
  **identiques** avant/après — la preuve attendue est une **absence de différence**, pas le
  déclenchement d'un repli. Il n'y a plus de « surfaces candidates » : la surface teintée du rang 1
  s'applique partout, y compris au chrome. Le seul repli qui existe encore est celui de
  `ProgressiveBlurBob` (rang 3), et il consiste à **rendre le rang 1** ;
  *Rédaction initiale 2026-07-23 (supersédée) : « démonstration Reduce Transparency et fallback
  opaque sur surfaces candidates » — contradictoire avec le point 6 de la décision ci-dessous, qui
  pose que Reduce Transparency n'a aucun effet visuel et qu'il n'y a pas de fallback à déclencher.*
- estimation QA/performance et décision Product/Design/Mobile/Accessibilité.

## Décision proposée

Retenir C avec gate :

1. corriger StatusBar et choisir explicitement force-light pour le train initial ;
2. définir les rôles light/dark/high-contrast ;
3. certifier toutes les routes prioritaires ;
4. activer `automatic` uniquement lorsque le thème complet est prêt ;
5. **(amendé A1 · 2026-07-29)** le chrome utilise les **surfaces teintées** du kit
   (`surfaceTint` / `BobSurface`). **Aucune matière n'est sélectionnée par capability
   runtime** : la matière est la MÊME sur tous les OS et toutes les versions, ce qui supprime la
   QA combinatoire matière × OS × version.
   *Rédaction initiale 2026-07-23 (supersédée) : « verre/blur réservés au chrome, sélectionnés par
   capability ».*
6. **(amendé A1 · 2026-07-29)** Reduce Transparency **n'a aucun effet visuel** : les surfaces sont
   déjà opaques (`surfaceTint`, opacités pré-composées en hex). Il n'y a pas de « fallback » à
   déclencher, donc pas de chemin de rendu qui ne soit testé qu'en préférence rare.
   *Rédaction initiale 2026-07-23 (supersédée) : « Reduce Transparency impose un fallback
   opaque ».*

## Algorithme de surface

> Amendé A1 · 2026-07-29 — remplace intégralement l'algorithme du 2026-07-23.

```text
0. ACCESSIBILITÉ D'ABORD
   reduceMotion         → aucune matière ANIMÉE ; durée 0, état final immédiat
   reduceTransparency   → aucun effet : la surface du rang 1 est déjà opaque
   increaseContrast     → bordure renforcée (2 pt `spec.ink`) sur la même surface

1. RANG 1 — SURFACE TEINTÉE BOB  (défaut, matière NOMINALE)
   surfaceTint[appearance][tone].flat | .raised, opaque par construction.
   S'applique au contenu, au plan Action ET au chrome (tab bar, toolbars, contrôles flottants).

2. RANG 2 — FLOU LÉGER DE BORD  (option bornée)
   Uniquement en RETOMBÉE non interactive (pointerEvents none) au-dessus d'une teinte opaque
   de notre palette, pour dissoudre le contenu sous un chrome flottant.
   Jamais comme fond d'une surface porteuse d'information (carte, ligne, formulaire, montant).

3. RANG 3 — REPLI OPAQUE UNIQUE
   La teinte seule, sans aucun échantillon de flou. C'est le DÉFAUT de `ProgressiveBlurBob`
   et le comportement obligatoire si le port de rendu de couche est absent, si Reduce
   Transparency est actif, sur Android dégradé, ou si le budget GPU n'est pas tenu.

4. LE VERRE SYSTÈME N'EST PAS UN RANG
   Liquid Glass / UIGlassEffect / expo-glass-effect : HORS DOCTRINE, quelle que soit sa
   disponibilité runtime.
```

> Rédaction initiale 2026-07-23 (supersédée par A1) : `reduceTransparency → opaque ; sinon chrome
> éligible + glass runtime → glass ; sinon chrome éligible + blur supporté + budget tenu → blur ;
> sinon → opaque`. Cet ordre plaçait le verre système au premier rang dès qu'il était disponible
> et ne faisait pas de la surface teintée un rang du tout — l'inverse exact de la directive du
> fondateur.

### Pourquoi le verre système est exclu, et pas seulement « déprioritisé »

1. **Il impose la teinte du système, pas la nôtre.** `UIGlassEffect` échantillonne le fond et
   applique le matériau d'Apple ; la couleur perçue du chrome devient une fonction de l'OS et du
   contenu qui passe dessous, pas de `surfaceTint`. Bob perd le contrôle de son identité au
   moment précis où il devrait l'affirmer (règle non négociable n° 4 du programme, « Bob, pas un
   clone »).
2. **Il n'existe pas partout.** Il crée deux matières à concevoir, à mesurer et à certifier
   (iOS récent vs le reste), donc une divergence iOS/Android structurelle — exactement le
   risque `R10` du registre.
3. **Il dégrade mal.** Sous Reduce Transparency, iOS transforme chaque `UIVisualEffectView` en
   matériau quasi opaque au ton système : la surface change d'aspect pour la population qui a
   le plus besoin de stabilité.
4. **Il coûte, en continu.** Un échantillonnage de flou sous un scroll est un coût GPU permanent,
   là où une teinte est un seul draw call.

Ce refus n'est pas un jugement esthétique sur Liquid Glass : c'est la conséquence directe de
« Je NE VEUX PAS une UI transparente à la iOS » et de la nécessité d'une identité constante.

### Ancrage sur le code

La doctrine matière n'est pas à écrire : elle est **livrée, testée et déjà consommée**.

| Norme exécutable | Chemin | Ce qu'elle fixe |
| --- | --- | --- |
| Tokens `surfaceTint` | `packages/tokens/src/index.ts` (l. 214-257) | 2 apparences × 6 tons × `{flat, raised, border, ink, inkMuted}`, hex pré-composés. |
| Contrastes AA | `packages/tokens/src/index.test.ts` | `ink`/`inkMuted` certifiés sur `flat` ET `raised`. |
| Composant de surface | `packages/ui/src/components/bob-surface.tsx` (+ `.logic.ts`, `.test.ts`) | `tone` × `emphasis` (`flat`/`raised`/`floating`), bordure renforcée en Increase Contrast, aucune `BlurView`, aucun `rgba`. **(précisé A23 · 2026-07-30)** Le composant pose **le fond, la bordure et l'ombre**. Il ne pose **pas** la couleur du texte. |
| Chrome de référence | `packages/ui/src/components/bottom-tab-bar.tsx` | Pilule `colors.surface` opaque + `controls.cardBorder` + `shadowNative.e2`. |
| Consommateurs livrés | `apps/mobile/app/equipements/[chantierId].tsx`, `apps/mobile/app/equipement/[id].tsx` | En-têtes de fichier : « BobSurface (surfaces teintées OPAQUES — jamais la transparence iOS) ». |

**En cas de divergence entre un document de ce dossier et le code du kit, le CODE fait foi.**

### Ce que `BobSurface` ne fait PAS — `ink` et `highContrast` ne se propagent pas

> Ajouté A23 · 2026-07-30. Source : lecture directe de
> `packages/ui/src/components/bob-surface.tsx` et `bob-surface.logic.ts`. Le dossier décrivait une
> propagation qui n'existe pas ; la règle de vérité s'applique — c'est la **description** qui cède.

Deux faits, vérifiables en trente lignes de code :

1. **`ink` / `inkMuted` ne descendent pas aux enfants.** `bobSurfaceColors()` **calcule** bien
   `ink` et `inkMuted` — les encres certifiées AA **sur ce fond précis** — mais `BobSurface` ne
   consomme que `backgroundColor`, `borderColor`, `borderWidth` et `elevated`. Il n'expose ni
   contexte React, ni render-prop, ni style hérité : `children` est rendu tel quel. **Un `Text`
   placé dans un `BobSurface` ne reçoit donc aucune couleur du composant.** La certification AA de
   `packages/tokens/src/index.test.ts` porte sur le **couple** `(ink, flat|raised)` ; elle ne se
   transporte pas à un texte qui n'utilise pas `ink`.
2. **`highContrast` est une prop par instance, pas une préférence lue.** Elle vaut `false` par
   défaut, n'est branchée sur aucune API système, et n'est pas héritée par un `BobSurface`
   imbriqué. Increase Contrast n'est donc **automatique nulle part** : chaque appelant doit passer
   la prop, sur chaque surface.

**Cas de preuve — réel, livré, et sous AA.** `apps/mobile/app/equipements/[chantierId].tsx` l. 274
rend `<BobSurface tone="warning" emphasis="raised">` — fond `surfaceTint.light.warning.raised`
`#F6E4C6` — et y place un sous-texte `font('sub', 500)` (13,5 pt, **texte normal**) coloré en
`colors.slate500` `#5B6B7B`, au lieu de l'encre certifiée du ton :

| Texte rendu | Fond réel | Contraste | Verdict AA (4,5:1) |
| --- | --- | ---: | --- |
| `colors.slate500` `#5B6B7B` (**ce que le code rend**) | `#F6E4C6` | **4,39:1** | **échoue** |
| `surfaceTint.light.warning.inkMuted` `#8A5A12` (encre certifiée du ton) | `#F6E4C6` | 4,74:1 | passe |
| `colors.ink800` `#0F2235` (titre de la même carte) | `#F6E4C6` | 12,94:1 | passe |

C'est le cas de preuve à inscrire au registre : il montre que la garantie AA **ne survit pas** à la
non-propagation, sur du code déjà livré et déjà cité par cet ADR comme « consommateur livré ». Il
n'est pas corrigé par le présent amendement — c'est un correctif de **code**, hors de ce lot, et il
est signalé comme tel.

**Ce qui reste donc vrai, et ce qu'il faut prouver :**

- vrai : les **tokens** `ink`/`inkMuted` sont certifiés AA sur `flat` **et** `raised` ;
- vrai : `BobSurface` garantit un fond **opaque** et une bordure renforçable ;
- **à prouver à chaque usage** : que le texte posé dans la surface utilise bien l'encre du ton, ou
  qu'il atteint AA sur ce fond par une autre voie **mesurée**. Aucun test du dépôt ne le vérifie
  aujourd'hui ([11 § Tests statiques](../11-test-strategy.md#tests-statiques)).

## Conséquences

Positives : cohérence système, accessibilité, progression sans big bang.
Négatives : double palette à concevoir, QA importante, matières variables par OS.

> Amendé A1 · 2026-07-29 — la conséquence négative « matières variables par OS » **disparaît** :
> avec une matière unique et opaque, la surface est identique sur iOS et Android, à toutes les
> versions. Ce qui reste à concevoir est la double palette clair/sombre, déjà livrée par
> `surfaceTint`. Conséquence positive ajoutée : la QA matière devient une QA de contraste
> (mesurable, automatisable) et non une QA de capability runtime (combinatoire, non reproductible).

## Critères de vérification de l'implémentation

- [ ] StatusBar/navigation bar lisibles sur chaque route.
- [ ] Aucun état automatique partiel.
- [ ] Contrastes certifiés light/dark/high contrast.
- [ ] ~~Reduce Transparency sans différence fonctionnelle.~~ **(amendé A1)** Reduce Transparency
      sans différence **visuelle** : capture avant/après identique au pixel sur le chrome et sur
      chaque `BobSurface`, la préférence n'ayant rien à dégrader.
- [ ] ~~Aucune carte métier dépend du verre.~~ **(amendé A1)** Aucune surface, métier ou chrome,
      n'importe `expo-glass-effect` ni ne dépend d'une capability de matière ; contrôle statique
      d'import (voir [11 — Tests](../11-test-strategy.md)).
- [ ] **(ajouté A1 ; précisé A23 · 2026-07-30)** Toute surface porteuse d'information est issue de
      `surfaceTint`/`BobSurface` **et le texte qu'elle contient utilise l'encre du ton** — `ink` ou
      `inkMuted` —, ou atteint AA sur ce fond par un couple **mesuré**. `BobSurface` ne propage pas
      l'encre : la case se prouve au point d'usage, pas au composant.
- [ ] **(ajouté A23 · 2026-07-30)** Chaque surface qui doit répondre à Increase Contrast reçoit
      explicitement `highContrast` : la prop n'est ni lue du système, ni héritée d'un
      `BobSurface` parent.
- [ ] GPU et batterie mesurés sur la seule matière restante autorisant un échantillonnage : la
      retombée `ProgressiveBlurBob` en mode flouté (budget dans
      [10 — Performance](../10-performance-observability.md)).

## Réexamen

Revoir le choix force-light lorsque toutes les routes critiques et surfaces tierces possèdent des
preuves dark mode.
