# Programme d'excellence de l'expérience mobile Bob

> Statut : **Proposed — dossier de conception, aucun code associé**
> Dernière mise à jour : 2026-07-30 (amendements A1 → A27, voir § Journal des amendements)
> Périmètre : application mobile Expo/React Native Bob Pro
> Audience : produit, design, mobile, QA, accessibilité, contenu, sécurité et direction

## Journal des amendements

Le dossier est amendé, jamais réécrit. Chaque amendement porte un identifiant stable, une date et
sa source ; les passages remplacés restent cités dans le document concerné sous la mention
« Rédaction initiale ». La gouvernance — 77 exigences, gates, registre de preuves, ADR — est
inchangée.

| ID | Date | Objet | Source | Documents touchés |
| --- | --- | --- | --- | --- |
| **A1** | 2026-07-29 | **Doctrine « matière Bob »** : l'algorithme de surface plaçait le verre système iOS au premier rang et ne faisait pas de la surface teintée un rang du tout. Nouvel ordre : accessibilité → surface teintée → flou léger de bord → repli opaque ; le verre système n'est pas un rang. | Directive du fondateur du 2026-07-29 (« Je NE VEUX PAS une UI transparente à la iOS ») ; kit livré `packages/tokens` (`surfaceTint`) + `packages/ui` (`BobSurface`). | [01](01-experience-vision.md), [04](04-navigation-scroll-surfaces.md), [08](08-accessibility-adaptive-design.md), [09](09-technical-architecture.md), [19](19-glossary.md), [UX-ADR-004](adr/UX-ADR-004-adaptive-appearance.md) |
| **A2** | 2026-07-29 | **Retombée de bord `ProgressiveBlurBob`** : l'interdiction « jamais de blur imbriqué » visait mal et interdisait le composant prescrit par le plan P1. Trois cas distingués ; budget de performance posé ; mode teinté sans flou par défaut. | Plan P1 du fondateur [`beta-fly-services-p1-conception-ecrans.md`](../superpowers/plans/beta-fly-services-p1-conception-ecrans.md) §1.3 ; code de `davidmokos/expo-glass-tabs` → `src/progressive-blur.tsx`. | [04](04-navigation-scroll-surfaces.md), [09](09-technical-architecture.md), [10](10-performance-observability.md), [19](19-glossary.md) |
| **A3** | 2026-07-29 | **Comportement normatif de la tab bar** : deux exigences communes interdisaient littéralement le comportement demandé. Six comportements spécifiés avec leurs paramètres, notre identité conservée, la matière iOS abandonnée. | Directive du fondateur : « la même FONCTIONNALITÉ, COMPORTEMENT et EFFET que la tab bar de `github.com/davidmokos/expo-glass-tabs` ». | [04](04-navigation-scroll-surfaces.md), [10](10-performance-observability.md), [15](15-traceability-matrix.md), [16](16-implementation-backlog.md), [19](19-glossary.md), [UX-ADR-002](adr/UX-ADR-002-navigation-surfaces.md) |
| **A4** | 2026-07-29 | **Autorités normatives** : ni les deux références du fondateur, ni le kit livré n'étaient cités. Bibliographie à deux étages, l'externe subordonné à l'interne, avec la ligne de partage comportement/matière. | Directives 1 et 3 du fondateur ; inventaire du kit livré. | [17](17-references.md) |
| **A5** | 2026-07-29 | **Collision de tokens** : le document définissait un système `motion.*` concurrent de l'export public `motion` et proposait des valeurs de press qui auraient restylé l'existant. Le dossier devient explicitement additif. | Kit livré `packages/tokens` (`motion`, `motionSemantic`), `packages/ui` (`button.logic.ts`, `pressable-scale.logic.ts`) ; directive 5 du fondateur. | [03](03-motion-interaction-system.md) |
| **A6** | 2026-07-29 | **Cohérence de gouvernance** : propagation d'A1 → A5 dans les registres (décisions, risques, traçabilité, backlog, DoD, tests, baseline, roadmap) sans changer la machine. | Amendements A1 → A5. | [00](00-audit-baseline.md), [02](02-roadmap.md), [11](11-test-strategy.md), [12](12-definition-of-done.md), [14](14-risk-register.md), [15](15-traceability-matrix.md), [16](16-implementation-backlog.md), [18](18-evidence-register.md), [adr/README](adr/README.md), ce fichier |
| **A7** | 2026-07-29 | **Fait de dépendance corrigé** : A3 affirmait que Reanimated **et** Gesture Handler étaient « installés mais importés nulle part ». Vérification faite, Gesture Handler est **déjà utilisé** (root provider + deux `Swipeable`) — l'affirmation recréait la contradiction avec [09](09-technical-architecture.md) qu'elle prétendait lever ; et Reanimated, déclaré depuis `251271dc`, n'est plus « transitif ». Une roadmap normative ne s'appuie pas sur un état de dépendances faux. | Lecture directe de `apps/mobile/package.json`, de `pnpm-lock.yaml` et des imports de `apps/mobile` / `packages/ui/src` au commit `251271dc` (2026-07-28), postérieur au snapshot `2515ddf3`. | [00](00-audit-baseline.md), [04](04-navigation-scroll-surfaces.md), [09](09-technical-architecture.md), [14](14-risk-register.md), [UX-ADR-001](adr/UX-ADR-001-motion-runtime.md), [UX-ADR-002](adr/UX-ADR-002-navigation-surfaces.md), ce fichier |
| **A8** | 2026-07-29 | **Le sixième comportement est exigé, pas seulement spécifié** : [04](04-navigation-scroll-surfaces.md) définissait SIX comportements normatifs de tab bar, la gouvernance n'en exigeait que CINQ — et l'omis, la teinte pilotée par le highlight, est justement l'**EFFET** que nomme la directive. Ce qui n'est pas exigé n'est pas construit. Six exigés en bloc, deux preuves ajoutées (contraste échantillonné le long de l'interpolation, Reduced Motion sans course), `R42` ajouté. | Directive du fondateur (« FONCTIONNALITÉ, **COMPORTEMENT et EFFET** ») ; [04 § 6](04-navigation-scroll-surfaces.md#6-teinte-icônelabel-pilotée-par-le-highlight-pas-par-le-focus) ; rôles certifiés AA de `bottom-tab-bar.logic.ts`. | [04](04-navigation-scroll-surfaces.md), [10](10-performance-observability.md), [14](14-risk-register.md), [15](15-traceability-matrix.md), [16](16-implementation-backlog.md), [18](18-evidence-register.md), [19](19-glossary.md), [adr/README](adr/README.md), [UX-ADR-002](adr/UX-ADR-002-navigation-surfaces.md), ce fichier |
| **A9** | 2026-07-29 | **Repli opaque résiduel** : quatre prescriptions d'avant A1 survivaient — dont une dans l'ADR doctrinal lui-même, qui exigeait de « démontrer le fallback opaque » quand le point 6 du même ADR pose que Reduce Transparency n'a aucun effet et qu'il n'y a **pas** de fallback à déclencher. Depuis A1, l'opaque n'est plus un repli : la **surface teintée est le rang normal**. Le seul repli restant est celui de `ProgressiveBlurBob`, et il consiste à rendre ce rang 1. **(A9 en avait trouvé quatre ; une cinquième a survécu au glossaire — voir A14.)** | Amendement A1 (algorithme de surface, rangs 0 → 3) ; kit livré `surfaceTint` / `BobSurface`. | [04](04-navigation-scroll-surfaces.md), [11](11-test-strategy.md), [adr/README](adr/README.md), [UX-ADR-004](adr/UX-ADR-004-adaptive-appearance.md), ce fichier |
| **A10** | 2026-07-29 | **Handoff RN aligné sur la matière Bob** : la « Table de traduction Web → RN », document canonique **hors** de ce dossier, traduisait encore `backdrop-filter` par un `BlurView` à **teinte sombre**. Deux documents canoniques du dépôt se contredisaient donc sur la matière. Le `backdrop-filter` du proto web se traduit par une **surface teintée opaque** ; le flou reste borné au port `renderBlurLayer`. | Amendements A1/A2 ; directive du fondateur (« Je NE VEUX PAS une UI transparente à la iOS »). | [`design_handoff_bob_pro/RN_EXPO_GUIDE.md`](../../design_handoff_bob_pro/RN_EXPO_GUIDE.md) §1 et §4, ce fichier |
| **A11** | 2026-07-29 | **Fade-through tranché** : [`NAVIGATION_MAP.md`](../../design_handoff_bob_pro/NAVIGATION_MAP.md) § 6 disait « cross-fade instantané » entre onglets, [04 § 5](04-navigation-scroll-surfaces.md#5-slot-décran-qui-sefface-fade-through) dit fondu avec écran sortant masqué net. Arbitré par la directive 1 — le comportement de la référence fait foi : ce n'est ni instantané, ni un cross-fade (un cross-fade croiserait deux écrans animés, ce que la spec interdit). L'absence de slide est confirmée ; l'indicateur, lui, voyage. **(durée corrigée par A12 : A11 avait retenu 220 ms, la valeur normative est 280 ms.)** | Directive 1 du fondateur ; `davidmokos/expo-glass-tabs` → `fading-tab-slot.tsx`. | [`design_handoff_bob_pro/NAVIGATION_MAP.md`](../../design_handoff_bob_pro/NAVIGATION_MAP.md) § 6, [03](03-motion-interaction-system.md), ce fichier |
| **A12** | 2026-07-29 | **Une seule durée de fade-through, et elle vient du code** : le dossier en portait deux — 280 ms en [03 § Tokens temporels](03-motion-interaction-system.md#livrés--à-consommer-tels-quels) (`motionSemantic.replace`, dont l'usage nommé est « Fade-through, segment, filtre ») et 220 ms en [04 § 5](04-navigation-scroll-surfaces.md#5-slot-décran-qui-sefface-fade-through), au [19 — Glossaire](19-glossary.md) et dans le handoff. La valeur **livrée** du token fait foi : **280 ms**. Le 220 ms n'était adossé à aucun token et coïncidait avec `motion.base`, registre historique réservé aux écrans existants. | Lecture directe du kit : `packages/tokens/src/index.ts` l. 209 (`replace: 280`), gelé par `packages/tokens/src/index.test.ts` l. 98 et `packages/ui/src/components/motion-presence.test.ts` l. 24. | [04](04-navigation-scroll-surfaces.md) § 5, [19](19-glossary.md), [`design_handoff_bob_pro/NAVIGATION_MAP.md`](../../design_handoff_bob_pro/NAVIGATION_MAP.md) § 6, ce fichier |
| **A13** | 2026-07-29 | **Le dossier dit vrai sur lui-même** : deux affirmations qu'il portait sur son propre contenu étaient fausses. (1) Le [19 — Glossaire](19-glossary.md) affirmait que « verre système » n'y apparaissait « que pour dire qu'on ne l'emploie pas », alors que [08 § Apparence claire/sombre](08-accessibility-adaptive-design.md#apparence-clairesombre) exigeait encore de tester le « blur/verre », que la carte documentaire de ce fichier présentait 04 comme spécifiant le verre, et que `GATE-NAV-DATA` parlait encore d'un « WP-0307 verre ». Les trois passages cèdent ; l'affirmation devient vérifiable par `grep`. (2) [04 § 6](04-navigation-scroll-surfaces.md#6-teinte-icônelabel-pilotée-par-le-highlight-pas-par-le-focus) attribuait notre label d'onglet de 10 pt à `font('meta')`, qui vaut **12 pt**, et invoquait un « plancher de lisibilité » que le dépôt contredit (9,5 pt déjà rendu). | Lecture directe du code : `packages/tokens/src/index.ts` l. 147 (`meta: size 12`), `packages/ui/src/components/bottom-tab-bar.tsx` l. 94 (`fontSize: 10`), `apps/mobile/src/components/PieceDetailView.tsx` l. 346 (`fontSize: 9.5`). | [04](04-navigation-scroll-surfaces.md) § 6, [08](08-accessibility-adaptive-design.md), [16](16-implementation-backlog.md), [17](17-references.md), [19](19-glossary.md), [UX-ADR-004](adr/UX-ADR-004-adaptive-appearance.md), ce fichier |
| **A14** | 2026-07-29 | **Cinquième prescription de repli, au glossaire** : l'entrée « Reduce Transparency » définissait encore la préférence comme « imposant des surfaces plus opaques » avec un « fallback » qui « ne perd aucune fonction » — l'algorithme d'avant A1, où l'opaque était un repli déclenché par la préférence. Reformulée sur la doctrine en vigueur : la surface teintée opaque est le **rang normal**, la préférence n'a rien à remplacer, et son seul effet possible est de **retirer les échantillons de flou** de la retombée de bord — même géométrie, même courbe, même couleur. Aucun chemin de rendu alternatif. | Amendement A1 (algorithme de surface, rangs 0 → 3, `reduceTransparency → aucun effet`) ; [08 § Reduce Transparency](08-accessibility-adaptive-design.md#reduce-transparency) ; [04 § Matières](04-navigation-scroll-surfaces.md#matières) ; [UX-ADR-004](adr/UX-ADR-004-adaptive-appearance.md) point 6. | [19](19-glossary.md), ce fichier |
| **A15** | 2026-07-29 | **Commande d'installation alignée sur sa propre note** : [`RN_EXPO_GUIDE.md`](../../design_handoff_bob_pro/RN_EXPO_GUIDE.md) §1 installait `expo-blur` dans son `npx expo install`, trois lignes au-dessus de la note d'A10 déclarant que `expo-blur` n'est pas une dépendance du produit. Une commande exécutable qui contredit sa propre note est pire qu'une phrase fausse : quelqu'un la lance, et la dépendance entre par la porte que la doctrine ferme. `expo-blur` retiré de la commande ; il ne peut entrer que par le port `renderBlurLayer`, dans `apps/mobile`, sur décision `D08`. | Amendements A1/A2/A10 ; vérification que `expo-blur` n'est déclaré dans **aucun** `package.json` du dépôt. | [`design_handoff_bob_pro/RN_EXPO_GUIDE.md`](../../design_handoff_bob_pro/RN_EXPO_GUIDE.md) §1, ce fichier |
| **A16** | 2026-07-29 | **Balayage numérique final du handoff** : le tableau « durées & courbes **figées** » de [`RN_EXPO_GUIDE.md`](../../design_handoff_bob_pro/RN_EXPO_GUIDE.md) §8 portait trois valeurs que le code livré contredit. (1) `withTiming(0.94, {duration:90})` pour « FAB / Pressable » mélangeait l'échelle du `Button` (0,94, **instantanée**) et la durée du `PressableScale` (90 ms), et prescrivait 0,94 à toute surface pressable là où le kit livre **0,98** + opacité 0,9 en 90/150 ms — contredisant [03 § Press states](03-motion-interaction-system.md#press-states). (2) Balayage OCR `duration:1400` contre `SCAN_SWEEP_DURATION_MS = 1100`. (3) Ligne Toast portant un identifiant corrompu (`withالسpring`) qui ne compile pas. Plus un caveat sur « Reanimated pour toutes les animations », qui pré-emptait `UX-ADR-001` encore `Proposed`. | Lecture directe du code : `packages/ui/src/components/button.logic.ts` l. 46, `pressable-scale.logic.ts`, `toast.tsx` (`AUTO_DISMISS_MS = 2400`, `bottom: 122`), `apps/mobile/src/scan/scan-reading-motion.ts`. | [`design_handoff_bob_pro/RN_EXPO_GUIDE.md`](../../design_handoff_bob_pro/RN_EXPO_GUIDE.md) §1 et §8, ce fichier |

| **A17** | 2026-07-30 | **Une zone non interactive ne porte aucune cible tactile** : A3 justifiait une cible ≥ 44 pt au repli de la tab bar par « le débord de retombée » — or la retombée est `pointerEvents="none"` et ne reçoit **aucune** touche. Le raisonnement inversait la cause. Règle rétablie : seul le **visuel intérieur** descend à 35 pt ; le `Pressable` reste ≥ **44 pt (iOS) / 48 dp (Android)**, complété au besoin par un `hitSlop` vertical non chevauchant, avec la condition vérifiable « aucun ancêtre `overflow: hidden` ». | Lecture directe de `packages/ui/src/components/bottom-tab-bar.tsx` (l. 78 `minHeight: 44`, l. 111 `pointerEvents="none"`) ; [08 § Cibles tactiles](08-accessibility-adaptive-design.md#cibles-tactiles). | [03](03-motion-interaction-system.md), [04](04-navigation-scroll-surfaces.md), [08](08-accessibility-adaptive-design.md), [11](11-test-strategy.md), [12](12-definition-of-done.md), [19](19-glossary.md), [`RN_EXPO_GUIDE`](../../design_handoff_bob_pro/RN_EXPO_GUIDE.md) §10, ce fichier |
| **A18** | 2026-07-30 | **Préférences d'accessibilité fail-CLOSED au premier rendu** : elles se lisent de façon **asynchrone** et le dossier prescrivait implicitement de considérer « pas de réduction » tant qu'on ne sait pas — donc d'animer avant de savoir. Fail-OPEN sur une préférence d'accessibilité. Trois états (`inconnue`/`active`/`inactive`), l'inconnu se replie du côté sûr ; le flash inverse est évité par une **résolution unique hissée au démarrage** derrière le splash et par l'interdiction de **rejouer** une animation déjà résolue. | `packages/ui/src/hooks/use-reduce-motion.ts` (`useState(false)` + lecture asynchrone) ; règle 7 de [03](03-motion-interaction-system.md#règles-fondamentales). | [03](03-motion-interaction-system.md), [04](04-navigation-scroll-surfaces.md), [08](08-accessibility-adaptive-design.md), [09](09-technical-architecture.md), [10](10-performance-observability.md), [11](11-test-strategy.md), [12](12-definition-of-done.md), [14](14-risk-register.md) (`R43`), [17](17-references.md), [19](19-glossary.md), ce fichier |
| **A19** | 2026-07-30 | **Géométrie qui survit à Dynamic Type** : A3 posait `58 → 44 pt` et `50 → 35 pt` en dur sur une barre qui **contient du texte**, contre [08](08-accessibility-adaptive-design.md#typographie) (« pas de hauteur fixe sur un bloc contenant du texte ») et `R12`. Les points deviennent des **planchers à la taille standard** ; ce qui s'adapte, ce qui reste fixe et ce qui passe sur deux lignes puis disparaît est tranché par un palier déterministe (une ligne → deux lignes → icônes seules, **jamais** de troncature, `adjustsFontSizeToFit` interdit). | [08 § Typographie](08-accessibility-adaptive-design.md#typographie) ; `R12` ; `PERF-12`. | [04](04-navigation-scroll-surfaces.md), [08](08-accessibility-adaptive-design.md), [11](11-test-strategy.md), [19](19-glossary.md), ce fichier |
| **A20** | 2026-07-30 | **Contrat `expo-blur` exécutable (Expo 57)** : le port `renderBlurLayer` était nommé partout, son contrat de props nulle part — ni `BlurTargetView`, ni `blurTarget`, ni `blurMethod`. Sans eux, la valeur par défaut `blurMethod: 'none'` rend une **vue semi-transparente**, c'est-à-dire exactement la matière hors doctrine : l'oubli produisait la faute silencieusement. Rangs posés : Android **≥ 31** = flou possible (`dimezisBlurViewSdk31Plus`, `RenderNode`), Android **< 31** = **N0, port non monté**, `experimentalBlurMethod` interdite, et une coupure de plus — `BlurTargetView` ne traverse pas un `Modal` RN. | Documentation Expo SDK 57 pinée, <https://docs.expo.dev/versions/v57.0.0/sdk/blur-view/>, consultée le 2026-07-30 ; limitation `Modal` : expo/expo#44165. | [04](04-navigation-scroll-surfaces.md), [09](09-technical-architecture.md), [17](17-references.md), ce fichier |
| **A21** | 2026-07-30 | **`PERF-13` devient exécutable** : le scénario existait, mais rien ne disait **quoi** mesurer, avec **quel seuil**, ni **quoi faire** au dépassement — et [11 § Performance](11-test-strategy.md#performance) s'arrêtait à `PERF-12`, laissant le seul scénario de la tab bar hors de la stratégie. Quatre passes (repos, repli/dépli, tab-hopping, scrub), deux budgets nouveaux (coût constant au repos, latence du tick), une famille d'owners, une ligne de rollback et quatre cas d'accessibilité obligatoires. | Budgets existants de [10](10-performance-observability.md#budgets-initiaux-proposés) ; `R40`, `R42` ; coût du double glyphe (A8). | [10](10-performance-observability.md), [11](11-test-strategy.md), ce fichier |
| **A22** | 2026-07-30 | **Le ressort ne barre pas la navigation** : « recalage au ressort **puis** navigation » se lisait comme une séquence temporelle et imposait d'attendre 420 ms avant de changer d'écran — contre la règle fondamentale n° 3 de [03](03-motion-interaction-system.md#règles-fondamentales) et le plafond « transition fréquente ≤ 300 ms ». « Puis » désignait une **dépendance de valeur**, pas un ordre : les deux effets partent dans la **même frame**, avec une preuve filmée. | [03 § Règles fondamentales](03-motion-interaction-system.md#règles-fondamentales) ; [10 § Budgets](10-performance-observability.md#budgets-initiaux-proposés). | [04](04-navigation-scroll-surfaces.md), [11](11-test-strategy.md), [19](19-glossary.md), ce fichier |
| **A23** | 2026-07-30 | **`BobSurface` ne propage ni `ink` ni `highContrast`** : le dossier décrivait une garantie AA « portée par la surface » ; elle est portée par un **couple** texte/fond, et le composant ne pose pas le texte. `ink`/`inkMuted` sont calculés puis **non exposés** aux `children` ; `highContrast` est une prop par instance, ni lue du système ni héritée. Cas de preuve **réel et sous AA** : `equipements/[chantierId].tsx` l. 274-278 rend `colors.slate500` `#5B6B7B` sur `warning.raised` `#F6E4C6` = **4,39:1** en texte normal 13,5 pt. Second relevé : l'exemple de teinte de highlight `#E2E9F2` fait tomber `navigation.inactive` à **4,48:1** — retiré. | Lecture directe de `bob-surface.tsx` / `.logic.ts` ; `apps/mobile/app/equipements/[chantierId].tsx` ; calcul WCAG aux bornes de `packages/tokens/src/index.test.ts`. | [01](01-experience-vision.md), [04](04-navigation-scroll-surfaces.md), [12](12-definition-of-done.md), [14](14-risk-register.md) (`R44`), [17](17-references.md), [19](19-glossary.md), [adr/README](adr/README.md), [UX-ADR-004](adr/UX-ADR-004-adaptive-appearance.md), ce fichier |
| **A24** | 2026-07-30 | **Le bootstrap qui prenait une décision d'ADR** : [`RN_EXPO_GUIDE.md`](../../design_handoff_bob_pro/RN_EXPO_GUIDE.md) §1 **installait** `expo-haptics` dans sa commande `npx expo install`, alors que `UX-ADR-006` est `Proposed`, que [09](09-technical-architecture.md#état-de-dépendances-observé) conditionne l'ajout à « ADR Accepted **et** certification acoustique » et que [04](04-navigation-scroll-surfaces.md#bornes-de-livraison) le nomme « la seule dépendance réellement absente ». Même motif qu'A15 : une commande exécutable prime sur la prose. Retiré, avec `@gorhom/bottom-sheet` et Skia, qui étaient dans le même cas. | Amendement A15 ; [UX-ADR-006](adr/UX-ADR-006-haptic-feedback.md) ; vérification qu'aucun `package.json` du dépôt ne déclare ces paquets. | [`RN_EXPO_GUIDE`](../../design_handoff_bob_pro/RN_EXPO_GUIDE.md) §1, [UX-ADR-006](adr/UX-ADR-006-haptic-feedback.md), ce fichier |
| **A25** | 2026-07-30 | **Les gates certifiaient un SDK que le produit n'exécute plus** : quatre autorités actives portaient « Expo 56 / RN 0.85 », dont **deux preuves minimales d'ADR** — donc deux gates. Le mobile est sur **Expo 57.0.8 / RN 0.86.0 / React 19.2.3 / Expo Router 57.0.8**. Toutes actualisées ; la baseline `00` garde son millésime avec une note datée, comme `B10`/`A7`. Un tableau unique de versions intégrées est posé en [17](17-references.md#versions-réellement-intégrées) pour que la prochaine dérive se voie à un seul endroit. | `apps/mobile/package.json`, lu le 2026-07-30. | [00](00-audit-baseline.md), [04](04-navigation-scroll-surfaces.md), [09](09-technical-architecture.md), [17](17-references.md), [UX-ADR-001](adr/UX-ADR-001-motion-runtime.md), [UX-ADR-006](adr/UX-ADR-006-haptic-feedback.md), ce fichier |
| **A26** | 2026-07-30 | **`Button` et `Toast` décrits contrairement au code** : (1) [03 § Bouton principal](03-motion-interaction-system.md#bouton-principal) prescrivait « press-in 80 ms » et « release par `motionSemantic.spring` » alors que le `Button` livré applique son échelle dans la **fonction de style** du `Pressable` — instantanée, sans durée ni ressort — et le même document disait « instantané » deux lignes plus haut ; (2) sa hauteur minimale livrée est **48**, pas 44 ; (3) il n'expose **ni `success` ni `error`** ; (4) la ligne Toast du handoff, « corrigée » par A16, annonçait encore `withSpring` là où `toast.tsx` utilise `Animated.timing` **200/180 ms** — réparer la graphie d'une valeur fausse la laisse fausse. Ajouté : `pointerEvents="none"` interdit tout Undo dans le toast livré. | Lecture directe de `button.tsx`, `button.logic.ts`, `pressable-scale.logic.ts`, `toast.tsx`. | [03](03-motion-interaction-system.md), [17](17-references.md), [`RN_EXPO_GUIDE`](../../design_handoff_bob_pro/RN_EXPO_GUIDE.md) §8, ce fichier |
| **A27** | 2026-07-30 | **Quatre dettes de rigueur soldées** : (1) la source de comportement était citée par sa **branche** — épinglée sur `expo-glass-tabs@0.1.1`, shasum, integrity et `gitHead` ; (2) le **double glyphe** et l'interdiction d'`onLayout` étaient écrits comme des exigences alors que ce sont des **moyens** — invariant et moyen séparés, alternative recevable sous trois conditions ; (3) les **contrôles statiques** de [11](11-test-strategy.md#tests-statiques) étaient cités comme preuves de sortie alors qu'aucun n'existait dans le dépôt — état réel écrit, `NOT RUN` tant qu'ils ne sont pas exécutables, **et un premier validateur livré** : `scripts/check-mobile-experience-docs.mjs` (16 contrôles verts au 2026-07-30) qui valide le socle **contre le code** et a lui-même trouvé une ancre morte dans [02](02-roadmap.md) ; (4) l'**enveloppe de la retombée** dépendait d'une hauteur de chrome qui s'anime tout en se déclarant « jamais animée » — enveloppe dimensionnée une fois sur l'état étendu, `transform` interdit, mode flouté exclu d'un chrome qui se minimise. Plus l'a11y des **doubles SVG** (glyphes retirés de l'arbre d'accessibilité). | Registre npm `expo-glass-tabs` ; inspection du dépôt le 2026-07-30 (aucun `scripts/`, aucun job CI, `package.json` racine) ; `apps/mobile/src/components/icons.tsx`. | [02](02-roadmap.md), [04](04-navigation-scroll-surfaces.md), [11](11-test-strategy.md), [16](16-implementation-backlog.md), [17](17-references.md), [19](19-glossary.md), [adr/README](adr/README.md), `scripts/check-mobile-experience-docs.mjs` (nouveau), ce fichier |

Ces amendements **ne modifient aucun code applicatif, n'ajoutent aucune dépendance et ne touchent
aucun écran**. Ils ne changent ni le nombre d'exigences (77), ni les gates, ni les statuts, ni les
owners — tous restent **à affecter**.

**Défauts de code signalés, non corrigés (2026-07-30).** Trois constats faits en écrivant `A18`,
`A23` et `A26` relèvent du **code**, pas du document, et sont hors de ce lot documentaire. Ils sont
consignés ici pour ne pas se perdre : le fail-OPEN de `use-reduce-motion.ts`, le couple
texte/fond à **4,39:1** de `equipements/[chantierId].tsx`, et l'`accessibilityState.disabled`
qui reste `false` pendant `loading` dans `button.tsx`. Le premier et le deuxième sont des écarts
d'accessibilité ; aucun n'est réparable par une phrase.

**Portée hors dossier.** `A7`, `A10`, `A11`, `A12`, `A15`, `A16` — et, le 2026-07-30, `A17`, `A24`
et `A26` — amendent des documents canoniques **hors** `docs/mobile-experience` : trois fichiers du
handoff design, `NAVIGATION_MAP.md`, `RN_EXPO_GUIDE.md` et `SPEC_LOT_RETOURS_DEVICE_20260714.md`. Ils y sont journalisés parce qu'une doctrine qui
n'est propagée que dans son propre dossier laisse la contradiction se reformer ailleurs — c'est
exactement ce que ces amendements corrigent. Les prototypes `.dc.html` et `.jsx` du handoff
ne sont pas touchés : ce sont des artefacts **web** historiques, pas des prescriptions RN.

## Objet

Ce dossier transforme l'audit visuel et motion du 22 juillet 2026 en un programme de livraison
exécutable. Il décrit ce que Bob doit devenir, dans quel ordre, avec quelles frontières techniques,
quels critères d'acceptation et quelles preuves de qualité.

Le programme vise une expérience de référence, comparable en finition aux meilleures applications
natives, sans :

- modifier les règles métier, financières, fiscales ou de sécurité ;
- inventer un succès, une progression ou un état qui n'existe pas réellement ;
- retarder une action backend pour terminer une animation ;
- recopier Siri, Gemini, ChatGPT ou un langage visuel tiers ;
- transformer Bob en démonstration de glassmorphism ou en catalogue d'effets ;
- **(ajouté A1 · 2026-07-29)** emprunter la matière d'un système d'exploitation : la surface de Bob
  est **teintée et opaque** (`surfaceTint` / `BobSurface`), sur les deux OS et à toutes les
  versions. « Je NE VEUX PAS une UI transparente à la iOS » (directive du fondateur).

La règle directrice est : **animer la causalité, l'état et la continuité spatiale ; préserver le
contrôle et la vérité du système**.

## Hiérarchie d'autorité

En cas de contradiction, l'ordre suivant s'applique :

1. invariants légaux, financiers, de sécurité, de consentement et comportement du code canonique ;
2. ADR acceptés et dernier cap de publication fondateur intégré à la branche canonique ;
3. contrats fonctionnels, de confirmation et de ton qui n'ont pas été supersédés ;
4. décisions `Accepted` du présent dossier ;
5. implémentation courante comme baseline factuelle, vérifiée au commit indiqué ;
6. handoff, prototypes et guides visuels historiques comme intention de référence ;
7. propositions `Proposed` du présent dossier ;
8. exemples visuels et valeurs indicatives.

Une proposition UX n'autorise jamais à contourner une confirmation, une révision, un ACK backend,
une règle RLS, une politique d'entitlement ou une dégradation fail-closed.

Le cap de publication accepté est désormais intégré à la branche canonique via
[OBJECTIFS_SPECS_DOD_PUBLICATION](../../design_handoff_bob_pro/OBJECTIFS_SPECS_DOD_PUBLICATION.md)
et
[l'ADR fournisseur de publication](../adr/0004-gpt-realtime-publication-mistral-v3-post-v1.md).
Cette intégration satisfait la dépendance documentaire, mais **ne lève pas à elle seule
D00/GATE-PUBLICATION** : le présent dossier reste préparatoire jusqu'au rescoping explicite du
feature freeze et à l'affectation des responsables exigés.

## Carte documentaire

| Document | Rôle | Lecteurs prioritaires |
| --- | --- | --- |
| [00 — Baseline](00-audit-baseline.md) | Fige l'état actuel, les notes, les preuves et la cible mesurable. | Tous |
| [01 — Vision](01-experience-vision.md) | Définit la direction artistique, les principes et les anti-patterns. | Produit, design, mobile |
| [02 — Roadmap](02-roadmap.md) | Ordonne les phases, jalons, dépendances, gates et scénarios de capacité. | Direction, produit, delivery |
| [03 — Système motion](03-motion-interaction-system.md) | Spécifie timings, ressorts, transitions, haptique et comportement réduit. | Design, mobile, QA |
| [04 — Navigation et surfaces](04-navigation-scroll-surfaces.md) | Spécifie routes, tabs, headers, scroll, sheets, menus, **matières** (surface teintée opaque, retombée de bord) et adaptation. **(corrigé A13 : « verre » — 04 ne le spécifie pas, il l'exclut.)** | Design, mobile |
| [05 — Bob Live](05-bob-live-experience.md) | Définit la signature vocale, la machine visuelle et les retours multimodaux. | Voix, design, mobile, QA |
| [06 — Écrans](06-screen-by-screen-spec.md) | Donne les exigences des 33 surfaces, correspondant à 32 routes physiques plus l'expérience auth agrégée. | Produit, design, mobile |
| [07 — Content design](07-content-design.md) | Cadre statuts, confirmations, erreurs, ton et texte temporel. | Produit, contenu, juridique |
| [08 — Accessibilité](08-accessibility-adaptive-design.md) | Spécifie Dynamic Type, contraste, lecteurs d'écran, motion et adaptation. | Accessibilité, design, QA |
| [09 — Architecture](09-technical-architecture.md) | Définit les frontières, modules, états, dépendances et stratégie de migration. | Tech leads, mobile, voix |
| [10 — Performance](10-performance-observability.md) | Fixe budgets, métriques, instrumentation et critères de rollback. | Mobile, SRE, QA |
| [11 — Tests](11-test-strategy.md) | Définit la pyramide de tests, la matrice appareils et les preuves attendues. | QA, mobile, design |
| [12 — Definition of Done](12-definition-of-done.md) | Donne les checklists binaires globales, composant, écran et Bob Live. | Tous les builders/reviewers |
| [13 — Gouvernance](13-delivery-governance.md) | Définit rôles, revues, flags, rollout, change control et rituels. | Produit, design, engineering |
| [14 — Risques](14-risk-register.md) | Registre les risques, signaux, propriétaires et mitigations. | Direction, leads |
| [15 — Traçabilité](15-traceability-matrix.md) | Garantit la couverture de G01–G22, V01–V14, S01–S33 et T01–T08. | PM, QA, audit |
| [16 — Backlog](16-implementation-backlog.md) | Décompose le programme en epics, work packages, dépendances et règles de découpage testables. | Delivery, engineering |
| [17 — Références](17-references.md) | Centralise sources normatives, documentation technique et caveats de version. | Tous |
| [18 — Preuves](18-evidence-register.md) | Enregistre owner, statut, manifest, build, verdict, reviewers et waivers pour 77/77. | QA, release, audit |
| [19 — Glossaire](19-glossary.md) | Fixe le sens des termes produit, delivery, runtime et design employés. | Tous |
| [ADR UX](adr/README.md) | Capture les décisions d'architecture proposées et leurs alternatives. | Architecture, mobile, design |

## Métadonnées et propriétaires documentaires

Sauf override explicite, les constats de code de ce dossier héritent du snapshot `2515ddf3` et de
la date de formalisation 2026-07-23 ; les références web ont été vérifiées le 2026-07-22. Une
modification de code ou de dépendance n'actualise pas automatiquement ce snapshot : le reviewer doit
mettre à jour le document concerné et le registre ci-dessous.

Un owner rôle n'est pas un owner effectif. Toutes les lignes restent **à affecter** parce que le
dossier est `Proposed`; aucune ne peut devenir `Accepted` avant qu'une personne nommée accepte la
responsabilité.

| Document | Owner rôle attendu | Owner nommé | Dernière référence |
|---|---|---|---|
| 00 Baseline | QA + Product Design | À affecter | code `2515ddf3` |
| 01 Vision | Design owner | À affecter | audit 2026-07-22 |
| 02 Roadmap | Product owner / delivery | À affecter | cap canonique de publication |
| 03 Motion | Design owner + Mobile | À affecter | code `2515ddf3` |
| 04 Navigation | Mobile tech lead + Design | À affecter | code `2515ddf3` |
| 05 Bob Live | Bob Live owner + Design | À affecter | code `2515ddf3`, cap canonique de publication |
| 06 Écrans | Product Design | À affecter | code `2515ddf3` |
| 07 Content | Content owner | À affecter | contrats existants au `2515ddf3` |
| 08 Accessibilité | Accessibility reviewer | À affecter | code `2515ddf3` |
| 09 Architecture | Mobile tech lead | À affecter | code `2515ddf3` |
| 10 Performance | QA/performance owner | À affecter | code `2515ddf3` |
| 11 Tests | QA owner | À affecter | stratégie 2026-07-23 |
| 12 DoD | QA owner + Product owner | À affecter | programme 2026-07-23 |
| 13 Gouvernance | Product owner | À affecter | programme 2026-07-23 |
| 14 Risques | Product + Tech leads | À affecter | programme 2026-07-23 |
| 15 Traçabilité | QA owner | À affecter | audit 77/77 |
| 16 Backlog | Delivery owner | À affecter | programme 2026-07-23 |
| 17 Références | Architecture owner | À affecter | web 2026-07-22, git 2026-07-23 |
| 18 Preuves | QA owner | À affecter | initialisé 2026-07-23 |
| 19 Glossaire | Content owner | À affecter | programme 2026-07-23 |
| UX-ADR-001–006 | Décideurs listés dans chaque ADR | À affecter | spikes futurs WP-0004 |

La mise à jour d'un owner nommé, d'un snapshot ou d'un statut se fait dans ce registre et dans
l'en-tête du document au même changement. Le registre est l'autorité si un ancien export diverge.

**Amendements du 2026-07-29 et du 2026-07-30.** Les documents concernés portent en tête un encadré
daté (`A1` → `A27`) qui nomme sa source et sa portée ; la liste fait foi dans les fichiers
eux-mêmes, pas ici — une énumération recopiée devient fausse au premier amendement suivant. La
colonne « Dernière référence » ci-dessus reste valable : ces amendements n'actualisent **pas** le
snapshot de code `2515ddf3` du corps historique — ils ajoutent une seconde référence, le kit
« matière Bob » livré et testé, dont les chemins exacts sont listés dans
[17 § Autorités normatives](17-references.md#autorités-normatives). Aucun owner n'est affecté
par ces amendements : toutes les lignes restent **à affecter**.

**Exceptions A7 et A25.** Deux amendements **actualisent** bien le snapshot, sur des points uniques
et nommés. `A7` corrige un état de dépendances qui a changé **après** `2515ddf3` (commit
`251271dc`) ; les constats concernés — [00](00-audit-baseline.md) `B10`,
[09](09-technical-architecture.md) § État de dépendances,
[UX-ADR-001](adr/UX-ADR-001-motion-runtime.md) § Contexte — portent la mention `corrigé A7` et
citent le commit vérifié. `A25` corrige le **SDK de référence**, pour la même raison et avec la
même discipline : le corps de [00](00-audit-baseline.md) garde son millésime `2515ddf3` avec une
note datée, tandis que les **gates** — en-tête de [09](09-technical-architecture.md), preuves
minimales de [UX-ADR-001](adr/UX-ADR-001-motion-runtime.md) et
[UX-ADR-006](adr/UX-ADR-006-haptic-feedback.md) — passent à Expo 57 / RN 0.86, parce qu'une gate
certifie l'avenir et non le passé. Le tableau de référence unique vit désormais en
[17 § Versions réellement intégrées](17-references.md#versions-réellement-intégrées). Tous les
autres constats de code restent hérités de `2515ddf3`.

## Parcours de lecture

### Décision produit

Lire `00`, `01`, `02`, `12`, `14`, puis la matrice `15`.

### Implémentation mobile

Lire `01`, `03`, `04`, `08`, `09`, `10`, `11`, `12`, puis les ADR UX.

### Bob Live

Lire les ADR Bob Live existants, puis `05`, `07`, `08`, `10`, `11` et `12`.

### Conception d'un écran

Lire `06`, puis les règles transversales `03`, `04`, `07` et `08`. Aucun écran ne peut définir
seul un nouveau timing, une nouvelle matière, une nouvelle haptique ou un nouveau statut.

## Identifiants stables

| Préfixe | Domaine | Étendue |
| --- | --- | --- |
| `G` | Fondations globales | `G01` à `G22` |
| `V` | Bob Live et voix | `V01` à `V14` |
| `S` | Écrans et routes | `S01` à `S33` |
| `T` | Content design | `T01` à `T08` |
| `E` | Epic de delivery | `E00` à `E12` |
| `WP` | Work package de delivery, à découper s'il reste `XL` | `WP-####`, puis enfants immuables `WP-####-NN` |
| `UX-ADR` | Décision d'architecture de ce programme | Numérotation locale |

Ces identifiants ne sont jamais recyclés. Une exigence supprimée reste dans l'historique avec le
statut `Rejected`, `Deprecated` ou `Superseded`.

## Statuts documentaires

- `Draft` : structure incomplète ; ne peut pas alimenter un ticket.
- `Proposed` : proposition complète en attente de revue/validation.
- `Accepted` : contrat validé, implémentation autorisée.
- `In progress` : au moins un work package est en construction.
- `Verified` : implémentation et preuves satisfont la DoD.
- `Deferred` : exigence conservée mais reportée par décision signée, avec impact et date de réexamen.
- `Deprecated` : ne s'applique plus, historique conservé.
- `Superseded` : remplacé par une décision liée.
- `Rejected` : étudié mais volontairement non retenu.

Le présent dossier est `Proposed`. L'acceptation doit être explicite et peut être faite par lots ;
elle ne doit pas être déduite du démarrage d'un autre chantier.

## Règles non négociables

1. **Truth first** : l'UI dérive des états canoniques ; elle n'invente aucune phase.
2. **Backend first** : l'animation n'avance jamais un statut métier et ne bloque jamais un ACK.
3. **Native first** : utiliser le comportement plateforme lorsque sa sémantique correspond.
4. **Bob, pas un clone** : conserver la palette, les formes, les polices et la voix propres à Bob.
   **(précisé A1 · 2026-07-29)** Cela inclut la **matière** : aucune surface ne délègue sa couleur
   au système. Un comportement de référence externe peut être repris intégralement ; sa matière,
   jamais.
5. **Une chorégraphie dominante** : aucune page ne cumule plusieurs effets concurrents.
6. **Motion facultative** : chaque effet possède une variante Reduce Motion complète.
7. **Performance mesurée** : aucune sensation premium ne repose sur une animation non profilée.
8. **Accessibilité comme gate** : pas comme tâche de finition.
9. **Actions sensibles sobres** : aucune célébration avant résultat durable.
10. **Dégradation honnête** : matière, zoom, haptique et voix ont toujours un fallback.
11. **Clean Architecture** : le domaine et l'application restent indépendants de React Native.
12. **Feature flags** : les migrations de chrome, motion et Bob Live restent désactivables.

## Hors périmètre

- Refonte des règles de calcul, des use cases ou du modèle fiscal.
- Changement de provider de voix, de protocole ou d'autorité de session.
- Modification des entitlements ou des plans commerciaux.
- Refonte du site web ou de l'espace cabinet, sauf cohérence de tokens documentée.
- Nouvelle identité de marque complète.
- Implémentation de code dans le cadre de ce dossier.

## Conditions de démarrage d'un lot

Un lot ne peut passer à `In progress` que si :

- ses exigences et exclusions sont `Accepted` ;
- l'ADR correspondant est accepté lorsqu'une dépendance structurante change ;
- le mapping audit → work package → test est complet ;
- une capture ou vidéo baseline existe ;
- le support plateforme et le fallback sont connus ;
- le risque de concurrence avec un chantier actif est résolu ;
- le plan de mesure et le rollback sont écrits avant le premier changement visible.

## Maintenance

- Ne jamais réécrire silencieusement un ADR accepté ; le superséder.
- Mettre à jour la matrice de traçabilité dans le même changement que la spec.
- Mettre à jour le registre de preuves dans le même changement que le verdict d'un ID.
- Lier toute dérogation de motion, accessibilité ou performance à une décision explicite.
- Rejouer le reader test documentaire après toute modification structurante.
- Revalider les liens et versions Expo/React Native avant chaque phase d'implémentation.
