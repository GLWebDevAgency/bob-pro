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

## Typographie

### Cible

Supporter les tailles système jusqu'à environ 200 % sur les parcours essentiels, avec un comportement
utile au-delà lorsque la plateforme le permet.

### Règles

- Ne jamais désactiver globalement `allowFontScaling`.
- Pas de hauteur fixe sur un bloc contenant du texte.
- Les labels et CTA peuvent passer sur deux lignes si nécessaire.
- Les nombres restent lisibles ; une devise peut passer sur une ligne secondaire selon composant.
- Les tableaux complexes basculent en cartes ou scroll horizontal explicite avec alternative.
- Le texte secondaire ne devient pas illisible pour préserver une maquette.
- Les poids fins ne sont pas utilisés pour de petits textes.
- Les grands titres peuvent se compacter ou wrapper sans masquer les actions.

## Cibles tactiles

- Minimum produit : 44 × 44 pt sur iOS.
- Android : viser au moins 48 × 48 dp pour les contrôles principaux.
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
| Taille | Petit téléphone, téléphone médian, grand téléphone, tablette/split. |
| Apparence | Light ; Dark uniquement si le contrat complet est accepté. |

## Critères d'acceptation

- [ ] Zéro action essentielle tronquée ou inaccessible à ~200 %.
- [ ] Cibles tactiles mesurées et non chevauchantes.
- [ ] Contrastes vérifiés sur toutes les variantes et matériaux.
- [ ] Chaque information couleur possède une alternative.
- [ ] Reduce Motion et Reduce Transparency sont fonctionnels sur chaque composant animé.
- [ ] Focus correct à l'ouverture, fermeture, erreur et mutation de layout.
- [ ] Les annonces ne spamment pas pendant Bob Live/streaming.
- [ ] Toutes les gestures ont une alternative tap.
- [ ] Les formulaires restent utilisables avec clavier et petit écran.
- [ ] Les layouts tablette ne perdent ni état ni action.
- [ ] Passe manuelle VoiceOver/TalkBack signée sur chaque parcours critique.
