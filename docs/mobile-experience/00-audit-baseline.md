# Baseline de l'expérience mobile

> Statut : **Proposed baseline**
> Observation : 2026-07-22
> Formalisation : 2026-07-23
> Dernière vérification du code : commit `2515ddf3`
> Méthode : inspection statique du code, des 32 routes, des composants, tokens, textes et captures
>
> **Amendement A6 — 2026-07-29.** Le constat `B11` est complété par la décision de matière prise en
> A1/A2. **Aucun constat n'est modifié dans sa description** : la baseline reste la photographie du
> commit `2515ddf3` du 2026-07-22. Le kit « matière Bob » livré depuis est postérieur à cette
> baseline et vit dans [17 § Autorités normatives](17-references.md#autorités-normatives).

## Résumé exécutif

Bob possède déjà une identité visuelle crédible et un socle d'états asynchrones supérieur à la
moyenne. L'écart avec une application de référence n'est pas principalement une question de
palette ou de cartes. Il se situe dans la manière dont les objets apparaissent, changent, se
déplacent, confirment une action et conservent leur continuité entre les écrans.

La note pondérée initiale est **65/100**. La qualité statique est évaluée autour de **76/100** ;
l'expérience motion/Bob Live autour de **47/100**. Ces notes servent de point de comparaison, pas
de certification ni de promesse marketing.

## Grille initiale

| Domaine | Note | Force actuelle | Écart principal |
| --- | ---: | --- | --- |
| Direction artistique | 76 | Marine, surfaces chaudes, indigo IA, accents métier. | Profondeur et variations de chrome limitées. |
| Typographie et tokens | 80 | Schibsted/Hanken, nombres tabulaires, rôles sémantiques. | Adaptation Dynamic Type et apparence système incomplètes. |
| Composition et hiérarchie | 67 | Très bonne sur Aujourd'hui. | Densité excessive sur les pages longues et techniques. |
| Cohérence pixel-perfect | 68 | Primitives structurées et captures de référence. | Deux couches UI et plusieurs feedbacks de pression. |
| Navigation et continuité | 40 | Native Stack sous Expo Router. | Headers masqués, transitions peu sémantiques, objets sans continuité. |
| Motion design | 38 | `FadeIn`, skeletons, score, quelques halos. | Presque aucune sortie, insertion, suppression ou relocalisation. |
| Micro-interactions | 45 | `PressableScale` constitue un bon début. | Réponses tactiles inégales et absence d'haptique globale. |
| Loading/empty/error | 84 | États honnêtes, explicites et souvent accessibles. | Transition skeleton → contenu et récupération encore brusques. |
| Accessibilité visuelle | 75 | Cibles tactiles et Reduce Motion partiellement couverts. | Status bar, Dynamic Type, contraste adaptatif et transparence. |
| Clarté des textes | 66 | Voix Bob distinctive, trois personnalités. | Statuts vagues, jargon technique, textes datés. |
| Sensation premium | 49 | Application propre et cohérente au repos. | Faible sensation de causalité et de matière vivante. |

## Périmètre inspecté

- 32 fichiers de routes hors layouts dans `apps/mobile/app` ;
- flux d'authentification et d'inscription montés par l'Auth Gate ;
- composants partagés `packages/ui` et composants mobiles locaux ;
- tokens visuels et motion dans `packages/tokens` ;
- clés et variantes de texte dans `packages/i18n` ;
- captures de handoff et de production disponibles ;
- architecture Bob Live, reducer de session, overlay global et composants vocaux ;
- configuration Expo SDK 56, React Native 0.85 et Expo Router.

## Faits structurants observés

| ID | Fait | Conséquence |
| --- | --- | --- |
| B01 | La StatusBar racine est forcée en `light`. | Icônes blanches peu lisibles sur plusieurs fonds clairs. |
| B02 | `userInterfaceStyle` est automatique sans thème système complet. | Contrat clair/sombre ambigu. |
| B03 | Les headers natifs sont masqués sur toute la Stack. | Perte de grands titres natifs, toolbar, matériaux et continuité plateforme. |
| B04 | Quatre routes seulement déclarent explicitement une présentation modale. | La sémantique push/modal/sheet reste incomplète. |
| B05 | La tab bar est une pill JS personnalisée sans indicateur mobile partagé. | Bonne identité statique, faible feedback de sélection. |
| B06 | La Sheet utilise 220 ms et une translation fixe de 480 dp. | Le handle visible n'est pas relié à un geste. |
| B07 | `FadeIn` anime uniquement le montage, avec fade et 6 dp. | Les mises à jour et sorties restent instantanées. |
| B08 | `Button` applique un scale press instantané ; `PressableScale` anime 90/150 ms. | Deux sensations tactiles concurrentes. |
| B09 | Aucune dépendance directe `expo-haptics` n'est déclarée. | Aucun langage tactile cohérent. |
| B10 | Reanimated n'est pas une dépendance mobile directe ni un runtime utilisé. | Layout/gestures interruptibles ne disposent pas encore d'un socle partagé. |
| B11 | Blur, GlassEffect et Symbols ne sont pas déclarés. | Aucun usage actuel, donc aucune dette de fallback. **(amendé A1/A2 · 2026-07-29 : la décision n'est plus ouverte. GlassEffect et Symbols ne seront pas adoptés — matière système et glyphes iOS-only. Blur reste possible uniquement derrière le port `renderBlurLayer` de la retombée de bord, dont le défaut est sans flou. Cette absence de dépendance devient un actif, pas une lacune.)** |
| B12 | Le thème expose des tailles fixes et des familles chargées par graisse. | Base typographique solide, mais adaptation extrême non prouvée. |
| B13 | Peu de ScrollViews utilisent l'ajustement automatique des insets. | Chrome et contenu ne se comportent pas uniformément. |
| B14 | `AppHeaderNavy` possède déjà un halo ambiant respectant Reduce Motion. | Bonne signature à préserver et à ne pas concurrencer. |
| B15 | Le Bob Live visible est essentiellement un bandeau, un point et un pulse. | Les états écoute/réflexion/parole sont peu différenciés. |
| B16 | Les phases connexion/dégradé sont souvent projetées vers `thinking`. | L'UI ne peut pas être totalement honnête sans projection plus riche. |
| B17 | Le transcript est disponible dans la session mais peu exposé dans l'overlay. | Occasion perdue de rassurer sur ce que Bob entend. |
| B18 | Les messages du chat n'ont pas de vraie entrée/sortie/layout transition. | Le fil paraît statique et peut sauter lors d'un enrichissement. |
| B19 | L'auto-scroll Assistant suit chaque changement de taille. | Risque de retirer le contrôle à un lecteur remonté dans l'historique. |
| B20 | Les états loading/error/empty sont largement couverts et accessibles. | Fondation à conserver, pas à réécrire. |

## Forces à protéger

1. Identité marine + indigo IA différenciante.
2. Typographies Schibsted Grotesk et Hanken Grotesk.
3. Montants en chiffres tabulaires et format français.
4. Ombres basses, larges et bleutées.
5. Cards opaques et rayons cohérents.
6. États asynchrones honnêtes et nombreux.
7. Cibles tactiles et libellés d'accessibilité déjà présents.
8. Hook Reduce Motion partagé.
9. Confirmation et consentement Bob fail-closed.
10. Dégradation vocale honnête et priorité donnée aux SLO audio.

## Cibles programme

| Indicateur | Baseline | Cible avant rollout général | Méthode de preuve |
| --- | ---: | ---: | --- |
| Note globale audit | 65/100 | ≥ 88/100 | Re-audit croisé code + vidéo + appareils. |
| Navigation/continuité | 40/100 | ≥ 85/100 | Parcours filmés, heuristiques et tests gestuels. |
| Motion design | 38/100 | ≥ 85/100 | Revue motion, captures 60/120 Hz, Reduced Motion. |
| Micro-interactions | 45/100 | ≥ 85/100 | Inventaire composants et QA haptique. |
| Bob Live visuel | 47/100 | ≥ 88/100 | Matrice états, amplitude réelle, erreurs et transcript. |
| Accessibilité | 75/100 | 100 % des gates binaires | Tests VoiceOver/TalkBack, Dynamic Type et modes système. |
| Régression fonctionnelle | N/A | 0 blocante | Suites existantes + tests ciblés + parcours manuels. |
| Exécution fantôme | 0 exigé | 0 | Invariants Bob Live existants et nouveaux tests UI. |
| Régression SLO voix | N/A | ≤ 5 % et SLO existants tenus | Traces avant/après sur appareils. |

La cible de note n'autorise pas à compenser un défaut critique par des effets décoratifs. Une
StatusBar illisible, une action sensible ambiguë, un échec silencieux ou une animation non
désactivable bloque la validation globale.

## Baselines à produire avant implémentation

- Vidéo 60 fps de chaque parcours principal sur iOS et Android.
- Captures des 32 routes et de l'expérience auth agrégée dans leurs états nominal, loading, empty,
  error et offline pertinents.
- Capture avec Dynamic Type standard, 150 % et 200 %.
- Capture avec Reduce Motion, Reduce Transparency et Increase Contrast.
- Mesure frame time JS/UI des tabs, sheets, listes, chat et Bob Live.
- Mesure SLO voix pendant rendu de l'overlay et d'une longue conversation.
- Inventaire des composants partagés et des doublons locaux.
- Matrice route → présentation → header → StatusBar → scroll policy.

## Limites de la baseline

- L'audit initial repose sur le code et des PNG, pas sur une campagne complète vidéo/appareil.
- Les sensations haptiques et acoustiques ne peuvent pas être certifiées statiquement.
- Les performances ne sont pas mesurées en build release dans cette baseline.
- Les comportements selon versions iOS/Android restent à qualifier.
- Les notes sont une aide à la décision ; seuls les critères binaires de la DoD autorisent un
  rollout.
