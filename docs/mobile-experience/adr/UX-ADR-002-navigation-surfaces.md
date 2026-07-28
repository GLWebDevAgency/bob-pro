# UX-ADR-002 — Navigation et présentations

## Statut

Proposed — 2026-07-23

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

## Réexamen

Revoir Native Tabs/Zoom après stabilisation officielle et deux versions Expo sans régression connue.
