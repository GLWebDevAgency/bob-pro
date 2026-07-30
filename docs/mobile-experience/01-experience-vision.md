# Vision de l'expérience mobile Bob

> Statut : **Proposed**
> Ambition : une expérience calme, précise, propriétaire et immédiatement compréhensible
>
> **Amendement A1 — 2026-07-29 · doctrine « matière Bob »** — § Architecture de profondeur et
> § Anti-patterns. Source : directive du fondateur du 2026-07-29 ; autorité de matière
> `packages/tokens/src/index.ts` (`surfaceTint`) + `packages/ui/src/components/bob-surface.tsx`.
> Les huit principes, la personnalité visuelle, les moments de delight et la définition
> d'« Apple-grade » sont inchangés.

## Promesse

Bob doit donner la sensation d'un bureau opérationnel qui se réorganise autour du travail réel de
l'utilisateur. L'application n'est pas un tableau de bord décoratif ni un chatbot ajouté à une
suite de formulaires. Chaque objet conserve sa place, chaque action montre sa causalité et Bob
reste le même copilote dans toutes les surfaces.

## Les huit principes Bob

### 1. Le travail avant l'interface

La première information répond à : « Que dois-je faire maintenant ? ». Les preuves, détails
comptables et explications techniques restent disponibles, mais n'occupent pas le premier plan.

### 2. La vérité avant le spectacle

Une animation ne prétend jamais que Bob écoute, calcule, classe ou a terminé si l'état canonique ne
le prouve pas. Une progression indéterminée est présentée comme telle.

### 3. La continuité avant la nouveauté

Lorsqu'une carte devient un détail, un document rejoint un dossier ou une action devient une
confirmation, l'objet se transforme. Il ne disparaît pas pour être remplacé par un écran sans lien.

### 4. Le contrôle avant l'automatisme

Les transitions sont interruptibles, les gestes suivent le doigt, les actions réversibles proposent
Undo et les actions sensibles conservent leurs confirmations existantes.

### 5. Le calme avant la décoration

Une page possède au maximum une chorégraphie dominante. Les boucles ambiantes sont réservées à un
état réellement actif et disparaissent en Reduce Motion.

### 6. Le natif avant l'imitation

Bob utilise les conventions de navigation, de scroll, de modalité et d'accessibilité de la
plateforme. La marque s'exprime dans les tokens, le contenu et les moments signature, pas dans la
réinvention de tous les contrôles système.

### 7. La souplesse avant le pixel figé

Le pixel-perfect signifie cohérence des relations, alignements et rythmes, pas hauteur fixe. Les
contenus doivent survivre aux grands textes, petits écrans, tablettes, traductions futures et modes
système.

### 8. Le delight comme conséquence

Le plaisir vient d'une action comprise et bien résolue : une priorité se replie, un document se
range, Bob répond immédiatement. Il ne vient pas de confettis ou de rebonds systématiques.

## Personnalité visuelle à préserver

| Élément | Contrat |
| --- | --- |
| Marine | Contexte, confiance et enveloppe de marque ; pas un fond universel. |
| Indigo IA | Bob, raisonnement et proposition ; ne remplace pas les statuts métier. |
| Vert | Succès durable et argent positif ; jamais simple état `speaking`. |
| Ambre | Attention ou récupération ; pas une erreur fatale. |
| Rouge | Danger, échec ou irréversible ; toujours accompagné d'un texte ou symbole. |
| Surfaces chaudes | Contenu et documents ; opacité et lisibilité prioritaires. |
| Schibsted | Titres, montants, nombres et moments éditoriaux. |
| Hanken | Texte, contrôles, légendes et conversation. |
| Ombres bleutées | Profondeur sobre ; jamais un halo gris générique. |
| Squircle/cartes | Conteneurs de travail ; rayons selon la hiérarchie, pas au hasard. |

## Architecture de profondeur

L'interface comporte trois plans visuels :

1. **Contenu** : cartes, documents, listes et données ; opaques.
2. **Action** : CTA, sélection, composer, toolbar et contrôles contextuels ; opaques.
3. **Navigation** : headers, tab bar, sheets et overlays ; opaques.

> Amendé A1 · 2026-07-29 — **doctrine « matière Bob »**. Source : directive du fondateur du
> 2026-07-29, « ce n'est pas forcément du verre liquide qu'on veut… en gardant NOS couleurs.
> **Je NE VEUX PAS une UI transparente à la iOS.** »

Les trois plans se distinguent par la **teinte, l'élévation et la bordure**, pas par la
transparence. La matière de Bob est la **surface teintée opaque** : `surfaceTint` (2 apparences ×
6 tons × `flat`/`raised`/`border`/`ink`/`inkMuted`, opacités pré-composées en hex) rendue par
`BobSurface`. Elle vaut pour les trois plans, chrome compris.

> **(précisé A23 · 2026-07-30)** `ink`/`inkMuted` appartiennent à la **table de tokens**, pas au
> composant : `BobSurface` pose le fond, la bordure et l'ombre, et laisse la couleur du texte à
> l'appelant. La lisibilité d'une surface teintée est donc une propriété du **couple** texte/fond,
> vérifiée au point d'usage — voir
> [UX-ADR-004 § Ce que `BobSurface` ne fait PAS](adr/UX-ADR-004-adaptive-appearance.md#ce-que-bobsurface-ne-fait-pas--ink-et-highcontrast-ne-se-propagent-pas).

Une seule chose peut être floutée : la **retombée de bord**, cette zone non interactive qui dissout
le contenu qui passe sous un chrome flottant — et son mode par défaut est lui aussi **sans flou**,
en dégradé de notre couleur de fond. Le verre système (Liquid Glass) n'est pas employé : il impose
la teinte de l'OS au moment précis où Bob doit affirmer la sienne, et il change d'aspect selon la
version du système.

Ce que la règle historique voulait protéger reste vrai et se dit mieux : appliquer une matière
translucide aux cartes de contenu détruirait la hiérarchie et affaiblirait le contraste.

> Rédaction initiale 2026-07-23 (supersédée par A1) : « Le verre ou le blur appartiennent aux
> plans 2 et 3 » ; le plan Navigation « peut utiliser une matière adaptative ».

## Hiérarchie type d'un écran

1. Contexte stable : titre, période, identité ou objet courant.
2. Conclusion métier : statut ou décision principale.
3. Action principale : une seule, dépendante du statut réel.
4. Actions secondaires : regroupées, menu ou toolbar.
5. Détails et preuves : repliables ou accessibles par drill-down.
6. Historique : après la décision, jamais avant.

Les pages financières et administratives utilisent davantage la révélation progressive que les
pages de consultation courtes.

## Signature Bob Live

Bob Live doit être reconnu sans texte, sans reproduire un assistant existant :

- un ruban ou une membrane indigo/lavande ;
- une géométrie stable qui se transforme plutôt que plusieurs composants sans parenté ;
- une amplitude audio réelle, lissée et contenue ;
- des directions différentes pour écouter et parler ;
- un noyau calme pour réfléchir ;
- des libellés d'état vrais et une transcription visible ;
- un retour immédiat vers l'écoute lors d'un barge-in.

La signature doit pouvoir se réduire à une icône, devenir une capsule, puis une carte, en conservant
la même identité.

## Motion : rôles narratifs

| Rôle | Question à laquelle le mouvement répond |
| --- | --- |
| Causalité | Qu'est-ce que mon geste vient de provoquer ? |
| Continuité | Où est passé l'objet que je regardais ? |
| Statut | L'action démarre-t-elle, progresse-t-elle, réussit-elle ou échoue-t-elle ? |
| Priorité | Où dois-je regarder maintenant ? |
| Relation | Ce contenu est-il parent, enfant, frère ou overlay ? |
| Personnalité | Est-ce un moment Bob, métier, succès ou avertissement ? |

Tout mouvement qui ne répond à aucune de ces questions est présumé décoratif et doit être retiré
ou justifié.

## Densité et rythme

- Rythme vertical basé sur les tokens existants, avec plus d'air autour de la décision principale.
- Une carte ne contient pas simultanément une explication, quatre CTA, une timeline et des preuves.
- Les listes répétitives privilégient la densité et la vitesse ; pas d'entrée animée à chaque
  retour.
- Les écrans de création utilisent une progression visible, mais évitent les steps purement
  administratifs.
- Les tableaux de bord animent le changement de donnée, jamais le simple retour sur l'onglet.

## Moments de delight autorisés

| Moment | Traitement |
| --- | --- |
| Priorité terminée | Check bref, repli, réorganisation et confirmation sobre. |
| Document classé | Relocalisation vers le dossier et compteur mis à jour. |
| Devis/facture créé | Brouillon qui devient feuille de document. |
| Diagnostic terminé | Progression qui devient score, puis priorités révélées. |
| Bob activé | Morph unique depuis le contrôle touché. |
| Bob interrompu | Retournement immédiat de la forme vers l'écoute. |
| Dossier comptable prêt | Scellement sobre et export, sans confettis. |

## Anti-patterns

- Glassmorphism sur toutes les cartes.
- **(ajouté A1 · 2026-07-29)** Verre système (Liquid Glass / `expo-glass-effect`) sur le chrome :
  il remplace notre teinte par celle de l'OS.
- **(ajouté A1 · 2026-07-29)** Une matière choisie par capability runtime : deux apparences à
  concevoir, à mesurer et à certifier pour un seul produit.
- Parallax décoratif sur les pages métier.
- Compteurs animés à chaque ouverture d'onglet.
- Typewriter lettre par lettre pour les réponses Bob.
- Skeleton permanent ou shimmer agressif.
- Même pulse pour écouter, réfléchir et parler.
- Rouge seul pour signaler une erreur.
- Shake important sur un formulaire financier.
- Haptique à chaque scroll, VAD, token ou frame.
- Navigation custom qui casse le geste Retour système.
- Shared-element expérimental sur un flux financier critique sans fallback.
- Animation qui retarde un résultat, empêche un tap ou masque une erreur.
- Texte technique exposant réconciliation, idempotence ou révision serveur au premier niveau.

## Définition qualitative d'« Apple-grade » pour Bob

Une fonctionnalité n'est pas premium parce qu'elle utilise du verre ou un ressort. Elle l'est si :

- le but est compris avant l'effet ;
- la réponse au toucher est immédiate ;
- la transition respecte la relation entre les objets ;
- l'utilisateur peut l'interrompre ou revenir ;
- l'état visible est vrai ;
- les grands textes et préférences système fonctionnent ;
- le rendu reste fluide sur l'appareil cible médian ;
- la marque Bob reste reconnaissable ;
- les détails ne créent aucune dette fonctionnelle ou backend.
