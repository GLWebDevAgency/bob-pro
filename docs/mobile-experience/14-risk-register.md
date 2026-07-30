# Registre des risques

> Statut : **Proposed**
> Échelle probabilité/impact : Faible, Moyen, Élevé, Critique
>
> **Amendement A6 — 2026-07-29.** `R08` est requalifié (le risque de matière se réduit à la seule
> retombée de bord, le reste de l'UI étant opaque par construction) et trois risques sont **ajoutés**
> à la suite du registre, sans recyclage d'identifiant : `R39`, `R40`, `R41`. Aucun risque existant
> n'est supprimé ni renuméroté. Voir le
> [journal des amendements](README.md#journal-des-amendements).
>
> **Amendements A7 et A8 — 2026-07-29.** `R40` change de **libellé** et de nature — Gesture Handler
> est déjà en service dans le produit, donc le risque n'est plus « première entrée » mais conflit de
> gestes avec l'existant (A7). Un risque est **ajouté** à la suite, sans recyclage : `R42`, la perte
> du sixième comportement de la tab bar (A8). Registre : **42 risques**, aucun supprimé ni
> renuméroté.
>
> **Amendements A18 et A23 — 2026-07-30.** Deux risques sont **ajoutés** à la suite, sans recyclage
> d'identifiant : `R43` (préférence d'accessibilité fail-OPEN au premier rendu) et `R44` (contraste
> perdu au point d'usage d'une surface teintée). Tous deux sont **observés dans le code livré**, pas
> anticipés : leur mitigation documentaire est écrite, leur correctif de code reste ouvert.
> Registre : **44 risques**, aucun supprimé ni renuméroté.
>
> **Amendement A28 — 2026-07-30 · le registre était cassé au rendu.** Une **ligne vide** séparait
> `R42` de `R43` : en GFM un tableau se termine à la première ligne vide, donc `R43` et `R44`
> **sortaient du registre** et s'affichaient en texte brut — contredisant frontalement l'en-tête
> ci-dessus, qui les annonçait comme deux lignes ajoutées à la suite. La ligne vide est supprimée ;
> un contrôle exécutable interdit désormais sa réapparition
> ([11 § Tests statiques](11-test-strategy.md#tests-statiques), contrôle d'intégrité des tableaux).
>
> **Amendement A29 — 2026-07-30.** Un risque est **ajouté** à la suite, sans recyclage : `R45`, le
> flou qui ne se rafraîchit pas au-dessus d'une liste virtualisée. Registre : **45 risques**.

## Registre

| ID | Risque | Prob. | Impact | Signal précoce | Mitigation | Gate/owner |
| --- | --- | --- | --- | --- | --- | --- |
| R01 | Sur-animation et fatigue | Moyen | Élevé | Plusieurs boucles ou staggers sur le même viewport. | Une chorégraphie dominante, revue motion, ambient réservé à Bob. | Design owner |
| R02 | Faux succès métier | Moyen | Critique | Check/vert déclenché au tap ou au timer. | State machine `pending → ACK/relecture → success`, tests perte réseau. | Finance/security |
| R03 | Fausse progression | Élevé | Élevé | Phases décoratives sans événement runtime. | Phases réelles ou indicateur indéterminé ; mapping audité. | Bob Live/mobile |
| R04 | Régression de confirmation | Faible | Critique | Une action sensible devient un geste direct. | Rejouer invariants, tests voix/tap, revue sécurité. | Security owner |
| R05 | Jank sur listes | Élevé | Élevé | Slow frames lors d'ajout, filtre ou scroll. | Transform/opacity, limites d'animations, profiling release, FlashList. | Mobile lead |
| R06 | Régression SLO voix | Moyen | Critique | Premier audio ou barge-in ralentit avec l'overlay. | UI thread, budgets séparés, Voice Trace avant/après, kill switch. | Bob Live owner |
| R07 | Audio perturbé par haptique | Faible | Élevé | Artefact micro au début/fin ou pendant VAD. | UX-ADR-006, aucune haptique continue, device QA/Voice Trace et silence pendant capture par défaut. | Audio owner |
| R08 | Coût GPU de la retombée floutée **(amendé A2 · 2026-07-29 : le risque se réduit à la seule retombée de bord, le reste de l'UI étant opaque.)** | Faible | Moyen | Chute de frames sous scroll continu, chauffe ou retombée illisible. | Mode teinté sans flou par **défaut** ; une retombée au plus par bord ; plafond de couches calibré ; repli opaque unique. | Mobile/design |
| R09 | Shared transition instable | Moyen | Élevé | Flash, destination incorrecte, geste Retour cassé. | Native zoom seulement sur surfaces éligibles ; fallback push ; pas de flux critique. | Navigation owner |
| R10 | Divergence iOS/Android | Élevé | Moyen | Bob semble premium sur un OS et générique/cassé sur l'autre. | Intention commune, implémentations adaptées, matrice de capture. | Design/mobile |
| R11 | Dark mode partiel | Élevé | Élevé | StatusBar/chrome sombre avec contenu clair non prévu. | Force-light transitoire jusqu'au thème complet ; zéro pseudo-automatique ; G02 ne ferme pas avant certification adaptative. | E01 owner |
| R12 | Grandes polices cassant la hiérarchie | Élevé | Élevé | CTA tronqué, montant hors carte, ligne inaccessible. | Layout extensible, wrapping, scroll, tests ~200 %, pas de hauteurs fixes. | Accessibility |
| R13 | Trop d'annonces lecteur d'écran | Moyen | Moyen | Chaque token/transcript déclenche une annonce. | Batching, live region ciblée, état majeur uniquement. | Accessibility/Bob |
| R14 | Scroll-jacking | Moyen | Élevé | Header ou auto-scroll lutte avec le geste. | Liaison 1:1, auto-scroll conditionnel, interruption par utilisateur. | Navigation owner |
| R15 | Perte de position/list keys | Moyen | Élevé | Liste saute après filtre ou mutation. | Identités stables, tests conservation offset, layout transitions bornées. | Data UI owner |
| R16 | Animation financière trompeuse | Moyen | Critique | Valeur intermédiaire interprétée comme montant réel. | Valeur finale accessible immédiatement, animation purement visuelle, unités stables. | Finance reviewer |
| R17 | Régression deep links/restauration | Moyen | Élevé | Mauvaise modalité ou boucle de redirection. | Tests deep links, background, process death et routes legacy. | Navigation/QA |
| R18 | Clavier masquant une action | Élevé | Élevé | Sheet/formulaire non soumis sur petit écran. | Keyboard handling natif, detents, safe areas, tests petits devices. | Mobile QA |
| R19 | Double système UI | Élevé | Moyen | Ancien et nouveau Button/Sheet continuent à diverger. | Dépréciation, lint/import policy, migration par domaine. | UI owner |
| R20 | Dépendance expérimentale bloquante | Moyen | Élevé | API alpha change pendant livraison. | ADR, spike, pin version, wrapper, fallback stable. | Tech lead |
| R21 | Bundle/mémoire Skia | Faible | Moyen | Taille et mémoire augmentent pour peu de valeur. | Réserver à Bob/chart ; mesurer ; préférer SVG/Reanimated sinon. | Tech lead |
| R22 | Scope tablette explosif | Moyen | Moyen | Layout spécifique par écran sans système. | Breakpoints, containers et master-detail partagés, priorisation. | E01 owner |
| R23 | Jargon masqué au support | Moyen | Moyen | Support ne peut plus diagnostiquer. | Détails techniques accessibles, copiables et non prioritaires. | Content/support |
| R24 | Texte temporel périmé | Élevé | Moyen | “2026” ou délai figé devient faux. | Source dynamique/configurée, tests année/fuseau, revue contenu. | Content owner |
| R25 | Personnalité changeant le sens légal | Faible | Critique | Pote/Direct omet une conséquence. | Sémantique verrouillée, seules tonalité/longueur varient, snapshots critiques. | Legal/content |
| R26 | Rollout impossible à annuler | Moyen | Critique | Migration remplace l'ancien chemin sans flag. | Flags capability, fallback maintenu, runbook et exercice rollback. | Release owner |
| R27 | Analytics doublées | Moyen | Moyen | Animation/re-render émet plusieurs événements. | Événement métier corrélé, idempotence analytics, tests. | Data/product |
| R28 | Concurrence agents/fichiers | Moyen | Élevé | Claims chevauchants ou grosse refonte partagée. | Refs/claims, owner unique, handoff et tranches petites. | Delivery lead |
| R29 | Roadmap lancée avant publication | Moyen | Critique | Travaux UX opportunistes concurrencent le cap release. | Gate fondateur explicite, docs seulement jusque-là. | Product owner |
| R30 | Documentation obsolète | Élevé | Élevé | Specs historiques contredisent code/ADR récent. | Hiérarchie d'autorité, dates, reader test, mise à jour traçabilité. | Doc owner |
| R31 | Faux effet premium sur appareil haut de gamme uniquement | Élevé | Élevé | Validation seulement simulateur/iPhone Pro. | Android médian obligatoire et mode économie d'énergie observé. | QA owner |
| R32 | Scan surchauffe ou masque une latence réelle | Moyen | Élevé | Animation infinie, batterie ou promesse de phase fausse. | Progression reliée au pipeline, cancel/retry, budget GPU/caméra. | Scan owner |
| R33 | Échec réseau détruisant une animation de relocalisation | Moyen | Élevé | Document visuellement rangé puis erreur. | Animer la relocalisation après succès ; état pending conservé à la source. | Document owner |
| R34 | Nouveau runtime motion incompatible Fabric/RN | Moyen | Élevé | Crash ou perf différente release. | Matrice de compatibilité, spike, pin, build natif et rollback. | Mobile lead |
| R35 | Focus perdu pendant layout transition | Moyen | Élevé | VoiceOver revient en haut ou action disparaît. | Politique focus, annonces, tests screen reader pendant mutations. | Accessibility |
| R36 | Preuve ou capture contenant une donnée sensible | Moyen | Critique | Nom, montant, document, transcript ou métadonnée réelle dans un manifest. | Fixtures synthétiques, redaction, revue Security/Privacy, convention `evidence/README.md`. | QA + Security |
| R37 | Gate signée sans owner effectif | Élevé | Élevé | Rôle générique ou champ « à affecter » au moment de passer Accepted. | Registres owners/décisions/preuves bloquants ; signature nominative obligatoire. | Product + QA |
| R38 | Recherche utilisateur enregistrée sans gouvernance | Faible | Élevé | Vidéo/voix conservée sans consentement, accès ou expiration. | Consentement, minimisation, fixtures, accès/rétention et suppression documentés avant session. | Product Research + Privacy |
| R39 **(ajouté A1 · 2026-07-29)** | Réintroduction rampante du verre système | Moyen | Élevé | Un `GlassView`, un `glassEffectStyle` ou un `rgba` translucide apparaît dans une PR de chrome « pour faire moderne ». | Doctrine écrite et sourcée (UX-ADR-004) ; contrôle statique d'import `expo-glass-effect` ; revue de matière dans la DoD composant. | Design owner |
| R40 **(ajouté A3 · 2026-07-29 ; libellé corrigé A7)** | Portage de la tab bar : **premier usage** de Reanimated (déclaré `4.5.0` + `worklets` `0.10.0`, importé nulle part) et **première utilisation de Gesture Handler dans le chrome** — la lib est déjà en service, mais uniquement en root provider et sur deux `Swipeable` de contenu | Élevé | Élevé | Le composant est fluide en dev et saccade en release ; **conflit de gestes** entre le `Race(pan, tap)` de la barre, le scroll et les `Swipeable` déjà en place ; régression du geste Retour. | `UX-ADR-001` accepté avant le portage ; `PERF-13` obligatoire ; seuils de geste repris tels quels de la référence ; **passe de non-régression sur `catalogue` et `PieceDetailView`, dont les `Swipeable` préexistent au portage** ; flag `mobile_tabs_experiment_v1` OFF par défaut ; `BottomTabBar` actuelle conservée comme fallback. | Mobile tech lead |
| R41 **(ajouté A3 · 2026-07-29)** | Le scrub casse l'exploration au lecteur d'écran | Moyen | Critique | Le détecteur de geste consomme les touches ; VoiceOver/TalkBack ne trouve plus les onglets. | Scrub **désactivé** dès qu'un lecteur d'écran est actif, retour aux `Pressable` ; passe manuelle signée sur les deux OS avant tout rollout. | Accessibility reviewer |
| R42 **(ajouté A8 · 2026-07-29)** | Le sixième comportement (teinte pilotée par le highlight) tombe du lot, ou tombe sous AA en cours d'interpolation | Élevé | Moyen | C'est un **effet** sans fonction propre : rien ne casse s'il manque, la barre marche — elle redevient simplement un commutateur, et la directive « même EFFET que la référence » n'est plus tenue. Variante silencieuse : il est livré, mais la teinte traverse une zone sous-contrastée, notamment `navigation.assistantActive` `#4338CA` qui n'a aucun équivalent dans la référence. | Exigé **nommément** dans `G11`, `WP-0303`, `D07` et les critères de `UX-ADR-002` ; vidéo au ralenti obligatoire au registre de preuves ; contraste **échantillonné le long de la course**, pas déduit des deux bornes ; variante Reduced Motion = commutation sans course. | Design owner + Accessibility reviewer |
| R43 **(ajouté A18 · 2026-07-30)** | Préférence d'accessibilité **fail-OPEN** au premier rendu | Élevé | Élevé | Les préférences se lisent de façon asynchrone : `useReduceMotion()` renvoie `false` avant de savoir (`packages/ui/src/hooks/use-reduce-motion.ts`, `useState(false)`). Un utilisateur qui a activé Reduce Motion voit quand même la première animation de chaque composant monté tôt — et le défaut est **invisible en QA**, puisqu'il ne se manifeste que chez qui a activé la préférence. Symétrique pour le lecteur d'écran : un détecteur de geste monté avant de savoir consomme les touches d'exploration. | Règle **fail-CLOSED** écrite ([08 § Préférences d'accessibilité et premier rendu](08-accessibility-adaptive-design.md#préférences-daccessibilité-et-premier-rendu)) : l'inconnu compte comme actif ; résolution **unique** hissée au démarrage derrière le splash ; interdiction de rejouer une animation déjà résolue ; cas de test dédié en [11 § Tests composants](11-test-strategy.md#tests-composants) et en matrice [08](08-accessibility-adaptive-design.md#matrice-minimale-de-test). **Le correctif du hook lui-même est un correctif de CODE, non couvert par le lot documentaire d'A18** : il reste ouvert. | Accessibility reviewer + Mobile tech lead |
| R44 **(ajouté A23 · 2026-07-30)** | Contraste perdu au point d'usage d'une surface teintée | Moyen | Élevé | `BobSurface` ne propage ni `ink` ni `highContrast` : rien n'empêche un appelant de poser une couleur de texte générique sur un fond teinté. Cas déjà réel : `apps/mobile/app/equipements/[chantierId].tsx` rend `colors.slate500` sur `warning.raised` = **4,39:1**, sous le seuil AA du texte normal. Aucun test du dépôt ne le détecte. | Case « Encre conforme » ajoutée à la [DoD composant](12-definition-of-done.md#dod-composant-partagé) ; frontière du composant écrite en [UX-ADR-004](adr/UX-ADR-004-adaptive-appearance.md#ce-que-bobsurface-ne-fait-pas--ink-et-highcontrast-ne-se-propagent-pas) ; contrôle statique « couple texte/fond » à écrire ([11 § Tests statiques](11-test-strategy.md#tests-statiques), aujourd'hui `NOT RUN`). | Accessibility reviewer + Design owner |
| R45 **(ajouté A29 · 2026-07-30)** | Le flou de la retombée **ne se rafraîchit pas** au-dessus d'une liste virtualisée | Moyen | Élevé | Limitation officielle `expo-blur` : un `BlurView` rendu avant un contenu dynamique (`FlatList` et assimilés) fige son échantillon. L'écran rend alors une image **périmée** sous le chrome, et **aucun test de comportement ne rougit** — le défaut ne se voit qu'à l'œil, sur un appareil, en défilant. `@shopify/flash-list` `^2.0.2` est déjà **déclaré** dans `apps/mobile/package.json` (importé nulle part au 2026-07-30) : le risque est devant nous, pas derrière. | `N = 0` obligatoire au-dessus d'une liste virtualisée (cinquième coupure du repli opaque unique) ; ordre de montage imposé ; contrôle statique interdisant la coexistence ; levée uniquement sur preuve filmée de rafraîchissement. | Mobile tech lead |

## Règle d'escalade

- Impact `Critique` : décision écrite et owner nommé avant implémentation.
- Probabilité `Élevée` + impact `Élevé` : prototype et métrique avant migration d'écran.
- Signal observé pendant canary : pause automatique du rollout.
- Risque sans mitigation testable : work package `Blocked`.

## Révision

Le registre est revu :

- à l'acceptation de chaque ADR ;
- avant chaque vague ;
- après un incident, rollback ou échec de reader/device test ;
- avant le passage R2, R3 et R4 ;
- lorsqu'une version Expo/RN ou une API native change.
