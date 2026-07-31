# Stratégie de tests et de validation

> Statut : **Proposed**
> Périmètre : design, motion, navigation, contenu, accessibilité, performance et non-régression
>
> **Amendement A6 — 2026-07-29.** Quatre contrôles statiques sont **ajoutés** (interdiction
> d'`expo-glass-effect`, interdiction d'un `rgba` translucide de surface d'information, `expo-blur`
> hors de `packages/ui`, non-redéfinition des noms de tokens) et deux tests unitaires de surface
> sont reformulés. **Aucun test n'est retiré**, la pyramide et la matrice appareils sont
> inchangées.
>
> **Amendement A21 — 2026-07-30.** § Performance : la liste des scénarios s'arrêtait à `PERF-12` et
> laissait `PERF-13` hors de la stratégie exécutable.
>
> **Amendement A27 — 2026-07-30.** § Tests statiques et § Gates CI : ces contrôles n'existent pas
> dans le dépôt et étaient pourtant cités comme preuves de sortie. L'état réel est écrit ; aucun
> contrôle n'est retiré de la liste des contrôles **à écrire**.
>
> **Amendement A18 — 2026-07-30.** § Tests composants : la préférence d'accessibilité **inconnue**
> devient un cas de test à part entière.
>
> **Amendement A28 — 2026-07-30.** § Tests statiques : l'encadré d'état réel affirmait « pas de
> répertoire `scripts/` » **dans le commit même qui créait `scripts/`**, dix lignes au-dessus du
> contrôle qui y vit. Le fait est rectifié, le constat de fond conservé ; un contrôle d'intégrité
> des tableaux et un contrôle « zéro `hitSlop` sur la tab bar » sont ajoutés à la liste.
>
> **Amendement A29 — 2026-07-30.** § Tests statiques : deux contrôles de la couture du port de
> flou — pas de mode flouté au-dessus d'une liste virtualisée, et ordre de montage imposé.
>
> **Amendement A30 — 2026-07-30 · le contrôle d'ordre de montage était inapplicable** — § Tests
> statiques. Le contrôle d'`A29` exigeait que `ProgressiveBlurBob` soit « le dernier enfant du
> conteneur » : il aurait fait échouer tout shell portant son chrome à la place que
> [04](04-navigation-scroll-surfaces.md) lui assigne. Réécrit sur l'ordre réel
> `CONTENU → RETOMBÉE → CHROME`, et complété par l'interdiction de `zIndex`/`elevation` sur la
> retombée. Trois contrôles sont par ailleurs ajoutés au validateur livré (`C11`, `C12`, `C9`
> élargi) — § Tests statiques, encadré d'état réel.
>
> **(ajouté A30 · 2026-07-30) Amendements portés dans le corps** — leur marqueur daté est au
> point d'application, pas dans cet encadré : `A9`, `A17`, `A19`, `A22`. Le
> [journal des amendements](README.md#journal-des-amendements) fait foi ; cette énumération
> n'est admissible que parce que le contrôle `C12` de `scripts/check-mobile-experience-docs.mjs`
> la tient à jour — une énumération que rien ne vérifie devient fausse au premier amendement
> suivant.

## Principe

Les tests ne prouvent pas seulement que l'animation se joue. Ils prouvent que l'état final est
correct avec animation complète, réduite, interrompue ou absente, et que le métier reste inchangé.

## Pyramide

| Niveau | Objet | Vitesse | Autorité |
| --- | --- | --- | --- |
| Statique | Imports, tokens, route matrix, types et clés i18n. | Très rapide | CI chaque PR |
| Unitaire | Projections, policies, reducers, timings et fallbacks. | Rapide | CI chaque PR |
| Composant | Sémantique, états, focus, cleanup et snapshots. | Rapide/moyen | CI ciblée |
| Intégration | Navigation, data state, mutations et layout. | Moyen | CI/preview |
| Visuel | Rendu déterministe multi-size/modes. | Moyen | PR de migration |
| E2E natif | Parcours réels sur build preview. | Lent | Gate de slice/vague |
| Appareil/perf | Sensation, audio, haptique, GPU, batterie. | Manuel/automatisé | Gate canary |

## Tests statiques

> **État réel, ajouté A27 · 2026-07-30 — rectifié A28 le même jour.** **Aucun** des contrôles
> listés ci-dessous n'existe aujourd'hui dans le dépôt : aucun job de CI dédié, et le
> `package.json` racine n'expose que `build`, `test`, `typecheck`, `lint` et `dev`. Ce
> sont des **contrôles à écrire**, pas des contrôles en vigueur. Tant qu'un contrôle n'est pas
> exécutable par une commande, il vaut `NOT RUN` au sens de
> [12 — DoD](12-definition-of-done.md#règle-na-limitation-et-waiver) et **ne peut être invoqué comme
> preuve par aucun work package** — en particulier `WP-0303` et `WP-0307`, dont les preuves de
> sortie citent un « contrôle statique ». Le premier lot qui a besoin d'un de ces contrôles le livre
> avec son code ; il ne le suppose pas acquis parce qu'il est écrit ici.
>
> *Rédaction A27 (fausse, supersédée par A28) : « vérifié le 2026-07-30 : pas de répertoire
> `scripts/` ». Le répertoire `scripts/` **existe** — il a été créé par le commit qui a écrit cette
> phrase, et le contrôle n° 2 ci-dessous s'y trouve, dix lignes plus bas. C'est exactement la
> famille d'erreur qu'A27 prétendait fermer : un document qui affirme un fait que le dépôt
> contredit. Le constat de fond, lui, reste vrai et n'est pas relâché — aucun contrôle de la liste
> ci-dessous n'existe.*
>
> **Deux** contrôles existent aujourd'hui, et seulement eux :
>
> 1. `pnpm --filter @bob/tokens test` (`packages/tokens/src/index.test.ts`) — certifie les
>    contrastes AA des couples `ink`/`inkMuted` sur `flat` **et** `raised`. Il ne couvre ni les
>    couleurs composées en dehors de `surfaceTint`, ni les couples texte/fond formés à l'exécution
>    — voir la limite nommée en
>    [UX-ADR-004](adr/UX-ADR-004-adaptive-appearance.md#ce-que-bobsurface-ne-fait-pas--ink-et-highcontrast-ne-se-propagent-pas).
> 2. **`node scripts/check-mobile-experience-docs.mjs`** *(ajouté A27 · 2026-07-30)* — valide le
>    présent socle **contre le code** : versions SDK citées vs `apps/mobile/package.json`,
>    absence de mention active d'un SDK périmé, constantes livrées (`Toast`, `Button`,
>    `PressableScale`) citées à l'identique par [17](17-references.md#autorités-normatives), table
>    de contraste de [04 § 2](04-navigation-scroll-surfaces.md#2-highlight-glissant-à-ressort-interruptible)
>    **recalculée** depuis `packages/tokens`, présence de `PERF-13` dans la stratégie, sources Expo
>    pinées sur une version, résolution de toutes les ancres de liens internes, et
>    **(ajouté A28 · 2026-07-30)** intégrité des tableaux Markdown — aucune ligne vide ne coupe un
>    tableau, défaut qui sortait silencieusement `A17`→`A27` du journal des amendements et
>    `R43`/`R44` du registre des risques. **(complété A30 · 2026-07-30)** Trois familles de plus,
>    toutes commises par ce dossier et toutes revenues après avoir été soldées à la main :
>    **bornes d'amendements divergentes** (`C11` — un fichier qui annonce des bornes s'arrêtant
>    avant le dernier amendement du journal, deux fois dans le même fichier),
>    **index d'amendements incomplet** (`C12` — un document que le journal déclare amendé, dont
>    l'encadré de tête ne cite pas l'amendement : cas d'`A18` dans
>    [04](04-navigation-scroll-surfaces.md)), et **affirmation d'absence sans nom de chose**
>    (`C9` élargi — la formulation **fausse** « aucun `scripts/` » passait, là où « pas de
>    répertoire `scripts/` » échouait déjà).
>    Sans dépendance ni accès réseau ; **non branché** à la CI — le brancher relève de
>    [13 — Gouvernance](13-delivery-governance.md), pas d'un auteur de document. Il ne remplace
>    aucun contrôle de la liste ci-dessous : il ferme la famille d'erreurs que ce dossier a
>    réellement commise, celle où un document affirme un fait que le dépôt contredit.

- Garde d'import Clean Architecture.
- Interdiction des durées/easing inline hors allowlist.
- Interdiction d'import transitif Reanimated/Haptics.
- **(ajouté A1 · 2026-07-29)** Interdiction **totale** d'importer `expo-glass-effect`, dans tout le
  dépôt : ce n'est pas une capability à encapsuler, c'est une matière hors doctrine.
- **(ajouté A1 · 2026-07-29)** Interdiction d'un `rgba(...)` translucide comme fond d'une surface
  porteuse d'information ; les fonds viennent de `surfaceTint`.
- **(ajouté A2 · 2026-07-29)** `expo-blur` n'est importé nulle part dans `packages/ui` : il ne peut
  entrer que par le port `renderBlurLayer`, injecté depuis `apps/mobile`.
- **(ajouté A29 · 2026-07-30)** **Mode flouté et liste virtualisée ne coexistent pas** : aucun
  module ne monte à la fois un `ProgressiveBlurBob` avec `layers > 0` et un `FlashList`,
  `FlatList`, `SectionList` ou `VirtualizedList`. Motif : un `BlurView` posé au-dessus d'un contenu
  dynamique recyclé **ne se rafraîchit pas** — le rendu est faux et aucun test de comportement ne
  rougit ([04 § Couture du port](04-navigation-scroll-surfaces.md#couture-du-port--qui-rend-quoi-de-part-et-dautre-de-la-frontière-de-paquet)).
- **(ajouté A29 · 2026-07-30 ; corrigé A30)** Dans un shell d'écran flouté, l'ordre de déclaration
  est **`CONTENU → RETOMBÉE → CHROME`** : le `BlurTargetView` d'abord, `ProgressiveBlurBob`
  **après** lui, le chrome flottant **après** la retombée. Le premier ordre est une contrainte
  officielle d'`expo-blur` (le flou ne se rafraîchit pas s'il est déclaré avant le contenu qu'il
  échantillonne) ; le second est une contrainte de rendu (le voile est opaque dès 60 % vers le bord
  ancré : un chrome déclaré avant la retombée est peint **dessous**, donc masqué). Le contrôle
  vérifie aussi que la retombée ne porte **ni `zIndex`, ni `elevation`, ni token d'ombre** — sur
  Android l'`elevation` trie l'ordre de dessin et primerait sur la déclaration, ce qui ferait
  diverger le rendu des deux OS
  ([04 § Couture du port](04-navigation-scroll-surfaces.md#couture-du-port--qui-rend-quoi-de-part-et-dautre-de-la-frontière-de-paquet)).
  *Rédaction A29 (supersédée) : « `ProgressiveBlurBob` est le dernier enfant du conteneur » — un
  contrôle qui aurait fait échouer tout shell portant son chrome à la bonne place.*
- **(ajouté A28 · 2026-07-30)** **Zéro `hitSlop`** sur les `Pressable` de la tab bar portée : sa
  cible est tenue par la hauteur du `Pressable` lui-même
  ([04 § Cibles tactiles et Dynamic Type](04-navigation-scroll-surfaces.md#cibles-tactiles-et-dynamic-type)).
- **(ajouté A5 · 2026-07-29)** Aucun document de ce dossier ne redéfinit un nom déjà exporté par
  `@bob/tokens` : contrôle des noms `motion.*` / `motionSemantic.*` cités dans les specs contre les
  exports réels.
- Route matrix exhaustive par rapport aux fichiers `app`.
- Chaque clé de statut existe dans les trois personnalités.
- Chaque motion intent possède une variante reduced.
- **(amendé A9 · 2026-07-29)** Chaque surface est **opaque à la source** : son fond vient de
  `surfaceTint`, jamais d'un `rgba` translucide ni d'une capability runtime. Le contrôle ne cherche
  plus l'existence d'un fallback — il cherche l'existence d'un chemin **non opaque**, et échoue s'il
  en trouve un. *Rédaction initiale 2026-07-23 (supersédée) : « Chaque surface adaptative possède
  fallback opaque » — un test qui, depuis A1, validerait du code mort : une branche de repli
  qu'aucune préférence ne peut atteindre.*
- Chaque ID G/V/S/T apparaît dans la matrice de traçabilité.
- Chaque ID possède exactement une ligne dans le registre de preuves ; `Verified` implique manifest,
  build, owner, reviewers et verdict admissible.
- Aucun WP/gate inconnu, doublon d'ID ou cycle de dépendances ; les enfants respectent
  `WP-####-NN`.
- Aucun ADR ne devient `Accepted` sans owner nommé et preuves minimales de décision ; les critères
  post-implémentation restent séparés.
- Aucun nouvel usage des composants deprecated.

## Tests unitaires

### Motion policy

- full, crossfade_only, off ;
- changement de préférence ;
- interruption/redirection ;
- entrée/sortie symétrique ;
- stagger cap ;
- validation des valeurs bornées.

### StatusBar/surfaces

- fond clair/sombre ;
- modal transparente ;
- transition route ;
- **(amendé A1 · 2026-07-29)** reduce transparency : le rendu est **identique** à la référence — la
  préférence ne doit produire aucune différence de surface ;
- **(amendé A2 · 2026-07-29)** port `renderBlurLayer` absent : la retombée de bord rend son repli
  opaque unique, même géométrie et même courbe ;
- increase contrast.

### Bob projection

- chaque phase canonique ;
- événement dupliqué ;
- événement tardif/génération ancienne ;
- perte réseau/reconnexion ;
- barge-in ;
- error ne devient pas idle ;
- success seulement après ACK ;
- input/output amplitude distincts ;
- cleanup.

### Content state

- mapping erreur → message/action ;
- unknown après timeout ;
- statut temporel ;
- snapshots Pote/Pro/Direct ;
- absence de millésime figé dans les clés durables.

## Tests composants

Pour chaque primitive :

- nominal ;
- press/selected/focused ;
- disabled ;
- loading ;
- success autoritaire ;
- recoverable/terminal error ;
- grandes polices ;
- Reduce Motion/Transparency ;
- **(ajouté A18 · 2026-07-30)** préférence **inconnue** au premier rendu : le composant se comporte
  en variante réduite, et ne rejoue **aucune** animation quand la préférence se résout ensuite ;
- **(ajouté A17 · 2026-07-30 ; précisé A28)** cible tactile **mesurée** (`measure()`) à l'état le
  plus compact du composant, non déduite d'une zone décorative **ni d'un style** ; si un `hitSlop`
  est employé, il est **contenu dans le padding du parent** — un `hitSlop` qui déborde n'est jamais
  dispatché ;
- VoiceOver/TalkBack props ;
- unmount pendant animation ;
- double tap ;
- absence d'haptique non autorisée.

### Sheet

- detents ; drag ; vélocité ; scrim ; clavier ; focus ; Escape ; back Android ; dirty state ;
rotation ; reduced motion ; une seule sheet ; retour focus.

### Tab bar

- sélection ; retap ; badge ; état préservé ; deep link ; clavier ; safe area ; rotation ;
screen reader ; flag figé au démarrage.
- **(ajouté A17/A19/A22/A23 · 2026-07-30 ; mécanisme tranché A28)** cible tactile mesurée **à
  l'état replié** et à ~200 %, **sur le `Pressable` lui-même**, rectangle contenu dans celui de la
  pilule, voisins non chevauchants, **zéro `hitSlop`**, plus la **preuve de touche** aux deux bords
  et l'absence de cible dans la retombée — les cinq mesures de
  [04 § Cibles tactiles et Dynamic Type](04-navigation-scroll-surfaces.md#cibles-tactiles-et-dynamic-type) ;
  labels non tronqués puis retirés au palier prévu ; navigation de fin de scrub **dans la même
  frame** que le recalage du ressort (et non après lui) ; contraste des trois rôles `navigation.*`
  mesuré **sur la teinte de highlight retenue**, pas seulement sur la pilule.

### Layout transition

- ajout, suppression, tri, expansion ;
- keys stables ;
- scroll offset ;
- focus ;
- interruption ;
- grande liste ;
- reduced motion.

## Tests intégration

| Parcours | Assertions critiques |
| --- | --- |
| Today priorité | Pending, ACK, check, repli, tri, compteur et erreur. |
| Client → fiche | Source/destination, back, scroll conservé, objet absent. |
| Document → dossier | Relocalisation après succès, échec reste source, compteur exact. |
| Devis lignes | Ajout/suppression, totals identiques, draft, clavier, double tap. |
| Facture génération | Idempotence, pending, résultat unique, détail exact. |
| Notification lue | Optimisme borné, rollback, badge synchronisé. |
| Scan | Permission, capture, upload, analyse longue, retry, document créé. |
| Assistant | Streaming blocs, auto-scroll conditionnel, card growth, erreur. |
| Bob Live | Connexion, écoute, commit, outil, parole, barge-in, reprise, fin. |

## Régression visuelle

### Captures déterministes

- Motion OFF pour le snapshot final.
- Horloge, données et IDs stabilisés uniquement en environnement test.
- Aucune fixture de capture ne pénètre l'artefact production.
- Comparer géométrie, rôle de couleur, typography et état.

### Variantes

| Axe | Valeurs minimales |
| --- | --- |
| Taille | Téléphone compact, standard, grand, tablette. |
| OS | iOS cible minimum/actuel, Android minimum/médian/actuel. |
| Police | Standard, ~150 %, ~200 %. |
| Apparence | Light ; dark si activé. |
| Accessibilité | Reduce Motion, Reduce Transparency, Increase Contrast. |
| Data | Loading, empty, data, error, offline, pending, success. |

Un diff visuel accepté porte une justification. Les seuils automatiques ne remplacent pas la revue
de sens.

## Validation d'utilisabilité et de compréhension

Les tests techniques ne prouvent pas que la hiérarchie est comprise. Chaque pilote de vague et
chaque parcours financier, documentaire ou vocal fortement remanié fait donc l'objet d'une session
basée sur des tâches avec des utilisateurs représentatifs de la cible validée par Produit.

### Protocole minimal

- comparer la baseline et le prototype/build sans expliquer la nouvelle interface ;
- inclure des personnes novices et régulières, sur téléphone personnel ou appareil équivalent ;
- demander des tâches concrètes : identifier la priorité, retrouver un client, expliquer un statut,
  créer/réviser un document, récupérer une erreur, interrompre Bob ;
- observer réussite, hésitations, retours arrière, erreurs, compréhension du statut, confiance et
  capacité à prédire la conséquence du CTA ;
- tester au moins une erreur, un état `pending` et un statut `unknown`, pas seulement le happy path ;
- ne collecter aucune donnée de production ; utiliser fixtures consenties et sessions enregistrées
  seulement avec accord, durée de conservation et accès définis ;
- séparer problème de compréhension, préférence esthétique et bug fonctionnel dans la synthèse.

Le nombre de participants est calibré avec la recherche produit ; il n'est pas utilisé pour faire
passer un résultat qualitatif pour une preuve statistique. Une confusion sur un montant, une
confirmation, une permission, un statut de succès ou l'écoute Bob est un écart P0/P1 à corriger,
même si une seule personne la révèle.

### Preuves de sortie

- script et profils de recrutement non identifiants ;
- synthèse par tâche et sévérité ;
- clips/captures expurgés si consentis ;
- décision de conception et lien vers les exigences concernées ;
- comparaison à la baseline ;
- retest des écarts critiques avant canary.

Un A/B test de conversion ne peut jamais autoriser un dark pattern, une perte d'accessibilité ou un
libellé moins vrai.

## E2E natif

Parcours minimum :

1. cold auth/onboarding ;
2. Today → priorité → résultat ;
3. Clients → fiche → action ;
4. Ventes → devis/facture → détail ;
5. création facture/devis avec reprise de brouillon ;
6. Documents → scan → analyse → classement ;
7. Argent → période/scénario ;
8. Assistant texte → proposition → confirmation ;
9. Bob Live → mission → barge-in → résultat/erreur ;
10. Compte/réglages → sauvegarde ;
11. deep links callback/recovery/legacy voice ;
12. background/foreground et process restart.

## Matrice appareils

| Classe | But |
| --- | --- |
| iPhone compact 60 Hz | Petit viewport et performance de base. |
| iPhone standard 60 Hz | Référence principale. |
| iPhone ProMotion | Fluidité 120 Hz et adaptation. |
| iPad/split view | Composition adaptative. |
| Android minimum supporté | Fallback, mémoire, navigation système. |
| Android médian réel | Cible artisan et performance principale. |
| Android haut de gamme/latest | APIs/matières récentes. |

Les modèles exacts sont figés à Vague 0 selon analytics de parc, disponibilité et minimum produit.

## Accessibilité manuelle

Pour chaque parcours critique :

- VoiceOver et TalkBack depuis cold start ;
- ordre/focus ;
- labels, valeurs et états ;
- grands textes ;
- actions swipe/drag alternatives ;
- Reduce Motion/Transparency ;
- contraste et différenciation sans couleur ;
- dictée/Voice Control si formulaire ;
- captions/Stop/retry Bob.

La passe est signée par personne/date/appareil/build et produit des écarts traçables.

## Bob Live/acoustique

- Micro permission allow/deny/blocked.
- Silence, bruit, parole courte/longue.
- Input amplitude et output amplitude.
- Faux barge-in/écho : zéro toléré selon invariant existant.
- Interruption répétée.
- Bluetooth, haut-parleur, écouteur si supportés.
- Appels/route audio/background.
- Réseau lent/perdu/repris.
- Session renderer legacy/v2.
- Reduced Motion pendant session.
- Haptique désactivée puis active, observation perturbation micro.
- SLO p50/p95 avec Voice Trace.

## Finance et sécurité

Chaque écran financier/sensible inclut :

- mêmes montants avant/après refonte ;
- même use case voix/tap ;
- confirmation inchangée ;
- idempotence/double soumission ;
- conflit de révision ;
- timeout résultat inconnu ;
- relecture serveur ;
- aucun succès prématuré ;
- RLS/tenant inchangés ;
- aucune donnée fictive ;
- logs/analytics sans donnée sensible.

## Performance

Exécuter les scénarios `PERF-01` à **`PERF-13`** du document performance
**(corrigé A21 · 2026-07-30 : la liste s'arrêtait à `PERF-12` et laissait `PERF-13` — le seul
scénario de la tab bar portée — hors de la stratégie exécutable ; son protocole détaillé est en
[10 § Protocole `PERF-13`](10-performance-observability.md#protocole-perf-13--la-barre-du-bas))**
avec :

- build release ;
- trois warm runs ;
- mémoire avant/après répétition ;
- frames JS/UI ;
- température/batterie pour voix/scan ;
- Voice Trace pour Bob ;
- comparaison version legacy/nouvelle.

## Gates CI proposées

> **(précisé A27 · 2026-07-30)** « Proposées » est à prendre au pied de la lettre : aucune de ces
> dix gates n'est branchée au 2026-07-30. Les nommer ne les exécute pas.

1. format/lint/typecheck ;
2. tests tokens/UI/mobile ciblés ;
3. garde d'imports ;
4. route/ID matrices ;
5. snapshots i18n critiques ;
6. visual tests stables ;
7. `expo-doctor` et `expo install --check` après changement natif ;
8. preview builds iOS/Android avant canary ;
9. suites globales avant merge/release ;
10. preuve appareil hors CI pour les gates acoustiques/haptiques.

## Dossier de preuve

Le stockage et le suivi suivent le [registre de preuves](./18-evidence-register.md) et le
[manifest normatif](./evidence/README.md). Un artefact non référencé par un manifest n'a pas de
valeur de gate.

Chaque work package fournit :

- commit/build ;
- IDs audit ;
- captures avant/après ;
- vidéo nominal/reduced/interruption ;
- résultats tests ;
- appareil/OS ;
- profiling ;
- revue accessibilité ;
- risques résiduels ;
- flag et rollback ;
- verdict signé.

## Critères de sortie

- [ ] Tous les niveaux pertinents de la pyramide sont verts.
- [ ] Les parcours métier et erreurs majeures sont couverts.
- [ ] La matrice appareils/modes est complète.
- [ ] Tests financiers et Bob Live satisfont leurs invariants.
- [ ] Visual diffs expliqués et approuvés.
- [ ] Validation de compréhension effectuée pour les pilotes et flux à fort enjeu, écarts critiques retestés.
- [ ] Performance et accessibilité signées sur appareils.
- [ ] Dossier de preuve lié dans la traçabilité.
