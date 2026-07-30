# Performance et observabilité de l'expérience

> Statut : **Proposed**
> Dernière vérification du code : commit `2515ddf3`
> IDs liés : G21, G22, V03, V07, V10–V14 et tous les écrans animés
>
> **Amendements 2026-07-29** (le corps daté du 2026-07-23 n'est pas réécrit) :
>
> - **A2 · retombée de bord** — § Règles d'implémentation (règle « blur imbriqué » précisée) et
>   § Budget de la retombée de bord (nouveau). Source : plan P1 du fondateur
>   [`beta-fly-services-p1-conception-ecrans.md`](../superpowers/plans/beta-fly-services-p1-conception-ecrans.md)
>   §1.3 ; étude du code de `davidmokos/expo-glass-tabs` → `src/progressive-blur.tsx`.
> - **A3 · tab bar** — § Règles d'implémentation (exception nommée d'animation de layout) et
>   scénario `PERF-13`. Source : directive du fondateur du 2026-07-29 sur le comportement de la
>   barre du bas.
>
> **Amendement A21 — 2026-07-30 · `PERF-13` devient exécutable** — § Budgets initiaux (deux lignes
> ajoutées), § Owners et rollback (une famille ajoutée), § Protocole `PERF-13` (nouveau),
> § Alertes et rollback. Motif : `PERF-13` **existait** comme scénario mais ne disait ni **quoi**
> mesurer, ni **avec quel seuil**, ni **quoi faire** au dépassement — un budget qu'on ne sait pas
> franchir n'est pas un budget. Aucun seuil existant n'est relâché.
>
> **Amendement A28 — 2026-07-30 · contradiction avec [04](04-navigation-scroll-surfaces.md) soldée**
> — § Budget de la retombée, ligne « Hauteur maximale ». La ligne conservait « hauteur du chrome »
> alors que le § Retombée de bord de 04 avait été corrigé en « hauteur **ÉTENDUE** du chrome ».
> Deux documents d'autorité donnaient deux formules pour la même enveloppe.
>
> **Amendement A29 — 2026-07-30 · liste virtualisée** — § Budget de la retombée, ligne nouvelle.
> Un `BlurView` posé au-dessus d'un contenu dynamique recyclé ne se rafraîchit pas : le rendu est
> faux et **aucun test ne rougit**. `N = 0` obligatoire jusqu'à preuve filmée du contraire.
>
> **Amendement A30 — 2026-07-30 · une ligne de synthèse se lit seule** — § Budget de la retombée,
> ligne « Coupures obligatoires », et § Protocole `PERF-13` (cas obligatoires). La ligne n'énumérait
> que **quatre** coupures là où [04](04-navigation-scroll-surfaces.md) en pose **cinq** — il
> manquait Android < 31, la retombée dans un `Modal`, l'état « préférence encore inconnue » et la
> liste virtualisée. Un lecteur qui s'arrête à la synthèse autorise ce que le dossier interdit.
>
> **(ajouté A30 · 2026-07-30) Amendements portés dans le corps** — leur marqueur daté est au
> point d'application, pas dans cet encadré : `A8`, `A18`. Le
> [journal des amendements](README.md#journal-des-amendements) fait foi ; cette énumération
> n'est admissible que parce que le contrôle `C12` de `scripts/check-mobile-experience-docs.mjs`
> la tient à jour — une énumération que rien ne vérifie devient fausse au premier amendement
> suivant.

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
| **(ajouté A21)** Coût constant du chrome au repos | Régression médiane CPU/GPU ≤ 10 % vs la `BottomTabBar` livrée, barre immobile | P1 motion |
| **(ajouté A21)** Latence du tick haptique | Médiane ≤ 1 frame (16,7 ms) et p95 ≤ 50 ms après le franchissement | UX interaction |
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
| Retombée de bord floutée **(amendé A2)** | Design + Mobile + A11y | Contraste, GPU ou batterie hors seuil sous scroll continu | Repli opaque unique (mode teinté). Aucune autre matière n'est concernée : le reste de l'UI est déjà opaque. |
| Tab bar portée **(ajouté A21)** | Mobile tech lead + QA/performance + Design | Un seul indicateur de `PERF-13` hors seuil | Flag `mobile_tabs_experiment_v1` **OFF** ; la `BottomTabBar` livrée reprend la main sans migration à chaud. |
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
| PERF-13 **(ajouté A3, étendu A8)** | Tab bar : scroll long avec repli/dépli répétés, tab-hopping rapide, scrub au doigt d'un bout à l'autre | Animation de layout de la barre, highlight transform-only, worklet de scroll, ticks haptiques et retombée de bord simultanés. Mesurer aussi la **latence du tick** par rapport au franchissement. **(A8)** + le **double rendu d'icônes** du sixième comportement : deux glyphes superposés par onglet, donc **dix** icônes montées en permanence pour cinq onglets, plus l'interpolation de couleur du label à chaque frame. Ce coût est constant, pas proportionnel au geste : le mesurer aussi **barre au repos**, sinon il disparaît dans le bruit du scrub. |

## Protocole `PERF-13` — la barre du bas

> Ajouté A21 · 2026-07-30. `PERF-13` existait comme **ligne de scénario** ; il n'était rattaché à
> aucune mesure, aucun seuil et aucune action. Un budget qu'on ne sait pas franchir n'en est pas un.
> Ce paragraphe le rend exécutable **sans** ajouter d'exigence de comportement : il n'invente aucun
> seuil nouveau là où un budget général existe déjà, il le **rattache** à une mesure.

**Conditions communes.** Build release, manifest `PERF-CALIBRATION` signé, un cold run séparé puis
au moins trois warm runs, appareil médian **et** pire cas supporté, flag `mobile_tabs_experiment_v1`
comparé ON/OFF sur le même commit. Sans manifest, `PERF-13` vaut `NOT RUN` — la barre portée n'est
alors pas livrable, quel que soit son rendu à l'œil.

**Quatre passes, parce que les coûts ne se mélangent pas.**

| Passe | Geste exact | Ce qu'on mesure | Seuil | Si dépassé |
| --- | --- | --- | --- | --- |
| **P13-A · repos** | Barre montée, **immobile**, 60 s, écran statique | CPU et GPU médians, comparés à la `BottomTabBar` livrée au même commit | Régression médiane ≤ **10 %** | Réduire le coût constant : c'est le **double glyphe** qui est en cause (dix icônes montées pour cinq onglets) — voir le moyen alternatif de [04 § 6](04-navigation-scroll-surfaces.md#6-teinte-icônelabel-pilotée-par-le-highlight-pas-par-le-focus) |
| **P13-B · repli/dépli** | Scroll long, ≥ 20 alternances bas/haut franchissant la zone morte `±3` | Frame UI p95, frames > 32 ms, pause continue | p95 ≤ **16,7 ms**, > 32 ms sur < **1 %**, aucune pause > **100 ms** | Flag OFF. L'exception d'animation de layout (§ Règles d'implémentation) est **conditionnée** à ce résultat : hors budget, elle tombe |
| **P13-C · tab-hopping** | 20 alternances de tap d'un bout à l'autre de la barre, interruptions comprises | Frame UI p95 ; **aucune** navigation perdue ou doublée | Mêmes seuils frame ; **0** navigation perdue/doublée | Flag OFF |
| **P13-D · scrub** | Balayage complet d'un bord à l'autre, aller-retour, ×10 | Latence du tick haptique **et** conflit de gestes | Tick : médiane ≤ **1 frame**, p95 ≤ **50 ms** ; **0** vol de scroll ; **0** `Swipeable` cassé sur `catalogue` et `PieceDetailView` | Flag OFF ; `R40` requalifié |

**Comment se mesure la latence du tick** — sinon la ligne reste une intention. Horodatage
**monotone** pris dans le worklet **au franchissement** de frontière, second horodatage à l'appel de
l'API haptique ; les deux dans un build **harness**, jamais en production. Ces horodatages ne
sortent pas de l'appareil : ils ne figurent pas dans § Métriques autorisées, et
§ Données interdites s'applique intégralement.

**Cas obligatoires en plus des quatre passes**, chacun sur les deux OS :

- **Reduce Motion actif dès le cold start** : ni repli animé, ni course de teinte, ni ressort de
  highlight — le tout **dès le premier frame** (règle fail-closed **A18 · 2026-07-30**,
  [08](08-accessibility-adaptive-design.md#préférences-daccessibilité-et-premier-rendu)) ; la
  préférence **encore inconnue** compte comme active, elle n'est pas un troisième cas de test
  facultatif ;
- **lecteur d'écran actif** : scrub désactivé, `Pressable` opérants, aucune touche consommée ;
- **préférence haptique système désactivée** : aucun tick, aucune autre régression ;
- **~200 % de taille de texte** : cibles ≥ 44/48 mesurées et labels non tronqués
  ([04 § Cibles tactiles et Dynamic Type](04-navigation-scroll-surfaces.md#cibles-tactiles-et-dynamic-type)).

**Rattachement.** `PERF-13` est une preuve de sortie de `WP-0303` et une condition de `G11` ; son
owner est nommé à la ligne « Tab bar portée » de § Owners et rollback. Un verdict `PASS-LIMITED` y
est possible seulement selon la règle de [12 — DoD](12-definition-of-done.md#règle-na-limitation-et-waiver),
et **jamais** pour les cas d'accessibilité ci-dessus.

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
  **Exception nommée (A3 · 2026-07-29)** : le **repli/dépli de la tab bar** anime `height` et
  `marginHorizontal` — c'est la géométrie même du comportement demandé, une pilule qui rétrécit
  dans les deux dimensions, qu'aucun `transform` ne reproduit sans déformer le contenu. Conditions
  de l'exception : ressort **critique-amorti** (380 ms, `dampingRatio` 1) pour n'avoir ni overshoot
  ni queue de stabilisation, animation pilotée par un **worklet** sans `setState`, et profilage
  `PERF-13` joint. Aucune autre animation de layout par frame n'est autorisée par cette exception.
- Les layout transitions de liste sont bornées aux éléments visibles/affectés.
- Les images utilisent tailles et cache adaptés ; pas de re-décodage pendant morph.
- **(amendé A2 · 2026-07-29)** Trois cas distincts, là où le texte du 2026-07-23 n'en connaissait
  qu'un :
  - **interdit** — blur **imbriqué** : une surface floutée dont le sous-arbre contient une autre
    surface floutée (double échantillonnage, contraste imprévisible) ;
  - **interdit** — blur comme **fond d'une surface porteuse d'information** (carte, ligne,
    formulaire, montant) : ces surfaces sont teintées opaques (`BobSurface`) ;
  - **autorisé et borné** — **retombée de bord par empilement de couches frères**, en zone non
    interactive (`pointerEvents="none"`), pour dissoudre le contenu sous un chrome flottant. Voir
    § Budget de la retombée de bord.
- Les shadows lourdes sont testées Android.
- Les listeners et loops sont annulés au blur/background/unmount.
- Une animation invisible n'est pas simplement mise à opacity 0 tout en continuant.
- Les charts ne recalculent pas toute la série à chaque frame JS.

## Budget de la retombée de bord

> Ajouté A2 · 2026-07-29. Spécification fonctionnelle :
> [04 — Navigation § Retombée de bord](04-navigation-scroll-surfaces.md#retombée-de-bord--progressiveblurbob).

Ce que coûte réellement la technique de la référence n'est pas un principe : ce sont **dix
échantillonnages de flou qui se recouvrent sur environ 120 pt de haut, en permanence, sous un
scroll**. C'est un coût GPU continu, pas ponctuel — d'où un budget, et non une interdiction.

| Règle | Valeur normative |
| --- | --- |
| Mode par défaut | **Teinté, `N = 0` couche floutée.** Un `LinearGradient`, un draw call. |
| Retombées floutées par bord d'écran | **Au plus une.** Jamais deux zones floutées superposées. |
| Hauteur maximale d'une retombée | **(corrigé A28 · 2026-07-30)** `inset de sécurité + hauteur ÉTENDUE du chrome + 44 pt de débord`. L'enveloppe est dimensionnée **une fois**, sur l'état le plus haut du chrome, et n'est ensuite ni animée ni transformée — [04 § Pourquoi l'enveloppe est fixe](04-navigation-scroll-surfaces.md#pourquoi-lenveloppe-est-fixe-et-non-recalculée-par-frame). *Rédaction A2 (supersédée) : « hauteur du chrome » — ambigu sur un chrome dont la hauteur s'anime, et donc incompatible avec la ligne « Animation : aucune » deux lignes plus bas.* |
| Profil de hauteurs si `N > 0` | `100 / 88 / 76 / 64 / 54 / 44 / 36 / 28 / 22 / 16 %`, tronqué aux `N` premières. **(précisé A29)** Calculé par `@bob/ui`, jamais par l'application : le port ne choisit que le matériau. |
| Au-dessus d'une liste virtualisée **(ajouté A29 · 2026-07-30)** | **`N = 0` obligatoire.** Un `BlurView` monté au-dessus d'un contenu dynamique recyclé (`FlashList`, `FlatList`, `SectionList`, `VirtualizedList`) **ne se rafraîchit pas** — limitation officielle `expo-blur`. Le flou reste alors figé sur une image périmée **sans qu'aucun test ne rougisse** : c'est le pire mode de défaillance du dossier, un rendu faux et silencieux. Levée uniquement sur preuve filmée de rafraîchissement ([04 § Couture du port](04-navigation-scroll-surfaces.md#couture-du-port--qui-rend-quoi-de-part-et-dautre-de-la-frontière-de-paquet)). |
| Plafond de `N` | Fixé par `PERF-CALIBRATION` sur l'appareil médian, jamais par le confort visuel. |
| Animation | Aucune, dans aucun mode. Une retombée n'anime ni sa hauteur, ni son intensité, ni son opacité. |
| Fonds éligibles au mode flouté | Uniquement les fonds **photographiques** (scan, aperçu de document, visualiseur). Jamais un fond de l'app. |
| Preuve exigée | Profilage **sous scroll continu**, médiane **et pire run**, sur appareil médian et pire cas supporté, jointe au work package. |
| Coupures obligatoires **(complété A30 · 2026-07-30)** | Les **cinq** cas de [04 § Quand le repli opaque unique s'applique](04-navigation-scroll-surfaces.md#quand-le-repli-opaque-unique-sapplique--sans-exception), sans en retrancher aucun : **(1)** port `renderBlurLayer` absent ou rendant `null` à l'index `0` ; **(2)** **Reduce Transparency** active **ou encore inconnue** ; **(3)** Android **< 31**, Android en rendu dégradé, ou retombée à l'intérieur d'un `Modal` ; **(4)** budget de performance non tenu sur l'appareil médian ; **(5)** retombée au-dessus d'une **liste virtualisée** — voir la ligne dédiée ci-dessus. Dans tous ces cas → **repli opaque unique**. *Rédaction A2 (supersédée) : « port absent, Reduce Transparency, Android dégradé, budget non tenu » — quatre cas là où 04 en pose cinq ; il manquait Android < 31, le `Modal`, l'état « préférence inconnue » et la liste virtualisée. Une ligne de synthèse se lit seule : incomplète, elle autorise ce que le document interdit.* |

Sans preuve de profilage sous scroll continu, une retombée floutée vaut `NOT RUN` et le mode
teinté reste seul autorisé.

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
| Retombée floutée illisible ou hors budget | Repli opaque unique (mode teinté). **(amendé A2)** |
| `PERF-13` hors seuil sur une passe quelconque | Flag `mobile_tabs_experiment_v1` OFF, `BottomTabBar` livrée conservée. **(ajouté A21)** |

## Critères d'acceptation

- [ ] **(ajouté A2)** Toute retombée floutée est profilée sous scroll continu (médiane et pire
      run) et respecte le § Budget de la retombée de bord ; à défaut, le mode teinté est livré.
- [ ] **(ajouté A21)** `PERF-13` exécuté selon son protocole — quatre passes, cas d'accessibilité
      compris — avec owner nommé et action de rollback exercée si une passe échoue.
- [ ] Baseline et protocole reproductible attachés.
- [ ] Tous les scénarios pertinents profilés en release.
- [ ] Budgets absolus et relatifs tenus.
- [ ] Cleanup background/unmount prouvé.
- [ ] Voice Trace démontre aucune régression > 5 % et SLO absolus tenus.
- [ ] Schéma télémétrique privacy-reviewed et testé anti-PII.
- [ ] Dashboard distingue renderer/flag/version.
- [ ] Alertes et rollback exercés en staging/canary.
- [ ] Aucune décision basée uniquement sur simulateur ou mode dev.
