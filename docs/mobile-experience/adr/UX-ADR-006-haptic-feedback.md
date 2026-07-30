# UX-ADR-006 — Retours haptiques mobiles

> **Amendement A25 — 2026-07-30 · SDK cible actualisé**
> **Source.** `apps/mobile/package.json`, lu le 2026-07-30 (`expo ~57.0.8`).
> **Portée.** § Preuves minimales, première puce. Décision, options et critères inchangés.
>
> **Amendement A24 — 2026-07-30 · le bootstrap qui contournait cet ADR**
> **Fait.** [`RN_EXPO_GUIDE.md`](../../../design_handoff_bob_pro/RN_EXPO_GUIDE.md) §1 **installait**
> `expo-haptics` dans sa commande `npx expo install`, alors que cet ADR est `Proposed`, que
> [09](../09-technical-architecture.md#état-de-dépendances-observé) conditionne l'ajout à
> « `UX-ADR-006` Accepted **et** certification acoustique », et que
> [04 § Bornes de livraison](../04-navigation-scroll-surfaces.md#bornes-de-livraison) le nomme comme
> « la seule dépendance réellement absente ». La commande a été retirée : une commande exécutable
> prime toujours sur la prose qui l'entoure — quelqu'un la lance, et la décision est prise sans
> décideur.

## Statut

Proposed — 2026-07-23 · amendé A24/A25 le 2026-07-30 (bootstrap retiré, SDK cible)

## Décideurs attendus

Mobile tech lead, Design owner, Accessibility reviewer, QA appareil et Bob Live owner pour la
non-régression acoustique. Décision attendue en Vague 0 sous `WP-0004`.

## Contexte

Le feedback de pression varie aujourd'hui selon les primitives et `expo-haptics` n'est pas une
dépendance directe de l'application mobile au commit `2515ddf3`. Une haptique bien placée peut
renforcer sélection, detent et confirmation, mais elle peut devenir envahissante, faire doublon
avec le son/système ou perturber une capture vocale sur certains appareils.

## Drivers

- retour causal et bref, jamais décoratif ;
- aucune information portée uniquement par vibration ;
- respect des préférences et capacités plateforme ;
- zéro vibration continue, par frame, au scroll ou au VAD ;
- aucune régression micro, playback, barge-in ou batterie ;
- mapping cohérent iOS/Android et fallback silencieux.

## Options

### A — Aucun retour haptique applicatif

Très sûr et sans dépendance, mais perd une modalité utile pour sélection, detent et action confirmée.

### B — `expo-haptics` derrière un port sémantique

Une dépendance Expo compatible, appelée par des intentions bornées (`selection`, `impact`,
`notification`) et neutralisée selon préférence, capacité ou session audio sensible.

### C — Moteur haptique natif custom

Contrôle fin, mais maintenance native, disparités et surface de test disproportionnées au besoin.

## Preuves minimales pour accepter la décision

- **(corrigé A25 · 2026-07-30)** version `expo-haptics` compatible **Expo SDK 57** confirmée par
  `npx expo install --check` et ajout direct planifié — dans `apps/mobile` uniquement.
  *Rédaction 2026-07-23 (supersédée) : « compatible Expo SDK 56 ».* ;
- harness non publié sur au moins un iPhone et deux classes Android ;
- mapping événement→intention revu par Design/Accessibilité ;
- Voice Trace et capture acoustique avant/après pendant activation haptique ;
- politique de désactivation/fallback et coût batterie documentés.

## Décision proposée

Retenir B :

- `HapticPort` vit dans `apps/mobile/src/experience/haptics`, jamais dans le domaine ;
- les écrans émettent une intention sémantique, pas une API plateforme ;
- haptique autorisée sur sélection explicite, changement de detent et résultat durable rare ;
- aucune haptique sur scroll, rendu streaming, token, frame, amplitude, VAD ou boucle ;
- pendant capture/playback Bob, le mapping est silencieux par défaut tant que l'essai acoustique
  n'autorise pas un événement précis ;
- Android et iOS peuvent choisir une primitive différente mais conservent le même sens ;
- le produit reste entièrement compréhensible lorsque l'haptique est absente ou désactivée.

## Conséquences

Positives : micro-interactions plus causales, API centralisée, usage mesurable et désactivable.
Négatives : dépendance directe, matrice appareil, variation matérielle et certification audio.

## Critères de vérification de l'implémentation

- [ ] Dépendance directe installée avec la version Expo compatible et contrôle `expo install` vert.
- [ ] Aucun import haptique dans core, UI générique ou écrans hors port/adapters autorisés.
- [ ] Matrice événement→haptique complète et aucune invocation non allowlistée.
- [ ] Réglage/capability/fallback silencieux testés.
- [ ] Voice Trace, capture, playback et barge-in non régressés.
- [ ] Batterie/température sans régression au-delà du budget calibré.
- [ ] VoiceOver/TalkBack et retour visuel/textuel restent équivalents sans vibration.
- [ ] Kill switch de capability vérifié.

## Réexamen

Réexaminer si Expo change l'API, si une classe d'appareil présente une perturbation audio, si le
feedback est jugé excessif en test d'utilisabilité ou avant toute haptique custom.
