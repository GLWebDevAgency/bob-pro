# Accessibilité et design adaptatif

> Statut : **Proposed — gate bloquante**
> IDs liés : G01, G02, G03, G19, G22, V14 et tous les écrans
>
> **Amendement A1 — 2026-07-29 · doctrine « matière Bob »** — § Reduce Transparency et ligne
> correspondante du tableau des préférences. Source : directive du fondateur du 2026-07-29 ;
> autorité `packages/tokens/src/index.ts` (`surfaceTint`) + `packages/ui/src/components/`
> `bob-surface.tsx`. Aucune exigence d'accessibilité n'est affaiblie : la garantie passe d'un
> fallback à exercer à une propriété structurelle de la matière. Chemins exacts du kit :
> [17 § Autorités normatives](17-references.md#autorités-normatives).
>
> **Amendement A18 — 2026-07-30 · préférences fail-CLOSED au premier rendu** — § Préférences
> d'accessibilité et premier rendu (nouveau), § Modes et préférences à supporter, § Reduced Motion.
> Source : lecture directe de `packages/ui/src/hooks/use-reduce-motion.ts` — la préférence est lue
> de façon **asynchrone** et le hook renvoie `false` au premier rendu. Le dossier prescrivait donc
> implicitement d'animer avant de savoir : un fail-OPEN sur une préférence d'accessibilité.
>
> **Amendement A17 — 2026-07-30 · une zone non interactive ne porte aucune cible** — § Cibles
> tactiles. Source : [04 § Cibles tactiles et Dynamic Type](04-navigation-scroll-surfaces.md#cibles-tactiles-et-dynamic-type).
>
> **Amendement A19 — 2026-07-30 · plancher ≠ hauteur fixe** — § Typographie. Source : même.
>
> **Amendement A13 — 2026-07-29** — § Apparence claire/sombre, prérequis du thème sombre complet.
> La liste exigeait encore de tester le « blur/verre » : A1 a retiré le verre système de la
> doctrine, il n'y a donc rien à tester de ce côté, et cette ligne était le dernier endroit du
> dossier où le terme était **prescrit**. Aucun prérequis n'est retiré : la ligne devient
> `surfaceTint.dark` + retombée de bord + scrims.

## Principe

Une animation ou une composition qui ne fonctionne qu'avec petits textes, couleurs standards,
vision parfaite et mouvement complet n'est pas premium. L'accessibilité est définie avant le
prototype, testée pendant l'implémentation et signée avant rollout.

## Modes et préférences à supporter

| Préférence/capacité | Réponse de Bob |
| --- | --- |
| Dynamic Type / taille police | Layout extensible, wrapping, scroll et priorisation. |
| Bold Text | Aucune troncature ou collision supplémentaire. |
| Increase Contrast | Rôles de contraste renforcés, bordures/symboles visibles. |
| Differentiate Without Color | Icône, texte, forme ou motif en plus de la couleur. |
| Reduce Motion | Suppression du spatial/ambient, crossfade ou instantané. |
| Prefers Cross-Fade | Préférer remplacement par fondu. |
| Reduce Transparency | **(amendé A1)** Sans effet : le chrome est déjà opaque et teinté (`surfaceTint`). Contraste stable par construction. |
| VoiceOver/TalkBack | Sémantique, ordre, focus et annonces dédupliquées. |
| Switch Control/accès moteur | Toutes les actions accessibles sans drag précis. |
| Haptique/son désactivé | Information visuelle et textuelle complète. |
| Économie d'énergie | Effets lourds réduits sans perte fonctionnelle. |

**(ajouté A18 · 2026-07-30)** Chacune de ces préférences a **trois** états, pas deux :
`inconnue`, `active`, `inactive`. Le tableau ci-dessus décrit la réponse quand la valeur est
connue ; § Préférences d'accessibilité et premier rendu décrit la réponse quand elle ne l'est pas
encore.

## Préférences d'accessibilité et premier rendu

> Ajouté A18 · 2026-07-30. Aucune exigence n'est affaiblie ; une **fenêtre d'ignorance** qui était
> tacite devient explicite et se referme du bon côté.

Sur les deux OS, ces préférences se lisent de manière **asynchrone** (`AccessibilityInfo`) : au
tout premier rendu d'un composant, leur valeur n'est pas encore revenue. Un composant qui traite
« pas encore connu » comme « pas de réduction » **anime avant de savoir** — un fail-OPEN sur une
préférence d'accessibilité, c'est-à-dire exactement l'effet que l'utilisateur a demandé à ne pas
subir.

**Règle fail-CLOSED, sans exception.** Tant qu'une préférence d'accessibilité est **inconnue**,
l'interface se comporte comme si elle était **active** :

| Préférence | Comportement pendant l'état `inconnue` |
| --- | --- |
| Reduce Motion | **Durée 0.** Aucune animation d'entrée, de sortie, de layout ni de teinte ; l'élément est rendu **directement dans son état final**. Aucune boucle ambiante n'est démarrée. |
| Reduce Transparency | **Repli opaque unique.** Aucun échantillon de flou n'est monté (§ [04 — Retombée de bord](04-navigation-scroll-surfaces.md#quand-le-repli-opaque-unique-sapplique--sans-exception)). |
| Lecteur d'écran actif | **Comme s'il l'était** : tout détecteur de geste qui consomme les touches d'exploration reste **désactivé** — au premier chef le scrub de la tab bar ([04 § 3](04-navigation-scroll-surfaces.md#3-scrubbing-au-doigt-avec-ticks-haptiques)). Les `Pressable` gardent la main : l'état sûr est aussi l'état accessible. |
| Increase Contrast | **Bordure renforcée.** Elle ne retire aucune information ; l'appliquer à tort est sans danger, ne pas l'appliquer ne l'est pas. |

**Comment on évite le flash inverse.** Fail-closed sans précaution produirait le défaut symétrique :
un élément rendu sans animation, puis ré-animé une fois la valeur revenue. Deux règles l'empêchent :

1. **La lecture est unique et hissée au démarrage.** Les préférences sont résolues **une fois**,
   dans l'adapter de préférences (`apps/mobile/src/experience/accessibility/preferences-adapter.ts`,
   [09 § Arborescence cible](09-technical-architecture.md#arborescence-cible-indicative)), avant le
   premier frame d'interface utile — pendant que l'écran de démarrage est encore affiché — et
   mémorisées. Tout composant monté ensuite reçoit une valeur **synchrone**. La fenêtre `inconnue`
   est donc consommée derrière le splash, là où il n'y a rien à faire clignoter. Un composant animé
   ne lit **jamais** la préférence lui-même : il la reçoit de la politique
   ([09 § Politique motion](09-technical-architecture.md#politique-motion)).
2. **On ne rejoue jamais une animation déjà résolue.** Un élément monté pendant la fenêtre
   `inconnue` est rendu dans son état final et **n'est pas ré-animé** quand la valeur arrive : seules
   les interactions **suivantes** animent. C'est la règle 7 de
   [03](03-motion-interaction-system.md#règles-fondamentales) (« les animations répétitives ne
   rejouent pas au retour sur un écran ») appliquée au démarrage, et le pendant exact de la règle
   déjà écrite pour le changement de préférence en cours d'exécution : on **termine** dans l'état
   final, on ne relance pas.

**Preuve exigée.** Cold start avec Reduce Motion **déjà actif** dans les réglages système, capturé
en vidéo : aucun mouvement entre le premier frame d'interface et l'état stable. Le test symétrique
— cold start sans Reduce Motion — ne doit montrer aucune animation **rejouée** après le premier
frame.

## Typographie

### Cible

Supporter les tailles système jusqu'à environ 200 % sur les parcours essentiels, avec un comportement
utile au-delà lorsque la plateforme le permet.

### Règles

- Ne jamais désactiver globalement `allowFontScaling`.
- Pas de hauteur fixe sur un bloc contenant du texte.
- **(précisé A19 · 2026-07-30)** Une valeur en points posée par une spec sur un bloc de texte est un
  **plancher à la taille de texte standard**, jamais une hauteur figée : la hauteur réelle vaut
  `max(plancher, contenu mesuré)`. Une spécification qui écrit « hauteur 58 pt » et une
  implémentation qui écrit `height: 58` ne disent pas la même chose — la seconde est un défaut. Le
  cas de référence est traité en
  [04 § Cibles tactiles et Dynamic Type](04-navigation-scroll-surfaces.md#cibles-tactiles-et-dynamic-type).
- **(ajouté A19 · 2026-07-30)** `adjustsFontSizeToFit` (et tout rétrécissement automatique
  équivalent) est interdit sur du texte porteur de sens : il annule silencieusement la préférence de
  l'utilisateur au lieu de réagencer le layout.
- **(ajouté A19 · 2026-07-30)** Quand un label ne tient plus, même sur deux lignes, il est **retiré**
  et son sens est porté par `accessibilityLabel` — jamais tronqué. Une ellipse est une perte
  d'information silencieuse ; une icône nommée n'en est pas une.
- Les labels et CTA peuvent passer sur deux lignes si nécessaire.
- Les nombres restent lisibles ; une devise peut passer sur une ligne secondaire selon composant.
- Les tableaux complexes basculent en cartes ou scroll horizontal explicite avec alternative.
- Le texte secondaire ne devient pas illisible pour préserver une maquette.
- Les poids fins ne sont pas utilisés pour de petits textes.
- Les grands titres peuvent se compacter ou wrapper sans masquer les actions.

## Cibles tactiles

- Minimum produit : 44 × 44 pt sur iOS.
- Android : viser au moins 48 × 48 dp pour les contrôles principaux.
- **(ajouté A17 · 2026-07-30)** La cible appartient à l'élément qui **reçoit la touche** —
  `Pressable`, bouton, `Touchable` — et à son `hitSlop`. Une vue `pointerEvents="none"` (dégradé,
  scrim, retombée de bord, halo, ombre) ne reçoit aucune touche : elle ne peut donc **jamais** être
  invoquée pour tenir une cible à 44 pt. Un raisonnement qui adosse une cible à une zone décorative
  est faux même quand les pixels coïncident.
- **(ajouté A17 · 2026-07-30)** Le **visuel** d'un contrôle peut être plus petit que sa cible ; la
  cible ne rétrécit pas avec lui. Quand le visuel descend sous le minimum, le complément vient d'un
  `hitSlop`, et un ancêtre en `overflow: 'hidden'` l'annule sur Android — à vérifier, pas à
  supposer.
- `hitSlop` ne crée pas de zones qui se chevauchent de façon ambiguë.
- Au moins 8–12 dp d'espace entre petites actions selon le contexte.
- Une action drag possède un bouton/menu alternatif.
- Les contrôles denses financiers privilégient la précision et l'espacement.

## Contraste

- Texte normal : viser 4,5:1 minimum.
- Grand texte et éléments graphiques essentiels : 3:1 minimum.
- Focus, sélection, bordure de champ et disabled restent perceptibles.
- Les matériaux sont testés sur le contenu réel derrière.
- Les thèmes de marque conservent les rôles sémantiques.
- Les statuts ne reposent jamais uniquement sur rouge/vert.
- Les graphiques utilisent motifs, symboles, labels ou formes distinctes.

## Apparence claire/sombre

La cible proposée du programme est un **thème adaptatif complet** : semantic colors pour canvas,
content, raised, chrome, sheet, text, border, status et focus. `Force light` est uniquement une gate
transitoire cohérente pour ne pas exposer un pseudo-dark mode pendant la migration. Elle peut
autoriser une release intermédiaire, mais ne ferme ni G02 ni le programme en `Verified`.

UX-ADR-004 doit accepter ou rejeter cette cible avant WP-0101. Une décision de conserver
définitivement le clair forcé serait une modification de cible explicite, avec ADR de supersession,
réévaluation G02 et validation Product/Accessibilité ; elle ne peut pas être déduite du provisoire.

Inacceptable : `userInterfaceStyle: automatic` avec surfaces claires fixes et StatusBar globale
claire. Le thème sombre complet nécessite :

- contrastes recalculés ;
- ombres remplacées/ajustées ;
- images et PDF sur surfaces adaptées ;
- **(amendé A13 · 2026-07-29)** `surfaceTint.dark` vérifié ton par ton, **retombée de bord** et
  scrims testés sur fond sombre ;
- clavier, alertes, modales et status/navigation bar cohérents ;
- captures de chaque route prioritaire.

> *Rédaction initiale 2026-07-23 (supersédée par A13) : « blur/verre et scrims testés ». Le verre
> système n'est pas employé (§ Reduce Transparency, [04 § Matières](04-navigation-scroll-surfaces.md#matières),
> [UX-ADR-004](adr/UX-ADR-004-adaptive-appearance.md)) : il n'y a rien à tester en sombre. Le seul
> flou du produit est celui, optionnel, de la retombée de bord non interactive. La ligne restait
> par ailleurs le dernier endroit du dossier où « verre » était **prescrit** au lieu d'être exclu —
> ce qui rendait fausse l'affirmation du [19 — Glossaire](19-glossary.md).*

## StatusBar et barres système

- Le style dépend de la surface réellement sous la zone système.
- Un seul owner actif.
- Le changement suit le fond, pas le début logique de la navigation.
- Les modales transparentes ne rendent pas la barre illisible.
- Android navigation bar est testée en clair/sombre et gestuel/3 boutons.

## Reduced Motion

### À supprimer

- zoom et scale spatiaux ;
- parallax ;
- grande translation ;
- loops périphériques ;
- blur animé ;
- pulsations continues ;
- rebonds/overshoots importants ;
- stagger de listes.

### À conserver autrement

- état par texte, icône, couleur et épaisseur ;
- focus et sélection ;
- progression réelle ;
- disparition/insertion compréhensible ;
- relation parent/enfant via header/breadcrumb si le zoom est absent ;
- transcript et captions Bob.

**(ajouté A18 · 2026-07-30)** La préférence **inconnue** compte comme active : voir § Préférences
d'accessibilité et premier rendu. Un cold start avec Reduce Motion déjà actif ne montre aucun
mouvement, y compris sur le tout premier frame.

## Reduce Transparency

> Amendé A1 · 2026-07-29 — **doctrine « matière Bob »**. Les surfaces de Bob sont teintées et
> **opaques par construction** (`surfaceTint`, opacités pré-composées en hex ; rendues par
> `BobSurface`). Cette préférence n'a donc **rien à dégrader** : c'est une garantie obtenue par
> l'architecture de matière, pas par un chemin de rendu de secours.

- **Aucune substitution à faire** : la surface affichée est déjà la surface opaque sémantique. Une
  capture avant/après doit être identique au pixel sur le chrome et sur chaque `BobSurface`.
- Cette préférence n'active **aucun chemin de rendu alternatif** — donc aucun chemin qui ne serait
  exercé que par une minorité d'utilisateurs et jamais en QA nominale.
- Maintenir séparation avec bordure/ombre adaptée (inchangé).
- Ne pas modifier la taille ou position des contrôles (inchangé).
- **Seule surface concernée** : la retombée de bord `ProgressiveBlurBob` si elle est un jour
  activée en mode flouté. Sous Reduce Transparency, elle rend son **repli opaque unique** — la
  même retombée teintée, sans échantillon de flou, donc sans changement de géométrie ni de
  lisibilité.
- Ne jamais animer l'activation/désactivation d'un flou.
- Tester pendant changement de préférence si la plateforme le notifie.

> Rédaction initiale 2026-07-23 (précisée par A1) : « Remplacer verre/blur par une couleur opaque
> sémantique ». L'intention est conservée ; ce qui change est qu'il n'y a plus rien à remplacer.

## Lecteurs d'écran

### Ordre et groupes

- L'ordre logique suit titre → statut → contenu → action principale → actions secondaires.
- Une carte composite est groupée seulement si ses sous-actions ne doivent pas être accessibles
  séparément.
- Les montants annoncent devise, signe et contexte.
- Les badges décoratifs n'ajoutent pas de répétition.

### Focus

- Ouverture route : titre ou contenu principal, selon convention plateforme.
- Ouverture sheet : titre/dialogue après disponibilité réelle.
- Fermeture : retour au déclencheur.
- Erreur de formulaire : premier champ invalide et résumé accessible.
- Layout transition : focus reste sur l'objet logique.
- Suppression de l'objet focalisé : focus vers l'élément suivant ou confirmation.

### Annonces

- Statuts majeurs uniquement, dédupliqués.
- Pas d'annonce par frame, token, point de waveform ou progression en pourcentage continu.
- Un message important utilise live region/status sans déplacer le focus.
- Bob Live regroupe le transcript partiel ; la réponse finale est annoncée selon le contrôle du
  lecteur et sans parler par-dessus l'audio de Bob de manière incontrôlée.

## Gestes

| Geste | Alternative obligatoire |
| --- | --- |
| Swipe row | Menu/bouton accessible. |
| Drag sheet | Bouton fermer et detent contrôlable. |
| Pull to refresh | Action rafraîchir ou refresh accessible système. |
| Scrub graphique | Tableau/liste de valeurs. |
| Pinch zoom document | Boutons zoom et plein écran. |
| Long press | Action visible/menu. |
| Barge-in vocal | Bouton Stop/interrompre. |

## Formulaires et clavier

- Labels persistants ; placeholder non utilisé comme seul label.
- Type de clavier, autofill et content type corrects.
- Erreurs proches du champ et résumées.
- Bouton submit visible avec clavier et grandes polices.
- Ordre de focus logique ; Next/Done cohérents.
- Valeurs sensibles ne sont pas annoncées inutilement.
- Password recovery ne révèle pas si un compte existe.
- Dictée et Voice Control ne sont pas bloqués par des contrôles custom.

## Bob Live

- Toutes les phases ont un libellé ; couleur et motion ne suffisent pas.
- Captions/transcript disponibles.
- Stop et continuer en texte accessibles à tout moment sûr.
- Haptique et earcon ont des alternatives.
- Reduced Motion utilise une forme statique.
- Les annonces d'état sont espacées et dédupliquées.
- La transcription ne devient jamais une confirmation implicite.

## Tablette et fenêtres

- Portrait, paysage et split view.
- Largeur de lecture bornée pour les longs textes.
- Master-detail conserve sélection et focus.
- Le passage une colonne ↔ deux colonnes ne perd pas le draft.
- Les modales utilisent une largeur adaptée et ne deviennent pas des feuilles étirées.
- Le clavier matériel et la navigation au focus sont testés lorsque pertinents.

## Matrice minimale de test

| Axe | Valeurs |
| --- | --- |
| Police | Standard, ~150 %, ~200 %, Bold Text. |
| Mouvement | Normal, Reduce Motion, crossfade préféré. |
| Transparence | Normal, Reduce Transparency. |
| Contraste | Standard, Increase Contrast, différenciation sans couleur. |
| Lecteur | VoiceOver iOS, TalkBack Android. |
| Entrée | Touch, Voice Control/dictée, clavier matériel si pertinent. |
| Résolution des préférences **(ajouté A18)** | Préférence déjà active **avant** le cold start ; préférence changée pendant l'exécution. |
| Taille | Petit téléphone, téléphone médian, grand téléphone, tablette/split. |
| Apparence | Light ; Dark uniquement si le contrat complet est accepté. |

## Critères d'acceptation

- [ ] Zéro action essentielle tronquée ou inaccessible à ~200 %.
- [ ] Cibles tactiles mesurées et non chevauchantes.
- [ ] **(ajouté A17)** Aucune cible tactile ne repose sur une vue `pointerEvents="none"` ; chaque
      cible sous-dimensionnée visuellement est complétée par un `hitSlop` non chevauchant.
- [ ] **(ajouté A18)** Cold start avec Reduce Motion, Reduce Transparency et lecteur d'écran
      **déjà actifs** : aucune animation, aucun flou, aucun détecteur de geste au premier frame ;
      aucune animation rejouée après la résolution des préférences.
- [ ] Contrastes vérifiés sur toutes les variantes et matériaux.
- [ ] Chaque information couleur possède une alternative.
- [ ] Reduce Motion et Reduce Transparency sont fonctionnels sur chaque composant animé.
- [ ] Focus correct à l'ouverture, fermeture, erreur et mutation de layout.
- [ ] Les annonces ne spamment pas pendant Bob Live/streaming.
- [ ] Toutes les gestures ont une alternative tap.
- [ ] Les formulaires restent utilisables avec clavier et petit écran.
- [ ] Les layouts tablette ne perdent ni état ni action.
- [ ] Passe manuelle VoiceOver/TalkBack signée sur chaque parcours critique.
