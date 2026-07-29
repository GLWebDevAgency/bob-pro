# Backlog d'implémentation de l'expérience mobile

Statut : **Proposed — non autorisé à l'implémentation tant que la gate de publication n'est pas levée**
Source : audit et spécifications `docs/mobile-experience/`
Propriétaires pressentis : Produit, Product Design, Mobile, QA, Accessibilité, Plateforme
Dernière mise à jour : 2026-07-29

> **Amendement A6 — 2026-07-29.** Les livrables et preuves de sortie de `WP-0303` (tab bar) et
> `WP-0307` (matière) sont précisés par A1 à A3. **Aucun `WP` n'est ajouté, supprimé, renuméroté ni
> déplacé d'epic ; aucune gate ni dépendance ne change.** `GATE-NAV-DATA` conserve sa formulation :
> `WP-0307` reste optionnel — ce qui devient optionnel n'est plus « le verre » mais le **mode
> flouté** de la retombée de bord, le mode teinté étant livrable sans décision. Voir le
> [journal des amendements](README.md#journal-des-amendements).

## 1. Mode d'emploi

Ce backlog découpe la cible en lots cohérents et vérifiables. Il ne constitue ni un engagement de calendrier ni une autorisation de modifier la release en cours. L'ordre, les gates et la capacité sont définis dans la [roadmap](./02-roadmap.md) ; le verdict binaire se trouve dans la [Definition of Done](./12-definition-of-done.md).

Chaque work package (`WP`) doit devenir une epic ou un ticket parent dans l'outil de suivi. Les sous-tâches de design, code, test et preuve restent rattachées au même `WP` pour éviter qu'une animation soit « terminée » sans accessibilité, mesure ou fallback.

### 1.1 Priorités

| Niveau | Sens |
|---|---|
| P0 | Vérité, sécurité, accessibilité bloquante, release, risque financier ou fondation sans laquelle la suite serait jetable. |
| P1 | Expérience principale et qualité premium attendue dans la première montée en gamme. |
| P2 | Enrichissement à forte valeur mais planifiable après les parcours critiques. |
| P3 | Exploration strictement optionnelle, activée seulement si les budgets et preuves le permettent. |

### 1.2 Tailles relatives

| Taille | Lecture de planification |
|---|---|
| XS | Changement borné dans un composant ou un artefact, preuve simple. |
| S | Petit lot vertical, peu de dépendances, une plateforme ou un état limité. |
| M | Lot vertical complet ou primitive transverse avec tests et recette iOS/Android. |
| L | Plusieurs écrans/plateformes, migration ou dépendance native, instrumentation comprise. |
| XL | Programme à découper avant engagement ; jamais accepté comme ticket d'exécution unique. |

Une taille n'est pas une durée. Toute estimation calendaire vient après prototype, baseline release et disponibilité réelle de l'équipe.

### 1.2.1 Convention de découpage des lots `XL`

Un parent `WP-####` se découpe en enfants immuables `WP-####-01`, `WP-####-02`, etc. :

- le parent conserve les IDs G/V/S/T et le verdict agrégé ;
- chaque enfant possède scope, dépendances, owner, taille ≤ L, tests et preuve propres ;
- les suffixes ne sont jamais recyclés, même après rejet ;
- une dépendance cite l'enfant exact quand elle ne nécessite pas tout le parent ;
- le parent passe `Verified` uniquement lorsque tous ses enfants `Accepted` sont `Verified` ; un
  enfant `Deferred` ou `Rejected` exige une décision de rescoping signée et reste visible ;
- aucun suffixe libre (`bis`, `final`, `v2`) n'est permis.

### 1.3 Definition of Ready d'un WP

Un WP peut passer de `Proposed` à `Ready` uniquement si :

- son epic est autorisé par la gate de publication ;
- ses exigences `G`, `V`, `S`, `T` sont listées dans la [matrice](./15-traceability-matrix.md) ;
- les ADR nécessaires sont `Accepted` ;
- le prototype inclut normal, erreur, mouvement réduit, grande police et fallback plateforme ;
- les événements backend requis existent réellement ou sont explicitement exclus ;
- les métriques, données interdites et kill switch sont définis ;
- les tests d'acceptation sont écrits avant le changement ;
- les fichiers/aires sont réclamés dans le protocole multi-agent du dépôt.

Les spikes nécessaires à une décision ADR constituent l'unique exception : ils s'exécutent sous
`WP-0004`, après `WP-0001` à `WP-0003`, dans un harness ou build expérimental non publié. Ils ne modifient
ni le domaine ni une donnée de production et sont supprimables. Ils servent à rendre un ADR
`Accepted`; ils ne valent jamais implémentation du produit.

<a id="gates-executables"></a>

### 1.4 Gates exécutables et fondations minimales

Ces gates sont l'autorité d'ordonnancement. Une dépendance d'epic dans la roadmap exprime une
relation produit ; une dépendance exécutable cite un `WP` exact ou l'une des gates ci-dessous.

| Gate | WP obligatoires | Preuve de sortie | Autorise |
|---|---|---|---|
| `GATE-PUBLICATION` | WP-0001 | Cap canonique intégré ou rescoping signé ; freeze explicitement levé pour la tranche. | Baseline et spikes, aucun feature runtime. |
| `GATE-BASELINE` | WP-0001 à WP-0008 | Baselines, inventaires, privacy plan, flags ; D01–D06 résolues sur preuves de décision. Une décision requise rejetée possède une alternative Accepted ; une capability optionnelle rejetée garde son ID, son fallback et une disposition `Rejected` ou `Deferred` signée. | Vague 1. |
| `GATE-FOUNDATION` | WP-0101 à WP-0105 ; WP-0201 à WP-0210 ; WP-1201 à WP-1205 | Primitives, accessibilité, contenu, runtime et harness vérifiés ; tablette exclue à ce stade. | Navigation/données. |
| `GATE-NAV-DATA` | `GATE-FOUNDATION` ; WP-0301 à WP-0306 ; WP-0308 ; WP-0401 à WP-0405 | Push/back/tabs/sheets/search/listes/données certifiés. WP-0307 verre reste optionnel. | Bob pilote et écrans quotidiens. |
| `GATE-BOB-PILOT` | `GATE-NAV-DATA` ; WP-0501 à WP-0508 ; WP-0509-01 ; Voice Trace/runtime publication certifiés | Projection, amplitude/fallback, barge-in, overlay, conversation, actions et accessibilité Bob vérifiés. La route legacy S32 reste hors pilote. | WP-0009. |
| `GATE-PILOT` | WP-0009 | S05 + S01 + scénario borné S04 certifiés, P0/P1 fermés, compréhension retestée. | Migrations écran Vagues 4–6. |
| `GATE-TABLET` | WP-0106, WP-0301, WP-0406 | Règles compact/large et composition iPad/split view vérifiées. | Certification large layout. |
| `GATE-ROLLOUT-READY` | Tous les IDs disposent d'une disposition ; exigences `Accepted` avec preuve `PASS` ou `PASS-LIMITED` admissible ; aucun P0/P1 ouvert ; flags et runbooks prêts | Registre 77/77 contrôlé, limitations P2/P3 signées et non expirées, rescopings `Deferred`/`Rejected` signés, dry-run rollback staging. | WP-0010-01 et R0. |
| `GATE-GLOBAL` | WP-0010-01 ; critères R0→R3 ; aucun P0/P1 ; rollback exercé | Verdict Go/No-Go R4 signé, budgets/funnels stables et registre 77/77 toujours recevable. | WP-0010-02, R4 et fermeture finale. |

Les plages `WP-xxxx à WP-yyyy` sont inclusives. Si un WP de la plage est `Rejected` ou `Deferred`,
la gate ne passe qu'avec une décision de rescoping signée, son fallback, son impact et sa date de
réexamen ; il n'est jamais omis du registre historique. `N/A` qualifie uniquement
l'applicabilité déclarée d'une exigence ou d'un critère, jamais le statut d'un WP.

## 2. E00 — Gouvernance, baselines et autorisation

E00 est un epic transverse, pas une phase calendaire : `WP-0001` à `WP-0008` s'exécutent en Vague 0,
`WP-0009` en Vague 3 et le parent `WP-0010` avec ses deux enfants en Vague 7.

| WP | P | Taille | Livrable et contenu détaillé | Dépendances | Preuves de sortie |
|---|---:|---:|---|---|---|
| WP-0001 | P0 | S | **Gate de publication.** Confirmer la priorité de release, les périodes de freeze, les correctifs UX autorisés et le sponsor de la tranche. Enregistrer explicitement ce qui est différé. | Cap de publication Accepted, release owner. | Compte-rendu daté, périmètre signé, aucune ambiguïté entre « documenté » et « autorisé ». |
| WP-0002 | P0 | M | **Baseline runtime.** Capturer démarrage, navigation, scroll, listes, charts, scan et Bob Live sur appareils cibles, en build release. Mesurer frames, pauses, mémoire, CPU, batterie et SLO voix applicables. | WP-0001. | Dossier de traces reproductibles et manifest signé `PERF-CALIBRATION` : versions, fixtures, appareils, seuils, owners et rollbacks `PERF-01…12`. |
| WP-0003 | P0 | L | **Baseline visuelle exhaustive.** Capturer les 33 surfaces et leurs états chargé/vide/chargement/erreur/hors-ligne/interdit, tailles de texte et plateformes pertinentes. Lister les écarts entre historique, code et cible. | WP-0001. | Inventaire versionné, aucune route ou expérience agrégée manquante, propriétaire attribué à chaque écart. |
| WP-0004 | P0 | M | **Décisions et prototypes d'architecture.** Produire les spikes non publiés motion, tabs/sheets, apparence, Bob projection, observabilité et haptique ; rendre les six UX-ADR `Accepted` ou `Rejected`. | WP-0002, WP-0003, contraintes Expo/RN réelles. | Preuves minimales de décision signées, statuts D01–D06 mis à jour, fallbacks et coûts de rollback documentés ; aucun critère post-implémentation exigé ici. |
| WP-0005 | P0 | M | **Inventaire tokens et primitives.** Cartographier couleurs, typographies, espacements, rayons, Button/Row/Field/Card/Sheet/Toast/State ; choisir l'autorité et un ordre de migration. | WP-0003. | Rapport d'usage, doublons, imports cibles, règle anti-réintroduction et liste de compatibilité. |
| WP-0006 | P0 | S | **Plan d'observabilité respectueux de la vie privée.** Définir noms d'événements, agrégations, sampling, rétention, redaction et interdictions pour UI/voix. | DPIA, WP-0002. | Revue Privacy/Security, exemples d'événements sans transcript, audio, PII, montant ou contenu libre. |
| WP-0007 | P0 | M | **Feature flags, anneaux et kill switches.** Définir flags indépendants pour runtime motion, tabs, surfaces, Bob et lots écran ; documenter defaults et rollback. | WP-0004, plateforme flags existante. | Test flags ON/OFF, anciens parcours intacts, rollback sans migration de données. |
| WP-0008 | P0 | S | **Gabarits de preuves et revue.** Créer modèles ticket, manifest, fiche design review, capture appareil, trace perf, audit accessibilité, décision de rollout et waiver expirant. | Aucun. | Gabarits validés par Design/Mobile/QA/A11y et dry-run sur une baseline/spike ; leur usage réel est revalidé par WP-0009. |
| WP-0009 | P0 | L | **Certification pilote Vague 3.** Exécuter le cycle complet sur `S05 Assistant + overlay Bob`, `S01 Aujourd'hui` et un scénario borné `S04 validation → classement`, y compris compréhension avec utilisateurs représentatifs. | `GATE-BOB-PILOT`. | DoD binaire, rapport avant/après, synthèse d'utilisabilité, retest des incompréhensions critiques, P0/P1 fermés ; waiver signé uniquement pour un écart non bloquant et expirant. |
| WP-0010 | P0 | M | **Parent de rollout et certification finale Vague 7.** Agréger les preuves et fermer le programme après les deux étapes de rollout. | WP-0010-01, WP-0010-02. | Registre final 77/77, R4 surveillé, aucune alerte bloquante et dossier de clôture signé. |
| WP-0010-01 | P0 | M | **Rollout contrôlé R0→R3.** Déployer progressivement, surveiller budgets/funnels, tester l'arrêt et exercer le rollback en conditions représentatives. | `GATE-ROLLOUT-READY`. | Critères R0/R1/R2/R3 signés, rollback prouvé, incidents résolus et Go/No-Go R4 proposé. |
| WP-0010-02 | P0 | S | **R4 et clôture post-déploiement.** Autoriser 100 %, maintenir la fenêtre de rollback, surveiller puis archiver la décision et les preuves. | `GATE-GLOBAL`. | R4 stable pendant la fenêtre acceptée, registre archivé, owners informés et programme formellement fermé. |

## 3. E01 — Adaptation, apparence et accessibilité

| WP | P | Taille | Exigences | Livrable | Dépendances | Preuves de sortie |
|---|---:|---:|---|---|---|---|
| WP-0101 | P0 | M | G02 | Implémenter la cible thème sémantique complet acceptée par UX-ADR-004 ; utiliser force-light uniquement comme gate transitoire, puis éliminer tout état hybride. | UX-ADR-004 Accepted, WP-0005. | Matrice de toutes les routes dans chaque mode supporté ; G02 reste ouvert tant que le thème adaptatif complet n'est pas certifié. |
| WP-0102 | P0 | M | G01 | Créer tokens de surfaces/luminance et resolver de barre système, puis le contrat consommé par les headers, sans flash clair↔marine. | WP-0101, WP-0005. | Harness isolé et captures/vidéos sur familles de fonds, iOS/Android ; intégration finale vérifiée par WP-0304. |
| WP-0103 | P0 | L | G03 | Définir échelle typographique adaptative, règles de reflow, limites des montants, boutons multi-lignes et contenu scrollable. | WP-0005. | Recette standard/XL/accessibilité ~200 % sur routes critiques ; zéro CTA ou montant essentiel perdu. |
| WP-0104 | P0 | M | G22, V14 | Centraliser préférences Reduced Motion/Transparency et définir le contrat de substitutions ; les consommateurs motion et Bob l'appliquent ensuite sans modifier le sens. | WP-0005, APIs OS confirmées. | Harness de préférence live et contrat testable ; intégrations motion/Bob vérifiées par WP-0210 et WP-0508. |
| WP-0105 | P0 | L | G03, V14 | Auditer touch targets, rôles, labels, ordre, focus, annonces, alternatives gestuelles et contraste ; corriger les primitives avant les écrans. | WP-0005, WP-0209. | Audit VoiceOver/TalkBack, contraste et touch targets ; zéro blocage critique ouvert. |
| WP-0106 | P1 | L | G19 | Définir breakpoints sémantiques, max-width, split view, grille/master-detail, clavier et rotation pour iPad/grandes fenêtres. | WP-0003, WP-0005. | Contrat compact/large et captures harness ; intégration routes/écrans fermée par WP-0406 et `GATE-TABLET`. |

## 4. E02 — Runtime motion et primitives d'interaction

| WP | P | Taille | Exigences | Livrable | Dépendances | Preuves de sortie |
|---|---:|---:|---|---|---|---|
| WP-0201 | P0 | L | G04, G21 | Implémenter le runtime Reanimated/worklets accepté et la boundary JS/UI thread ; ajouter les dépendances directes compatibles. | UX-ADR-001 Accepted, WP-0002. | Build release iOS/Android, tests interruption, benchmark avant/après, procédure de retrait. |
| WP-0202 | P0 | M | G04, G22 | Implémenter tokens `duration/easing/spring/delay/distance` sémantiques et policy mouvement réduit. Interdire les nombres magiques. | WP-0201. | Catalogue Storybook/harness, test statique des imports/valeurs, revue Design. |
| WP-0203 | P1 | M | G05 | Unifier Pressable/Button/CardAction : rest, pressed, disabled, loading, selected, focus ; cible tactile inchangée pendant la compression. | WP-0202, WP-0209. | Tests composants et vidéo appareil rapide/lent/double tap. |
| WP-0204 | P1 | S | G06 | Ajouter un port haptique sémantique, mapping événement→retour et garde-fous plateforme/préférence/audio. | UX-ADR-006 Accepted, WP-0203. | Recette appareils et acoustique, zéro vibration continue/doublée, fallback silencieux. |
| WP-0205 | P0 | M | G09, T08 | Créer primitives d'état `idle/pending/confirmed/error/unknown`, boutons idempotents, skeleton/empty/error/toast autoritatifs. | Contrats domaine, WP-0209. | Tests timeout, perte réseau, relecture, double tap ; aucun faux succès. |
| WP-0206 | P1 | L | G08, G14 | Fournir transitions insert/remove/reorder/status avec clés stables, interruption et hooks de préservation focus/scroll ; E04 les applique aux listes métier. | WP-0201, WP-0202. | Harness listes courtes/longues, tri rapide, refresh et Reduced Motion ; consommation vérifiée par WP-0402. |
| WP-0207 | P1 | M | G13 | Fournir la primitive segment/filter avec indicateur continu, compteurs, pending, changement rapide et lecture accessible ; E04 définit les compositions métier. | WP-0202, WP-0209. | Tests isolés sélection/clavier/VoiceOver/TalkBack ; cohérence résultat vérifiée par WP-0403. |
| WP-0208 | P1 | M | G15 | Fournir primitives nombres tabulaires/transitions exactes et contrat de données chart : valeur finale, signe, unité, comparaison et fallback texte. | WP-0201, WP-0202. | Fixtures exactes et aucune animation sans changement ; parité métier vérifiée par WP-0404. |
| WP-0209 | P0 | L | G18 | Consolider UI vers une source officielle ; adaptateurs temporaires ; déprécier les doublons sans big bang. | WP-0005. | Contrôle statique, migrations pilotes, documentation API et zéro nouveau doublon. |
| WP-0210 | P0 | M | G21, G22 | Ajouter harness release et seuils CI/manual pour animations, scroll, mémoire et préférences ; détecter régressions. | WP-0002, WP-0201. | Traces reproductibles 60/120 Hz selon appareils, rapport delta et gate de merge. |

## 5. E03 — Navigation, scroll et surfaces

| WP | P | Taille | Exigences | Livrable | Dépendances | Preuves de sortie |
|---|---:|---:|---|---|---|---|
| WP-0301 | P0 | M | G10, G11, G19 | Inventorier chaque route : push, modal, sheet, full-screen, tab ; back behavior, deep link et layout compact/large. | WP-0003. | Table canonique 32 routes physiques + S33 agrégée, approuvée Product/Mobile. |
| WP-0302 | P1 | L | G10 | Implémenter transitions de routes natives et continuité spatiale ; fallback OS/version ; aucun shared element sur promesse alpha non maîtrisée. | UX-ADR-002 Accepted, WP-0201, WP-0301. | E2E push/back/swipe/deep link, vidéos objet liste→détail et interruption. |
| WP-0303 | P1 | L | G11 | Livrer le renderer de tabs retenu par D07 : badges, retap scroll-top, état par onglet, clavier/safe area. **(amendé A3 · 2026-07-29)** Plus les cinq comportements normatifs de [04 § Comportement normatif de la tab bar](./04-navigation-scroll-surfaces.md#comportement-normatif-de-la-tab-bar) — minimize-on-scroll, highlight glissant, scrub à ticks, retombée de bord, fade-through — avec **notre** matière (`colors.surface` opaque, rôles `navigation.*`) et sans restyler la `BottomTabBar` existante. | UX-ADR-002 Accepted, D07 Accepted, WP-0301. **(A3)** + UX-ADR-001 (Reanimated/Gesture Handler) et UX-ADR-006 (`expo-haptics`) Accepted. | Tests cinq tabs, rotation, lecteur d'écran, fallback ; statut d'implémentation ADR mis à jour. **(A3)** + trace `PERF-13`, vidéo de chaque comportement, preuve que le scrub est désactivé sous lecteur d'écran et que le tick suit la préférence système sur les deux OS. |
| WP-0304 | P0 | L | G01, G12 | Créer grand/compact header, sticky subheader et synchronisation barre système au scroll. | WP-0102, WP-0202. | Vidéos scroll lent/rapide/interrompu, pas de saut, flash ou contenu recouvert. |
| WP-0305 | P1 | L | G07 | Implémenter la Sheet retenue : detents, drag 1:1, velocity, clavier, focus trap, dismissal, contenu scrollable et alternative accessible. | UX-ADR-002 Accepted, dépendance directe acceptée si tierce. | E2E geste/clavier/a11y/iOS/Android, stress test nested scroll. |
| WP-0306 | P1 | M | G16 | Contrat Search : focus, debounce/cancel, requêtes obsolètes, récents, groupes, clavier, résultats et restauration. | WP-0301, API existante. | E2E complet et traces de rendu/réseau sans spinner pleine page. |
| WP-0307 | P2 | M | G20 | **(amendé A1/A2 · 2026-07-29)** Livrer la **retombée de bord** `ProgressiveBlurBob` : mode teinté sans flou par défaut (valeurs `patterns.bottomTabBar`), port injecté `renderBlurLayer`, repli opaque unique. N'activer le **mode flouté** que si D08 l'accepte, sur fond photographique uniquement, avec contraste et budget GPU tenus. **Aucune introduction de verre système** : `expo-glass-effect` ne sera pas adopté. | UX-ADR-004 Accepted (algorithme A1), D08 résolue, WP-0101, WP-0002. | **(A1/A2)** Contrôle statique zéro import `expo-glass-effect` ; captures Reduce Transparency identiques avant/après. Si le mode flouté est Accepted : trace GPU **sous scroll continu** (médiane et pire run), lisibilité sur fonds extrêmes, plateforme ancienne, repli opaque unique démontré. Si Rejected : audit du mode teinté et disposition signée de WP/G20. |
| WP-0308 | P0 | M | G10, G11, G16 | Centraliser restauration route/scroll/focus/filtres/onglet, deep links chauds/froids et comportements back. | WP-0301 à WP-0306. | E2E interruption, background, lien externe, session expirée et retour multi-niveaux. |

## 6. E04 — Densité, listes et visualisation de données

| WP | P | Taille | Exigences | Livrable | Dépendances | Preuves de sortie |
|---|---:|---:|---|---|---|---|
| WP-0401 | P1 | L | G17 | Recomposer chaque écran selon `conclusion → raison → action`, limiter cartes concurrentes et déplacer détails en disclosure sans perte. | Specs S01–S33, Content Design. | Revue avant/après et test de compréhension ; toutes preuves métier restent accessibles. |
| WP-0402 | P1 | L | G14 | Unifier Row/Card/ListSection : identité, montant, statut, skeleton dimensionné, virtualisation et actions contextuelles. | WP-0206, WP-0209. | Longues listes, refresh, insert/reorder, grosses polices et profil mémoire. |
| WP-0403 | P1 | M | G13 | Standardiser segments, chips et filtres actifs : nombre limité, reset, overflow, accessibilité et continuité. | WP-0207. | Scénarios filtre vide/multiple/rapide, petit écran, clavier. |
| WP-0404 | P1 | L | G15 | Standardiser KPI, Money, Delta, Sparkline/Chart, tooltip et équivalent tabulaire. | WP-0208. | Fixtures financières exactes, locale/date/devise, mouvement réduit, lecteur d'écran. |
| WP-0405 | P0 | M | G09, G17 | Catalogue des états par module : skeleton stable, vide actionnable, erreur locale, stale/offline, accès interdit et refresh. | WP-0205. | Matrice états sur chaque famille d'écran, zéro page blanche ou layout shift critique. |
| WP-0406 | P1 | M | G19 | Ajuster densité et progressive disclosure aux largeurs : colonnes, master-detail et plafonds de lecture. | WP-0106, WP-0401 à WP-0404. | Recette iPad/split-screen et ordre de focus inter-colonnes. |

## 7. E05 — Bob Live et conversation agentique

| WP | P | Taille | Exigences | Livrable | Dépendances | Preuves de sortie |
|---|---:|---:|---|---|---|---|
| WP-0501 | P0 | L | V02, V04, V05, V08 | Projection pure runtime→état visuel : autorisation, connexion, prêt, écoute, silence, raisonnement, outil, parole, reconnexion, erreurs typées. | UX-ADR-003 Accepted, D09 Accepted. | Tests exhaustifs de projection, aucun timer décoratif ni fournisseur dans l'UI. |
| WP-0502 | P1 | L | V01 | Concevoir/implémenter la signature Bob et ses formes trigger/capsule/carte ; contrastes, states et Reduced Motion. | WP-0501, Product Design. | Prototype appareil, revue DA, propriété visuelle et fallback statique. |
| WP-0503 | P0 | L | V03, V06 | Exposer ports d'amplitude entrée/sortie éphémères acceptés, smoothing borné et fallback honnête si indisponible. | D09 Accepted, modules audio, revue Security/Privacy, WP-0002. | Fixtures audio, attack/release, arrêt au silence, aucune persistance/télémétrie fine. |
| WP-0504 | P0 | M | V07 | Lier feedback de barge-in à l'événement local le plus précoce sans retarder l'audio. | Voice Trace/SLO, WP-0501. | p95 visuel <100 ms, SLO interruption audio non régressé, tests bruit/silence. |
| WP-0505 | P0 | L | V09, V10 | Overlay global unique, règles d'ancrage/clavier/safe area, morph et fermeture conservant mission/résultat/focus. | WP-0308, WP-0502. | Navigation multi-écrans, une seule session/instance, aucun CTA obstrué. |
| WP-0506 | P1 | L | V11, V12 | Scroll conversationnel respectueux et batching phrases/blocs ; ancre, nouveaux messages, sélection et rendu borné. | WP-0501, WP-0402. | E2E lecture en bas/haut, deltas rapides, mémoire et lecteur d'écran. |
| WP-0507 | P0 | L | V13 | Carte agentique à machine d'états réelle : proposition, confirmation, pending, relecture, succès/échec/inconnu. | WP-0205, contrats outils. | Tests idempotence, timeout, retry, perte réseau et confirmation sensible. |
| WP-0508 | P0 | M | V14 | Captions, labels, ordre, annonces, alternatives texte, grandes polices et mouvement réduit pour tous les états Bob. | WP-0104, WP-0105, WP-0501, WP-0502. | Recette VoiceOver/TalkBack sans dépendre du son, couleur ou mouvement. |
| WP-0509 | P0 | L | S05, S32 | Parent de convergence Assistant/overlay/route historique ; agrège les deux preuves sans imposer S32 au pilote. | WP-0509-01, WP-0509-02. | Même cas d'usage, une seule instance audio et parent `Verified` lorsque les deux enfants Accepted sont fermés. |
| WP-0509-01 | P0 | M | S05 | Converger Assistant et overlay Bob pour le pilote : renderer, contexte, composer, fermeture et focus. | WP-0501 à WP-0508. | E2E texte/voix/outil/route/background ; requis par `GATE-BOB-PILOT`. |
| WP-0509-02 | P1 | S | S32 | Appliquer D10 à la route voix historique en Vague 6 : maintien, façade ou redirection sans frame intermédiaire. | WP-0501, WP-0505, D10 Accepted. | Deep links chaud/froid, aucune boucle, perte de contexte ou double session audio. |

## 8. E06 — Aujourd'hui, recherche et notifications

| WP | P | Taille | Exigences | Livrable | Dépendances | Preuves de sortie |
|---|---:|---:|---|---|---|---|
| WP-0601 | P1 | L | S01 | Fermer la migration complète d'Aujourd'hui après le slice pilote : priorité causale, résumé financier sûr, activité, header contractile et tous les états. | `GATE-PILOT`. | Scénarios fraîcheur/offline/retour détail, captures et trace scroll ; aucun reliquat du pilote non tracé. |
| WP-0602 | P1 | M | S06 | Recomposer Recherche globale : récents, groupes, focus, résultats et erreurs locales. | `GATE-PILOT`, WP-0306, WP-0402. | E2E debounce/cancel/retour, clavier et annonces accessibles. |
| WP-0603 | P2 | M | S07 | Recomposer Notifications : groupes temporels, gravité sémantique, action/undo et badge autoritatif. | `GATE-PILOT`, WP-0205, WP-0308. | E2E lu/non-lu/perte réseau/deep link, position restaurée. |

## 9. E07 — Clients et chantiers

| WP | P | Taille | Exigences | Livrable | Dépendances | Preuves de sortie |
|---|---:|---:|---|---|---|---|
| WP-0701 | P1 | L | S02 | Clients : recherche, filtres, lignes denses, ajout et continuité vers fiche. | `GATE-PILOT`. | E2E ajout/recherche/filtre/retour, longue liste et gros texte. |
| WP-0702 | P1 | L | S08 | Détail client : identité, header contractile, actions, encours et modules indépendants. | WP-0701, WP-0304. | E2E états client, erreur partielle, retour à la même ligne. |
| WP-0703 | P1 | L | S09 | Chantiers : segments, prochaine échéance, statuts et création sûre. | `GATE-PILOT`. | E2E filtre/création/offline/retour et stabilité média. |
| WP-0704 | P1 | L | S10 | Détail chantier : prochaine étape, timeline, documents/médias, finances et note vocale seulement si ce sous-scope est explicitement accepté. | WP-0703 ; WP-0503 et WP-0508 si note vocale incluse, sinon décision de scope datée sans waiver implicite. | E2E chronologie, upload, voix si incluse, mémoire et restauration scroll ; décision et impact tracés si la note vocale est différée. |

## 10. E08 — Finance, comptabilité et pilotage

| WP | P | Taille | Exigences | Livrable | Dépendances | Preuves de sortie |
|---|---:|---:|---|---|---|---|
| WP-0801 | P0 | L | S03 | Argent : montants sourcés, réalisé/prévision distincts, périodes, échéances et graphiques accessibles. | `GATE-PILOT`, validation métier nommée. | Fixtures exactes, stale/offline, parité graphe-table et aucune couleur seule. |
| WP-0802 | P1 | L | S18 | Dépenses : période, fournisseurs, justificatifs, statut temporel et actions sûres. | `GATE-PILOT`, WP-0402, WP-0404, WP-0405. | E2E ajout/consultation/statut/retry, montant exact et non-duplication. |
| WP-0803 | P0 | L | S19 | Comptabilité : synchro, tâches, équilibre/écarts, détails progressifs et export autoritatif. | `GATE-PILOT`, WP-0401, revue finance/compta nommée. | Fixtures équilibrées/déséquilibrées, export identique, offline sûr. |
| WP-0804 | P0 | L | S20 | Clôture : checklist réelle, blocages, reprise, confirmation finale et preuve. | WP-0803, confirmations domaine. | E2E bloqué→résolu→clôturé, idempotence et historique. |
| WP-0805 | P2 | L | S21 | Pilotage : KPI sourcés, périodes, charts explorables et équivalent textuel/tabulaire. | `GATE-PILOT`, WP-0404, validation Product/Data nommée. | Fixtures, scrub/tooltip, accessibilité, performance release. |

## 11. E09 — Documents et scanner

| WP | P | Taille | Exigences | Livrable | Dépendances | Preuves de sortie |
|---|---:|---:|---|---|---|---|
| WP-0901 | P1 | L | S04 | Fermer la migration complète du hub Documents après le scénario pilote : dossiers, recherche, filtres, scan et tous les statuts de traitement. | `GATE-PILOT`. | E2E filtre/dossier/traitement/erreur, aucune phase inventée et aucun reliquat pilote. |
| WP-0902 | P1 | M | S22 | Dossier : orientation, tri, ajout/déplacement/suppression récupérables et retour spatial. | WP-0901. | E2E mutations/undo/retour, offset et identité préservés. |
| WP-0903 | P1 | L | S23 | Détail : preview stable, zoom, extraction, édition autorisée, partage et fallback OS. | WP-0901, contrats fichiers. | E2E PDF/image/échec/permission, profil mémoire et alternative accessible. |
| WP-0904 | P0 | XL→découper | S24 | Scanner : permissions, capture, aperçu, correction, upload, OCR et reprise. Découper en `WP-0904-01 camera`, `-02 review`, `-03 pipeline-state`, `-04 recovery`. | `GATE-PILOT`, contrat scanner Accepted, appareil réel, WP-0002. | Matrice appareil/lumière/rotation/réseau, pipeline véridique, confidentialité. |

## 12. E10 — Ventes, devis, factures et catalogue

| WP | P | Taille | Exigences | Livrable | Dépendances | Preuves de sortie |
|---|---:|---:|---|---|---|---|
| WP-1001 | P1 | L | S11 | Ventes : cycle de vie, filtres, montants/statuts et accès création/détail. | `GATE-PILOT`, WP-1201. | E2E devis/factures/filtres/retour, statut backend exclusivement. |
| WP-1002 | P0 | XL→découper | S12 | Nouveau devis : étapes, lignes, dictée révisable, autosauvegarde réelle, revue et création. Découper `WP-1002-01 shell`, `-02 lines`, `-03 voice-draft`, `-04 review-submit`. | `GATE-PILOT`, cas d'usage Accepted, WP-0205 ; WP-0501/WP-0507/WP-0508 pour voice-draft. | E2E background/offline/retry, totaux exacts, aucun double document. |
| WP-1003 | P1 | L | S13 | Détail devis : document hero, historique, aperçu/partage et CTA par statut. | WP-1001, dictionnaire statuts. | Matrice de statuts et E2E action autorisée/interdite. |
| WP-1004 | P0 | XL→découper | S14, S15, S16 | Facture bout en bout : `WP-1004-01 création`, `-02 détail`, `-03 transmission`, `-04 machine d'états/preuves`, incluant conformité, timeout inconnu et reçu. | `GATE-PILOT`, WP-1001, contrats légaux/Factur-X/idempotence Accepted, WP-0205. | E2E valeurs/taxes/double tap/transmission/paiement, succès autoritatif. |
| WP-1005 | P2 | L | S17 | Catalogue : recherche, catégories, CRUD, prix/unités/taxes et récupération. | `GATE-PILOT`, règles catalogue Accepted. | E2E CRUD/undo/dépendances, prix exact et liste stable. |

## 13. E11 — Diagnostic, onboarding, compte et authentification

| WP | P | Taille | Exigences | Livrable | Dépendances | Preuves de sortie |
|---|---:|---:|---|---|---|---|
| WP-1101 | P2 | M | S25 | Diagnostic : questions, reprise, résultat réel, limites et actions. | `GATE-PILOT`, contrat score/recommandations Accepted. | E2E partial/reprise/erreur ; aucun score décoratif. |
| WP-1102 | P0 | L | S26 | Onboarding : étapes nécessaires, permissions contextuelles, persistance et première valeur. | `GATE-PILOT`, contrats auth/session, WP-0308. | E2E abandon/reprise/froid/hors-ligne/gros texte. |
| WP-1103 | P0 | XL→découper | S27, S28, S29 | Compte/réglages sensibles : `WP-1103-01 compte`, `-02 facturation`, `-03 fiscal`, avec dirty state, revue, confirmation et autorité. | `GATE-PILOT`, revues Finance/Legal/Security nommées, WP-0205. | E2E édition/retry/danger, absence de PII analytics et succès après persistance. |
| WP-1104 | P0 | XL→découper | S30, S31, S33 | Auth : `WP-1104-01 login-register`, `-02 callback`, `-03 recovery`, partageant les primitives sans fusionner les états sensibles. | `GATE-PILOT`, D11 Accepted, contrats auth/deep links Accepted, revue Security nommée, WP-0308. | E2E anti-énumération, token expiré/double ouverture/autofill/background, aucune boucle. |

## 14. E12 — Content design et lexique d'état

| WP | P | Taille | Exigences | Livrable | Dépendances | Preuves de sortie |
|---|---:|---:|---|---|---|---|
| WP-1201 | P0 | M | T01, T08 | Dictionnaire canonique événement/source→clé→libellé→action, incluant pending/confirmed/error/unknown. | Contrats runtime/domaine. | Snapshots et tests contractuels, aucun succès au tap. |
| WP-1202 | P0 | M | T02, T07 | Matrice Pote/Pro/Direct : ton varie, faits/montants/temps/conséquences restent identiques ; confirmations sensibles sobres. | Voice & Tone, Finance/Legal. | Revue des phrases critiques et snapshots trois personnalités. |
| WP-1203 | P1 | M | T03, T04 | Réécrire jargon et cartes selon `conclusion → justification → action`; détails techniques accessibles au support. | Inventaire copy par écran. | Test de compréhension, audit jargon et absence de secret/PII. |
| WP-1204 | P0 | M | T05, T06 | Rendre dates/délais pérennes et erreurs réparables ; timezone, changement d'année, cause sûre, impact et action. | Horloge/locale, catalogue erreurs. | Tests 31/12→01/01, E2E erreurs, anti-énumération auth. |
| WP-1205 | P1 | S | T01–T08 | Installer gouvernance des clés, revue copy, snapshots, localisation future et règle de dépréciation. | WP-1201 à WP-1204. | CI anti-drift, owner, changelog et zéro chaîne critique sauvage. |

## 15. Chemin critique et lots parallélisables

Le chemin critique exécutable minimal est :

`WP-0001 → WP-0002/0003/0005/0006/0008 → WP-0004 → WP-0007 → GATE-BASELINE → GATE-FOUNDATION → GATE-NAV-DATA → GATE-BOB-PILOT → WP-0009/GATE-PILOT → WP écrans acceptés → GATE-TABLET si applicable → GATE-ROLLOUT-READY → WP-0010-01 → GATE-GLOBAL → WP-0010-02 → WP-0010`.

Peuvent avancer en parallèle après les gates :

- E12 avec E01/E02, car le dictionnaire d'état nourrit toutes les surfaces ;
- E05 avec E03/E04, à condition que projection et audio restent isolés ;
- E07, E08, E09, E10 et E11 par équipes distinctes après certification des primitives ;
- tests, accessibilité et observabilité à l'intérieur de chaque WP, jamais comme phase finale séparée.

Ne doivent pas être parallélisés sans ownership explicite :

- modifications de `app/_layout`, tab layout ou provider racine ;
- primitives UI partagées et migrations d'écran au même moment ;
- module audio Bob et projection visuelle si le contrat d'événements n'est pas gelé ;
- libellés financiers et changements de statuts métier ;
- route historique voix et nouvelle surface canonique sans plan de compatibilité.

## 16. Gabarit obligatoire d'un ticket d'exécution

```md
# [WP-ID] Résultat utilisateur observable

Statut : Proposed | Ready | In progress | In review | Verified | Released
Owner :
Reviewers obligatoires : Design / Mobile / QA / A11y / métier si sensible
Exigences : Gxx, Vxx, Sxx, Txx
ADR :
Feature flag / default / kill switch :

## Problème et résultat attendu
## Non-scope et invariants backend
## Écrans, états et plateformes concernés
## Prototype normal / erreur / Reduced Motion / grande police
## Contrat d'événements et source d'autorité
## Plan d'implémentation et migration
## Plan de test
## Budget performance
## Télémétrie autorisée et données interdites
## Rollback
## Preuves jointes
## Verdict DoD
```

## 17. Règles de clôture du backlog

- Un WP ne passe pas à `Verified` sur la base de captures simulateur seules.
- « Code mergé » n'est pas un résultat ; la DoD demande fonctionnement, preuve, accessibilité, performance et rollback.
- Une exigence décalée garde son ID, un owner et une justification ; elle ne disparaît pas du total 77/77.
- Un risque accepté possède un waiver daté, un responsable, une expiration et un impact utilisateur explicite.
- Les work packages `XL→découper` sont interdits en sprint tant qu'ils ne sont pas transformés en
  enfants `WP-####-NN` de taille `L` ou plus petite avec preuves indépendantes.
- Toute régression de vérité financière, confirmation sensible, Voice Trace, confidentialité, accessibilité bloquante ou SLO voix arrête le rollout.
