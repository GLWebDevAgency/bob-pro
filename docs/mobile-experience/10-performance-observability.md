# Performance et observabilité de l'expérience

> Statut : **Proposed**
> Dernière vérification du code : commit `2515ddf3`
> IDs liés : G21, G22, V03, V07, V10–V14 et tous les écrans animés

## Objectif

Prouver que la nouvelle expérience est fluide sur les appareils réels sans dégrader l'audio, le
réseau, la batterie, la mémoire ou le premier contenu utile. Une animation jolie sur simulateur ne
constitue aucune preuve.

## Principes

1. Mesurer en build release/preview, jamais conclure depuis le mode dev.
2. Baseline avant modification, même scénario après modification.
3. Tester l'appareil cible médian et le pire cas supporté, pas uniquement un iPhone haut de gamme.
4. Prioriser transform/opacity et rendu UI thread.
5. Arrêter tout travail hors écran/background.
6. Séparer performance visuelle et succès métier.
7. Corréler Bob Live avec Voice Trace sans contenu vocal.
8. Toute métrique possède seuil, owner et action de rollback.

## Budgets initiaux proposés

Les seuils sont à recalibrer pendant Vague 0. Ils sont néanmoins bloquants tant qu'aucune baseline
plus justifiée n'est acceptée.

| Mesure | Budget cible | Gate |
| --- | ---: | --- |
| Feedback press visuel | Frame suivante perceptible | P0 interaction |
| Frame UI à 60 Hz | p95 ≤ 16,7 ms sur scénario certifié | P0 motion |
| Frames > 32 ms | < 1 % sur scénario certifié | P1 motion |
| Pause continue UI pendant transition | Aucune > 100 ms | P0 |
| Transition fréquente | ≤ 300 ms hors natif/gesture | Design gate |
| Route interactive warm | Pas de régression > 10 % vs baseline | Release gate |
| Mémoire après 20 cycles route | Pas de tendance positive ; delta retenu ≤ max(5 % baseline, 10 MiB) | Leak gate |
| CPU/GPU scénario Bob ou scan | Régression médiane ≤ 10 % vs baseline et budgets frame tenus | Capability gate |
| Énergie Bob/scan 10 min | Régression ≤ 10 % vs baseline ; aucun niveau thermique OS supplémentaire | Battery gate |
| Boucle hors écran | 0 | P0 batterie |
| Voice fin parole → premier audio | p50 ≤ 900 ms, p95 ≤ 1 800 ms | Hérité Bob Live |
| Voice parole user → silence Bob | p50 ≤ 250 ms, p95 ≤ 500 ms | Hérité Bob Live |
| Régression SLO voix due au renderer | ≤ 5 % et budgets absolus tenus | P0 Bob |
| Feedback visuel barge-in | < 100 ms | UX Bob |
| Exécution fantôme | 0 | Bloquant release |
| Faux succès | 0 | Bloquant release |

Pour 120 Hz, la cible est une amélioration perceptible et mesurée ; la certification fonctionnelle
reste d'abord à 60 Hz. Une animation ne peut pas être déclarée 120 fps si ses données ou le reste
de la page restent à 60 fps de manière saccadée.

## Artefact normatif `PERF-CALIBRATION`

Avant `GATE-FOUNDATION`, `WP-0002` crée et fait signer :

`docs/mobile-experience/evidence/<release>/_shared/PERF-CALIBRATION/manifest.md`

Ce manifest remplace les expressions qualitatives par un protocole reproductible. Il contient :

- owner nommé et reviewers QA/Mobile/Bob selon scénario ;
- commit baseline, build, mode release, flags, backend/runtime et fixture ;
- modèles exacts, OS, fréquence écran, état batterie, niveau thermique initial, réseau et route audio ;
- cold run séparé, au moins trois warm runs, nombre de cycles et durée ;
- métrique, unité, agrégation, seuil absolu, tolérance relative, sévérité et action de rollback ;
- versions d'outils, commandes/scénarios et URI des traces brutes ;
- distinction entre bruit de mesure, limitation acceptée et régression ;
- date d'expiration/recalibration à chaque changement Expo/RN/runtime/appareil cible.

Les seuils du tableau précédent sont les defaults bloquants. Une calibration peut les rendre plus
stricts ou les adapter avec justification statistique et métier ; elle ne peut pas les relâcher
pour masquer une régression déjà observée. Sans manifest signé, toute preuve performance vaut
`NOT RUN`.

## Owners et rollback par famille

| Famille | Owner rôle à nommer | Signal de non-conformité | Rollback obligatoire |
|---|---|---|---|
| Press, routes, listes, sheets, charts | QA/performance + Mobile | Frame/pause/TTI hors seuil | Flag motion/navigation/surface OFF. |
| Mémoire/listeners | Mobile tech lead | Tendance positive ou delta retenu hors seuil | Stop ring, renderer legacy, correction cleanup. |
| Bob visuel | Bob Live owner + QA voix | SLO, audio, CPU/GPU/énergie hors seuil | Flag Bob visuel OFF, transport sûr conservé. |
| Scanner/médias | Mobile + QA appareil | Mémoire, énergie ou niveau thermique hors seuil | Effet/capability OFF, pipeline fonctionnel conservé. |
| Blur/verre | Design + Mobile + A11y | Contraste, GPU ou batterie hors seuil | Fallback opaque. |
| Faux succès/exécution fantôme | QA + owner métier/Security | Toute occurrence | Stop release, incident P0 ; aucun waiver. |

## Scénarios de profiling

| ID | Scénario | Charge simultanée |
| --- | --- | --- |
| PERF-01 | Cold start → Today utile | Fonts, auth, queries, header et skeleton. |
| PERF-02 | Changement de tab × 20 | State preservation, tab indicator, scroll. |
| PERF-03 | Liste Clients 500 rows | Scroll, filtre, insertion et retour détail. |
| PERF-04 | Documents 200 items | Images, dossier, relocation et compteur. |
| PERF-05 | Sheet formulaire | Drag, clavier, validation, erreur et dismissal. |
| PERF-06 | Nouveau devis 30 lignes | Layout transitions, totals, keyboard et draft. |
| PERF-07 | Argent/Pilotage | Graphique, scénario, scrub et tooltip. |
| PERF-08 | Scan 30 s | Caméra, overlay, détection, upload et analyse longue. |
| PERF-09 | Assistant 200 messages | Streaming blocs, card growth, auto-scroll conditionnel. |
| PERF-10 | Bob Live 5 min | Audio input/output, amplitude, transcript, tool card, barge-in. |
| PERF-11 | Background/foreground × 10 | Cleanup loops, session, restauration. |
| PERF-12 | Dynamic Type 200 % | Layout, reflow, scroll et sheets. |

## Méthode

### Avant

- Tag/commit exact.
- Appareil, OS, build, réseau et batterie documentés.
- Trois warm runs minimum après un cold run séparé.
- Capture Observe/Profiler/Instruments selon plateforme.
- Voice Trace pour les scénarios Bob.

### Après

- Même données, appareil et scénario.
- Comparer médiane et pire run, pas un run choisi.
- Vérifier crash, warnings, mémoire et nettoyage.
- Joindre vidéo et trace à la preuve de work package.

## Règles d'implémentation

- Pas de `setState` React par frame d'amplitude ou de scroll.
- Pas d'animation de `width/height/top/left` par frame si transform/draw convient.
- Les layout transitions de liste sont bornées aux éléments visibles/affectés.
- Les images utilisent tailles et cache adaptés ; pas de re-décodage pendant morph.
- Blur/verre n'est pas imbriqué.
- Les shadows lourdes sont testées Android.
- Les listeners et loops sont annulés au blur/background/unmount.
- Une animation invisible n'est pas simplement mise à opacity 0 tout en continuant.
- Les charts ne recalculent pas toute la série à chaque frame JS.

## Bob Live

- Audio Meter 20–30 Hz ; interpolation UI pour le rendu.
- Échantillons liés à génération/tour et rejetés si tardifs.
- Maximum 8–12 primitives audio et deux halos.
- Aucun log d'amplitude fine.
- Renderer stable pendant la session.
- Toute détection de pression CPU/audio déclenche réduction de détail, jamais perte d'état.
- La capture et le playback ont priorité sur l'effet.
- Haptique testée pour ne pas perturber le micro.

## Scan

- La ligne/scène de scan n'est active que lorsque caméra/pipeline correspondant l'est.
- Une analyse longue affiche une phase réelle et cancel/retry.
- Le renderer ne maintient pas caméra et aperçu haute résolution simultanément sans besoin.
- CPU, GPU, température et batterie observés sur Android médian.
- Aucun effet ne prétend progresser linéairement pendant un OCR indéterminé.

## Métriques autorisées

| Événement | Champs allowlistés |
| --- | --- |
| `ux_transition_completed` | transitionName enum, durationBucket, interrupted, rendererVersion. |
| `ux_slow_frame_window` | scenario enum, frameBucket, OS class, app version. |
| `ux_screen_interactive` | screen enum sans params, warm/cold, durationBucket. |
| `ux_sheet_interaction` | sheetType enum, detent, dismissed/completed, durationBucket. |
| `ux_accessibility_mode` | Modes booléens agrégés, jamais identifiant utilisateur. |
| `bob_visual_phase_duration` | phase enum, durationBucket, rendererVersion. |
| `bob_visual_barge_in_feedback` | durationBucket, metBudget bool. |
| `ux_renderer_rollback` | flag/version, normalized reason. |

## Données interdites

- route ou document avec identifiant ;
- nom d'entreprise/client/fournisseur ;
- montant, TVA, IBAN, SIRET ;
- transcript, texte utilisateur ou réponse Bob ;
- audio, amplitude fine, waveform ;
- arguments/résultats outil ;
- token, secret, stack provider brute contenant une donnée ;
- coordonnées précises ou identifiant appareil stable.

## Dashboards

### Experience health

- TTI par écran enum et version renderer ;
- slow frame windows par scénario/appareil ;
- crashes/hangs pendant transition ;
- abandon sheet/form flow ;
- taux de rollback.

### Bob visual health

- durée par phase normalisée ;
- feedback barge-in budget ;
- erreur/reconnexion/continuer texte ;
- impact corrélé aux percentiles Voice Trace par version, sans contenu.

### Accessibilité

- uniquement agrégats de mode pour déceler une régression, si validé privacy ;
- aucune expérience réduite ne doit avoir un taux d'échec supérieur inexpliqué.

## Alertes et rollback

| Signal | Action |
| --- | --- |
| Crash/hang significativement supérieur | Stop rollout, flag OFF. |
| p95 voix hors SLO | Stop Bob renderer, conserver transport si sûr. |
| Faux succès/exécution fantôme | Stop immédiat du lot, incident P0. |
| Slow frames > seuil | Geler progression ring, profiler. |
| Échec accessibilité critique | Stop rollout. |
| Memory leak monotone | Stop, corriger cleanup. |
| Matière illisible/bug OS | Capability OFF/fallback opaque. |

## Critères d'acceptation

- [ ] Baseline et protocole reproductible attachés.
- [ ] Tous les scénarios pertinents profilés en release.
- [ ] Budgets absolus et relatifs tenus.
- [ ] Cleanup background/unmount prouvé.
- [ ] Voice Trace démontre aucune régression > 5 % et SLO absolus tenus.
- [ ] Schéma télémétrique privacy-reviewed et testé anti-PII.
- [ ] Dashboard distingue renderer/flag/version.
- [ ] Alertes et rollback exercés en staging/canary.
- [ ] Aucune décision basée uniquement sur simulateur ou mode dev.
