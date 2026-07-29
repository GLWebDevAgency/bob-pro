# Navigation, scroll et surfaces

> Statut : **Proposed**
> IDs liés : G01, G07, G10, G11, G12, G16, G19, G20
>
> **Amendements 2026-07-29** (le corps daté du 2026-07-23 n'est pas réécrit ; chaque passage
> remplacé reste cité sous « Rédaction initiale ») :
>
> - **A1 · doctrine « matière Bob »** — § Matières. Source : directive du fondateur du 2026-07-29,
>   « Je NE VEUX PAS une UI transparente à la iOS » ; autorité de matière
>   `packages/tokens/src/index.ts` (`surfaceTint`) + `packages/ui/src/components/bob-surface.tsx`.
> - **A2 · retombée de bord `ProgressiveBlurBob`** — § Retombée de bord (nouveau). Source :
>   plan P1 du fondateur `docs/superpowers/plans/beta-fly-services-p1-conception-ecrans.md` §1.3 ;
>   technique étudiée dans `davidmokos/expo-glass-tabs` → `src/progressive-blur.tsx`.
> - **A3 · comportement normatif de la tab bar** — § Tabs (exigences communes l. 85 et 91 amendées)
>   et § Comportement normatif de la tab bar (nouveau). Source : directive du fondateur —
>   « garder notre design system niveau couleur et identité, mais implémenter la même
>   FONCTIONNALITÉ, COMPORTEMENT et EFFET que la tab bar de `davidmokos/expo-glass-tabs` ».

## Objectif

Faire comprendre la relation entre chaque destination tout en conservant Expo Router, les deep
links, les gestes natifs et le fonctionnement existant.

## Taxonomie de présentation

| Intention | Présentation cible | Exemples |
| --- | --- | --- |
| Explorer un objet | Push natif. | Client, chantier, dossier, document, devis, facture. |
| Créer/éditer un flux long | Full-screen modal ou page dédiée. | Devis, facture, scan. |
| Choisir/éditer une tâche courte | Form sheet ou sheet à detents. | Nouveau client, filtres, dossier, catalogue. |
| Afficher une action ancrée | Menu/context menu/popover. | Actions secondaires d'une pièce. |
| Confirmer une conséquence | Dialogue/confirm sheet. | Destruction, émission, abandon de brouillon. |
| Changer de domaine principal | Tab. | Aujourd'hui, Clients, Argent, Documents, Assistant. |

Le type de présentation est choisi selon l'intention, pas selon la taille de l'écran historique.

## Contrat de la Stack

- Conserver Expo Router Native Stack pour les destinations de niveau page.
- Conserver le geste Retour natif lorsqu'il n'expose pas une perte de données.
- Intercepter la fermeture uniquement si un dirty state réel existe.
- Utiliser les headers/toolbar natifs lorsque la composition et la marque le permettent.
- Ne pas remplacer un push natif fonctionnel par une animation JS globale.
- Les transitions custom ne changent ni URL, ni historique, ni restauration.

## Carte de routes cible

| Route actuelle | Relation | Présentation proposée | Source principale |
| --- | --- | --- | --- |
| `(tabs)/index` | Destination racine | Tab, état préservé | Tab bar |
| `(tabs)/clients` | Destination racine | Tab, état préservé | Tab bar |
| `(tabs)/argent` | Destination racine | Tab, état préservé | Tab bar/carte solde |
| `(tabs)/documents` | Destination racine | Tab, état préservé | Tab bar |
| `(tabs)/assistant` | Destination racine | Tab, état préservé | Tab bar/Bob global |
| `client/[id]` | Objet enfant | Push ; zoom optionnel depuis avatar/carte | Clients/recherche |
| `chantiers` | Collection enfant | Push | Client/Today |
| `chantier/[id]` | Objet enfant | Push ; continuité carte/photo | Chantiers/client |
| `documents/folder/[id]` | Conteneur enfant | Push ; continuité tuile | Documents |
| `documents/[id]` | Objet enfant | Push téléphone ; panneau de détail large optionnel ; zoom aperçu progressif | Dossier/recherche |
| `devis/[id]` | Objet métier | Push ; hero document | Ventes/client/Today |
| `facture/[id]` | Objet métier | Push ; hero document | Ventes/client/notif |
| `facture/transmission/[id]` | Étape enfant | Push depuis facture | Détail facture |
| `devis/new` | Création longue | Full-screen modal ; dirty guard | CTA/FAB/client |
| `facture/new` | Création longue | Full-screen modal ; dirty guard | CTA/FAB/devis |
| `scan-document` | Capture immersive | Full-screen modal | Documents/FAB |
| `catalogue` | Collection/édition | Push depuis réglages ; form sheet en sélection | Compte/devis |
| `ventes` | Collection métier | Push ou future destination secondaire | Today/Documents |
| `depenses` | Collection métier | Push | Documents/Argent |
| `comptabilite` | Collection/rapport | Push | Documents/Compte |
| `cloture` | Parcours guidé | Push | Comptabilité/Today |
| `pilotage` | Tableau de bord | Push | Today/Argent |
| `notifications` | Centre d'action | Push téléphone ; popover/panneau large seulement si route et focus restent cohérents | Cloche |
| `recherche` | Recherche globale | Search route/header | Header/raccourci |
| `diagnostic` | Assistant multi-étapes | Full-screen modal | Today/onboarding |
| `onboarding` | Couche hors app | Full-screen, historique contrôlé | Auth Gate |
| `compte` | Réglages racine | Push | Avatar/menu |
| `reglages-facturation` | Réglages enfant | Push | Compte |
| `profil-fiscal` | Réglages guidés | Push/form sheet selon largeur | Compte |
| `auth/callback` | Retour externe | Écran utilitaire terminal | Deep link email |
| `auth/recovery` | Flux sécurisé | Full-screen auth | Deep link |
| `voix` | Compatibilité legacy | Redirect sans frame intermédiaire | Ancien deep link |

Cette table doit être validée route par route avant modification ; elle n'autorise pas une migration
globale automatique.

Ici, un **panneau de détail large** est une composition master-detail iPad/grande fenêtre : la route
reste adressable, le bouton Retour et le focus ont une sémantique définie, et le téléphone conserve
un push standard. Ce n'est ni une carte décorative ni une modalité implicite. Les formulations
alternatives restantes (`push/form sheet`, `search route/header`, renderer tabs) sont des décisions
de `WP-0301`/D02 ; sa route matrix Accepted doit choisir une valeur par classe de largeur et éliminer
le « ou » avant toute migration.

## Tabs

### Exigences communes

- cinq destinations stables ;
- labels toujours présents et non tronqués au format standard ;
- sélection perceptible par couleur, forme et état accessible ;
- retap sur l'onglet actif : retour en haut ou comportement racine défini ;
- état de navigation conservé par tab ;
- badge annoncé avec sa signification ;
- clavier, safe area et rotation testés ;
- aucune animation slide entre tabs sœurs.

### Options à prototyper

1. conserver la pill Bob et ajouter indicateur mobile/haptique ;
2. adopter Native Tabs par plateforme avec tint/roles Bob ;
3. hybride : Native Tabs sur OS compatibles, composant Bob sur fallback.

Le choix final appartient à `UX-ADR-002`. Native Tabs ne doit pas être adopté uniquement pour
obtenir Liquid Glass ; l'identité, l'accessibilité, la restauration et la maturité API priment.

## Headers et StatusBar

| Surface | Header | StatusBar |
| --- | --- | --- |
| Aujourd'hui navy | Hero éditorial, peut se contracter. | Clair. |
| Tab claire | Grand titre puis compact. | Sombre. |
| Détail objet | Titre contextuel, actions toolbar. | Selon fond réellement visible. |
| Full-screen marine | Contrôles clairs et safe area. | Clair. |
| Sheet | Le propriétaire dessous ne change pas arbitrairement de style. | Contraste garanti. |
| Média/caméra | Overlay contrôlé. | Style calculé pour la zone système. |

Un seul owner de StatusBar est actif : route de premier plan ou orchestrateur de chrome. La
transition de style ne précède pas le changement de fond.

## Scroll

- Le contenu utilise les insets automatiques lorsqu'ils correspondent au header natif.
- Le collapse suit le scroll 1:1, sans délai ni interpolation indépendante.
- Le header compact conserve titre et action principale nécessaires.
- Une remontée fait réapparaître le chrome sans voler le scroll.
- Aucun parallax gratuit sur les pages financières/administratives.
- Les listes ne sont pas imbriquées sur le même axe sans justification.
- Un changement de filtre conserve ou réinitialise la position selon une règle explicite.
- Le retap tab remonte la racine ; il ne modifie pas un formulaire en cours.

## Sheets

### Types

| Type | Detents | Usage |
| --- | --- | --- |
| Action courte | Contenu/medium | Source, partage, filtre. |
| Formulaire | Medium/large | Client, dossier, paiement. |
| Sélecteur | Medium/large | Catalogue, destination document. |
| Confirmation | Contenu | Abandon/destruction/conséquence. |

### Contrat

- translation calculée depuis la hauteur réelle ;
- drag lié au doigt et settle depuis vélocité ;
- poignée seulement si la sheet est réellement draggable ;
- titre visible et focus initial cohérent ;
- fermeture VoiceOver/TalkBack et Escape ;
- clavier ne masque jamais le CTA ;
- dismissal bloqué seulement avec dirty state/destruction ;
- une seule sheet visible ;
- scrim animé indépendamment mais synchronisé ;
- Reduce Motion : apparition immédiate/fade, gestes toujours utilisables ;
- fallback natif/custom documenté par plateforme.

## Menus et actions secondaires

- Les actions fréquentes restent visibles.
- Les actions rares se regroupent dans un menu ancré.
- Le menu naît du contrôle touché, sans déplacement du contenu.
- L'ordre privilégie action fréquente, information, puis destruction séparée.
- Une action essentielle n'est jamais disponible uniquement par long press.
- Context menu possède une alternative tap et des labels complets.

## Recherche et clavier

- Le champ devient la surface principale au focus.
- Annuler restaure le contexte et le scroll sans navigation parasite.
- Requête annulable/debouncée ; résultats obsolètes rejetés.
- Recherches récentes locales/tenant-safe selon contrat produit.
- Correspondance soulignée sans dépendre uniquement de la couleur.
- Clavier, autofill, password manager, dictée et lecteur d'écran testés.
- Le bouton retour ferme d'abord le clavier si attendu, puis la route.

## Continuité objet → détail

Éligible : avatar client, tuile dossier, miniature document, carte devis/facture, photo chantier.

Non éligible par défaut : mutation financière, confirmation, écran de paiement, formulaire avec
dirty state, destination dont la source peut disparaître avant le retour.

Le zoom partagé :

- préserve l'objet source et le geste Retour ;
- possède un identifiant stable ;
- tombe sur un push natif si l'API est absente ;
- ne retarde pas la destination ;
- est désactivé en Reduced Motion ;
- est testé après cold start, deep link et retour depuis background.

## Matières

> Amendé A1 · 2026-07-29 — doctrine « matière Bob ». Source : directive du fondateur, « ce n'est
> pas forcément du verre liquide qu'on veut… en gardant NOS couleurs. **Je NE VEUX PAS une UI
> transparente à la iOS.** » Autorité : `packages/tokens/src/index.ts` (`surfaceTint`) et
> `packages/ui/src/components/bob-surface.tsx`.

- **Surface teintée opaque partout, chrome compris.** Contenu, cartes, documents, zones de texte
  longues, **et aussi** tab bar, toolbars et contrôles flottants : `surfaceTint` / `BobSurface`,
  opacités pré-composées en hex. La `BottomTabBar` livrée en est la référence (pilule
  `colors.surface` + `controls.cardBorder` + `shadowNative.e2` + `radius.cardXl`).
- **Seule la RETOMBÉE peut être floutée** : la zone non interactive qui dissout le contenu sous un
  chrome flottant (`ProgressiveBlurBob`, § Retombée de bord). Jamais le fond d'une surface qui
  porte une information.
- **Le verre système n'est pas une option.** Liquid Glass / `expo-glass-effect` impose la teinte du
  système et varie par OS et par version : il ne peut pas porter l'identité Bob. Sa mention dans ce
  dossier sert uniquement à dire qu'on ne l'emploie pas.
- Contraste vérifié sur chaque fond réel, pas sur une maquette unie.
- **Reduce Transparency n'a rien à remplacer** : les surfaces sont déjà opaques. La préférence ne
  déclenche aucun chemin de rendu alternatif, donc aucun chemin non testé.
- Android ancien et iOS non compatible affichent **exactement la même surface** : il n'y a plus de
  fallback de matière, donc plus de divergence fonctionnelle ou esthétique par OS.
- Le blur n'est pas animé, ni en entrée/sortie, ni en Reduced Motion, ni jamais.

> Rédaction initiale 2026-07-23 (supersédée par A1) : « Blur/verre possible pour tab bar, toolbar
> et contrôles flottants » et « Reduce Transparency remplace par une surface opaque sémantique ».
> Ces deux lignes faisaient du verre la matière de premier choix du chrome et de l'opaque un repli.

## Retombée de bord — `ProgressiveBlurBob`

> Ajouté A2 · 2026-07-29. Source normative : plan P1 du fondateur,
> [`beta-fly-services-p1-conception-ecrans.md`](../superpowers/plans/beta-fly-services-p1-conception-ecrans.md)
> §1.3. Technique étudiée dans `davidmokos/expo-glass-tabs` → `src/progressive-blur.tsx` (43 l.),
> présent à l'identique dans `davidmokos/revolut-expo-clone`. Implémentation de référence déjà
> livrée : `patterns.bottomTabBar` (`packages/tokens/src/index.ts`) rendu par
> `packages/ui/src/components/bottom-tab-bar.tsx`.

### Ce que c'est

Un chrome flottant (tab bar, barre d'action de fiche, toolbar de visualiseur) laisse le contenu
défiler **dessous**. Sans traitement, le contenu vient buter sur le bord du chrome et on lit une
ligne de coupe. La **retombée de bord** est la zone qui dissout ce contenu avant qu'il n'atteigne
le chrome. Elle est décorative, non interactive (`pointerEvents="none"`), et ne contient jamais de
texte ni d'information.

### Mode nominal — teinté, sans aucun flou (défaut)

`ProgressiveBlurBob` rend **par défaut** un dégradé de notre couleur de fond, **zéro échantillon de
flou**, en un seul draw call :

| Paramètre | Valeur normative | Source |
| --- | --- | --- |
| Stops de couleur | `['rgba(239,242,247,0)', 'rgba(239,242,247,.92)', '#EFF2F7']` | `patterns.bottomTabBar.fade` |
| Positions | `[0, 0.32, 0.6]` — transparent au sommet, 92 % à 32 %, **opaque dès 60 %** | `patterns.bottomTabBar.fadeLocations` |
| Hauteur totale | `inset de sécurité + hauteur du chrome + 44 pt de débord` | Géométrie de la référence (`BLUR_BLEED`) |
| Ancre | `bottom` pour un chrome bas, `top` pour un chrome haut ; le point opaque est toujours au bord ancré | Référence |
| Interaction | `pointerEvents="none"` | Référence |
| Animation | **jamais animée**, dans aucun mode | Plan P1 §1.3 |

C'est la **même courbe de dissolution** que la référence, mais dans notre couleur, opaque par
construction, sans une seule ligne de noir, et déjà livrée.

### Mode flouté — option bornée, teintée Bob

Réservé aux fonds où une teinte plate ne suffit pas parce que le fond **est une image** : scan,
aperçu de document, visualiseur photo. Jamais sur un fond de l'app.

| Paramètre | Valeur normative | Justification |
| --- | --- | --- |
| Topologie | N couches **frères** dans un même parent — **jamais imbriquées** | La retombée vient de la géométrie, pas d'un masque |
| Profil de hauteurs | `100 / 88 / 76 / 64 / 54 / 44 / 36 / 28 / 22 / 16 %` (tronqué aux N premières) | Profil exact de la référence |
| Intensité par couche | **uniforme et faible** (référence : 5 pour chacune) | L'intensité effective vient du recouvrement, pas d'une rampe |
| Intensité effective | ~5 × N au bord ancré → ~5 à l'extrémité, par marches de 5 | Nombre de couches couvrant le pixel à la distance f du bord |
| N (couches floutées) | **plafonné ; `N = 0` est le défaut** | Chaque couche est un échantillonnage GPU permanent sous scroll |
| Voile | **teinté Bob** — dégradé de notre couleur de fond, aux mêmes stops que le mode nominal | La référence pose `rgba(0,0,0,.70)`, inversion complète d'identité sur notre fond `#EFF2F7` |
| Rendu de couche | **port injecté `renderBlurLayer`** (doctrine `PrefsStorage`) | `@bob/ui` ne prend aucune dépendance ; `expo-blur` reste dans `apps/mobile` |
| Repli | **repli opaque UNIQUE** = le mode nominal | Un seul chemin de secours, donc un seul chemin à tester |

### Quand le repli opaque unique s'applique — sans exception

1. port `renderBlurLayer` absent (cas par défaut de `@bob/ui`) ;
2. **Reduce Transparency actif** ;
3. Android en rendu dégradé ;
4. budget de performance non tenu sur l'appareil médian.

Dans les quatre cas, l'utilisateur voit la **même géométrie, la même courbe et la même couleur** :
seuls les échantillons de flou disparaissent. Aucune information, aucune cible et aucun contraste
ne change.

### Pourquoi notre version est meilleure que son modèle

Le `ProgressiveBlur` de la référence n'écoute **aucune** préférence d'accessibilité. Sous Reduce
Transparency, iOS dégrade chacune de ses dix `UIVisualEffectView` en matériau quasi opaque : la
retombée progressive s'effondre en **dalle dure** et le voile `rgba(0,0,0,.70)` subsiste par-dessus
— un bandeau sombre opaque en pied d'écran. Notre version n'a pas ce problème parce qu'elle **n'a
rien à dégrader** : elle est déjà opaque et déjà dans notre couleur.

### Contradiction levée

Deux documents canoniques posaient « jamais de blur imbriqué »
([09 — Architecture](09-technical-architecture.md), [10 — Performance](10-performance-observability.md))
et semblaient donc interdire la technique prescrite par le plan P1. Vérification faite dans le code
de la référence : les couches sont des **frères** dans un même parent et il n'y a **aucun masque**.
La règle ne visait pas cette technique ; elle était imprécise. Les deux documents ont été amendés
pour distinguer le blur imbriqué (interdit), le blur de fond d'une surface d'information (interdit)
et l'empilement de frères en zone non interactive (autorisé et **borné par un budget**).

## Adaptation tablette

| Domaine | Composition proposée |
| --- | --- |
| Clients | Liste maître + fiche, sélection persistante. |
| Documents | Dossiers/liste + aperçu document. |
| Ventes | Liste + détail pièce ; création centrée/largeur bornée. |
| Assistant | Conversation centrée, panneau de contexte optionnel. |
| Argent/Pilotage | Grille 2 colonnes avec largeur de lecture bornée. |
| Réglages | Sidebar de sections + détail. |

La tablette ne modifie pas les use cases ni les statuts. Une action reste accessible dans les deux
compositions.

## Deep links, restauration et retour

- Chaque route existante conserve son contrat de deep link ou une redirection explicite.
- La restauration ne rejoue pas une animation de succès.
- Un objet absent affiche un état honnête puis une sortie sûre.
- Un formulaire restauré relit sa révision avant de permettre une mutation.
- Le retour ferme menu → sheet → modal → route dans cet ordre logique.
- La route legacy voix ne produit aucune frame blanche ni boucle.

## Critères d'acceptation

- [ ] Route map acceptée et testée avec deep links.
- [ ] Geste Retour natif conservé sur tous les pushes éligibles.
- [ ] Dirty guards empêchent toute perte silencieuse.
- [ ] StatusBar lisible sur le premier, milieu et dernier frame.
- [ ] Sheets testées avec clavier, drag, focus et Reduce Motion.
- [ ] Tabs testées retap, badge, safe area, rotation et restauration.
- [ ] Scroll ne saute pas pendant collapse ou layout transition.
- [ ] Matières possèdent fallback opaque et contraste vérifié.
- [ ] Layouts tablette et split view conservent toutes les actions.
- [ ] Aucune route ne change de sens métier ou de contrat backend.
