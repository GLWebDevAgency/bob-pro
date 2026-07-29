# Système de motion et d'interaction

> Statut : **Proposed**
> IDs liés : G04, G05, G06, G08, G09, G13, G14, G15, G21, G22
> Autorité : spécification future ; les composants et tokens runtime actuels restent la baseline
>
> **Amendement A5 — 2026-07-29 · ce dossier est ADDITIF**
> **Source.** Kit livré `packages/tokens/src/index.ts` (l. 184-212 : `motion`, `motionSemantic`) et
> `packages/ui` (`button.logic.ts`, `pressable-scale.logic.ts`, `motion-presence`) ; directive 5 du
> fondateur (aucun écran existant n'est restylé tant que la refonte visuelle est reportée).
> **Portée.** § Tokens temporels, § Profils de ressort, § Press states. Les règles fondamentales,
> la taxonomie, les courbes, les relations, l'haptique, les layout transitions, le Reduced Motion
> et les critères d'acceptation sont inchangés.

## Règle d'additivité

> Ajoutée A5 · 2026-07-29, en tête du document parce qu'elle conditionne tout ce qui suit.

**Ce dossier est ADDITIF. Un nom de token déjà exporté par `@bob/tokens` ne peut être ni réutilisé
pour autre chose, ni revalorisé. Toute proposition qui changerait une valeur existante est un
restyling d'écrans déjà livrés — donc hors périmètre tant que la refonte visuelle est reportée.**

Si une valeur doit malgré tout changer, c'est une **PR de tokens distincte**, avec son inventaire
de consommateurs, ses captures avant/après et son GO — jamais un « réglage » glissé dans une
spécification d'expérience. C'est déjà la règle de la
[gouvernance des tokens](13-delivery-governance.md#gouvernance-des-tokens) ; elle est rappelée ici
parce que ce document l'avait enfreinte trois fois.

## Objectif

Fournir une grammaire unique afin qu'un builder n'invente ni durée, ni easing, ni haptique dans un
écran. Le système décrit une intention ; l'implémentation native conserve la liberté nécessaire
pour suivre le geste, les conventions plateforme et les préférences d'accessibilité.

## Règles fondamentales

1. Un effet répond à causalité, continuité, statut, priorité, relation ou personnalité.
2. L'interaction reçoit un feedback dans le premier frame perceptible.
3. Une animation ne bloque pas un tap ni un résultat backend.
4. Une transition peut être interrompue et redirigée.
5. L'entrée est généralement plus lente que la sortie.
6. Une seule animation dominante à la fois.
7. Les animations répétitives ne rejouent pas au retour sur un écran.
8. L'état final exact est accessible même pendant l'interpolation.
9. Le mode Reduced Motion conserve toute l'information.
10. Le contenu déjà au repos n'est jamais caché à opacité zéro pour créer un spectacle d'entrée.

La règle historique « pas d'opacité zéro à l'entrée » s'applique au contenu nominal déjà présent.
Elle n'interdit pas l'apparition d'un nouvel objet, d'un toast ou d'une carte créée par une action.

## Taxonomie

| Famille | Usage | Exemples |
| --- | --- | --- |
| `feedback` | Réponse immédiate au geste. | Pression, sélection, drag. |
| `enter` | Nouvel élément causé par l'action ou la donnée. | Message, ligne, toast. |
| `exit` | Élément retiré ou terminé. | Notification lue, carte classée. |
| `replace` | Deux contenus frères occupent la même place. | Filtre, segment, onglet interne. |
| `layout` | Position ou taille change sans perdre l'identité. | Accordéon, tri, carte enrichie. |
| `navigate` | Relation entre destinations. | Push, modal, zoom, sheet. |
| `status` | État asynchrone. | Pending, success, error, reconnect. |
| `ambient` | Présence non bloquante, réellement active. | Halo Bob, connexion en cours. |

## Tokens temporels

> Amendé A5 · 2026-07-29 — **collision de namespace résolue.** Les tokens de ce paragraphe étaient
> nommés `motion.instant` … `motion.hero`, alors que **`motion` est déjà un export public de
> `@bob/tokens`** (`packages/tokens/src/index.ts` l. 184) avec `{ fast: 200, base: 220, content:
> 360, ambient: 1500 }`, consommé aujourd'hui par `apps/mobile/src/scan/scan-reading-motion.ts`.
> Sept des dix lignes étaient par ailleurs **déjà livrées à l'identique** sous un autre nom.

Les tokens temporels d'intention **existent** et s'appellent **`motionSemantic`**
(`packages/tokens/src/index.ts` l. 198-212). Ce document ne les redéfinit pas : il les **documente**
et propose des **ajouts**.

### Livrés — à consommer tels quels

| Token | Valeur | Usage | Interdit pour |
| --- | ---: | --- | --- |
| `motionSemantic.feedbackIn` | 80 ms | Press-down, focus, début de sélection. | Transition de contenu. |
| `motionSemantic.feedbackOut` | 160 ms | Relâchement, retour de focus. | Page entière. |
| `motionSemantic.exitFast` | 140 ms | Petit élément qui disparaît. | Destruction nécessitant compréhension. |
| `motionSemantic.enterFast` | 180 ms | Badge, bouton contextuel, toast. | Page ou sheet. |
| `motionSemantic.enter` | 240 ms | Carte/message/section nouvellement créée. | Liste complète à chaque visite. |
| `motionSemantic.replace` | 280 ms | Fade-through, segment, filtre. | Push parent→enfant. |

### Ajouts proposés — non normatifs avant calibration

| Token proposé | Cible | Usage | Interdit pour |
| --- | ---: | --- | --- |
| `motionSemantic.instant` | 0 ms | Reduced Motion ou synchronisation immédiate. Déjà **réalisé** par la table reduce-motion de `motion-presence` ; le nommer ne fait que le rendre citable. | Masquer une latence réelle. |
| `motionSemantic.page` | 320 ms | Transition custom lorsque le natif ne convient pas. | Remplacer un push natif correct. |
| `motionSemantic.hero` | 420 ms max | Objet → détail ou document → aperçu. | Interaction fréquente sans continuité. |

### Registre historique `motion` — gelé

| Token | Valeur **inchangée** | Portée |
| --- | ---: | --- |
| `motion.fast` | 200 ms | Écrans existants. |
| `motion.base` | 220 ms | Écrans existants. |
| `motion.content` | 360 ms | Écrans existants. |
| `motion.ambient` | **1 500 ms** | Écrans existants. |

**`motion.ambient` reste à 1 500 ms.** La fourchette « 1 800–2 400 ms » proposée dans la rédaction
du 2026-07-23 toucherait immédiatement `apps/mobile/src/scan/scan-reading-motion.ts`
(`SCAN_PULSE_DURATION_MS = motion.ambient`) **et son test** — c'est-à-dire un restyling d'un écran
livré, interdit par la directive 5. Aucune valeur existante de `motion` ou de `motionSemantic`
n'est modifiée par ce dossier.

Ces valeurs de proposition sont des points de départ. Les transitions système et le mouvement
directement lié au geste n'utilisent pas un timer arbitraire.

`motionSemantic.page` et `motionSemantic.hero` sont des transitions rares de continuité, pas des
« transitions fréquentes » au sens du budget performance ≤ 300 ms. Une action répétée, un filtre, un
onglet ou une navigation courante utilise le natif ou un token ≤ 280 ms. Même rare, page/hero reste
profilé et ne retarde jamais l'interactivité ; si le protocole `PERF-CALIBRATION` échoue, le token
est raccourci ou remplacé par le natif/fondu.

## Courbes proposées

| Token | Courbe | Usage |
| --- | --- | --- |
| `easing.standard` | `cubic-bezier(0.2, 0, 0, 1)` | Déplacement ou remplacement équilibré. |
| `easing.enter` | `cubic-bezier(0, 0, 0, 1)` | Entrée décélérée. |
| `easing.exit` | `cubic-bezier(0.3, 0, 1, 1)` | Sortie accélérée. |
| `easing.emphasizedEnter` | `cubic-bezier(0.05, 0.7, 0.1, 1)` | Moment hero rare. |
| `easing.emphasizedExit` | `cubic-bezier(0.3, 0, 0.8, 0.15)` | Sortie d'un hero. |

L'implémentation React Native choisit la représentation compatible. Aucun écran ne copie ces
valeurs inline.

## Profils de ressort

> Amendé A5 · 2026-07-29 — le profil « control » ne peut pas être *proposé* : il **existe** sous le
> nom `motionSemantic.spring` (`packages/tokens/src/index.ts` l. 211), figé à
> `{ damping: 26, stiffness: 300, mass: 1 }`. Il est aujourd'hui défini mais consommé **nulle
> part** — ce qui rend son gel indolore et son respect obligatoire, puisqu'il est la valeur de
> référence annoncée aux nouveaux composants.

| Profil | Statut | Valeur | Usage |
| --- | --- | --- | --- |
| `motionSemantic.spring` | **Livré et gelé** | damping 26, stiffness 300, mass 1 | Bouton, segment, icône, layout transitions standard. C'est le « `spring.control` » de la rédaction initiale ; il ne peut pas être contredit par une table de proposition. |
| `spring.surface` | Ajout **proposé** | stiffness 260, damping 26 | Sheet, carte, toolbar. |
| `spring.hero` | Ajout **proposé** | stiffness 220, damping 22 | Morph Bob ou objet → détail. |
| `spring.gesture` | Ajout **proposé** | Calculé depuis la vélocité | Drag/dismiss/settle. |

Les trois ajouts proposés ne deviennent normatifs qu'après l'ADR runtime, une calibration sur
appareil et un prototype release. Aucun d'eux ne redéfinit `motionSemantic.spring`.

### Ajouts nécessaires au portage de la tab bar

> Ajouté A5 · 2026-07-29. Ces deux ressorts n'existent nulle part et sont exigés par
> [04 § Comportement normatif de la tab bar](04-navigation-scroll-surfaces.md#comportement-normatif-de-la-tab-bar).
> Ce sont des **ajouts** au kit, pas des réglages : ils ne touchent aucune valeur consommée.

| Ajout proposé | Valeur | Pourquoi cette valeur |
| --- | --- | --- |
| `motionSemantic.springMinimize` | `{ duration: 380, dampingRatio: 1 }` | **Critique-amorti**, réservé au repli/dépli de la tab bar, qui anime de la **layout** (`height`, `marginHorizontal`) : ni overshoot, ni queue de stabilisation. Un ressort et non un timing, parce que la direction du scroll s'inverse en permanence et qu'un ressort recible en conservant la vélocité. |
| `motionSemantic.springSlide` | `{ duration: 420, dampingRatio: 0.82 }` | Légèrement **sous-amorti**, réservé au highlight glissant, qui est **transform-only** : le micro-rebond de calage est sans danger puisqu'aucun layout n'est impliqué. |

## Relations et transitions

| Relation | Pattern | Exemple Bob | Reduced Motion |
| --- | --- | --- | --- |
| Même objet | Container transform/zoom. | Client → fiche, document → détail. | Crossfade court ou push natif. |
| Parent → enfant | Push natif/shared axis. | Dossier → document. | Push natif réduit/crossfade système. |
| Création | Modal verticale ou document qui se construit. | Nouveau devis, scan. | Présentation immédiate/fade. |
| Choix temporaire | Sheet depuis le bas. | Filtres, dossier, catalogue. | Apparition immédiate/fade. |
| Destinations sœurs | Fade-through. | Filtres, segments, tabs internes. | Crossfade ou remplacement immédiat. |
| Ancré à un contrôle | Fade + micro-scale depuis l'ancre. | Menu, popover. | Fade seul. |
| Changement de statut | Layout transition + symbole. | Payé, classé, lu. | Couleur/symbole/texte immédiats. |

## Press states

> Amendé A5 · 2026-07-29 — **les valeurs de press sont celles du kit ; ce document ne les modifie
> pas.** La rédaction du 2026-07-23 proposait « scale cible 0,975 » pour le bouton principal et
> « scale cible 0,99 […], jamais 0,94 » pour les cartes/rows, alors que le kit livré vaut
> `BUTTON_PRESSED_SCALE = 0.94` (`packages/ui/src/components/button.logic.ts` l. 46) et
> `PRESSABLE_SCALE_PRESSED = 0.98` / opacité `0.9` / 90 ms in / 150 ms out
> (`pressable-scale.logic.ts`). Écrites telles quelles, ces deux lignes auraient restylé **tous**
> les boutons et **toutes** les lignes de l'app — directive 5 violée. La ligne « jamais 0,94 »
> visait par surcroît exactement la valeur livrée du `Button`.

| Surface | Valeur **livrée**, normative | Source |
| --- | --- | --- |
| Boutons pleins (`Button`, `FAB`) | échelle **0,94**, instantané | `packages/ui/src/components/button.logic.ts` |
| Toute autre surface interactive (`PressableScale`) | échelle **0,98** + opacité **0,9**, **90 ms** in / **150 ms** out | `packages/ui/src/components/pressable-scale.logic.ts` |

Si le 0,94 du `Button` doit un jour être adouci, c'est une PR de tokens/composant distincte avec
son inventaire de consommateurs et son GO — pas une ligne de ce document.

### Bouton principal

- press-in 80 ms (`motionSemantic.feedbackIn`) ;
- **échelle 0,94 — valeur livrée** ;
- légère baisse de luminosité/élévation ;
- release par `motionSemantic.spring` ;
- disabled : aucune compression, contraste accessible ;
- loading : largeur et label stables si possible, indicateur sémantique ;
- success : seulement après événement autoritaire ; icône/texte remplacent le progress ;
- error : retour contrôlé avec message inline, pas de shake prolongé.

### Carte/row

- **échelle 0,98 + opacité 0,9 en 90/150 ms — valeurs livrées** (`PressableScale`) ; une variation
  d'élévation seule reste acceptable là où aucune compression n'est souhaitable ;
- chevron/icône peut avancer de 1–2 dp ;
- aucune haptique sur chaque simple ouverture de row ;
- le press ne doit pas modifier la hauteur ni le scroll.

### Icône seule

- surface tactile ≥ 44 pt iOS et cible Android conforme ;
- feedback porté par la surface entière, pas seulement le glyph ;
- label accessible décrivant le résultat.

## Haptique

| Sémantique | Haptique proposée | Moment exact | Exclusions |
| --- | --- | --- | --- |
| Sélection | `selection` | Segment/chip réellement sélectionné. | Scroll ou survol. |
| Action significative | `impactLight`/`Soft` | Geste accepté localement. | Chaque row fréquente. |
| Succès | `notificationSuccess` | ACK/relecture réussie. | Optimisme non confirmé. |
| Avertissement | `notificationWarning` | État récupérable présenté. | Simple information. |
| Erreur | `notificationError` | Erreur terminale visible. | Retry automatique silencieux. |
| Destructif | `impactMedium` puis confirmation | Après choix explicite, avant ou après selon plateforme. | Jamais sans dialogue/undo requis. |
| Voix | Éventuellement activation/fin | Hors capture si les tests acoustiques l'exigent. | VAD, amplitude, tokens, pulse continu. |

La préférence système et l'indisponibilité matérielle sont toujours respectées. L'information ne
dépend jamais de l'haptique.

## Entrée, sortie et stagger

- Déplacement maximal standard : 6–12 dp.
- Scale standard : 0,985 → 1, jamais zoom marqué sur une liste.
- Stagger : 20–40 ms, maximum 4–6 éléments.
- Aucun stagger sur un refetch, un retour d'onglet ou une longue liste paginée.
- Sortie avant réorganisation ; la liste ne saute pas vers la position finale pendant le fade.
- Le focus accessible suit l'objet logique et non son wrapper animé.

## Layout transitions

Cas obligatoires :

- ajout/suppression de ligne de devis/facture ;
- carte de priorité terminée ;
- notification marquée lue ;
- document classé ou déplacé ;
- message Assistant enrichi ;
- changement de scénario financier ;
- expansion/fermeture d'accordéon ;
- mutation d'un badge/statut.

Garanties : identités stables, animation annulable, position de scroll conservée, focus non perdu,
état final exact et fallback instantané.

## Nombres et graphiques

- L'accessibility value expose immédiatement la valeur finale.
- Le signe, la devise, l'unité et le séparateur ne roulent pas comme des digits décoratifs.
- L'interpolation n'est déclenchée que par une nouvelle révision de donnée ou un nouveau scénario.
- Un retour sur l'onglet ne rejoue pas le graphique.
- L'animation ne traverse pas des valeurs pouvant être interprétées comme réelles.
- Une alternative tabulaire accompagne toute visualisation exploratoire.

## États asynchrones

```text
idle → pending → success
            └→ recoverable_error → pending
            └→ terminal_error
            └→ cancelled
```

- `pending` commence avec l'envoi/acceptation de la commande, pas avec un simple tap décoratif ;
- un timeout est `unknown/recoverable`, jamais succès ou échec irréversible inventé ;
- success transforme le contrôle après ACK/relecture ;
- l'animation success ne retarde pas la navigation demandée ;
- une erreur conserve les données et précise ce qui est sûr.

## Reduced Motion

| Effet nominal | Variante réduite |
| --- | --- |
| Zoom/container | Crossfade ou push système réduit. |
| Slide partagé | Crossfade sans profondeur. |
| Scale press | Variation de couleur/élévation, scale 1. |
| Spring | Timing court ou état final immédiat. |
| Parallax | Aucun ; position fixe. |
| Blur animé | Surface opaque stable. |
| Pulse ambiant | Aucun ; symbole/couleur/texte statiques. |
| Layout transition | Réorganisation immédiate avec annonce ciblée. |
| Waveform Bob | Niveau simplifié ou symbole d'état statique. |

Le changement de préférence pendant l'exécution termine proprement l'animation en cours et place
l'interface dans son état final.

## Budget de concurrence

- Une animation hero maximum.
- Une boucle ambiante maximum dans le viewport.
- Pas plus de 6 entrées stagger simultanées.
- Pas d'animation layout par frame sur une liste entière.
- Bob Live ne doit pas animer plus de 8–12 primitives audio et 2 halos.
- Les animations invisibles sont arrêtées à l'arrière-plan et hors focus.

## Critères d'acceptation

- [ ] Tous les composants utilisent des tokens sémantiques, aucune durée inline non justifiée.
- [ ] Press, loading, success, error et disabled sont filmés et testés.
- [ ] Chaque animation possède une variante Reduced Motion.
- [ ] L'interruption au milieu converge vers l'état correct.
- [ ] Une re-navigation ne rejoue pas les entrées nominales.
- [ ] Focus et position de scroll survivent aux layout transitions.
- [ ] Les haptics sont synchronisées à l'événement réel et absentes quand désactivées.
- [ ] Les montants finaux sont exacts et accessibles pendant l'animation.
- [ ] Le profiling release satisfait les budgets du document performance.
- [ ] **(amendé A5)** Le fallback sans Reanimated ni Zoom reste fonctionnel si le capability check
      échoue. *Glass retiré de cette liste : ce n'est plus une capability du produit — la matière
      est unique et opaque, voir [UX-ADR-004](adr/UX-ADR-004-adaptive-appearance.md).*
- [ ] **(ajouté A5)** Aucun token exporté par `@bob/tokens` n'a changé de valeur ni de sens du fait
      de ce dossier ; tout ajout est nommé, justifié et sans consommateur existant à migrer.
