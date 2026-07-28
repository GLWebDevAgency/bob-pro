# Références et dépendances documentaires

> Statut : **Proposed reference set**
> Sources web vérifiées le 2026-07-22 ; à revalider avant chaque phase

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
| [Materials](https://developer.apple.com/design/human-interface-guidelines/materials) | Matière fonctionnelle réservée au chrome et contrôles ; adaptation au contraste/transparence. |
| [Buttons](https://developer.apple.com/design/human-interface-guidelines/buttons) | Feedback pressé, cibles et états asynchrones explicites. |
| [Haptics](https://developer.apple.com/design/human-interface-guidelines/playing-haptics) | Retours brefs, causaux et non surutilisés ; prudence pendant capture audio. |
| [Scroll views](https://developer.apple.com/design/human-interface-guidelines/scroll-views) | Geste direct, chrome lié au scroll et absence de scroll-jacking. |
| [Sheets](https://developer.apple.com/design/human-interface-guidelines/sheets) | Tâche courte, dismissal évident et modalité adaptée. |
| [Generative AI](https://developer.apple.com/design/human-interface-guidelines/generative-ai) | États spécifiques et vrais, contrôle utilisateur, erreur et prochaine action claires. |
| [WWDC 2025 — Liquid Glass](https://developer.apple.com/videos/play/wwdc2025/219/) | Morph de la couche fonctionnelle, usage parcimonieux et adaptation système. |
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
| [Expo Haptics](https://docs.expo.dev/versions/latest/sdk/haptics/) | Sélection, impact et notifications sémantiques. | Disponibilité et réglages système. |
| [GlassEffect](https://docs.expo.dev/versions/latest/sdk/glass-effect/) | Matière de chrome sur iOS compatible. | Fallback View, Reduce Transparency et disponibilité runtime. |
| [BlurView](https://docs.expo.dev/versions/latest/sdk/blur-view/) | Chrome flottant sur plateformes compatibles. | Coût GPU et limites Android selon API. |
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

Avant l'ouverture de chaque phase :

1. vérifier la version Expo/RN réellement intégrée ;
2. relire les pages officielles utilisées par l'ADR concerné ;
3. noter tout changement de statut alpha/beta/stable ;
4. exécuter un spike sur les versions minimales et maximales supportées ;
5. mettre à jour ce fichier et la date de vérification ;
6. ne jamais déduire la disponibilité d'une API de sa seule présence dans une documentation latest.
