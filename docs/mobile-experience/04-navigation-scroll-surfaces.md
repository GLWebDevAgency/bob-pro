# Navigation, scroll et surfaces

> Statut : **Proposed**
> IDs liés : G01, G07, G10, G11, G12, G16, G19, G20
>
> **Amendements 2026-07-29** (le corps daté du 2026-07-23 n'est pas réécrit ; chaque passage
> remplacé reste cité sous « Rédaction initiale ») :
>
> - **A1 · doctrine « matière Bob »** — § Matières. Source : directive du fondateur du 2026-07-29,
>   « Je NE VEUX PAS une UI transparente à la iOS » ; autorité de matière
>   `packages/tokens/src/index.ts` (`surfaceTint`) + `packages/ui/src/components/bob-surface.tsx`.
> - **A2 · retombée de bord `ProgressiveBlurBob`** — § Retombée de bord (nouveau). Source :
>   plan P1 du fondateur `docs/superpowers/plans/beta-fly-services-p1-conception-ecrans.md` §1.3 ;
>   technique étudiée dans `davidmokos/expo-glass-tabs` → `src/progressive-blur.tsx`.
> - **A3 · comportement normatif de la tab bar** — § Tabs (exigences communes l. 85 et 91 amendées)
>   et § Comportement normatif de la tab bar (nouveau). Source : directive du fondateur —
>   « garder notre design system niveau couleur et identité, mais implémenter la même
>   FONCTIONNALITÉ, COMPORTEMENT et EFFET que la tab bar de `davidmokos/expo-glass-tabs` ».
>
> **Amendements 2026-07-30** (mêmes règles : rien n'est réécrit silencieusement) :
>
> - **A17 · la retombée ne porte aucune cible tactile** — § Exigences communes, § 1 (lignes
>   « Géométrie » et « Item et highlight ») et § Cibles tactiles et Dynamic Type (nouveau). A3
>   justifiait une cible ≥ 44 pt par « le débord de retombée » ; la retombée est
>   `pointerEvents="none"` et ne reçoit donc **aucune** touche.
> - **A19 · géométrie qui survit à Dynamic Type** — § Cibles tactiles et Dynamic Type (nouveau).
>   A3 posait des hauteurs en points fixes sur une barre qui contient du texte, contre
>   [08 § Typographie](08-accessibility-adaptive-design.md#typographie) (« pas de hauteur fixe sur
>   un bloc contenant du texte ») et `R12`.
> - **A20 · contrat `expo-blur` Android/Expo 57** — § Mode flouté. Le contrat ne nommait ni
>   `BlurTargetView`, ni `blurTarget`, ni `blurMethod` : il n'était pas exécutable.
> - **A22 · scrub — le ressort ne barre pas la navigation** — § 3, lignes « Navigation » et
>   « Fin de geste ».
> - **A23 · contraste du highlight mesuré** — § 2. L'exemple de teinte de highlight
>   (`surfaceTint.light.marine.raised` `#E2E9F2`) est **sous AA** avec `navigation.inactive`.
> - **A25 · SDK de référence Expo 57 / RN 0.86** — § Bornes de livraison.
> - **A27 · moyens et invariants distingués** — §§ 2 et 6 : la géométrie calculée et le double
>   glyphe sont des **moyens** de référence, pas les exigences ; l'a11y des glyphes est posée.
>   **(portée complétée A28)** A27 a également ajouté § Pourquoi l'enveloppe est fixe et non
>   recalculée par frame et corrigé la ligne « Hauteur totale » du § Mode nominal ; le présent index
>   ne le déclarait pas.
> - **A28 · un seul mécanisme de cible tactile, exécutable sur Android** — § Exigences communes,
>   § 1 (ligne « Géométrie »), § Cibles tactiles et Dynamic Type, table des régimes, § 4,
>   § Matières et § Critères d'acceptation. A17 complétait la cible par un `hitSlop` qui déborde la
>   pilule : un tel `hitSlop` n'est **jamais dispatché**, sur aucun des deux OS. La cible est
>   désormais tenue par la **hauteur du `Pressable` lui-même**, avec cinq mesures d'acceptation.
> - **A29 · couture du port `renderBlurLayer`** — § Couture du port (nouveau) et § Quand le repli
>   opaque unique s'applique (cinquième cas). Le contrat de props A20 était exact mais s'arrêtait
>   avant la frontière de paquet : type du port, propriétaire du `BlurTargetView`, passage de la
>   `ref`, englobement par construction et cas de la liste virtualisée.

## Objectif

Faire comprendre la relation entre chaque destination tout en conservant Expo Router, les deep
links, les gestes natifs et le fonctionnement existant.

## Taxonomie de présentation

| Intention | Présentation cible | Exemples |
| --- | --- | --- |
| Explorer un objet | Push natif. | Client, chantier, dossier, document, devis, facture. |
| Créer/éditer un flux long | Full-screen modal ou page dédiée. | Devis, facture, scan. |
| Choisir/éditer une tâche courte | Form sheet ou sheet à detents. | Nouveau client, filtres, dossier, catalogue. |
| Afficher une action ancrée | Menu/context menu/popover. | Actions secondaires d'une pièce. |
| Confirmer une conséquence | Dialogue/confirm sheet. | Destruction, émission, abandon de brouillon. |
| Changer de domaine principal | Tab. | Aujourd'hui, Clients, Argent, Documents, Assistant. |

Le type de présentation est choisi selon l'intention, pas selon la taille de l'écran historique.

## Contrat de la Stack

- Conserver Expo Router Native Stack pour les destinations de niveau page.
- Conserver le geste Retour natif lorsqu'il n'expose pas une perte de données.
- Intercepter la fermeture uniquement si un dirty state réel existe.
- Utiliser les headers/toolbar natifs lorsque la composition et la marque le permettent.
- Ne pas remplacer un push natif fonctionnel par une animation JS globale.
- Les transitions custom ne changent ni URL, ni historique, ni restauration.

## Carte de routes cible

| Route actuelle | Relation | Présentation proposée | Source principale |
| --- | --- | --- | --- |
| `(tabs)/index` | Destination racine | Tab, état préservé | Tab bar |
| `(tabs)/clients` | Destination racine | Tab, état préservé | Tab bar |
| `(tabs)/argent` | Destination racine | Tab, état préservé | Tab bar/carte solde |
| `(tabs)/documents` | Destination racine | Tab, état préservé | Tab bar |
| `(tabs)/assistant` | Destination racine | Tab, état préservé | Tab bar/Bob global |
| `client/[id]` | Objet enfant | Push ; zoom optionnel depuis avatar/carte | Clients/recherche |
| `chantiers` | Collection enfant | Push | Client/Today |
| `chantier/[id]` | Objet enfant | Push ; continuité carte/photo | Chantiers/client |
| `documents/folder/[id]` | Conteneur enfant | Push ; continuité tuile | Documents |
| `documents/[id]` | Objet enfant | Push téléphone ; panneau de détail large optionnel ; zoom aperçu progressif | Dossier/recherche |
| `devis/[id]` | Objet métier | Push ; hero document | Ventes/client/Today |
| `facture/[id]` | Objet métier | Push ; hero document | Ventes/client/notif |
| `facture/transmission/[id]` | Étape enfant | Push depuis facture | Détail facture |
| `devis/new` | Création longue | Full-screen modal ; dirty guard | CTA/FAB/client |
| `facture/new` | Création longue | Full-screen modal ; dirty guard | CTA/FAB/devis |
| `scan-document` | Capture immersive | Full-screen modal | Documents/FAB |
| `catalogue` | Collection/édition | Push depuis réglages ; form sheet en sélection | Compte/devis |
| `ventes` | Collection métier | Push ou future destination secondaire | Today/Documents |
| `depenses` | Collection métier | Push | Documents/Argent |
| `comptabilite` | Collection/rapport | Push | Documents/Compte |
| `cloture` | Parcours guidé | Push | Comptabilité/Today |
| `pilotage` | Tableau de bord | Push | Today/Argent |
| `notifications` | Centre d'action | Push téléphone ; popover/panneau large seulement si route et focus restent cohérents | Cloche |
| `recherche` | Recherche globale | Search route/header | Header/raccourci |
| `diagnostic` | Assistant multi-étapes | Full-screen modal | Today/onboarding |
| `onboarding` | Couche hors app | Full-screen, historique contrôlé | Auth Gate |
| `compte` | Réglages racine | Push | Avatar/menu |
| `reglages-facturation` | Réglages enfant | Push | Compte |
| `profil-fiscal` | Réglages guidés | Push/form sheet selon largeur | Compte |
| `auth/callback` | Retour externe | Écran utilitaire terminal | Deep link email |
| `auth/recovery` | Flux sécurisé | Full-screen auth | Deep link |
| `voix` | Compatibilité legacy | Redirect sans frame intermédiaire | Ancien deep link |

Cette table doit être validée route par route avant modification ; elle n'autorise pas une migration
globale automatique.

Ici, un **panneau de détail large** est une composition master-detail iPad/grande fenêtre : la route
reste adressable, le bouton Retour et le focus ont une sémantique définie, et le téléphone conserve
un push standard. Ce n'est ni une carte décorative ni une modalité implicite. Les formulations
alternatives restantes (`push/form sheet`, `search route/header`, renderer tabs) sont des décisions
de `WP-0301`/D02 ; sa route matrix Accepted doit choisir une valeur par classe de largeur et éliminer
le « ou » avant toute migration.

## Tabs

### Exigences communes

- cinq destinations stables ;
- **(amendé A3 · 2026-07-29 ; corrigé A17/A19 · 2026-07-30)** les labels sont présents et non
  tronqués **à l'état de repos de la barre** — et lorsque la taille de texte système ne le permet
  plus, ils sont **retirés**, jamais tronqués (§ Cibles tactiles et Dynamic Type). La barre **peut
  se minimiser au scroll** : labels repliés, **tous les onglets restant visibles et atteignables**,
  **cible tactile ≥ 44 pt (iOS) / 48 dp (Android) maintenue par la hauteur mesurée du `Pressable`
  de l'onglet** — jamais par une zone décorative, jamais par un `hitSlop` qui déborde la pilule
  (**corrigé A28 · 2026-07-30**, § Cibles tactiles et Dynamic Type). Elle se ré-étend au scroll vers
  le haut, dès le retour à moins de 24 px du sommet, et à **toute** interaction avec la barre ;
- sélection perceptible par couleur, forme et état accessible ;
- retap sur l'onglet actif : retour en haut ou comportement racine défini ;
- état de navigation conservé par tab ;
- badge annoncé avec sa signification ;
- clavier, safe area et rotation testés ;
- **(amendé A3 · 2026-07-29)** les **écrans** frères ne glissent jamais : le passage d'un onglet à
  l'autre est un **fade-through**. L'**indicateur** de sélection, lui, **voyage** : un highlight
  unique glisse d'un onglet à l'autre. Ces deux règles ne se contredisent pas — c'est exactement ce
  que fait la référence normative (`fading-tab-slot.tsx` + `glass-tab-bar.tsx`).

> Rédaction initiale 2026-07-23 (précisée par A3) : « labels toujours présents et non tronqués au
> format standard » — interdisait littéralement le minimize-on-scroll — et « aucune animation slide
> entre tabs sœurs » — que la référence **confirme** pour les écrans et **contredit** pour
> l'indicateur.

### Options à prototyper

1. conserver la pill Bob et ajouter indicateur mobile/haptique ;
2. adopter Native Tabs par plateforme avec tint/roles Bob ;
3. hybride : Native Tabs sur OS compatibles, composant Bob sur fallback.

Le choix final appartient à `UX-ADR-002`. Native Tabs ne doit pas être adopté uniquement pour
obtenir Liquid Glass ; l'identité, l'accessibilité, la restauration et la maturité API priment.

> Amendé A3 · 2026-07-29 — cette dernière phrase est la seule ligne du dossier déjà conforme à la
> doctrine « matière Bob ». Elle est **généralisée** : **ni Native Tabs ni aucun composant ne sera
> adopté POUR obtenir Liquid Glass.** Le comportement, lui, se reprend intégralement — voir
> ci-dessous.

## Comportement normatif de la tab bar

> Ajouté A3 · 2026-07-29. **Directive du fondateur** : « garder notre design system niveau couleur
> et identité, mais implémenter la même **FONCTIONNALITÉ, COMPORTEMENT et EFFET** que la tab bar
> de <https://github.com/davidmokos/expo-glass-tabs> ». C'est le **comportement** qui est demandé,
> pas la matière.
>
> **Source d'autorité de comportement** : `github.com/davidmokos/expo-glass-tabs`
> (`src/glass-tab-bar.tsx` 438 l., `src/minimize-context.tsx` 88 l., `src/fading-tab-slot.tsx`
> 93 l., `src/progressive-blur.tsx` 43 l.). Voir [17 — Références](17-references.md#autorités-normatives).
>
> **Ligne de partage.** On reprend le COMPORTEMENT. On ne reprend PAS la MATIÈRE.

Chaque comportement ci-dessous précise ce qu'on **reprend** et ce qu'on **abandonne**. Ce qu'on
abandonne est toujours la même chose : la matière iOS.

> **Décompte normatif (précisé A8 · 2026-07-29).** Ils sont **SIX**, exigés **en bloc** : §§ 1 à 6
> ci-dessous. La directive nomme trois choses — **FONCTIONNALITÉ, COMPORTEMENT et EFFET** — et le
> § 6 est le seul qui soit un **EFFET** au sens strict : il ne change ni la fonction ni la
> topologie, il change ce que l'œil voit pendant que le highlight voyage. C'est précisément le
> genre de ligne qu'un backlog laisse tomber en dernier ; elle est donc **exigée nommément** dans
> `G11`, `WP-0303`, `D07` et les critères de `UX-ADR-002`. Livrer cinq comportements sur six
> **ne satisfait pas** `G11`.

| # | Comportement | Nature | Perdu si non livré |
| --- | --- | --- | --- |
| 1 | Minimize-on-scroll | Comportement + fonctionnalité | La signature de la barre |
| 2 | Highlight glissant | Comportement | La continuité de la sélection |
| 3 | Scrub à ticks | Fonctionnalité | Un moyen de navigation entier |
| 4 | Flou de bord (retombée) | Effet | La dissolution du contenu sous le chrome |
| 5 | Fade-through | Comportement | Le calme du changement d'onglet |
| 6 | Teinte pilotée par le highlight | **Effet** | La lumière qui **voyage** — la barre redevient un commutateur |

### 1. Minimize-on-scroll — la signature

| Paramètre | Valeur normative | Note |
| --- | --- | --- |
| Source de vérité | **un seul** `progress` 0 → 1 partagé (`SharedValue`), plus un `target` qui empêche de relancer le ressort à chaque frame | Le `target` est le détail qui évite le stutter |
| Déclencheur | worklet de scroll sur le **thread UI**, **jamais** de `setState` par frame | Cohérent avec [10 — Performance](10-performance-observability.md) § Règles d'implémentation |
| Offset | `y = clamp(contentOffset.y, 0, max(contentSize − layout, 0))` | Le clamp existe pour que le rubber-band d'overscroll ne puisse pas inverser la direction une frame et faire clignoter la barre |
| Zone morte | `dy > 3` → minimiser ; `dy < −3` → étendre ; entre −3 et +3, rien ne bouge | |
| Retour haut forcé | `y < 24` → toujours étendue | |
| Ressort | **380 ms, `dampingRatio` 1** (critique-amorti) | Un ressort, pas un timing : la direction du scroll s'inverse en permanence et un ressort recible en conservant la vélocité. Amorti critique parce qu'il anime de la **layout** |
| Géométrie | hauteur **VISIBLE** `hauteurÉtendue → hauteurRepliée`, retrait latéral **animé de 0 → 34 pt par côté**, `borderRadius = hauteur / 2` recalculé à chaque frame | La pilule rétrécit dans **les deux** dimensions. Ce retrait ANIMÉ s'ajoute à la marge de safe area (12 pt, § Ce que la référence fait bien) : deux grandeurs distinctes, jamais la même. **(corrigé A19 · 2026-07-30 ; précisé A28)** Les deux hauteurs sont **calculées**, pas littérales, et la pilule se déduit du `Pressable` — `58 → 44 pt` est leur valeur à la taille standard **sur iOS** ; sur Android le repli s'arrête à **48 dp**. Voir § Cibles tactiles et Dynamic Type |
| Item et highlight | hauteur du **VISUEL INTÉRIEUR** (capsule de highlight + bloc icône/label) `50 → 35 pt` à la taille de texte standard, **animée explicitement** et non déduite du contenu | Une taille dérivée du layout est en retard sur l'animation du thread UI. **(corrigé A17 · 2026-07-30)** Seul le **visuel** descend à 35 pt : le `Pressable` de l'onglet, lui, ne descend **jamais** sous 44 pt (iOS) / 48 dp (Android) — voir § Cibles tactiles et Dynamic Type |
| Labels | opacité 1 → 0 sur `progress ∈ [0 ; 0,4]` | Le label a disparu bien avant la fin du mouvement |
| Ré-expansion forcée | à `onStart` du pan, `onEnd` du tap et `onPress` du Pressable | Toute interaction délibérée avec la barre la ré-étend |

**Identité conservée** : la pilule reste `colors.surface` opaque, `radius.cardXl`,
`controls.cardBorder`, `shadowNative.e2`. **Abandonné** : rien — `minimize-context.tsx` n'importe
ni `expo-blur`, ni `expo-glass-effect`, ni aucune couleur. C'est du comportement pur, transposable
tel quel.

#### Cibles tactiles et Dynamic Type

> Ajouté A17/A19 · 2026-07-30. Ce paragraphe **borne** la géométrie de § 1 et de § 2. Il n'ajoute
> aucun comportement : il dit lesquels des chiffres ci-dessus sont des **planchers**, lesquels sont
> **calculés**, et lequel n'est **jamais** négociable.

**La cible tactile ne dépend pas du visuel.** Le `Pressable` d'un onglet conserve
`minHeight` **44 pt** sur iOS et **48 dp** sur Android — à l'état étendu comme à l'état replié,
à toutes les tailles de texte. C'est le minimum produit de
[08 § Cibles tactiles](08-accessibility-adaptive-design.md#cibles-tactiles) et il **prime** sur la
géométrie de la référence. Le visuel intérieur (capsule de highlight, bloc icône/label) peut, lui,
descendre à 35 pt : il est **dessiné dans** le `Pressable`, il ne le redimensionne pas.

**Un seul mécanisme, et c'est la surface pressable elle-même.**
**(tranché A28 · 2026-07-30)** La cible est tenue par la **hauteur mesurée du `Pressable`**.
Aucun `hitSlop`, aucune zone voisine, aucun débord n'entre dans le calcul de la cible de la tab
bar. La règle est donc une **contrainte de layout**, pas une compensation :

```text
CIBLE            = 44 pt (iOS) | 48 dp (Android)          ← plancher absolu, jamais compensé
hauteurPressable = max(CIBLE, hauteurVisuelIntérieur)     ← à tout instant de l'animation
hauteurPilule    = hauteurPressable + 2 × rythmeExtérieur ← la pilule se déduit du Pressable
rythmeExtérieur  = interpolation de `progress`, 4 → 0 pt  ← c'est LUI qui s'anime, pas la cible
```

La pilule est **calculée à partir** du `Pressable`, et non l'inverse. Le repli ne rétrécit donc
jamais la cible : il consomme le rythme extérieur, puis s'arrête. Valeurs à la taille de texte
standard, entièrement dérivées des chiffres déjà posés au § 1 :

| État | Visuel intérieur | `hauteurPressable` | `rythmeExtérieur` | `hauteurPilule` |
| --- | ---: | ---: | ---: | ---: |
| Étendu (`progress = 0`) | 50 pt | 50 pt (> CIBLE) | 4 pt | **58 pt** sur les deux OS |
| Replié (`progress = 1`) | 35 pt | **44 pt** (iOS) / **48 dp** (Android) | 0 | **44 pt** (iOS) / **48 dp** (Android) |

Le `44` de la référence est une valeur **iOS**. Sur Android la pilule repliée mesure **48 dp** :
elle n'est jamais « plus courte que la cible », parce que la cible la définit. Le visuel de 35 pt
est centré dans les 44/48 : c'est la seule construction qui tient sur les **deux** OS.

> **Pourquoi pas un `hitSlop` (rédaction A17, supersédée par A28).** A17 complétait la cible par un
> « `hitSlop` vertical tombant dans la zone de retombée, qui est `pointerEvents="none"` », sous la
> condition « aucun ancêtre en `overflow: 'hidden'` ». Ce mécanisme est **non exécutable**, pour
> trois raisons cumulatives :
>
> 1. **Un `hitSlop` ne franchit pas les bornes d'un ancêtre.** La descente de la recherche de cible
>    n'entre dans un enfant que si le point est **déjà** dans les bornes du parent — Android
>    (`TouchTargetHelper.findTouchTargetView`, qui n'élargit du `hitSlop` que l'enfant testé, jamais
>    ses ancêtres) comme iOS (`hitTest:` s'arrête dès qu'un `pointInside:` de superview est faux).
>    Un `hitSlop` qui déborde la pilule n'est donc **jamais dispatché**, quelle que soit la valeur
>    d'`overflow`.
> 2. **La condition posée était vraie mais insuffisante**, et présentée comme LA condition
>    vérifiable. `overflow: 'hidden'` est une cause de plus d'annulation ; son absence ne rend rien
>    atteignable.
> 3. **Le budget n'existait pas.** Sur la barre livrée, la pilule ne porte que
>    `paddingVertical: 8` (`packages/ui/src/components/bottom-tab-bar.tsx` l. 60) : tout `hitSlop`
>    supérieur à 8 sort de la pilule, donc du parent du `Pressable`, donc du dispatch. Et la
>    retombée n'y change rien : c'est un **frère du conteneur de la pilule** (le `LinearGradient`
>    l. 110-117), jamais un **ancêtre** du `Pressable` — elle ne participe à aucun moment à la
>    descente de la recherche de cible, en plus d'être `pointerEvents="none"` (l. 111).
>
> Un implémenteur qui aurait suivi A17 aurait livré une cible **< 48 dp sur Android** en croyant
> l'avoir tenue. Le `hitSlop` reste légitime **ailleurs** — à l'intérieur du padding d'un parent,
> cf. `hitSlop: 6` du `Button` en taille `compact`
> ([03 § Bouton principal](03-motion-interaction-system.md#bouton-principal)) — mais il ne tient
> **aucune** cible de cette barre.

**Critère d'acceptation — mesurable, pas intentionnel.** Sur build release, aux deux tailles de
texte **100 %** et **~200 %**, sur iOS et sur Android, à `progress = 1` (barre entièrement
repliée) :

1. `measure()` sur le `Pressable` de **chacun** des cinq onglets → `height ≥ 44.0` (iOS) /
   `≥ 48.0` (Android) et `width ≥ 44.0 / 48.0` ;
2. le rectangle mesuré de chaque `Pressable` est **entièrement contenu** dans le rectangle mesuré
   de la pilule — l'écart vertical de part et d'autre vaut exactement `rythmeExtérieur`, soit `0`
   au repli. Aucune cible ne dépasse de son conteneur ;
3. deux `Pressable` voisins ne se recouvrent pas (intersection des rectangles = ∅) ;
4. **preuve de touche**, la seule qui prouve le dispatch : un tap à 1 dp **à l'intérieur** du bord
   haut puis du bord bas de chaque `Pressable` sélectionne cet onglet ; un tap à 1 dp
   **au-dessus** du bord haut de la pilule ne sélectionne **rien** — ce qui démontre qu'aucune
   cible fantôme ne vit dans la retombée ;
5. aucun `hitSlop` n'est déclaré sur les `Pressable` de la barre : contrôle statique, pas revue
   visuelle.

Le verdict est `FAIL` si l'une de ces cinq mesures manque : une cible « visiblement assez grande »
n'est pas une cible mesurée.

> **Ce qui était faux (rédaction A3, supersédée par A17).** « La hauteur VISIBLE descend sous 44 pt
> au repli, jamais la CIBLE TACTILE : **le débord de retombée** (§ Exigences communes) la maintient
> à ≥ 44 pt. » La retombée de bord est **décorative et non interactive** — `pointerEvents="none"`,
> § Retombée de bord, ligne « Interaction », et
> [10 § Règles d'implémentation](10-performance-observability.md#règles-dimplémentation). Une vue
> qui ne reçoit aucune touche ne peut porter aucune cible : le raisonnement inversait la cause. La
> cible se tient par le `Pressable` **lui-même**, comme dans la barre **livrée**, qui pose bien la
> cible sur le `Pressable` (`minHeight: 44`,
> `packages/ui/src/components/bottom-tab-bar.tsx` l. 78).
> *(A17 disait ici « par le `Pressable` **et son `hitSlop`** » — corrigé A28 : le `hitSlop` ne
> franchit pas les bornes de la pilule, il ne peut donc rien compléter ici.)*
>
> **Défaut de code signalé, non corrigé.** La même ligne 78 pose `minHeight: 44` **sans distinction
> de plateforme**, et le contenu de l'onglet mesure ~39 pt (icône 23 + `gap` 3 + label ~13) : la
> cible livrée vaut donc **44 dp sur Android**, sous le plancher de 48 dp que le présent paragraphe
> pose comme absolu. Ce n'est pas une erreur de document — c'est un écart du **code**, hors du
> présent lot documentaire et hors de la borne de livraison n° 1 (« la `BottomTabBar` existante
> n'est ni restylée ni supprimée »). Il est consigné au
> [README § Défauts de code signalés](README.md#journal-des-amendements) et **n'est pas corrigé
> ici**.

**Ce qui s'adapte, ce qui reste fixe, ce qui passe sur plusieurs lignes.**

| Grandeur | Régime | Règle normative |
| --- | --- | --- |
| Hauteur étendue de la pilule | **S'adapte** | `hauteurÉtendue = hauteurPressable(0) + 2 × 4 pt`, avec `hauteurPressable(0) = max(CIBLE, hauteur mesurée du contenu à la taille de texte courante)`. **58 pt** est sa valeur à la taille standard, donc un **plancher**, jamais un plafond. |
| Hauteur repliée de la pilule | **Se déduit de la cible** | **(corrigé A28 · 2026-07-30)** `hauteurRepliée = hauteurPressable(1) = max(CIBLE, hauteur de l'icône + rythme intérieur)`, le rythme **extérieur** valant 0 au repli. Soit **44 pt sur iOS** et **48 dp sur Android** à la taille standard : sur Android elle ne vaut **jamais** 44. *Rédaction A19 (supersédée) : « `max(44 pt iOS / 48 dp Android, hauteur de l'icône + rythme)` » — la formule était juste, mais la prose voisine décrivait encore une pilule Android à 44, que cette même formule interdit.* |
| Visuel intérieur (highlight, bloc icône/label) | **S'adapte** | Interpolé entre les deux hauteurs ci-dessus, moins le rythme intérieur. `50 → 35 pt` est sa valeur à la taille standard. Il est **dessiné dans** le `Pressable` et ne le redimensionne jamais. |
| Cible tactile | **Fixe — plancher absolu** | `CIBLE` = 44 pt iOS / 48 dp Android, portée par la **hauteur du `Pressable`** et par rien d'autre. Un plancher ne rétrécit pas ; il ne s'échelonne pas non plus avec le texte ; il ne se complète pas par un `hitSlop`. |
| Retrait latéral animé `0 → 34 pt`, marge de safe area 12 pt | **Fixe** | Grandeurs horizontales, sans texte : la taille de police ne les concerne pas. |
| `borderRadius = hauteur / 2` | **Fixe en tant que fonction** | C'est une formule, pas une constante : elle suit automatiquement la hauteur adaptée. |
| Débord de la retombée (44 pt) | **Fixe** | Zone décorative sans texte (§ Retombée de bord). |
| Label d'onglet | **Passe sur plusieurs lignes, puis disparaît** | Voir le palier ci-dessous. |

**Palier du label** — déterministe et testable à `PERF-12` / matrice `~150 %` / `~200 %` :

1. tant que le label tient sur **une** ligne dans la largeur d'item : une ligne ;
2. sinon, tant qu'il tient sur **deux** lignes : `numberOfLines={2}`, la pilule grandit d'autant.
   `adjustsFontSizeToFit` est **interdit** — il casserait silencieusement l'échelle typographique et
   rendrait le 10 pt du label encore plus petit ;
3. sinon, la barre passe **icônes seules** au repos : le label est **retiré**, jamais tronqué. Le
   nom reste porté par `accessibilityLabel` (déjà posé,
   `packages/ui/src/components/bottom-tab-bar.tsx` l. 73) et la sélection par
   `accessibilityState.selected` : aucune information n'est perdue, seule une redondance visuelle
   l'est.

`allowFontScaling` n'est **jamais** désactivé pour préserver la pilule
([08 § Typographie](08-accessibility-adaptive-design.md#typographie)). Conséquence directe :
`numberOfLines={1}` de la barre livrée n'est pas transposable tel quel dans le portage — il
tronquerait, ce que l'exigence commune interdit.

### 2. Highlight glissant à ressort interruptible

| Paramètre | Valeur normative |
| --- | --- |
| Topologie | **un seul** bloc animé partagé, en absolu dans la capsule — pas un highlight par onglet |
| Position | `translateX` **transform-only** (GPU, zéro travail de layout par frame) |
| Géométrie | **(précisé A27 · 2026-07-30)** **Invariant** : la position du highlight ne dépend d'aucune mesure asynchrone — aucune frame de retard, aucun saut au premier rendu. **Moyen de référence** : la largeur d'item est **calculée** (`(largeur fenêtre − marges − inset) / nombre d'onglets`). `onLayout` est interdit **comme source de la géométrie animée** ; il reste permis pour une assertion de test ou une mesure non animée. |
| Ressort | **420 ms, `dampingRatio` 0,82** — légèrement sous-amorti, micro-rebond de calage sans danger parce que transform-only |
| Interruptibilité | par construction : un tab-hopping rapide recible en conservant la vélocité |
| Écrivains | le tap, le relâchement du scrub, et un effet sur le focus |
| Navigation programmatique | le highlight **voyage aussi** sur un deep link ou une action Bob à la voix — il ne saute pas |
| Garde | jamais recalé pendant un drag : pendant un scrub, le doigt est propriétaire du highlight |

**Identité conservée** : le highlight est un **aplat opaque** issu de `surfaceTint`.
**Abandonné** : le `rgba(255,255,255,0.14)` de la référence — un voile blanc translucide qui
n'existe que parce qu'il est posé sur du verre sombre.

> **Amendé A23 · 2026-07-30 — la teinte du highlight est une contrainte de contraste, pas un
> exemple.** Le highlight passe **sous les labels**, y compris sous des labels encore inactifs :
> il devient donc un **fond de texte**, et les trois rôles `navigation.*` doivent y rester AA. La
> teinte retenue doit satisfaire `contraste(rôle, highlight) ≥ 4,5:1` **pour les trois rôles**, le
> plus serré étant toujours `navigation.inactive` `#5B6B7B`. Relevé sur les tons `surfaceTint.light`
> (formule WCAG 2.x, mêmes bornes que `packages/tokens/src/index.test.ts` :
> `WCAG_AA_NORMAL_TEXT = 4.5`) :
>
> | Teinte candidate | `navigation.active` `#0C2340` | `navigation.assistantActive` `#4338CA` | `navigation.inactive` `#5B6B7B` | Verdict |
> | --- | ---: | ---: | ---: | --- |
> | `marine.flat` `#F4F7FB` | 14,69 | 7,36 | **5,10** | AA |
> | `ai.flat` `#F6F4FD` | 14,49 | 7,26 | **5,03** | AA |
> | `neutral.raised` `#EAEEF3` | 13,55 | 6,78 | **4,70** | AA |
> | `marine.raised` `#E2E9F2` | 12,91 | 6,46 | **4,48** | **sous AA** |
> | `neutral.border` `#E0E6EE` | 12,57 | 6,29 | **4,36** | **sous AA** |
> | `marine.border` `#D3DEEC` | 11,60 | 5,81 | **4,02** | **sous AA** |
>
> *Rédaction A3 (supersédée) : « par exemple `surfaceTint.light.marine.raised` `#E2E9F2` sur la
> pilule blanche ». L'exemple est retiré : `#E2E9F2` fait tomber `navigation.inactive` à **4,48:1**,
> sous le seuil AA du texte normal — et le label d'onglet est du texte normal (10 pt). L'affirmation
> du § 6 selon laquelle les rôles sont « déjà certifiés AA » reste vraie **sur la pilule**
> `colors.surface` `#FFFFFF` (5,48:1), pas sur un fond de highlight arbitraire : la certification
> livrée porte sur un couple, pas sur une couleur.*
>
> Le choix final appartient à `UX-ADR-002`/`D07`. Il ne peut pas être obtenu en assombrissant
> `navigation.inactive` : ce serait revaloriser un token livré et consommé, interdit par la
> [règle d'additivité](03-motion-interaction-system.md#règle-dadditivité).

### 3. Scrubbing au doigt avec ticks haptiques

| Paramètre | Valeur normative |
| --- | --- |
| Reconnaissance | `Race(pan, tap)` sur **toute** la capsule |
| Seuils du pan | `activeOffsetX ±6 pt` (au-delà, le pan gagne) ; `failOffsetY ±14 pt` (au-delà, le pan échoue et laisse passer le scroll) |
| Seuils du tap | `maxDistance 16 pt`, `maxDuration 400 ms` — la tolérance par défaut (~2 pt) fait échouer les taps de vrais doigts |
| Mapping | **1:1 strict, sans ressort pendant le drag** : l'indicateur doit se sentir attaché au doigt |
| Géométrie | recalculée **live** sur le `progress` d'expansion : elle suit la barre pendant qu'elle s'ouvre |
| Tick haptique | `selection`, au **franchissement de frontière** d'onglet, jamais un tick par frame |
| Navigation | **au relâchement seulement, jamais pendant le drag** — changer d'écran sous le doigt ferait sauter le contenu |
| Fin de geste **(levé A22 · 2026-07-30)** | au relâchement, le **recalage au ressort** du highlight (§ 2) et la **navigation** partent dans la **même frame**. La navigation **n'attend pas** que le ressort se stabilise : un ressort n'est pas une porte. Garde contre la double-navigation quand le pan a échoué (le geste était un tap) |

Le tick correspond exactement à la ligne « Sélection → `selection` » de la table haptique de
[03 — Motion](03-motion-interaction-system.md) : rien à inventer.

> **Ambiguïté levée A22 · 2026-07-30.** La rédaction A3 disait « recalage au ressort du highlight
> (§ 2) **puis** navigation ». Lu comme une séquence temporelle, ce « puis » impose d'attendre la
> fin d'un ressort de **420 ms** avant de naviguer — ce qui viole frontalement la règle
> fondamentale n° 3 de [03](03-motion-interaction-system.md#règles-fondamentales) (« une animation
> ne bloque pas un tap ni un résultat backend ») et le budget « transition fréquente ≤ 300 ms » de
> [10](10-performance-observability.md#budgets-initiaux-proposés). « Puis » ne décrivait pas un
> ordre temporel mais une **dépendance de valeur** : l'onglet cible est lu **avant** de lancer le
> ressort, parce que c'est lui qui fixe la position d'arrivée. Les deux effets sont ensuite
> **simultanés** — le ressort continue de tourner pendant que le fade-through de l'écran entrant
> (§ 5) a déjà commencé. Preuve attendue : vidéo au ralenti d'un scrub d'un bout à l'autre montrant
> que le premier frame du fade-through de l'écran entrant tombe **avant** la stabilisation du
> highlight, jamais après.

**Supériorités Bob obligatoires, absentes de la référence** :

- le tick respecte la **préférence système** haptique et fonctionne sur **les deux OS** (la
  référence le garde sous `Platform.OS === 'ios'`, ce qui est un choix de la lib, pas une
  contrainte) ;
- le scrub est **désactivé quand un lecteur d'écran est actif** : le détecteur de geste consomme
  les touches, et sans cette coupure la barre deviendrait un bloc opaque au geste d'exploration
  VoiceOver/TalkBack. Les `Pressable` reprennent alors la main.

### 4. Flou de bord

Le principe et la géométrie sont repris : zone de dissolution qui déborde d'environ **44 pt**
au-dessus de la pilule, jamais de bord dur, non interactive, hauteur totale = inset bas + hauteur
**ÉTENDUE** de la barre + débord — **(corrigé A28 · 2026-07-30 : « hauteur de barre » était
ambigu sur la seule barre du dossier dont la hauteur s'anime. L'enveloppe est dimensionnée une
fois, sur l'état le plus haut ; voir § Pourquoi l'enveloppe est fixe et non recalculée par
frame.)** Sur cette barre, la retombée est **toujours** en mode nominal teinté : le mode flouté ne
coexiste jamais avec un chrome dont la hauteur s'anime.

**Identité conservée** : c'est notre § Retombée de bord — `patterns.bottomTabBar.fade`, un dégradé
de notre couleur de fond, **déjà livré** dans `packages/ui/src/components/bottom-tab-bar.tsx`.
**Abandonné** : toute la matière de la référence — dix `BlurView` iOS empilées **et** un voile noir
`rgba(0,0,0,.70)` en pied, qui sur notre fond `#EFF2F7` est une inversion complète d'identité.

### 5. Slot d'écran qui s'efface (fade-through)

| Paramètre | Valeur normative |
| --- | --- |
| Écran entrant | opacité 0 → 1 et échelle **0,985 → 1** en **280 ms** = `motionSemantic.replace`, courbe `easing.enter` |
| Écran sortant | **aucune animation** : masqué instantanément — jamais deux écrans animés qui se croisent |
| Premier rendu | le tout premier écran au lancement n'est pas animé |
| Reduced Motion | **durée 0**, via `useReduceMotion()` |
| Respect des options | `lazy`, `unmountOnBlur`, `freezeOnBlur`, `detachInactiveScreens` conservés |

Cette référence **confirme** l'exigence commune : chez elle non plus les écrans frères ne glissent.
La seule lacune à corriger est qu'elle **n'écoute pas Reduce Motion** ; notre version passe par
`packages/ui/src/hooks/use-reduce-motion.ts`. La courbe est notre `easing.enter`, pas une bézier
recopiée inline.

> **Amendé A12 · 2026-07-29 — la durée du fade-through n'est plus un chiffre libre.** Un
> fade-through est exactement le cas d'usage de `motionSemantic.replace`, que
> [03 § Livrés — à consommer tels quels](03-motion-interaction-system.md#livrés--à-consommer-tels-quels)
> désigne mot pour mot : « Fade-through, segment, filtre ». La valeur **livrée** de ce token est
> **280 ms** — `packages/tokens/src/index.ts` l. 209, gelée par `packages/tokens/src/index.test.ts`
> l. 98 (`expect(motionSemantic.replace).toBe(280)`) et par
> `packages/ui/src/components/motion-presence.test.ts` l. 24. Le plan P1 du fondateur
> ([`beta-fly-services-p1-conception-ecrans.md`](../superpowers/plans/beta-fly-services-p1-conception-ecrans.md)
> §1.4) énonce la même valeur — trois autorités concordantes, aucune ne dit 220. Elle reste sous le
> plafond « transition fréquente ≤ 300 ms » de [10 — Performance](10-performance-observability.md).
> Conformément à la [règle d'additivité](03-motion-interaction-system.md#règle-dadditivité), le
> dossier **consomme** ce token, il ne le revalorise pas.
>
> *Rédaction A3 (supersédée) : « 220 ms ». Cette durée n'était adossée à aucun token ; elle
> coïncide avec `motion.base` (`packages/tokens/src/index.ts` l. 186), qui appartient au registre
> **historique** réservé aux écrans existants et ne régit pas les destinations sœurs. Le dossier
> portait donc deux durées différentes — 280 ms en [03](03-motion-interaction-system.md) et
> 220 ms ici et au [19 — Glossaire](19-glossary.md) — pour une seule et même transition.*

### 6. Teinte icône/label pilotée par le highlight, pas par le focus

**Invariant (l'exigence).** La teinte de l'icône et du label est une fonction **continue** de la
distance au highlight, `1 − min(|position du highlight − index|, 1)` : un crossfade linéaire sur
exactement une largeur d'onglet. Aucun booléen de focus n'intervient.

**Moyen de référence (précisé A27 · 2026-07-30).** Deux glyphes superposés — inactif dessous, actif
par-dessus — dont on anime l'opacité du glyphe supérieur. C'est le moyen de la référence, et celui
qu'on retient par défaut parce qu'il est transform/opacity pur. Il n'est **pas** l'exigence : toute
technique donnant la même fonction continue satisfait § 6, à trois conditions cumulatives —
(1) le contraste est **échantillonné** le long de la course, pas déduit ; (2) le coût **au repos**
n'excède pas celui du double glyphe, mesuré à `PERF-13` ; (3) la variante Reduced Motion commute
sans rendre de position intermédiaire. Une interpolation de la prop `color` d'un glyphe unique est
donc recevable si elle passe ces trois portes — et elle supprime au passage le doublon
d'accessibilité ci-dessous.

Conséquence : la teinte suit **le highlight**, pas le focus de navigation. Pendant un scrub les
icônes s'allument au passage du doigt ; sur un tap, la lumière **voyage** avec l'indicateur au lieu
de commuter d'un coup.

**Identité conservée** : les rôles déjà certifiés AA de `bottom-tab-bar.logic.ts` —
`navigation.active` `#0C2340`, `navigation.inactive` `#5B6B7B`, et la règle Bob propre à l'onglet
Assistant `navigation.assistantActive` `#4338CA`, **qui doit survivre à l'interpolation** (elle n'a
aucun équivalent dans la référence). Nos icônes maison prennent déjà une prop `color` : elles se
prêtent au double rendu sans modification. **Abandonné** : les teintes de chrome sombre de la
référence, son `fontSize: 9.5` — **(corrigé A13 · 2026-07-29)** notre label d'onglet reste à
**10 pt**, valeur **livrée** : `font('meta')` (Hanken Grotesk 600) posé puis explicitement ramené
par `fontSize: 10` dans `packages/ui/src/components/bottom-tab-bar.tsx` l. 94, en paire certifiée
AA avec les rôles `navigation.*`. On ne la change pas pour ressembler à la référence — et
SF Symbols (`expo-symbols`, inexistant sur Android).

> *Rédaction A3 (fausse, supersédée par A13) : « notre label reste à 10 pt `font('meta')`, sous
> peine de passer sous le plancher de lisibilité en plein soleil ». Deux faits faux. **Un**,
> `font('meta')` ne vaut pas 10 pt : il résout `type.meta` = **12 pt** Hanken Grotesk 600
> (`packages/tokens/src/index.ts` l. 147) ; le 10 pt vient d'un override explicite du composant, et
> l'écrire autrement laisserait croire qu'on peut obtenir la taille du label en citant le token
> seul. **Deux**, aucun « plancher de lisibilité » n'est défini par ce dossier, et le dépôt rend
> déjà du 9,5 pt (`apps/mobile/src/components/PieceDetailView.tsx` l. 346) : la justification
> invoquée était contredite par le code qu'elle prétendait protéger. Le motif réel du refus est
> plus simple et vérifiable — nous avons **notre** valeur livrée et certifiée, la référence n'a pas
> autorité sur notre typographie ([17 § Ligne de partage](17-references.md#autorités-normatives) :
> on reprend le comportement, pas la matière).*

**Ce que ce comportement exige en plus (ajouté A8 · 2026-07-29)** — parce qu'il est le seul à
interpoler une **couleur** et non une géométrie :

| Contrainte | Valeur normative |
| --- | --- |
| Contraste en cours d'interpolation **(précisé A23 · 2026-07-30)** | Le rapport de contraste doit rester **AA sur toute la course**, pas seulement aux deux extrémités — et l'échantillonnage est **à deux dimensions** : la couleur du texte **et** le fond réellement derrière le pixel, qui est tantôt la pilule `colors.surface` `#FFFFFF`, tantôt la capsule de highlight qui passe dessous (§ 2). Les bornes ne sont certifiées que sur la pilule ; ni le chemin, ni le fond de highlight ne le sont automatiquement, en particulier `navigation.assistantActive` `#4338CA` → `navigation.inactive` `#5B6B7B`. À prouver par échantillonnage, pas par raisonnement. |
| Reduced Motion | La teinte **commute** à l'état final, sans course : `useReduceMotion()`, durée 0, même couleur d'arrivée. Aucune position intermédiaire n'est rendue. **(précisé A18 · 2026-07-30)** Tant que la préférence n'est pas connue, on est dans l'état **replié** de la règle fail-closed : on commute, on n'anime pas. |
| Lecteur d'écran | La teinte est **décorative** : la sélection est portée par `accessibilityState.selected`, jamais par la couleur seule. Scrub désactivé (§ 3), donc la teinte suit alors le focus et non le doigt — c'est le même code, avec un highlight qui ne bouge que par saut. |
| Accessibilité des glyphes **(ajouté A27 · 2026-07-30)** | Les glyphes sont **décoratifs** et doivent être **retirés de l'arbre d'accessibilité** : `accessible={false}` + `importantForAccessibility="no-hide-descendants"` sur chaque `<Svg>`, ou sur le conteneur qui les porte tous les deux. Sans cela, TalkBack peut annoncer **deux** éléments par onglet — c'est le moyen « double glyphe » qui crée le doublon, pas l'invariant. Le nom accessible reste porté par le `Pressable` (`accessibilityRole="tab"` + `accessibilityLabel`, déjà posés dans `packages/ui/src/components/bottom-tab-bar.tsx` l. 71-74). Les icônes livrées (`apps/mobile/src/components/icons.tsx`) ne portent **aucune** de ces props aujourd'hui : le portage les ajoute, il ne les suppose pas. |
| Coût de rendu | **Deux glyphes par onglet** (dix pour cinq onglets) sont montés en permanence. À mesurer dans `PERF-13`, pas à supposer négligeable. |
| Interpolation | Sur la **distance au highlight**, jamais sur un booléen de focus : c'est ce qui fait voyager la lumière au lieu de la commuter. |

### Ce que la référence ne fait PAS — et que Bob ne doit pas perdre en la copiant

Le silence de la référence n'est pas une norme. Sur ces cinq points, notre kit est **supérieur** et
ne doit pas régresser pour lui ressembler :

| Point | Référence | Exigence Bob |
| --- | --- | --- |
| Retap sur l'onglet actif | **Non traité** — `router.navigate` sur la route courante est un no-op | Retour en haut (§ Exigences communes) |
| Clavier | **Aucune gestion** — barre en `position: absolute; bottom: 0` | Comportement défini et testé |
| Rôles d'accessibilité | **Non posés** par la barre | `accessibilityRole` `tablist`/`tab` + `accessibilityState.selected`, **déjà** dans `bottom-tab-bar.tsx` |
| Reduce Motion / Reduce Transparency | **Aucune gestion, nulle part** dans le paquet | `useReduceMotion()` obligatoire ; Reduce Transparency sans objet (surfaces opaques) |
| Badge | Non traité | Annoncé avec sa signification |

Ce que la référence fait bien et qu'on reprend tel quel : le calcul de safe area
(`max(inset bas − 16, 12)`, marge latérale 12 pt) et la géométrie recalculée à la rotation.

### Bornes de livraison

1. Ces comportements sont livrés par le **nouveau** composant. La `BottomTabBar` existante n'est ni
   restylée ni supprimée tant que la refonte visuelle est reportée (directive 5 du fondateur).
2. **(corrigé A7 · 2026-07-29 — vérifié dans `apps/mobile/package.json`)** Les deux bibliothèques du
   portage n'ont **pas** le même statut, et A3 les avait mises à tort dans le même sac :
   - `react-native-reanimated` **`4.5.0`** et son runtime `react-native-worklets` **`0.10.0`** sont
     **déclarés** dans `apps/mobile/package.json` — ajoutés le 2026-07-28 par `251271dc`
     (« prescrits par SDK 57 »), donc **après** le snapshot `2515ddf3` du dossier — mais
     **importés par aucun fichier** de `apps/mobile` ni de `packages/ui/src`. Le portage en est le
     **premier usage réel** : c'est un runtime à mettre en service, pas une dépendance à ajouter.
   - `react-native-gesture-handler` **`^2.32.0`** est déclaré **et déjà utilisé** : le
     `GestureHandlerRootView` est monté à la racine (`apps/mobile/app/_layout.tsx`) et deux écrans
     consomment `Swipeable` (`app/catalogue.tsx`, `src/components/PieceDetailView.tsx`). Le portage
     **n'introduit pas** cette dépendance ; il étend son usage au **chrome** (`Race(pan, tap)`,
     § 3), là où elle ne servait qu'au contenu — ce qui déplace le risque du « premier build natif »
     vers le **conflit de gestes** avec les `Swipeable` existants et le scroll (`R40`).
   - Reste **une seule** dépendance réellement absente : `expo-haptics`, introuvable dans tous les
     `package.json` du dépôt.

   Tout le motion actuel reste en `Animated` RN avec `useNativeDriver`. Ces faits relèvent de
   `UX-ADR-001`, `UX-ADR-002` et `UX-ADR-006` : aucune dépendance n'est ajoutée par le présent
   document.

   **(ajouté A25 · 2026-07-30)** Ces versions se lisent sur le SDK **réellement intégré** :
   **Expo 57.0.8, React Native 0.86.0, React 19.2.3, Expo Router 57.0.8**
   (`apps/mobile/package.json`, vérifié le 2026-07-30). Toute matrice de compatibilité produite par
   `WP-0004` part de ces versions, et non de « Expo 56 / RN 0.85 » — voir
   [17 § Politique de version](17-references.md#politique-de-version).

   *Rédaction A3 (fausse, supersédée) : « les deux sont installés (4.5.0 et 2.32.0) mais aucun
   fichier de `apps/mobile` ni de `packages/ui/src` ne les importe ». Gesture Handler est importé
   depuis `75de6545`, ce que
   [09 § État de dépendances observé](09-technical-architecture.md#état-de-dépendances-observé)
   disait déjà correctement — l'amendement recréait donc la contradiction qu'il prétendait lever.*
3. Aucune valeur ci-dessus n'est un « réglage » d'un token existant : les deux ressorts nécessaires
   sont des **ajouts** au kit, spécifiés dans
   [03 — Motion](03-motion-interaction-system.md#ajouts-nécessaires-au-portage-de-la-tab-bar).

## Headers et StatusBar

| Surface | Header | StatusBar |
| --- | --- | --- |
| Aujourd'hui navy | Hero éditorial, peut se contracter. | Clair. |
| Tab claire | Grand titre puis compact. | Sombre. |
| Détail objet | Titre contextuel, actions toolbar. | Selon fond réellement visible. |
| Full-screen marine | Contrôles clairs et safe area. | Clair. |
| Sheet | Le propriétaire dessous ne change pas arbitrairement de style. | Contraste garanti. |
| Média/caméra | Overlay contrôlé. | Style calculé pour la zone système. |

Un seul owner de StatusBar est actif : route de premier plan ou orchestrateur de chrome. La
transition de style ne précède pas le changement de fond.

## Scroll

- Le contenu utilise les insets automatiques lorsqu'ils correspondent au header natif.
- Le collapse suit le scroll 1:1, sans délai ni interpolation indépendante.
- Le header compact conserve titre et action principale nécessaires.
- Une remontée fait réapparaître le chrome sans voler le scroll.
- Aucun parallax gratuit sur les pages financières/administratives.
- Les listes ne sont pas imbriquées sur le même axe sans justification.
- Un changement de filtre conserve ou réinitialise la position selon une règle explicite.
- Le retap tab remonte la racine ; il ne modifie pas un formulaire en cours.

## Sheets

### Types

| Type | Detents | Usage |
| --- | --- | --- |
| Action courte | Contenu/medium | Source, partage, filtre. |
| Formulaire | Medium/large | Client, dossier, paiement. |
| Sélecteur | Medium/large | Catalogue, destination document. |
| Confirmation | Contenu | Abandon/destruction/conséquence. |

### Contrat

- translation calculée depuis la hauteur réelle ;
- drag lié au doigt et settle depuis vélocité ;
- poignée seulement si la sheet est réellement draggable ;
- titre visible et focus initial cohérent ;
- fermeture VoiceOver/TalkBack et Escape ;
- clavier ne masque jamais le CTA ;
- dismissal bloqué seulement avec dirty state/destruction ;
- une seule sheet visible ;
- scrim animé indépendamment mais synchronisé ;
- Reduce Motion : apparition immédiate/fade, gestes toujours utilisables ;
- fallback natif/custom documenté par plateforme.

## Menus et actions secondaires

- Les actions fréquentes restent visibles.
- Les actions rares se regroupent dans un menu ancré.
- Le menu naît du contrôle touché, sans déplacement du contenu.
- L'ordre privilégie action fréquente, information, puis destruction séparée.
- Une action essentielle n'est jamais disponible uniquement par long press.
- Context menu possède une alternative tap et des labels complets.

## Recherche et clavier

- Le champ devient la surface principale au focus.
- Annuler restaure le contexte et le scroll sans navigation parasite.
- Requête annulable/debouncée ; résultats obsolètes rejetés.
- Recherches récentes locales/tenant-safe selon contrat produit.
- Correspondance soulignée sans dépendre uniquement de la couleur.
- Clavier, autofill, password manager, dictée et lecteur d'écran testés.
- Le bouton retour ferme d'abord le clavier si attendu, puis la route.

## Continuité objet → détail

Éligible : avatar client, tuile dossier, miniature document, carte devis/facture, photo chantier.

Non éligible par défaut : mutation financière, confirmation, écran de paiement, formulaire avec
dirty state, destination dont la source peut disparaître avant le retour.

Le zoom partagé :

- préserve l'objet source et le geste Retour ;
- possède un identifiant stable ;
- tombe sur un push natif si l'API est absente ;
- ne retarde pas la destination ;
- est désactivé en Reduced Motion ;
- est testé après cold start, deep link et retour depuis background.

## Matières

> Amendé A1 · 2026-07-29 — doctrine « matière Bob ». Source : directive du fondateur, « ce n'est
> pas forcément du verre liquide qu'on veut… en gardant NOS couleurs. **Je NE VEUX PAS une UI
> transparente à la iOS.** » Autorité : `packages/tokens/src/index.ts` (`surfaceTint`) et
> `packages/ui/src/components/bob-surface.tsx`.

- **Surface teintée opaque partout, chrome compris.** Contenu, cartes, documents, zones de texte
  longues, **et aussi** tab bar, toolbars et contrôles flottants : `surfaceTint` / `BobSurface`,
  opacités pré-composées en hex. La `BottomTabBar` livrée en est la référence (pilule
  `colors.surface` + `controls.cardBorder` + `shadowNative.e2` + `radius.cardXl`).
- **Seule la RETOMBÉE peut être floutée** : la zone non interactive qui dissout le contenu sous un
  chrome flottant (`ProgressiveBlurBob`, § Retombée de bord). Jamais le fond d'une surface qui
  porte une information.
- **Le verre système n'est pas une option.** Liquid Glass / `expo-glass-effect` impose la teinte du
  système et varie par OS et par version : il ne peut pas porter l'identité Bob. Sa mention dans ce
  dossier sert uniquement à dire qu'on ne l'emploie pas.
- Contraste vérifié sur chaque fond réel, pas sur une maquette unie.
- **Reduce Transparency n'a rien à remplacer sur les SURFACES** : elles sont déjà opaques. Sur
  elles, la préférence ne déclenche aucun chemin de rendu alternatif, donc aucun chemin non testé.
  **(portée corrigée A28 · 2026-07-30)** Elle n'est pas pour autant « sans effet » dans tout le
  dossier : la **retombée de bord en mode flouté** est la seule matière du produit qui échantillonne
  quoi que ce soit, et Reduce Transparency — **active ou encore inconnue** — y déclenche le repli
  opaque unique (§ Quand le repli opaque unique s'applique, cas 2, et
  [08 § Préférences d'accessibilité et premier rendu](08-accessibility-adaptive-design.md#préférences-daccessibilité-et-premier-rendu)).
  *Rédaction A1 (supersédée) : « La préférence ne déclenche aucun chemin de rendu alternatif » —
  vraie des surfaces, fausse du seul composant qui a un mode flouté ; A18 posait une règle
  fail-closed sur une préférence que cette phrase déclarait sans objet.*
- Android ancien et iOS non compatible affichent **exactement la même surface** : il n'y a plus de
  fallback de matière, donc plus de divergence fonctionnelle ou esthétique par OS.
- Le blur n'est pas animé, ni en entrée/sortie, ni en Reduced Motion, ni jamais.

> Rédaction initiale 2026-07-23 (supersédée par A1) : « Blur/verre possible pour tab bar, toolbar
> et contrôles flottants » et « Reduce Transparency remplace par une surface opaque sémantique ».
> Ces deux lignes faisaient du verre la matière de premier choix du chrome et de l'opaque un repli.

## Retombée de bord — `ProgressiveBlurBob`

> Ajouté A2 · 2026-07-29. Source normative : plan P1 du fondateur,
> [`beta-fly-services-p1-conception-ecrans.md`](../superpowers/plans/beta-fly-services-p1-conception-ecrans.md)
> §1.3. Technique étudiée dans `davidmokos/expo-glass-tabs` → `src/progressive-blur.tsx` (43 l.),
> présent à l'identique dans `davidmokos/revolut-expo-clone`. Implémentation de référence déjà
> livrée : `patterns.bottomTabBar` (`packages/tokens/src/index.ts`) rendu par
> `packages/ui/src/components/bottom-tab-bar.tsx`.

### Ce que c'est

Un chrome flottant (tab bar, barre d'action de fiche, toolbar de visualiseur) laisse le contenu
défiler **dessous**. Sans traitement, le contenu vient buter sur le bord du chrome et on lit une
ligne de coupe. La **retombée de bord** est la zone qui dissout ce contenu avant qu'il n'atteigne
le chrome. Elle est décorative, non interactive (`pointerEvents="none"`), et ne contient jamais de
texte ni d'information.

### Mode nominal — teinté, sans aucun flou (défaut)

`ProgressiveBlurBob` rend **par défaut** un dégradé de notre couleur de fond, **zéro échantillon de
flou**, en un seul draw call :

| Paramètre | Valeur normative | Source |
| --- | --- | --- |
| Stops de couleur | `['rgba(239,242,247,0)', 'rgba(239,242,247,.92)', '#EFF2F7']` | `patterns.bottomTabBar.fade` |
| Positions | `[0, 0.32, 0.6]` — transparent au sommet, 92 % à 32 %, **opaque dès 60 %** | `patterns.bottomTabBar.fadeLocations` |
| Hauteur totale | `inset de sécurité + hauteur ÉTENDUE du chrome + 44 pt de débord` | Géométrie de la référence (`BLUR_BLEED`). **(précisé A27 · 2026-07-30)** L'enveloppe est dimensionnée une fois sur l'état **le plus haut** du chrome — voir § Pourquoi l'enveloppe est fixe |
| Ancre | `bottom` pour un chrome bas, `top` pour un chrome haut ; le point opaque est toujours au bord ancré | Référence |
| Interaction | `pointerEvents="none"` | Référence |
| Animation | **jamais animée**, dans aucun mode | Plan P1 §1.3 |

C'est la **même courbe de dissolution** que la référence, mais dans notre couleur, opaque par
construction, sans une seule ligne de noir, et déjà livrée.

#### Pourquoi l'enveloppe est fixe et non recalculée par frame

> Ajouté A27 · 2026-07-30. Contradiction levée : la ligne « Hauteur totale » fait dépendre la
> retombée de la hauteur du chrome, alors que la ligne « Animation » interdit d'animer cette même
> retombée — et la hauteur du chrome, elle, **s'anime** (§ 1). Les deux règles ne peuvent tenir que
> si l'on dit **quelle** hauteur de chrome on prend.

L'enveloppe est calculée **une fois**, sur la hauteur **étendue** du chrome — donc sur son état le
plus haut — et ne bouge plus. Le repli de la barre se produit **à l'intérieur** de cette enveloppe.
Trois raisons, dans cet ordre :

1. **La règle « jamais animée » est tenue littéralement.** Une hauteur recalculée à chaque frame
   serait une animation de layout par frame, que
   [10 § Règles d'implémentation](10-performance-observability.md#règles-dimplémentation) n'autorise
   que par une **exception nommée**, et cette exception ne couvre que le repli/dépli de la barre.
2. **Le surplus est invisible en mode nominal.** La retombée est un dégradé de
   **notre couleur de fond** (`#EFF2F7`), opaque dès 60 % de sa hauteur : quand la barre rétrécit,
   la bande opaque qui dépasse est exactement la couleur du fond de l'écran. Elle ne se voit pas.
   Cette propriété n'existe que parce que la matière est opaque et dans notre teinte — c'est un
   bénéfice direct de la doctrine A1, pas une coïncidence.
3. **Un `transform: scaleY` serait pire qu'une hauteur.** Étirer le dégradé déplace ses stops
   (`[0 ; 0,32 ; 0,6]`) : la courbe de dissolution changerait de forme à chaque frame, et le point
   opaque quitterait le bord ancré. La retombée n'est donc **ni redimensionnée, ni transformée**.

En **mode flouté**, le raisonnement 2 tombe : des échantillons de flou révèlent le décalage, parce
qu'ils échantillonnent le contenu et non une teinte. C'est la raison de fond pour laquelle le mode
flouté est réservé aux **fonds photographiques** (scan, aperçu, visualiseur), dont le chrome ne se
minimise pas. **Une retombée floutée ne coexiste jamais avec un chrome dont la hauteur s'anime.**

### Mode flouté — option bornée, teintée Bob

Réservé aux fonds où une teinte plate ne suffit pas parce que le fond **est une image** : scan,
aperçu de document, visualiseur photo. Jamais sur un fond de l'app.

| Paramètre | Valeur normative | Justification |
| --- | --- | --- |
| Topologie | N couches **frères** dans un même parent — **jamais imbriquées** | La retombée vient de la géométrie, pas d'un masque |
| Profil de hauteurs | `100 / 88 / 76 / 64 / 54 / 44 / 36 / 28 / 22 / 16 %` (tronqué aux N premières) | Profil exact de la référence. **(précisé A29 · 2026-07-30)** Il est calculé par **`@bob/ui`** et transmis couche par couche au port (`heightPercent`, `style`) : `apps/mobile` choisit le matériau, jamais la géométrie — § Couture du port |
| Intensité par couche | **uniforme et faible** (référence : 5 pour chacune) | L'intensité effective vient du recouvrement, pas d'une rampe |
| Intensité effective | ~5 × N au bord ancré → ~5 à l'extrémité, par marches de 5 | Nombre de couches couvrant le pixel à la distance f du bord |
| N (couches floutées) | **plafonné ; `N = 0` est le défaut** | Chaque couche est un échantillonnage GPU permanent sous scroll |
| Voile | **teinté Bob** — dégradé de notre couleur de fond, aux mêmes stops que le mode nominal | La référence pose `rgba(0,0,0,.70)`, inversion complète d'identité sur notre fond `#EFF2F7` |
| Rendu de couche | **port injecté `renderBlurLayer`** (doctrine `PrefsStorage`) — signature, propriétaire du `BlurTargetView` et passage de la `ref` : § Couture du port | `@bob/ui` ne prend aucune dépendance ; `expo-blur` reste dans `apps/mobile` |
| Repli | **repli opaque UNIQUE** = le mode nominal | Un seul chemin de secours, donc un seul chemin à tester |

### Contrat exécutable du port `renderBlurLayer` — `expo-blur`, Expo SDK 57

> Ajouté A20 · 2026-07-30. Ce contrat **débloque** le kit de matière : il sera écrit d'après lui.
> Source pinée : documentation Expo SDK 57, `expo-blur`,
> <https://docs.expo.dev/versions/v57.0.0/sdk/blur-view/>, consultée le 2026-07-30.
> `expo-blur` n'est déclaré dans **aucun** `package.json` du dépôt : son installation est une
> décision `D08`, et elle a lieu dans `apps/mobile` uniquement, jamais dans `packages/ui`.

Le port `renderBlurLayer` est injecté depuis `apps/mobile`. Il rend **une** couche de flou et rien
d'autre : ni voile, ni dégradé — le voile teinté Bob reste un `LinearGradient` **frère**, rendu par
`@bob/ui`. Contrat de props, tel que l'API le pose :

| Élément | Valeur normative | Plateforme | Pourquoi |
| --- | --- | --- | --- |
| Composant flouteur | `BlurView` (`expo-blur`) | iOS + Android | — |
| Conteneur du contenu flouté | **`BlurTargetView`** — le contenu à flouter est **enveloppé** dedans | Android | Depuis SDK 55, Android n'échantillonne plus l'arrière-plan implicitement : il faut lui **désigner** la cible. |
| Liaison | la **ref** du `BlurTargetView` est passée au `BlurView` par la prop **`blurTarget`** (`RefObject<View \| null>`) | Android | C'est le seul lien entre la couche et ce qu'elle floute. Sans lui, aucun flou. |
| Méthode | **`blurMethod="dimezisBlurViewSdk31Plus"`**, écrit explicitement | Android | Défaut de la prop = **`'none'`**, qui ne floute pas et rend **une vue semi-transparente** — précisément la matière hors doctrine. L'oubli de la prop produit donc la faute, silencieusement. |
| Méthode **interdite** | `blurMethod="dimezisBlurView"` | Android | Sous SDK 31 elle retombe sur `RenderScript`, coût GPU permanent sous scroll : hors budget (§ [10 — Budget de la retombée](10-performance-observability.md#budget-de-la-retombée-de-bord)). |
| Prop **interdite** | `experimentalBlurMethod` | Android | **Dépréciée** dans l'API courante (mappée sur `blurMethod`, avertissement runtime). |
| `intensity` | **uniforme et faible** (référence : 5 par couche) | iOS + Android | L'intensité effective vient du **recouvrement** des frères, pas d'une rampe. |
| `tint` | jamais `'dark'` | iOS + Android | La couleur perçue vient de **notre** dégradé frère, pas du matériau système. |
| `blurReductionFactor` | **défaut `4`**, non modifié sans profilage | Android | Réglage d'appariement d'intensité Android↔iOS ; le changer déplace le budget GPU. |
| Topologie | les `N` couches sont **frères** et pointent **toutes vers le même** `BlurTargetView` | iOS + Android | Un seul échantillonnage de cible, donc aucune imbrication — la règle de [09](09-technical-architecture.md#surfaces-et-apparence) et [10](10-performance-observability.md#règles-dimplémentation) est tenue par construction. |

**Rangs par version d'Android**, sans zone grise :

| Contexte | Rang | Ce qui est rendu |
| --- | --- | --- |
| iOS | flou possible | `BlurView` (`intensity`, `tint`) ; ni `blurTarget`, ni `blurMethod` (props Android). |
| **Android ≥ 31** (Android 12) | flou possible | `BlurTargetView` + `blurTarget` + `blurMethod="dimezisBlurViewSdk31Plus"`. Chemin efficace `RenderNode`, introduit par SDK 31. |
| **Android < 31** | **N0 — aucun flou** | Le port **n'a rien à monter** : `renderBlurLayer` rend `null` **pour tous les index** (règle *tout ou rien*, § Couture du port) et `ProgressiveBlurBob` sert son repli opaque unique. On ne se contente pas de laisser `dimezisBlurViewSdk31Plus` retomber sur `'none'` : `'none'` rendrait une vue **semi-transparente**, hors doctrine. |

**Limite connue, à traiter comme une coupure** : un `BlurTargetView` ne traverse pas la frontière
d'un `Modal` React Native (expo/expo#44165). Or `scan-document`, `devis/new` et `facture/new` sont
des **full-screen modals** dans la carte de routes ci-dessus, et le mode flouté vise justement les
fonds photographiques du scan. Sur Android, une retombée floutée rendue **à l'intérieur d'un
`Modal`** sert donc le repli opaque unique, sans exception ni contournement.

### Couture du port — qui rend quoi, de part et d'autre de la frontière de paquet

> Ajouté A29 · 2026-07-30. Le contrat de props ci-dessus est exact et **n'est pas modifié**. Il
> s'arrête cependant là où commence la seule chose que ce dossier devait spécifier : la **couture**
> entre `@bob/ui`, qui rend les couches, et `apps/mobile`, qui détient `expo-blur`. Trois trous
> obligeaient à deviner — la signature du port, le propriétaire du `BlurTargetView`, et le passage
> de sa `ref` à travers la frontière. Ce paragraphe les ferme, assez précisément pour que le kit
> s'écrive **sans deviner**.

#### 1. Signature du port — le type exact

`renderBlurLayer` n'est pas un nom de prop : c'est une fonction typée, injectée en prop de
`ProgressiveBlurBob`. Les deux seuls types importés viennent de `react` et de `react-native` ; rien
d'`expo-blur` n'apparaît dans `@bob/ui`.

```ts
// packages/ui/src/components/progressive-blur-bob.types.ts — AUCUN import d'expo-blur
import type { ReactElement } from 'react';
import type { StyleProp, ViewStyle } from 'react-native';

/** Description d'UNE couche, entièrement calculée par `@bob/ui`. */
export interface BlurLayerSpec {
  /** Rang de la couche. 0 = la plus haute (100 %), N−1 = la plus courte. */
  readonly index: number;
  /** Nombre total de couches demandées (`N`). Invariant : `0 <= index < layerCount`. */
  readonly layerCount: number;
  /** Hauteur de la couche en POURCENTAGE de la hauteur d'enveloppe, profil § Mode flouté. */
  readonly heightPercent: number;
  /** Intensité `expo-blur`, identique pour toutes les couches (valeur Bob : 5). */
  readonly intensity: number;
  /** Teinte `expo-blur`. Jamais `'dark'` — contrainte du contrat de props ci-dessus. */
  readonly tint: 'light' | 'default';
  /** Bord ancré de la retombée : `'bottom'` pour un chrome bas, `'top'` pour un chrome haut. */
  readonly anchor: 'top' | 'bottom';
  /** Position absolue déjà résolue par `@bob/ui`. À appliquer TEL QUEL, sans recalcul. */
  readonly style: StyleProp<ViewStyle>;
}

/** Rend une couche, et rien d'autre : ni voile, ni dégradé, ni conteneur. */
export type RenderBlurLayer = (spec: BlurLayerSpec) => ReactElement | null;

export interface ProgressiveBlurBobProps {
  readonly anchor: 'top' | 'bottom';
  /** Hauteur d'enveloppe en points — fixe, § Pourquoi l'enveloppe est fixe. */
  readonly height: number;
  /** `N`. `0` = mode nominal teinté, seul défaut livrable. */
  readonly layers?: number;
  /** Port injecté. ABSENT = repli opaque unique, sans autre condition. */
  readonly renderBlurLayer?: RenderBlurLayer;
}
```

**Règles de la signature**, toutes vérifiables :

| Règle | Énoncé |
| --- | --- |
| Retour | `ReactElement` = couche rendue ; `null` = pas de couche. |
| **Tout ou rien** | Pour un même montage, le port rend `N` éléments **ou** `null` pour tous les index. Une pile partielle est **interdite** : elle produirait une courbe de dissolution qui n'est ni celle du mode flouté ni celle du repli. |
| Détection du repli | Si le port renvoie `null` pour `index === 0`, `ProgressiveBlurBob` n'appelle plus le port et sert le **repli opaque unique**. C'est le seul chemin de bascule ; il n'y en a pas d'autre. |
| Propriété du profil | Le profil `100 / 88 / 76 / …` et le `style` de chaque couche sont calculés par **`@bob/ui`**, jamais par `apps/mobile`. Le port ne peut donc pas déformer la courbe : il choisit le **matériau**, pas la géométrie. |
| Voile | Le voile teinté Bob est un `LinearGradient` **frère**, rendu par `@bob/ui`, dans les deux modes. Le port ne le rend jamais. |

#### 2. Qui possède le `BlurTargetView`, et à quel niveau de layout

`BlurTargetView` doit envelopper le **contenu à flouter** — qui vit **hors** de
`ProgressiveBlurBob`. Il appartient donc à `apps/mobile`, et il se monte au niveau du **shell
d'écran**, dans le conteneur commun qui porte à la fois le contenu défilant et le chrome flottant :

```tsx
// apps/mobile/src/experience/blur/blurred-screen-shell.tsx — le SEUL endroit qui importe expo-blur
// Noms `BlurView` / `BlurTargetView` : ceux du contrat de props ci-dessus, aucun autre introduit.
<View style={{ flex: 1 }}>                        {/* parent commun, espace de coordonnées unique */}
  <BlurTargetView ref={blurTargetRef} style={StyleSheet.absoluteFill}>
    {children}                                    {/* le contenu défilant, ce qui est échantillonné */}
  </BlurTargetView>

  <ProgressiveBlurBob                             {/* DERNIER enfant — voir § 4 */}
    anchor="bottom"
    height={enveloppe}
    layers={N}
    renderBlurLayer={renderBlurLayer}             {/* la closure ci-dessous */}
  />
</View>
```

| Question | Réponse normative |
| --- | --- |
| Propriétaire | `apps/mobile`. `@bob/ui` ne le monte pas, ne le nomme pas, ne le type pas. |
| Niveau de layout | Le **shell d'écran** : le parent commun `flex: 1` qui contient le contenu **et** le chrome. Ni plus haut (un `BlurTargetView` racine échantillonnerait le chrome lui-même), ni plus bas (il manquerait le contenu qui défile). |
| Relation aux couches | Les `BlurView` sont des **frères** du `BlurTargetView`, jamais ses descendants : sinon la cible s'échantillonnerait elle-même. |
| Quantité | **Un seul** `BlurTargetView` par écran. Les `N` couches pointent toutes vers lui — c'est ce que dit la ligne « Topologie » du contrat, et c'est ici qu'elle devient exécutable. |

#### 3. Comment la `ref` traverse la frontière — elle ne la traverse pas

C'est le point qui rend le reste possible : **la `ref` ne franchit jamais la frontière de paquet.**
`@bob/ui` ne la voit pas, ne la type pas et n'a donc aucune raison d'importer `expo-blur`. Le port
est une **closure** créée dans `apps/mobile`, qui capture la `ref` dans sa portée lexicale :

```tsx
// apps/mobile/src/experience/blur/render-blur-layer.tsx
const blurTargetRef = useRef<View | null>(null);

const renderBlurLayer = useCallback<RenderBlurLayer>((spec) => {
  if (!canBlurHere) return null;              // Android < 31, dans un Modal, liste virtualisée,
                                              // Reduce Transparency active OU inconnue, hors budget
  return (
    <BlurView
      key={spec.index}
      style={spec.style}                      // géométrie de @bob/ui, appliquée telle quelle
      intensity={spec.intensity}
      tint={spec.tint}
      blurTarget={blurTargetRef}              // Android — la ref, capturée, jamais passée à @bob/ui
      blurMethod="dimezisBlurViewSdk31Plus"   // Android — écrite explicitement, jamais omise
    />
  );
}, [canBlurHere]);
```

`canBlurHere` est résolu **une fois par montage**, jamais par frame, et il est `false` par défaut :
c'est la traduction directe de § Quand le repli opaque unique s'applique. `@bob/ui` n'a besoin
d'aucune de ces conditions — il ne connaît que « le port a rendu quelque chose » ou « il a rendu
`null` ».

#### 4. L'englobement des couches, garanti par construction

La contrainte officielle est géométrique : *« as long as all of the `BlurView`s fit into the bounds
of a single `BlurTargetView` »*. Elle n'est **pas** garantie par le simple fait d'écrire du code —
elle l'est par la **structure** ci-dessus, et pour une raison unique :

1. le `BlurTargetView` est en `StyleSheet.absoluteFill` dans le parent commun : son rectangle est
   **exactement** celui du parent ;
2. la retombée est ancrée au même parent (`position: 'absolute', left: 0, right: 0, bottom: 0`) et
   toutes ses couches sont positionnées **dans** son enveloppe ;
3. deux rectangles exprimés dans le **même espace de coordonnées**, l'un occupant tout le parent,
   l'autre contenu dans le parent : l'inclusion est un fait de layout, pas une mesure à refaire.

**La seule façon de casser cet invariant** est de donner à l'enveloppe une hauteur supérieure à
celle du shell. Assertion de développement obligatoire, `__DEV__` uniquement :
`height <= hauteur mesurée du shell` — sinon `ProgressiveBlurBob` sert le repli opaque et journalise
l'écart. Aucune mesure n'est faite en production : l'invariant est structurel.

#### 5. Ordre de montage, et le cas de la liste virtualisée

Second point officiel, celui qui invalide silencieusement le rendu : *« the blur effect does not
update when `BlurView` is rendered before dynamic content using, for example, `FlatList` »*. Un flou
figé ne fait rougir **aucun** test : il rend une image, simplement périmée.

**Fait vérifié dans le dépôt le 2026-07-30** : `@shopify/flash-list` **`^2.0.2`** est déclaré dans
`apps/mobile/package.json` et n'est **importé par aucun fichier** de `apps/mobile` ni de
`packages/ui/src`. Le risque est donc encore entièrement devant nous — c'est le bon moment pour le
fermer.

| Règle | Énoncé | Comment on le vérifie |
| --- | --- | --- |
| **Ordre imposé** | Dans le parent commun, le `BlurTargetView` (donc le contenu) est monté **avant** la retombée. `ProgressiveBlurBob` est le **dernier** enfant du shell, sans exception. | Contrôle statique sur le shell d'écran : `ProgressiveBlurBob` est le dernier élément retourné. |
| **Interdiction au-dessus d'une liste virtualisée** | Tant qu'aucune preuve filmée ne démontre le rafraîchissement, le **mode flouté est interdit** au-dessus d'un `FlashList`, `FlatList`, `SectionList` ou `VirtualizedList` : la retombée sert le **repli opaque unique**. C'est la **cinquième** coupure, au même rang que les quatre autres. | Contrôle statique : aucun écran ne monte à la fois un de ces quatre composants et un `ProgressiveBlurBob` avec `layers > 0` ([11 § Tests statiques](11-test-strategy.md#tests-statiques)). |
| **Preuve de levée** | Vidéo : liste virtualisée d'au moins 200 cellules **hétérogènes** défilant 10 s sous la retombée ; on compare le contenu échantillonné à `t` et `t + 30` frames. Le flou doit **changer avec la liste**. Un flou identique = `FAIL`. | Manifest `PERF-CALIBRATION`, joint à `WP-0307`. Sans lui, l'interdiction reste. |

Cette coupure coûte peu, et c'est voulu : le mode flouté est déjà réservé aux **fonds
photographiques** (scan, aperçu, visualiseur), qui ne sont pas des listes. Elle ferme une porte que
la doctrine tenait déjà entrouverte — mais elle la ferme de façon **vérifiable**, ce qui n'était pas
le cas.

### Quand le repli opaque unique s'applique — sans exception

1. port `renderBlurLayer` absent (cas par défaut de `@bob/ui`), ou port rendant `null` pour la
   couche d'index `0` ;
2. **Reduce Transparency actif** — ou **encore inconnu** au premier rendu (règle fail-closed,
   [08 § Préférences et premier rendu](08-accessibility-adaptive-design.md#préférences-daccessibilité-et-premier-rendu)) ;
3. Android **< 31**, ou Android en rendu dégradé, ou retombée à l'intérieur d'un `Modal` sur
   Android ;
4. budget de performance non tenu sur l'appareil médian ;
5. **(ajouté A29 · 2026-07-30)** retombée posée au-dessus d'une **liste virtualisée**
   (`FlashList`, `FlatList`, `SectionList`, `VirtualizedList`), tant que la preuve de
   rafraîchissement du § Couture du port n'est pas fournie.

Dans les cinq cas, l'utilisateur voit la **même géométrie, la même courbe et la même couleur** :
seuls les échantillons de flou disparaissent. Aucune information, aucune cible et aucun contraste
ne change.

### Pourquoi notre version est meilleure que son modèle

Le `ProgressiveBlur` de la référence n'écoute **aucune** préférence d'accessibilité. Sous Reduce
Transparency, iOS dégrade chacune de ses dix `UIVisualEffectView` en matériau quasi opaque : la
retombée progressive s'effondre en **dalle dure** et le voile `rgba(0,0,0,.70)` subsiste par-dessus
— un bandeau sombre opaque en pied d'écran. Notre version n'a pas ce problème parce qu'elle **n'a
rien à dégrader** : elle est déjà opaque et déjà dans notre couleur.

### Contradiction levée

Deux documents canoniques posaient « jamais de blur imbriqué »
([09 — Architecture](09-technical-architecture.md), [10 — Performance](10-performance-observability.md))
et semblaient donc interdire la technique prescrite par le plan P1. Vérification faite dans le code
de la référence : les couches sont des **frères** dans un même parent et il n'y a **aucun masque**.
La règle ne visait pas cette technique ; elle était imprécise. Les deux documents ont été amendés
pour distinguer le blur imbriqué (interdit), le blur de fond d'une surface d'information (interdit)
et l'empilement de frères en zone non interactive (autorisé et **borné par un budget**).

## Adaptation tablette

| Domaine | Composition proposée |
| --- | --- |
| Clients | Liste maître + fiche, sélection persistante. |
| Documents | Dossiers/liste + aperçu document. |
| Ventes | Liste + détail pièce ; création centrée/largeur bornée. |
| Assistant | Conversation centrée, panneau de contexte optionnel. |
| Argent/Pilotage | Grille 2 colonnes avec largeur de lecture bornée. |
| Réglages | Sidebar de sections + détail. |

La tablette ne modifie pas les use cases ni les statuts. Une action reste accessible dans les deux
compositions.

## Deep links, restauration et retour

- Chaque route existante conserve son contrat de deep link ou une redirection explicite.
- La restauration ne rejoue pas une animation de succès.
- Un objet absent affiche un état honnête puis une sortie sûre.
- Un formulaire restauré relit sa révision avant de permettre une mutation.
- Le retour ferme menu → sheet → modal → route dans cet ordre logique.
- La route legacy voix ne produit aucune frame blanche ni boucle.

## Critères d'acceptation

- [ ] Route map acceptée et testée avec deep links.
- [ ] Geste Retour natif conservé sur tous les pushes éligibles.
- [ ] Dirty guards empêchent toute perte silencieuse.
- [ ] StatusBar lisible sur le premier, milieu et dernier frame.
- [ ] Sheets testées avec clavier, drag, focus et Reduce Motion.
- [ ] Tabs testées retap, badge, safe area, rotation et restauration.
- [ ] **(ajouté A17 · 2026-07-30 ; mécanisme tranché A28)** Cible tactile de chaque onglet
      **mesurée** ≥ 44 pt (iOS) / 48 dp (Android) à l'état **replié** et à ~200 %, portée par la
      hauteur du `Pressable` lui-même, rectangle du `Pressable` **contenu** dans celui de la pilule,
      cibles voisines non chevauchantes, **zéro `hitSlop`** sur la barre, et preuve de touche aux
      deux bords — les cinq mesures de
      [§ Cibles tactiles et Dynamic Type](#cibles-tactiles-et-dynamic-type).
- [ ] **(ajouté A19 · 2026-07-30)** Barre recettée à ~150 % et ~200 % : label sur une puis deux
      lignes, puis icônes seules ; **zéro troncature**, `allowFontScaling` jamais désactivé,
      hauteurs recalculées et non littérales.
- [ ] **(ajouté A23 · 2026-07-30)** Teinte de highlight retenue par `D07` **mesurée** ≥ 4,5:1 avec
      les trois rôles `navigation.*`, et contraste échantillonné le long de l'interpolation sur les
      **deux** fonds réels (pilule et highlight).
- [ ] **(ajouté A20 · 2026-07-30)** Si le mode flouté est activé : `BlurTargetView` + `blurTarget` +
      `blurMethod="dimezisBlurViewSdk31Plus"` présents et vérifiés ; Android < 31, Android dégradé
      et retombée dans un `Modal` servent le repli opaque unique.
- [ ] **(ajouté A29 · 2026-07-30)** Couture du port vérifiée : `@bob/ui` n'importe ni `expo-blur`
      ni sa `ref` ; **un seul** `BlurTargetView` par écran, monté par `apps/mobile` au shell
      d'écran, **avant** la retombée ; `ProgressiveBlurBob` **dernier enfant** du shell ; port
      **tout ou rien** ; assertion `__DEV__` d'englobement ; et **aucun** écran ne combine mode
      flouté et liste virtualisée sans la preuve filmée de rafraîchissement.
- [ ] Scroll ne saute pas pendant collapse ou layout transition.
- [ ] **(amendé A9 · 2026-07-29)** Matières **opaques par construction** (`surfaceTint` /
      `BobSurface`) et contraste vérifié. Aucune surface n'a de « fallback opaque » : l'opaque n'est
      plus un repli, c'est le rang normal. Seule la retombée de bord en mode flouté doit démontrer
      son repli — qui consiste à rendre cette même surface teintée.
      *Rédaction initiale 2026-07-23 (supersédée) : « Matières possèdent fallback opaque et
      contraste vérifié ».*
- [ ] Layouts tablette et split view conservent toutes les actions.
- [ ] Aucune route ne change de sens métier ou de contrat backend.
