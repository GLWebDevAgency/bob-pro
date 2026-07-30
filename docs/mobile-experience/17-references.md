# Références et dépendances documentaires

> Statut : **Proposed reference set**
> Sources web vérifiées le 2026-07-22 ; à revalider avant chaque phase
>
> **Amendement A4 — 2026-07-29 · autorités normatives**
> Ajoute la section « Autorités normatives » ci-dessous. Motif : ni les deux références désignées
> par le fondateur, ni le kit « matière Bob » déjà livré n'étaient cités dans les 5 603 lignes de ce
> dossier. Les tables existantes (Apple, Material, Expo/RN, Reanimated, accessibilité, voix) ne sont
> pas réécrites ; deux lignes reçoivent un caveat daté.
>
> **Amendements 2026-07-30**
>
> - **A18/A23/A26 · l'étage 1 dit ce que le kit fait, et ce qu'il ne fait pas** — trois lignes
>   précisées (`Surface`, `Mouvement réduit`) et deux ajoutées (`Boutons et press`, `Toast`). Une
>   autorité qui ne nomme que les garanties laisse croire que le reste est garanti aussi.
> - **A27 · épinglage de la source externe** — § Épinglage de la source externe (nouveau). La
>   référence de comportement était citée par sa **branche**.
> - **A25 · versions réellement intégrées** — § Politique de version, tableau nouveau.
> - **A20 · documentation `expo-blur` pinée sur SDK 57** — ligne `BlurView` de la table Expo/RN ;
>   `versions/latest` proscrit.
> - **A29 · limitations officielles `expo-blur`** — même ligne : englobement dans un
>   `BlurTargetView` unique, et non-rafraîchissement au-dessus d'un contenu dynamique.

## Autorités normatives

> Ajouté A4 · 2026-07-29. Cette section a **deux étages**, et l'étage 2 est **subordonné** à
> l'étage 1. Elle est référencée depuis [01](01-experience-vision.md),
> [03](03-motion-interaction-system.md), [04](04-navigation-scroll-surfaces.md),
> [08](08-accessibility-adaptive-design.md), [09](09-technical-architecture.md),
> [10](10-performance-observability.md), et depuis
> [UX-ADR-002](adr/UX-ADR-002-navigation-surfaces.md) et
> [UX-ADR-004](adr/UX-ADR-004-adaptive-appearance.md).

### Étage 1 — Autorité de MATIÈRE, interne (la plus forte)

Le kit « matière Bob » est **livré, testé et consommé en production P1**. Il ne s'agit pas d'une
intention de design : c'est du code exécutable avec ses tests.

| Norme exécutable | Chemin | Ce qu'elle fixe |
| --- | --- | --- |
| Tokens de surface | `packages/tokens/src/index.ts` (l. 214-257) | `surfaceTint` : 2 apparences × 6 tons × `{flat, raised, border, ink, inkMuted}`, opacités **pré-composées en hex**. Le commentaire du bloc **est** la doctrine : « surfaces TEINTÉES OPAQUES (jamais la transparence iOS) ». |
| Tokens de motion | `packages/tokens/src/index.ts` (l. 184-212) | `motion` (historique : `fast` 200, `base` 220, `content` 360, `ambient` 1500) et `motionSemantic` (additif : `feedbackIn` 80, `feedbackOut` 160, `exitFast` 140, `enterFast` 180, `enter` 240, `replace` 280, `spring` `{damping 26, stiffness 300, mass 1}`). |
| Contrastes | `packages/tokens/src/index.test.ts` | `ink`/`inkMuted` certifiés AA sur `flat` **et** `raised`, pour les 12 specs. |
| Surface | `packages/ui/src/components/bob-surface.tsx` + `.logic.ts` + `.test.ts` | `tone` × `emphasis` (`flat`/`raised`/`floating`), bordure 1 pt `border` ou 2 pt `ink` en Increase Contrast, `shadowNative.e2` en `floating`. Aucune `BlurView`, aucun `rgba`, aucune capability runtime. **(précisé A23 · 2026-07-30)** Le composant pose fond, bordure et ombre — **pas** la couleur du texte : `ink`/`inkMuted` sont calculés mais **non exposés** aux `children`, et `highContrast` est une prop par instance, ni lue du système ni héritée. Voir [UX-ADR-004 § Ce que `BobSurface` ne fait PAS](adr/UX-ADR-004-adaptive-appearance.md#ce-que-bobsurface-ne-fait-pas--ink-et-highcontrast-ne-se-propagent-pas). |
| Boutons et press | `packages/ui/src/components/button.tsx` + `button.logic.ts` + `pressable-scale.logic.ts` | **(ajouté A26 · 2026-07-30)** `Button` : échelle **0,94 instantanée** (fonction de style du `Pressable`, ni durée ni ressort), `BUTTON_MIN_HEIGHT = 48` posé en `minHeight` **et** `minWidth` (taille `regular`), `hitSlop: 6` en taille `compact`, radius borné 11–15, **ni `success` ni `error`**. `PressableScale` : **0,98** + opacité **0,9**, **90 ms** in / **150 ms** out, cible ≥ 44 pt. |
| Toast | `packages/ui/src/components/toast.tsx` | **(ajouté A26 · 2026-07-30)** `Animated` RN (`useNativeDriver`), entrée **200 ms** (`translateY` 16 → 0 + opacité), sortie **180 ms**, auto-dismiss **2 400 ms**, `bottom: 122`, `pointerEvents="none"` (**aucune touche, donc aucun Undo possible dedans**), `accessibilityRole="alert"` + `accessibilityLiveRegion="polite"`. Les 200/180 ms **ne sont aucun token**. |
| Présence et remplacement | `packages/ui/src/components/motion-presence.tsx` + `.logic.ts` | `useRowPresence`, `PresenceRow` (enter 240 + `translateY` 6 → 0, exit 140), `MorphReplace` (replace 280 en 2 × 140, échelle 0,96 → 1, interruptible). Transform/opacity uniquement. |
| Mouvement réduit | `packages/ui/src/hooks/use-reduce-motion.ts` | Implémentation **unique**. Règle produit inscrite dans le fichier : ambient **coupé**, transitions d'UI à **durée 0**. **(précisé A18 · 2026-07-30)** La lecture est **asynchrone** et l'état initial du hook est `false` : au **premier rendu**, le hook affirme « pas de réduction » avant de savoir. C'est un fail-OPEN, signalé comme défaut de code et **non corrigé par ce lot** ; la règle produit qui s'applique en attendant est le repli fail-CLOSED de [08 § Préférences d'accessibilité et premier rendu](08-accessibility-adaptive-design.md#préférences-daccessibilité-et-premier-rendu). |
| Chrome de référence | `packages/ui/src/components/bottom-tab-bar.tsx` + `.logic.ts` + `.test.ts` | Pilule `colors.surface` opaque, `radius.cardXl`, `controls.cardBorder`, `shadowNative.e2` ; rôles `navigation.active` / `navigation.assistantActive` / `navigation.inactive` ; `accessibilityRole` `tablist`/`tab` + `accessibilityState.selected` **déjà posés** ; mode flottant = retombée `patterns.bottomTabBar.fade`. |
| Consommateurs livrés | `apps/mobile/app/equipements/[chantierId].tsx`, `apps/mobile/app/equipement/[id].tsx` | Preuve d'usage réel : `BobSurface` (tones `warning`/`neutral`/`marine`), `useRowPresence` + `PresenceRow`, `MorphReplace`. |
| Plan qui a livré le kit | [`beta-fly-services-p1-conception-ecrans.md`](../superpowers/plans/beta-fly-services-p1-conception-ecrans.md) §1 | Spécifie `surfaceTint`, `BobSurface`, `ProgressiveBlurBob` (§1.3), `motionSemantic`, et le cadre « 100 % additif ». |

**Phrase d'autorité.** Ce kit est livré, testé et consommé en production P1. **Aucune
spécification de ce dossier ne peut redéfinir un token existant ni proposer une matière
concurrente ; elle peut seulement s'y ajouter. En cas de divergence entre un document et le code du
kit, LE CODE FAIT FOI.**

### Étage 2 — Autorité de COMPORTEMENT, externe (subordonnée à l'étage 1)

| Référence | Rôle désigné par le fondateur | Ce qu'on en prend | Ce qu'on n'en prend pas |
| --- | --- | --- | --- |
| [`davidmokos/expo-glass-tabs`](https://github.com/davidmokos/expo-glass-tabs) — npm `expo-glass-tabs` 0.1.1, MIT, David Mokos. 4 fichiers, 662 l. de source : `glass-tab-bar.tsx` (438), `fading-tab-slot.tsx` (93), `minimize-context.tsx` (88), `progressive-blur.tsx` (43). | Référence de **FONCTIONNALITÉ, COMPORTEMENT et EFFET** de la barre du bas. | Les gestes, les seuils, les ressorts, les enchaînements et le sens du mouvement — détaillés dans [04 § Comportement normatif de la tab bar](04-navigation-scroll-surfaces.md#comportement-normatif-de-la-tab-bar). | `expo-glass-effect`, `GlassView`, `glassEffectStyle`, les `rgba` translucides, le voile noir, la palette sombre, SF Symbols (`expo-symbols`), le label à 9,5 pt. |
| [`davidmokos/revolut-expo-clone`](https://github.com/davidmokos/revolut-expo-clone) | Référence d'**INSPIRATION UI**, notamment son `ProgressiveBlur`. | La technique de retombée par empilement (§ [04 § Retombée de bord](04-navigation-scroll-surfaces.md#retombée-de-bord--progressiveblurbob)) ; la discipline de thème centralisé ; le chiffre héros scindé entier/centimes en `tabular-nums` ; le chrome flottant avec padding compensatoire ; `borderCurve: 'continuous'` ; la sobriété du press feedback. | Le fond noir absolu `#000000` et l'identité sombre permanente (Bob est force-light avec une couture navy → clair), `expo-glass-effect` sous toutes ses formes, les hex de catégories système iOS, SF Symbols, l'avatar servi depuis une URL distante. |

**Ligne de partage, mot pour mot.**

> **On reprend le COMPORTEMENT. On ne reprend PAS la MATIÈRE.** Concrètement : on reprend les
> gestes, les seuils, les ressorts, les enchaînements et le sens du mouvement ; on ne reprend ni
> `expo-glass-effect`, ni `GlassView`, ni `glassEffectStyle`, ni les `rgba` translucides, ni le
> voile noir, ni la palette sombre, ni les SF Symbols.

**Note de fait, utile aux relecteurs.** Les 4 fichiers de `src/lib/glass-tab-bar/` du clone Revolut
sont une copie **octet pour octet** de `expo-glass-tabs` (`diff` = 0 sur les quatre). Il n'y a donc
qu'**une** référence de comportement ; le clone n'en est que la démonstration. Ne pas les traiter
comme deux sources indépendantes.

#### Épinglage de la source externe

> Ajouté A27 · 2026-07-30. Une autorité de comportement citée par une **branche mobile** (« la tab
> bar de `davidmokos/expo-glass-tabs` ») n'est pas une autorité : la branche bouge, et les seuils,
> ressorts et décomptes de lignes que [04](04-navigation-scroll-surfaces.md) recopie deviennent
> invérifiables. La référence est donc épinglée sur un artefact **immuable**.

| Ancre | Valeur | Nature |
| --- | --- | --- |
| Paquet npm | `expo-glass-tabs@0.1.1` | Immuable — publié le 2026-07-22T21:53:19Z. |
| `dist.shasum` | `881cdcaede9f76f4d6f9084c6718ec003a0327b5` | Vérifiable hors ligne. |
| `dist.integrity` | `sha512-DVtfA+wTXz63LNAgGXXuAPEtCFwciELLTI8J1kq16ER7IcAx+dPZdMwfBpOY9iVkwinPdSz60dSe8QNQGWbBZg==` | Vérifiable hors ligne. |
| `gitHead` de la publication | `f6119a19104885ddb4cbca3b1405e037149aaba7` | Commit exact correspondant au tarball. |
| Licence / auteur | MIT — David Mokos | Compatible avec une reprise de comportement. |
| Empreinte de lecture | `glass-tab-bar.tsx` 438 l., `fading-tab-slot.tsx` 93 l., `minimize-context.tsx` 88 l., `progressive-blur.tsx` 43 l. | Contrôle de cohérence : si ces décomptes changent, la citation ne porte plus sur la même source. |

Toute valeur de [04 § Comportement normatif de la tab bar](04-navigation-scroll-surfaces.md#comportement-normatif-de-la-tab-bar)
attribuée à « la référence » se lit dans **cet** artefact et pas ailleurs. Épingler n'est pas
adopter : le paquet n'est **pas** une dépendance de Bob et ne le devient pas
([UX-ADR-002 § Amendement A3](adr/UX-ADR-002-navigation-surfaces.md)).

**Ce que la référence NE fait PAS.** Son silence n'est pas une norme. Aucun builder ne doit prendre
ces absences pour des décisions :

| Sujet | État dans la référence |
| --- | --- |
| Reduce Motion | Aucune gestion, nulle part dans le paquet. |
| Reduce Transparency | Aucune gestion ; `progressive-blur.tsx` ne teste rien. |
| Clavier | Aucune gestion : barre en `position: absolute; bottom: 0`, sans évitement. |
| Retap sur l'onglet actif | Non traité : `router.navigate` sur la route courante est un no-op, donc pas de « retour en haut ». |
| Rôles d'accessibilité | La barre ne pose ni `accessibilityRole="tablist"/"tab"` ; le détecteur de geste qui consomme les touches est un risque VoiceOver non traité. |

Sur ces cinq points, **notre kit est supérieur à la référence** et ne doit pas régresser pour lui
ressembler.

## Cap de publication canonique intégré

Les deux autorités suivantes sont présentes dans la branche canonique et conservent le statut
`Accepted` :

- [OBJECTIFS_SPECS_DOD_PUBLICATION](../../design_handoff_bob_pro/OBJECTIFS_SPECS_DOD_PUBLICATION.md) ;
- [ADR-0004 — GPT Realtime pour la publication, Mistral V3 après V1](../adr/0004-gpt-realtime-publication-mistral-v3-post-v1.md).

Elles donnent la priorité à la publication stable, Factur-X, aux données réelles et à GPT
Realtime, et diffèrent Mistral V3 ainsi que les ajouts opportunistes. Elles prévalent sur les
anciens documents contradictoires ; ce dossier n'en recopie pas le contenu afin d'éviter deux
sources concurrentes.

Les dépendances d'intégration et de liens de D00 sont donc satisfaites. D00 reste néanmoins
`Proposed` tant qu'un release owner nommé n'a pas signé dans `WP-0001` le périmètre UX autorisé et
le rescoping explicite du feature freeze.

## Références produit internes

| Source | Usage dans le programme | Autorité |
| --- | --- | --- |
| [`COMPONENT_SPECS.md`](../../design_handoff_bob_pro/COMPONENT_SPECS.md) | Géométrie et identité des primitives existantes. | Référence visuelle existante. |
| [`NAVIGATION_MAP.md`](../../design_handoff_bob_pro/NAVIGATION_MAP.md) | Intention de navigation, modalité et StatusBar. | Intention initiale, à confronter au code réel. |
| [`RN_EXPO_GUIDE.md`](../../design_handoff_bob_pro/RN_EXPO_GUIDE.md) | Conseils RN/Expo, polices, safe areas et animation. | Guide historique ; dépendances à réévaluer. |
| [`SCREENS.md`](../../design_handoff_bob_pro/SCREENS.md) | Vision initiale des écrans et flux. | Référence fonctionnelle, pas état exact du code. |
| [`VOICE_AND_TONE.md`](../../design_handoff_bob_pro/VOICE_AND_TONE.md) | Personnalités Pote/Pro/Direct et principes de copy. | Source de vérité du ton. |
| [`SPEC_BOB_LIVE.md`](../../design_handoff_bob_pro/SPEC_BOB_LIVE.md) | SLO, invariants de consentement et dégradation. | Mandat historique ; ADR acceptés prévalent sur les choix provider. |
| [`BOB_LIVE.md`](../architecture/BOB_LIVE.md) | Fondation runtime et gates historiques. | Les ADR/specs acceptés plus récents prévalent sur provider et priorité. |
| [`ADR-0001`](../adr/0001-bob-live-mistral-conversation-v2.md) | Autorité de session/tour et Mistral v2. | Accepted. |
| [`ADR-0002`](../adr/0002-boucle-agentique-vocale-outils-types.md) | Outils typés, interactions bimodales et confirmations. | Proposed ; ne pas traiter comme acquis. |
| [`ADR-0003`](../adr/0003-mistral-v2-ordered-retention.md) | Rétention et convergence fail-closed. | Accepted. |
| [`USER_FLOWS.md`](../../design_handoff_bob_pro/USER_FLOWS.md) | Intentions de parcours et cas limites historiques. | Baseline ; routes et code actuel prévalent. |
| [`DOMAIN_MODEL.md`](../../design_handoff_bob_pro/DOMAIN_MODEL.md) | Vocabulaire métier initial. | Intention ; `packages/core` et tests font foi. |
| [`SPEC_SCANNER_INTELLIGENT.md`](../../design_handoff_bob_pro/SPEC_SCANNER_INTELLIGENT.md) | Capture, analyse et correction documentaires. | Contrat produit à confronter au pipeline courant. |
| [`SPEC_LOT_RETOURS_DEVICE_20260714.md`](../../design_handoff_bob_pro/SPEC_LOT_RETOURS_DEVICE_20260714.md) | Retours appareils et arbitrages UI. | Décisions datées, vérifier si supersédées. |
| [`PROMPT_EXIGENCE_UNIVERSEL.md`](../../design_handoff_bob_pro/PROMPT_EXIGENCE_UNIVERSEL.md) | Discipline de spec, preuves et DoD. | Process historique utile. |
| [`architecture-blueprint.md`](../architecture/architecture-blueprint.md) | Frontières d'architecture générales. | Référence d'architecture. |
| [`VERITES_V1_PARITE_ET_PERF.md`](../architecture/VERITES_V1_PARITE_ET_PERF.md) | Exceptions de parité et baseline performance datée. | Baseline, à mesurer de nouveau. |
| [`dpia-ia.md`](../compliance/dpia-ia.md) | Contraintes de traitement et IA. | Référence conformité. |
| [`AUDIT_VOCAL_GPT.md`](../../design_handoff_bob_pro/AUDIT_VOCAL_GPT.md) | Preuves/audit vocal historique. | Historique uniquement. |

## Apple

| Référence | Principes retenus |
| --- | --- |
| [Design principles](https://developer.apple.com/design/human-interface-guidelines/design-principles) | Purpose, agency, responsibility, familiarity, flexibility, simplicity, craft et delight. |
| [Motion](https://developer.apple.com/design/human-interface-guidelines/motion) | Mouvement utile, bref, précis, cohérent avec le geste, facultatif et interrompable. |
| [Accessibility](https://developer.apple.com/design/human-interface-guidelines/accessibility) | Dynamic Type, cibles tactiles, alternatives, Reduce Motion, contraste et feedback multimodal. |
| [Materials](https://developer.apple.com/design/human-interface-guidelines/materials) | Matière fonctionnelle réservée au chrome et contrôles ; adaptation au contraste/transparence. **(caveat A13 · 2026-07-29)** Résumé de ce que dit la HIG, **pas** de ce que fait Bob : chez nous la matière du chrome est la surface teintée opaque (`surfaceTint`), et « matière fonctionnelle » a été redéfini en ce sens par A1 — voir [19 — Glossaire](19-glossary.md), entrées « Matière fonctionnelle » et « Matière Bob ». Ce qu'on en retient réellement : l'exigence d'adaptation au contraste et à la transparence. |
| [Buttons](https://developer.apple.com/design/human-interface-guidelines/buttons) | Feedback pressé, cibles et états asynchrones explicites. |
| [Haptics](https://developer.apple.com/design/human-interface-guidelines/playing-haptics) | Retours brefs, causaux et non surutilisés ; prudence pendant capture audio. |
| [Scroll views](https://developer.apple.com/design/human-interface-guidelines/scroll-views) | Geste direct, chrome lié au scroll et absence de scroll-jacking. |
| [Sheets](https://developer.apple.com/design/human-interface-guidelines/sheets) | Tâche courte, dismissal évident et modalité adaptée. |
| [Generative AI](https://developer.apple.com/design/human-interface-guidelines/generative-ai) | États spécifiques et vrais, contrôle utilisateur, erreur et prochaine action claires. |
| [WWDC 2025 — Liquid Glass](https://developer.apple.com/videos/play/wwdc2025/219/) | Morph de la couche fonctionnelle, usage parcimonieux et adaptation système. **(caveat A4 · 2026-07-29)** Référence de **principe** uniquement : le matériau lui-même n'est pas employé par Bob, car il impose la teinte du système. Voir [UX-ADR-004 § Algorithme de surface](adr/UX-ADR-004-adaptive-appearance.md). |
| [WWDC 2024 — Zoom transitions](https://developer.apple.com/videos/play/wwdc2024/10145/) | Continuité spatiale objet → destination. |
| [WWDC 2018 — Fluid interfaces](https://developer.apple.com/videos/play/wwdc2018/803/) | Interfaces réactives, dynamiques, interruptibles et redirigeables. |
| [Apple Design Awards 2026](https://www.apple.com/newsroom/2026/06/apple-reveals-winners-of-the-2026-apple-design-awards/) | Barre qualitative pour interaction, inclusivité, innovation et craft. |

Apple ne publie pas une durée universelle applicable à toutes les animations. Les timings Bob sont
des cibles de design et doivent céder la priorité aux comportements natifs de la plateforme.

## Material et Android

| Référence | Principes retenus |
| --- | --- |
| [Material motion patterns](https://github.com/material-components/material-components-android/blob/master/docs/theming/Motion.md) | Container transform, shared axis, fade-through et fade. |
| [Material 3 MotionScheme](https://developer.android.com/reference/kotlin/androidx/compose/material3/MotionScheme) | Expressivité sur les moments proéminents, standard sur les actions fréquentes. |
| [Android animation quick guide](https://developer.android.com/develop/ui/compose/animation/quick-guide) | Ressorts naturels et préférence pour draw/transform plutôt que layout coûteux. |
| [Android accessibility](https://developer.android.com/design/ui/mobile/guides/foundations/accessibility) | Cibles tactiles et perception multimodale. |

Material sert de référentiel relationnel et de baseline Android. Il ne doit pas transformer Bob en
application générique Material.

## Expo et React Native

| Référence | Usage potentiel | Caveat |
| --- | --- | --- |
| [Expo Router Stack](https://docs.expo.dev/router/advanced/stack/) | Push/modal natifs et gestes système. | Valider les options par version SDK. |
| [Native Tabs](https://docs.expo.dev/router/advanced/native-tabs/) | Tab bar système, matériaux récents et comportements natifs. | API évolutive ; prototype comparatif obligatoire. |
| [Zoom transition](https://docs.expo.dev/router/advanced/zoom-transition/) | Carte → détail sur iOS compatible. | iOS/versionné, alpha ; jamais sans fallback. |
| [Stack toolbar](https://docs.expo.dev/router/advanced/stack-toolbar/) | Menus et actions de header natifs. | Support par plateforme à vérifier. |
| [Expo Haptics — SDK 57 (pinée)](https://docs.expo.dev/versions/v57.0.0/sdk/haptics/) | Sélection, impact et notifications sémantiques. | **(pinée A20 · 2026-07-30)** Disponibilité et réglages système. Non déclaré dans le dépôt ; l'ajout dépend d'`UX-ADR-006` **Accepted** et de la certification acoustique. |
| [GlassEffect — SDK 57 (pinée)](https://docs.expo.dev/versions/v57.0.0/sdk/glass-effect/) | **(amendé A4 · 2026-07-29)** Aucun. **Ne sera pas adopté** : hors doctrine « matière Bob ». | Conservé dans cette bibliographie pour tracer la décision de non-adoption, pas comme candidat. |
| [BlurView — SDK 57 (pinée)](https://docs.expo.dev/versions/v57.0.0/sdk/blur-view/) | **(amendé A4 · 2026-07-29 ; pinée A20 · 2026-07-30)** Uniquement derrière le port `renderBlurLayer` de `ProgressiveBlurBob`, en retombée de bord sur fond photographique. Contrat de props exécutable : [04 § Contrat exécutable du port `renderBlurLayer`](04-navigation-scroll-surfaces.md#contrat-exécutable-du-port-renderblurlayer--expo-blur-expo-sdk-57). | Consultée le 2026-07-30. `…/versions/latest/…` est **proscrit** dans ce dossier : il change de contenu sans changer d'URL. Android **< 31** = aucun flou ; `blurMethod` par défaut `'none'` rend une vue **semi-transparente**, hors doctrine ; `experimentalBlurMethod` dépréciée. **(complété A29 · 2026-07-30)** Deux limitations officielles de plus, toutes deux structurantes : les `BlurView` doivent **tenir dans les bornes d'un seul** `BlurTargetView`, et le flou **ne se met pas à jour** quand la `BlurView` est rendue **avant** un contenu dynamique (`FlatList` et assimilés) — voir [04 § Couture du port](04-navigation-scroll-surfaces.md#couture-du-port--qui-rend-quoi-de-part-et-dautre-de-la-frontière-de-paquet). Jamais importé par `packages/ui`. |
| [React Native Performance](https://reactnative.dev/docs/performance.html) | Budget frame et tests en release. | Ne jamais profiler uniquement en dev. |
| [AccessibilityInfo](https://reactnative.dev/docs/accessibilityinfo) | Reduce Motion, Reduce Transparency et préférence de crossfade. | Matrice de support plateforme. |

## Reanimated et rendu avancé

| Référence | Usage potentiel | Caveat |
| --- | --- | --- |
| [Reanimated Performance](https://docs.swmansion.com/react-native-reanimated/docs/guides/performance/) | UI thread, gestures et layout transitions. | Installer version compatible ; limiter les composants simultanés. |
| [Reanimated Accessibility](https://docs.swmansion.com/react-native-reanimated/docs/guides/accessibility/) | Politique Reduce Motion. | Tester les alternatives, pas seulement désactiver. |
| [Shared Element Transitions](https://docs.swmansion.com/react-native-reanimated/docs/category/shared-element-transitions/) | Continuité expérimentale. | Ne pas utiliser sur un flux critique sans preuve de stabilité. |
| [React Native Skia animations](https://shopify.github.io/react-native-skia/docs/animations/animations/) | Orb vocale ou chart propriétaire. | Coût bundle ; réserver aux signatures à forte valeur. |

## Accessibilité normative

| Référence | Exigence retenue |
| --- | --- |
| [WCAG 2.2](https://www.w3.org/TR/WCAG22/) | Référentiel complémentaire de qualité. |
| [Animation from interactions](https://www.w3.org/WAI/WCAG22/Understanding/animation-from-interactions.html) | Motion non essentielle désactivable. |
| [Status messages](https://www.w3.org/WAI/WCAG22/Understanding/status-messages.html) | Statuts annoncés sans déplacement de focus. |
| [Target size](https://www.w3.org/WAI/WCAG22/Understanding/target-size-minimum.html) | Cibles suffisantes et espacées. |
| [Three flashes](https://www.w3.org/WAI/WCAG22/Understanding/three-flashes.html) | Aucun flash dangereux. |

## Conversation et voix

| Référence | Principe retenu |
| --- | --- |
| [Google conversation design](https://developers.google.com/assistant/conversation-design/what-is-conversation-design) | Expérience multimodale, tours clairs et une question à la fois. |
| [Confirmations](https://developers.google.com/assistant/conversation-design/confirmations) | Confirmation proportionnée au risque et formulation non ambiguë. |
| [Errors](https://developers.google.com/assistant/conversation-design/errors) | Récupération explicite et prochaine action. |
| [Voice indicator](https://developer.android.com/design/ui/ai-glasses/guides/components/voice-indicator) | Feedback micro immédiat et langage d'état cohérent. |

## Politique de version

### Versions réellement intégrées

> Ajouté A25 · 2026-07-30. Une seule ligne citable, pour que les gates cessent de recopier une
> version périmée. Source : `apps/mobile/package.json`.

| Brique | Version au 2026-07-30 | Ce qu'elle remplace |
| --- | --- | --- |
| Expo SDK | **57.0.8** | ~~56~~ |
| React Native | **0.86.0** | ~~0.85~~ |
| React | **19.2.3** | ~~19.2~~ |
| Expo Router | **57.0.8** | ~~56~~ |
| Reanimated / Worklets | **4.5.0** / **0.10.0** — déclarés, importés nulle part | *(inchangé, A7)* |
| Gesture Handler | **^2.32.0** — déclaré et utilisé | *(inchangé, A7)* |
| `expo-haptics`, `expo-blur`, `expo-glass-effect` | **absents de tous les `package.json`** | *(inchangé)* |

Toute gate, preuve minimale d'ADR ou matrice de compatibilité part de **ces** valeurs. Les
documents qui portaient « Expo 56 / RN 0.85 » ont été corrigés le 2026-07-30 :
[00 § Périmètre inspecté](00-audit-baseline.md#périmètre-inspecté),
[09 en-tête](09-technical-architecture.md), [UX-ADR-001](adr/UX-ADR-001-motion-runtime.md) § Contexte
et § Preuves minimales, [UX-ADR-006](adr/UX-ADR-006-haptic-feedback.md) § Preuves minimales.

### Rituel

Avant l'ouverture de chaque phase :

1. vérifier la version Expo/RN réellement intégrée **et mettre à jour le tableau ci-dessus dans le
   même changement** ;
2. relire les pages officielles utilisées par l'ADR concerné ;
3. noter tout changement de statut alpha/beta/stable ;
4. exécuter un spike sur les versions minimales et maximales supportées ;
5. mettre à jour ce fichier et la date de vérification ;
6. ne jamais déduire la disponibilité d'une API de sa seule présence dans une documentation latest.
