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
- **(amendé A3 · 2026-07-29)** les labels sont présents et non tronqués **à l'état de repos de la
  barre**. La barre **peut se minimiser au scroll** : labels repliés, **tous les onglets restant
  visibles et atteignables**, cible ≥ 44 pt maintenue. Elle se ré-étend au scroll vers le haut, dès
  le retour à moins de 24 px du sommet, et à **toute** interaction avec la barre ;
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
| Géométrie | hauteur **58 → 44 pt**, marge latérale **0 → 34 pt par côté**, `borderRadius = hauteur / 2` recalculé à chaque frame | La pilule rétrécit dans **les deux** dimensions |
| Item et highlight | hauteur d'item **50 → 35 pt**, hauteur de highlight idem, **animées explicitement** et non déduites du contenu | Une taille dérivée du layout est en retard sur l'animation du thread UI |
| Labels | opacité 1 → 0 sur `progress ∈ [0 ; 0,4]` | Le label a disparu bien avant la fin du mouvement |
| Ré-expansion forcée | à `onStart` du pan, `onEnd` du tap et `onPress` du Pressable | Toute interaction délibérée avec la barre la ré-étend |

**Identité conservée** : la pilule reste `colors.surface` opaque, `radius.cardXl`,
`controls.cardBorder`, `shadowNative.e2`. **Abandonné** : rien — `minimize-context.tsx` n'importe
ni `expo-blur`, ni `expo-glass-effect`, ni aucune couleur. C'est du comportement pur, transposable
tel quel.

### 2. Highlight glissant à ressort interruptible

| Paramètre | Valeur normative |
| --- | --- |
| Topologie | **un seul** bloc animé partagé, en absolu dans la capsule — pas un highlight par onglet |
| Position | `translateX` **transform-only** (GPU, zéro travail de layout par frame) |
| Géométrie | **calculée** (`largeur d'item = (largeur fenêtre − marges − inset) / nombre d'onglets`), **jamais mesurée par `onLayout`** |
| Ressort | **420 ms, `dampingRatio` 0,82** — légèrement sous-amorti, micro-rebond de calage sans danger parce que transform-only |
| Interruptibilité | par construction : un tab-hopping rapide recible en conservant la vélocité |
| Écrivains | le tap, le relâchement du scrub, et un effet sur le focus |
| Navigation programmatique | le highlight **voyage aussi** sur un deep link ou une action Bob à la voix — il ne saute pas |
| Garde | jamais recalé pendant un drag : pendant un scrub, le doigt est propriétaire du highlight |

**Identité conservée** : le highlight est un **aplat opaque** issu de `surfaceTint` (par exemple
`surfaceTint.light.marine.raised` `#E2E9F2` sur la pilule blanche). **Abandonné** : le
`rgba(255,255,255,0.14)` de la référence — un voile blanc translucide qui n'existe que parce qu'il
est posé sur du verre sombre.

### 3. Scrubbing au doigt avec ticks haptiques

| Paramètre | Valeur normative |
| --- | --- |
| Reconnaissance | `Race(pan, tap)` sur **toute** la capsule |
| Seuils du pan | `activeOffsetX ±6 pt` (au-delà, le pan gagne) ; `failOffsetY ±14 pt` (au-delà, le pan échoue et laisse passer le scroll) |
| Seuils du tap | `maxDistance 16 pt`, `maxDuration 400 ms` — la tolérance par défaut (~2 pt) fait échouer les taps de vrais doigts |
| Mapping | **1:1 strict, sans ressort pendant le drag** : l'indicateur doit se sentir attaché au doigt |
| Géométrie | recalculée **live** sur le `progress` d'expansion : elle suit la barre pendant qu'elle s'ouvre |
| Tick haptique | `selection`, au **franchissement de frontière** d'onglet, jamais un tick par frame |
| Navigation | **au relâchement seulement** — changer d'écran pendant le scrub ferait sauter le contenu sous le doigt |
| Fin de geste | recalage au ressort du highlight (§ 2) **puis** navigation ; garde contre la double-navigation quand le pan a échoué (le geste était un tap) |

Le tick correspond exactement à la ligne « Sélection → `selection` » de la table haptique de
[03 — Motion](03-motion-interaction-system.md) : rien à inventer.

**Supériorités Bob obligatoires, absentes de la référence** :

- le tick respecte la **préférence système** haptique et fonctionne sur **les deux OS** (la
  référence le garde sous `Platform.OS === 'ios'`, ce qui est un choix de la lib, pas une
  contrainte) ;
- le scrub est **désactivé quand un lecteur d'écran est actif** : le détecteur de geste consomme
  les touches, et sans cette coupure la barre deviendrait un bloc opaque au geste d'exploration
  VoiceOver/TalkBack. Les `Pressable` reprennent alors la main.

### 4. Flou de bord

Le principe et la géométrie sont repris : zone de dissolution qui déborde d'environ **44 pt**
au-dessus de la pilule, jamais de bord dur, non interactive, hauteur totale ≈ inset bas + hauteur
de barre + débord.

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
> `packages/ui/src/components/motion-presence.test.ts` l. 24. Elle reste sous le plafond
> « transition fréquente ≤ 300 ms » de [10 — Performance](10-performance-observability.md).
> Conformément à la [règle d'additivité](03-motion-interaction-system.md#règle-dadditivité), le
> dossier **consomme** ce token, il ne le revalorise pas.
>
> *Rédaction A3 (supersédée) : « 220 ms ». Cette durée n'était adossée à aucun token ; elle
> coïncide avec `motion.base` (`packages/tokens/src/index.ts` l. 186), qui appartient au registre
> **historique** réservé aux écrans existants et ne régit pas les destinations sœurs. Le dossier
> portait donc deux durées différentes — 280 ms en [03](03-motion-interaction-system.md) et
> 220 ms ici et au [19 — Glossaire](19-glossary.md) — pour une seule et même transition.*

### 6. Teinte icône/label pilotée par le highlight, pas par le focus

Chaque onglet rend **deux glyphes superposés** — inactif dessous, actif par-dessus — et l'opacité
du glyphe actif vaut `1 − min(|position du highlight − index|, 1)` : un crossfade linéaire sur
exactement une largeur d'onglet. Le label interpole sa couleur sur la même distance.

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
| Contraste en cours d'interpolation | Le rapport de contraste doit rester **AA sur toute la course**, pas seulement aux deux extrémités. Les deux bornes sont certifiées ; le chemin entre elles ne l'est pas automatiquement, en particulier `navigation.assistantActive` `#4338CA` → `navigation.inactive` `#5B6B7B`. À prouver par échantillonnage, pas par raisonnement. |
| Reduced Motion | La teinte **commute** à l'état final, sans course : `useReduceMotion()`, durée 0, même couleur d'arrivée. Aucune position intermédiaire n'est rendue. |
| Lecteur d'écran | La teinte est **décorative** : la sélection est portée par `accessibilityState.selected`, jamais par la couleur seule. Scrub désactivé (§ 3), donc la teinte suit alors le focus et non le doigt — c'est le même code, avec un highlight qui ne bouge que par saut. |
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
- **Reduce Transparency n'a rien à remplacer** : les surfaces sont déjà opaques. La préférence ne
  déclenche aucun chemin de rendu alternatif, donc aucun chemin non testé.
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
| Hauteur totale | `inset de sécurité + hauteur du chrome + 44 pt de débord` | Géométrie de la référence (`BLUR_BLEED`) |
| Ancre | `bottom` pour un chrome bas, `top` pour un chrome haut ; le point opaque est toujours au bord ancré | Référence |
| Interaction | `pointerEvents="none"` | Référence |
| Animation | **jamais animée**, dans aucun mode | Plan P1 §1.3 |

C'est la **même courbe de dissolution** que la référence, mais dans notre couleur, opaque par
construction, sans une seule ligne de noir, et déjà livrée.

### Mode flouté — option bornée, teintée Bob

Réservé aux fonds où une teinte plate ne suffit pas parce que le fond **est une image** : scan,
aperçu de document, visualiseur photo. Jamais sur un fond de l'app.

| Paramètre | Valeur normative | Justification |
| --- | --- | --- |
| Topologie | N couches **frères** dans un même parent — **jamais imbriquées** | La retombée vient de la géométrie, pas d'un masque |
| Profil de hauteurs | `100 / 88 / 76 / 64 / 54 / 44 / 36 / 28 / 22 / 16 %` (tronqué aux N premières) | Profil exact de la référence |
| Intensité par couche | **uniforme et faible** (référence : 5 pour chacune) | L'intensité effective vient du recouvrement, pas d'une rampe |
| Intensité effective | ~5 × N au bord ancré → ~5 à l'extrémité, par marches de 5 | Nombre de couches couvrant le pixel à la distance f du bord |
| N (couches floutées) | **plafonné ; `N = 0` est le défaut** | Chaque couche est un échantillonnage GPU permanent sous scroll |
| Voile | **teinté Bob** — dégradé de notre couleur de fond, aux mêmes stops que le mode nominal | La référence pose `rgba(0,0,0,.70)`, inversion complète d'identité sur notre fond `#EFF2F7` |
| Rendu de couche | **port injecté `renderBlurLayer`** (doctrine `PrefsStorage`) | `@bob/ui` ne prend aucune dépendance ; `expo-blur` reste dans `apps/mobile` |
| Repli | **repli opaque UNIQUE** = le mode nominal | Un seul chemin de secours, donc un seul chemin à tester |

### Quand le repli opaque unique s'applique — sans exception

1. port `renderBlurLayer` absent (cas par défaut de `@bob/ui`) ;
2. **Reduce Transparency actif** ;
3. Android en rendu dégradé ;
4. budget de performance non tenu sur l'appareil médian.

Dans les quatre cas, l'utilisateur voit la **même géométrie, la même courbe et la même couleur** :
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
- [ ] Scroll ne saute pas pendant collapse ou layout transition.
- [ ] **(amendé A9 · 2026-07-29)** Matières **opaques par construction** (`surfaceTint` /
      `BobSurface`) et contraste vérifié. Aucune surface n'a de « fallback opaque » : l'opaque n'est
      plus un repli, c'est le rang normal. Seule la retombée de bord en mode flouté doit démontrer
      son repli — qui consiste à rendre cette même surface teintée.
      *Rédaction initiale 2026-07-23 (supersédée) : « Matières possèdent fallback opaque et
      contraste vérifié ».*
- [ ] Layouts tablette et split view conservent toutes les actions.
- [ ] Aucune route ne change de sens métier ou de contrat backend.
