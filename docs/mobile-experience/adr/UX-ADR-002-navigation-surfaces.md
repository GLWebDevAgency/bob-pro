# UX-ADR-002 — Navigation et présentations

> **Amendement A3 — 2026-07-29 · comportement normatif de la tab bar**
> **Source.** Directive du fondateur du 2026-07-29 : « garder notre design system niveau couleur et
> identité, mais implémenter la même **FONCTIONNALITÉ, COMPORTEMENT et EFFET** que la tab bar de
> `github.com/davidmokos/expo-glass-tabs` ». C'est le comportement qui est demandé, pas la matière.
> **Portée.** Ajoute une contrainte au choix D07 et deux critères de vérification. Le corps daté du
> 2026-07-23 n'est pas réécrit ; les options A/B/C et la décision C restent inchangées.
> **Effet sur D07.** Le renderer de tabs final doit porter les comportements spécifiés dans
> [04 — § Comportement normatif de la tab bar](../04-navigation-scroll-surfaces.md#comportement-normatif-de-la-tab-bar).
> Ce n'est **pas** un ordre d'adopter `expo-glass-tabs` comme dépendance ni Native Tabs : c'est un
> cahier des charges de comportement, à porter dans le composant Bob, avec **notre** matière.
> **Conséquence pour Native Tabs.** `UITabBar` iOS 26 minimise en s'effondrant sur une seule icône,
> ce qui **perd la visibilité de tous les onglets** — contraire à l'exigence commune amendée
> (« tous les onglets restant visibles et atteignables »). Native Tabs ne peut donc pas satisfaire
> le comportement demandé ; l'option 2 (§ Options à prototyper de 04) devient non conforme, et
> l'option hybride 3 avec elle.
> **Dépendances révélées.** Le portage introduit `react-native-reanimated` et
> `react-native-gesture-handler` dans le produit (installés, mais importés nulle part à ce jour) et
> exige `expo-haptics` (absent de `apps/mobile/package.json`). Aucune n'est ajoutée par cet
> amendement : elles restent conditionnées à `UX-ADR-001` et `UX-ADR-006`.

## Statut

Proposed — 2026-07-23 · amendé A3 le 2026-07-29 (comportement de la tab bar)

## Décideurs attendus

Mobile tech lead, Design owner, Product owner, QA et Accessibility reviewer. Décision attendue en
Vague 0 après prototype comparatif des tabs, sheets, deep links et fallbacks.

## Contexte

Expo Router/Native Stack existe, mais tous les headers sont masqués et la plupart des routes n'ont
pas de présentation sémantique explicite. La tab bar Bob est différenciante mais statique. Native
Tabs et Apple Zoom offrent des comportements récents mais restent versionnés/expérimentaux.

## Drivers

- préserver deep links, restauration et geste Retour ;
- rendre push/modal/sheet compréhensibles ;
- conserver l'identité Bob ;
- obtenir keyboard/safe area/accessibilité robustes ;
- avoir un fallback stable par OS.

## Options

### A — Conserver toutes les surfaces custom

Faible migration mais dette de gestures, sheets et chrome.

### B — Migrer immédiatement vers toutes les APIs natives récentes

Très natif mais dépendance forte à des APIs alpha/versionnées et risque de perte d'identité.

### C — Architecture hybride et progressive

Native Stack et formSheet lorsque stables ; tab Bob conservée par défaut ; spikes Native Tabs/Zoom
isolés et fallback custom/natif stable.

## Preuves minimales pour accepter la décision

- inventaire des 32 routes physiques et de l'expérience auth, avec présentation candidate ;
- prototype non publié d'un push/retour interactif, d'une sheet clavier/focus et des deux options de
  tab bar sur les OS cibles ;
- deep link chaud/froid, dirty state et restauration démontrés sur le prototype ;
- tableau capability/fallback montrant que Native Tabs et Zoom ne sont pas bloquants ;
- arbitrage Product/Design/Mobile/QA/Accessibilité consigné.

## Décision proposée

Retenir C :

- Expo Router comme seule façade applicative ;
- matrice route → présentation versionnée ;
- push natif pour exploration ;
- full-screen modal pour création immersive ;
- formSheet natif ou sheet partagée selon tâche/capability ;
- tab bar actuelle améliorée comme baseline ;
- Native Tabs expérimenté dans un build/ring séparé, choix figé au démarrage ;
- Apple Zoom uniquement sur objets non critiques et fallback push.

## Conséquences

Positives : continuité plateforme sans dépendre d'une API unique ; rollout progressif ; identité Bob
préservée.
Négatives : matrice cross-platform plus riche ; coexistence de surfaces ; QA deep links importante.

## Critères de vérification de l'implémentation

- [ ] Route matrix complète et approuvée.
- [ ] Deep links/back/restauration/dirty state testés.
- [ ] Sheet clavier/focus/detents testée.
- [ ] Tab retap/badges/state preservation prouvés.
- [ ] Native Tabs/Zoom n'ont aucun rôle bloquant.
- [ ] StatusBar adaptative livrée avant chrome avancé.
- [ ] **(ajouté A3)** Les cinq comportements de la barre sont livrés et filmés : minimize-on-scroll,
      highlight glissant interruptible, scrub avec ticks au franchissement, retombée de bord et
      fade-through des écrans frères — chacun avec sa variante Reduced Motion et son alternative
      lecteur d'écran.
- [ ] **(ajouté A3)** Le scrub est **désactivé** quand un lecteur d'écran est actif, et les
      `Pressable` reprennent la main sans perte d'action.

## Réexamen

Revoir Native Tabs/Zoom après stabilisation officielle et deux versions Expo sans régression connue.
