# UX-ADR-001 — Runtime motion mobile

> **Amendement A7 — 2026-07-29 · fait de dépendance corrigé**
> **Source.** Lecture directe de `apps/mobile/package.json` et des imports de `apps/mobile` /
> `packages/ui/src`, après le commit `251271dc` (2026-07-28, « déclarer reanimated 4.5.0 et
> worklets 0.10.0 prescrits par SDK 57 ») — postérieur au snapshot `2515ddf3` dont hérite le corps
> de cet ADR.
> **Portée.** Corrige le seul constat de dépendance du § Contexte. Options, décision proposée et
> preuves minimales sont **inchangées**.
> **Fait.** `react-native-reanimated` `4.5.0` et `react-native-worklets` `0.10.0` sont des
> dépendances **directes** de `apps/mobile`, **importées nulle part** ;
> `react-native-gesture-handler` `^2.32.0` est déclaré **et déjà utilisé**
> (`GestureHandlerRootView` à la racine, deux `Swipeable` de contenu).
> **Ce que ça ne change pas.** Déclarer n'est pas adopter : aucun fichier n'exécute de worklet, la
> boundary JS/UI thread n'existe pas, et la décision de runtime reste entière. L'ADR gagne
> seulement en exactitude — la version compatible n'est plus « à proposer », elle est **déjà
> posée** et doit être **vérifiée** en build release.
> *Rédaction initiale 2026-07-23 (supersédée) : « Reanimated existe transitivement dans le lockfile
> mais n'est pas une dépendance mobile directe ».*

## Statut

Proposed — 2026-07-23 · amendé A7 le 2026-07-29 (fait de dépendance)

## Décideurs attendus

Mobile tech lead, Design owner, QA/performance owner et responsable Bob Live pour la non-régression
audio. Décision attendue en Vague 0 après spike release iOS/Android.

## Contexte

L'app utilise RN Animated dans plusieurs composants et possède des animations majoritairement
mount-only. Les interactions futures exigent layout transitions, gestes liés au doigt, scroll et
interruptibilité. ~~Reanimated existe transitivement dans le lockfile mais n'est pas une dépendance
mobile directe~~ **(corrigé A7 · 2026-07-29 : dépendance directe `4.5.0` + `worklets` `0.10.0`,
importée nulle part — voir l'encadré en tête)** ; Expo SDK 56/RN 0.85 utilisent la New
Architecture.

## Drivers

- conserver Native Stack et ses gestes ;
- exécuter les mouvements interactifs sur le thread UI ;
- respecter Reduce Motion ;
- migrer sans réécriture big bang ;
- rester compatible Expo/dev client/release ;
- limiter bundle, mémoire et dette.

## Options

### A — RN Animated uniquement

Avantages : aucune nouvelle dépendance directe, migration minimale.
Inconvénients : layout/gestures complexes et politique partagée plus difficiles, adoption actuelle
inégale.

### B — Reanimated pour l'expérience, natif pour les routes

Avantages : gestures/layout/scroll interruptibles, UI thread, intégration Gesture Handler.
Inconvénients : dépendance/worklets, compatibilité et profiling à certifier, double runtime pendant
la migration.

### C — Skia/Rive comme runtime global

Avantages : liberté graphique maximale.
Inconvénients : coût bundle et expertise, contrôle/accessibilité plus complexe, surdimensionné pour
les listes et boutons.

## Preuves minimales pour accepter la décision

Ces preuves sont produites par le spike non publié `WP-0004` ; elles autorisent la décision, pas le
rollout :

- matrice officielle Expo 56/RN 0.85/Reanimated/Worklets et dépendances directes proposée ;
- harness jetable Button + liste avec layout + sheet gestuelle en build release iOS/Android ;
- smoke test Fabric/dev client/module audio et comparaison baseline frame/bundle/mémoire ;
- stratégie de coexistence RN Animated/Reanimated et rollback écrite ;
- validation Design, Mobile, QA/performance et Bob Live owner.

## Décision proposée

Retenir B :

- routes et transitions de navigation restent Native Stack/Expo Router ;
- Reanimated direct et version compatible Expo pour press avancé, layout, scroll et gestures ;
- RN Animated existant reste jusqu'à migration naturelle ;
- aucun mélange de deux moteurs sur la même propriété d'un même élément ;
- Skia reste optionnel pour Bob Live/chart après ADR ou amendement et spike ;
- tous les effets passent par tokens/policy, jamais par durées inline.

## Conséquences positives

- Interaction interrompable et liée au geste.
- Unification future de FadeIn, layouts et scroll.
- Meilleure capacité à tenir 60/120 Hz.
- Reduced Motion centralisable.

## Conséquences négatives

- Ajout de dépendance et worklets.
- Coexistence temporaire des runtimes.
- Tests et mocks à adapter.
- Risque New Architecture/Fabric à certifier sur les modules natifs Bob.

## Mitigations

- `expo install` et `expo install --check` ;
- spike dev client + release iOS/Android ;
- migration composant par composant ;
- garde d'import et wrapper policy ;
- profiling et kill switch ;
- ne pas migrer une animation stable sans bénéfice observable.

## Critères de vérification de l'implémentation

- [ ] Matrice de compatibilité SDK/Worklets certifiée.
- [ ] Button, layout list et sheet prototype verts sur appareils.
- [ ] Reduce Motion prouvé.
- [ ] Aucun impact mesurable sur les SLO audio.
- [ ] Bundle/mémoire documentés.
- [ ] Rollback vers primitives actuelles démontré.

## Réexamen

Revoir si RN Animated couvre désormais les besoins avec moins de dette, si Reanimated régresse sous
une version Expo cible, ou si le coût du double runtime dépasse sa valeur.
