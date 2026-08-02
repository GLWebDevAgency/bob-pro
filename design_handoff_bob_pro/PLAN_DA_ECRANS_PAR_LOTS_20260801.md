# Plan DA — écrans par lots (01/08/2026)
**Mandat fondateur** : « tout l'aspect visuel, ultra poussé, ultra expert, pixel perfect, direction artistique de dingue, ultra clean. »
Produit par l'étude workflow `etude-da-ecrans-par-lots` (39 écrans inventoriés, 5 auditeurs DA parallèles, synthèse directeur de création). **Lecture seule — aucune implémentation dans ce document.** L'implémentation démarre lot par lot après observation fondateur de la tab bar (APK preview du 01/08).
## Décision fondateur requise (UNE seule)
- **Facture/new : afficher le TTC dans la barre sticky** — seul ajout d'information visible du plan sous feature freeze (donnée déjà calculée `totals.ttc`). Tout le reste est à iso-information et iso-comportement. **GO / NO-GO ?**
## Top 3 des coups de maître
- 1. LE VOILE V2 SUR LES DEUX HEADERS DU CŒUR QUOTIDIEN (Lot 1) — un seul mécanisme kit (ProgressiveBlurBob en variantes AppHeaderNavy + InnerScreenHeader, fail-closed opaque) et la FloatingBalanceCard devient réellement flottante sur l'écran ouvert chaque matin, pendant que 7 écrans intérieurs héritent de la signature sans une ligne d'écran. Zéro comportement modifié, fallback opaque par défaut, port injecté déjà testé en hostile : le ratio émerveillement/risque maximal du plan, et c'est la PREMIÈRE chose que le fondateur verra.
- 2. « BOB LIT TON DOCUMENT » SCÉNARISÉ (Lot 2) — PaperThumb unifie la matière papier sur les 4 écrans du coffre, MotionPresence enchaîne les cartes d'état du scan en narration continue, et la ligne de scan indigo devient irréprochable dès sa première frame (3 états de préférence, unknown = rien). C'est LE moment démo signature du produit — celui que le fondateur montre — porté par l'extinction legacy qui apporte gratuitement press-scale et cibles 44 aux deux écrans les plus en retard.
- 3. LE FIL ROUGE « COULEUR DE L'ARGENT » (Lot 4) — la teinte du standing (vert à jour / ambre en attente / rouge en retard) suit l'artisan du carnet (rangée) à la fiche (héros BobSurface, encours en MoneyText teinté) jusqu'au geste (StickyActionBar floating au liseré du même token : « Relancer F-2024-018 · 2 400 € » souligné rouge). Même dérivation deriveCustomerStandings, zéro logique nouvelle, primitives existantes — la signature fintech de Bob Pro, lisible au soleil, gants aux mains, sans copier personne.

## Arbitrages de direction de création (tranchés)
- SÉLECTION — contradiction inter-lots tranchée : le Lot 2 proposait semantic.ai pour les sélections (feuille Déplacer, feuille Transfert, ChoiceChip) et le Lot 4 proposait successBg+CheckIcon (pickRow contrat/new). Décision : sélection utilisateur = theme.ink (fond teinté 8-10 % + CheckIcon + bord ink) PARTOUT ; l'indigo reste le canal EXCLUSIF de Bob (doctrine du Lot 3, la plus forte du corpus) et le vert reste la récompense du geste commis. Les interventions L2/L4 concernées sont réécrites en ce sens.
- GOUTTIÈRE — contradiction L2 vs L3 : L2 demande 18→20 (aligné sur InnerScreenHeader), L3 qualifie ventes.tsx (20) de « divergent du reste (18) ». Tranché : 20 est le canon — le kit fait autorité et InnerScreenHeader pose ses textes à 20 ; ce sont les écrans à 18 qui migrent, lot par lot quand on les touche, jamais en passe globale. Le verdict L3 sur ventes est inversé : ventes avait raison.
- FAIL-CLOSED MOTION — 4 audits (L1, L2, L4, L5) signalaient chacun « useReduceMotion démarre à false » écran par écran. Tranché : UNE correction kit en Lot 0 — useReduceMotion devient fail-closed (préférence non résolue = pas d'animation) et useReduceMotionPreference (PreferenceState 3 états, déjà écrit pour la tab bar dans packages/ui/src/hooks/use-accessibility-preference.ts) est exposé pour les cas fins (ligne de scan). Coût assumé : première frame sans animation pour tous — c'est précisément la doctrine tab bar v2.
- GRAMMAIRE D'ERREUR — contradiction L2 (Toast→ErrorNotice) vs L5 (Toast 2 faces). Tranché par une grammaire unique : Toast tone success/danger = feedback éphémère NON actionnable ; ErrorSheet promu @bob/ui (portant ErrorNotice 2 faces + corrélation) = tout échec de mutation appelable au support ; ErrorNotice inline = erreurs persistantes d'écran/formulaire ; ErrorRetry = sous-sections. Corollaires : plus JAMAIS Alert.alert « Oups » (doctrine DocumentActions), plus jamais de CheckIcon vert sur un échec (comptabilite, depenses).
- STICKY BARS — 3 primitives demandées (StickyActionBar L3, StickyCtaBar L4, StickyBackRow L5). Fusion : UNE StickyActionBar à 2 variantes — 'bar' (surface + borderTop lineSoft, slots montant/CTA : facture/new, PieceDetailView) et 'floating' (aplat ink e3, liseré accent sémantique, apparition FadeIn fail-closed : client/[id]) ; StickyBackRow reste distincte (haut d'écran, Lot 5) mais partage le MÊME mécanisme de voile que les headers.
- HEADERS — 4 composants en circulation (InnerScreenHeader kit, screen-header local, BackHeader proposé, rangée retour sticky ad hoc). Tranché : pas de composant nouveau — screen-header.tsx local est PROMU @bob/ui comme BackHeader canonique (absorbe les 3 duplications de documents/[id], chantiers, ventes, scan) ; le voile ProgressiveBlurBob est UN mécanisme kit unique monté en variantes sur AppHeaderNavy, InnerScreenHeader et StickyBackRow.
- BADGE « LE SOLDE MENT » — ni 'particulier' (constat L1) ni 'warning' (proposition L1). Tranché : variant 'ai' — c'est Bob qui pédagogise (philosophie papa vocal, « Bob traduit le jargon »), warning reste réservé à l'actionnable ; le variant StatusBadge 'ai' est de toute façon REQUIS par la table de mapping legacy (le tone 'ai' de ventes/DocumentActions n'a pas d'équivalent aujourd'hui).
- TYPO — la proposition L1 d'« ajouter les crans manquants » est bornée : AUCUNE demi-taille tokenisée (11.5/12.5/13.5/14.5/15.5 s'arrondissent au cran existant selon le rôle) ; seuls 3 crans nouveaux entrent à l'échelle : sheetTitle 20/700 (8 recompositions inline), wizardTitle 24/700 (3 occurrences facture/new + devis/new plus tard), héros money ~27/800 via variant MoneyText (pilotage 26, depenses 27). Protéger l'échelle vaut mieux que la documenter en dérive.
- EXTINCTION LEGACY — le grep révèle 10 importateurs de src/components/ui, dont 4 non cités par les audits (argent.tsx, clients.tsx, index.tsx, client/[id].tsx via imports résiduels, + src/documents/document-insight-card.tsx) et surtout assistant.tsx (lane GPT). Objectif reformulé : « zéro importateur HORS lane GPT » à la fin du Lot 3 (jalon), chaque lot purgeant ses propres écrans ; la suppression PHYSIQUE de src/components/ui/index.tsx attend la restitution d'assistant.tsx.
- ORDRE L2 AVANT L3 — la fréquentation cumulée de L3 est légèrement supérieure (somme des inverses de rangs 0.53 vs 0.44) mais L2 passe d'abord : séquence nominale d'extinction (partie 1 → partie 2), et le risque supérieur de L3 (table de mapping badge, flux TVA QuestionSheet, DocumentActions rendu DANS les cartes) profite du retour d'expérience de la migration L2 (documents/[id] + scan). Le jalon « plus aucun importateur nôtre » clôt L3.
- LOT 0 MINIMAL — la « liste unique à construire d'abord » est tiérée : seules les fondations TRANSVERSES (tokens, doctrine motion/erreur, primitives consommées par ≥ 2 lots) se construisent en Lot 0 ; les primitives mono-lot se construisent en PREMIER COMMIT de leur lot consommateur. Préserve « lots mergeables indépendamment » et évite un Lot 0 tunnel invisible pour le fondateur.
- FACTURE/NEW « TTC DANS LA STICKY » — retenu mais suspendu à un GO fondateur explicite : c'est le seul ajout d'INFORMATION visible du plan sous feature freeze (donnée déjà calculée, totals.ttc). Tout le reste du plan est à iso-information et iso-comportement.
- BARRE LIVRÉE vs PORTÉE (PERF-13) — l'intervention L1 « porter les raffinements » est bornée : uniquement les statiques (géométrie/teinte déjà validées par bob-tab-bar.logic) sur packages/ui/src/components/bottom-tab-bar.tsx ; _layout.tsx sanctuarisé (zéro style) ; tout comportement attend le flag. La comparaison ON/OFF « même commit » reste intacte.
- TONS RECYCLÉS — journaux comptables en 'particulier'/'b2g', catégories de dépense en tons client, tuile documents en 'success', accent diagnostic emprunté à vault.scanChipIcon : tranché par des rôles tokens DÉDIÉS créés en Lot 0 (journaux, catégories, tone 'document' neutre, themes.indigo.accent). L'intérim « b2g » proposé par L5 pour la tuile document est REFUSÉ : un alias de typologie client en cacherait un autre.
- DEUX CORRECTIONS DE COMPORTEMENT ACCEPTÉES SOUS FREEZE — (1) contrat/new états manquants clients/chantiers (Skeleton+ErrorRetry) : application de la doctrine P0 « une source absente n'est jamais une collection vide », additif de rendu pur ; (2) chantier/[id].tsx l.113 personality:'pote' hardcodée dans t() : bug de voix (la personnalité choisie est écrasée), correction, pas une feature. Le catch manquant de deletePersistedDraft (ventes) entre dans la même catégorie.
- ÉCRANS NON AUDITÉS HORS LANE — notifications.tsx, compte.tsx, reglages-facturation.tsx, profil-fiscal.tsx, diagnostic-technique.tsx et src/screens (auth) ne sont couverts par aucun des 5 lots : ils ne sont PAS exclus pour cause de lane, simplement hors périmètre des audits — à traiter dans une vague ultérieure après restitution GPT, avec le kit alors complet (coût marginal minimal).

## Lot 0 — fondations kit & doctrine (transverses uniquement)
- [Lot 0 — tokens] Échelle d'espacement @bob/tokens `spacing` (gutter:20, sectionGap:20, itemGap:12, intraGap:14, cardPad:16, heroPad:20) — remplace les littéraux 10/11/13/14/18/20/22 des 5 lots ; la gouttière canonique est 20 (celle d'InnerScreenHeader)
- [Lot 0 — tokens] 3 crans typographiques : sheetTitle (20/700), wizardTitle (24/700), variant héros de MoneyText (~27/800 tabular) — AUCUNE demi-taille tokenisée (arbitrage) ; les 11.5/12.5/13.5/14.5/15.5 s'arrondissent au cran existant
- [Lot 0 — tokens] Encres AA sur fond pastel : semantic.warningInk / semantic.successInk (patron pieceDetail.creditInk généralisé) — consommées par StatusStrip, checklist transmission, facture/[id]
- [Lot 0 — tokens] Rôles couleur dédiés : journaux comptables (ventes/achats/banque/OD), catégories de dépense, IconTile tone 'document' (neutre), themes.indigo.accent (remplace l'emprunt vault.scanChipIcon) — fin du recyclage des tons de typologie client
- [Lot 0 — tokens] overlays.photoScrim (noir ≈ .92) + rôle « chrome sur scrim » + rôles texte AA on-dark (corps ≥ white80, détail ≥ white70) dans la famille overlays existante (index.ts l.354)
- [Lot 0 — tokens] +2 teintes vault dossiers (6 distinctes pour 6 dossiers système) + util PURE `folderTintFor({ id, systemKey })` : `systemKey` porte l'identité métier des dossiers système, `id` est haché uniquement pour les dossiers personnalisés (hash stable sur la palette — logique testable par mutants)
- [Lot 0 — doctrine] Fail-closed motion généralisé : useReduceMotion (packages/ui/src/hooks/use-reduce-motion.ts) passe fail-closed + réexport public de useReduceMotionPreference (PreferenceState, déjà écrit dans use-accessibility-preference.ts) + resolveScanReadingMotion étendu à 3 états (unknown/reduced/full) — corrige en un commit les premières frames de L1/L2/L4/L5
- [Lot 0 — doctrine] Grammaire d'erreur : ErrorSheet promu de apps/mobile/src/components/ErrorSheet.tsx vers @bob/ui (porte ErrorNotice 2 faces ; QuestionSheet y est déjà) + Toast tone success/danger + face sombre d'ErrorNotice (pour diagnostic)
- [Lot 0 — doctrine] StatusBadge variant 'ai' + table de correspondance officielle BadgeTone legacy → StatusBadgeVariant (dont tone 'ai' → 'ai') — FIGÉE avant toute migration, testée unitairement
- [Lot 0 — transversal] Voile « header veil » ProgressiveBlurBob : mécanisme UNIQUE (port injecté, préférence transparence/motion inconnue = voile plat opaque) décliné en variantes AppHeaderNavy, InnerScreenHeader, StickyBackRow
- [Lot 0 — transversal] BackHeader : promotion kit du screen-header local (retour 44 pt + titre + sous-titre) — consommateurs : documents/[id] (3 duplications), folder/[id], scan-document, chantiers, ventes
- [Lot 0 — transversal] StickyActionBar 2 variantes : 'bar' (surface + borderTop, slots montant/CTA — facture/new, PieceDetailView) et 'floating' (aplat ink e3 + liseré accent sémantique + FadeIn fail-closed — client/[id]) [fusion StickyCtaBar/StickyActionBar]
- [Lot 0 — transversal] StickyBackRow (fond patterns fade[1] + voile optionnel, cible 44 pt) — pilotage, comptabilite, cloture, depenses, recherche
- [Lot 0 — transversal] StatusStrip (icône + fond sémantique pastel + encre foncée AA) — résorbe 6 duplications : PieceDetailView deposit/progress/paidDone, facture/[id] ×3, transmission ×2
- [Lot 0 — transversal] SearchField (surface + e1 + loupe + bouton clear 44 pt) — clients, equipements/[chantierId], recherche
- [Lot 0 — transversal] FormField + DateField (label visible persistant + input tokenisé + slot erreur danger ; masque AAAA-MM-JJ purement visuel) — equipements, equipement/[id], contrat/new, feuille période facture/[id]
- [Lot 0 — transversal] HeaderIconButton (squircle 44×44, radius 13 — arbitrage entre le squircle 42 de clients et le rond 44 de chantiers)
- [Lot 1 — 1er commit] États loading/failed intégrés à FloatingBalanceCard et HeroMoneyCard + presets SkeletonKpiTile/SkeletonPriorityCard + variantes skeleton/empty de MoneyRow + DeadlineRow + TipCard/coach-mark + clés i18n tabs.* (5 labels × 4 personnalités)
- [Lot 2 — 1er commit] PaperThumb (vault.thumb*/reader*, tailles 46×58 et 120×154) + VaultRow + FolderTile + AiHintRow + MetricChip + SuccessBanner + RadioRow + ChoiceChip + KeyValueRow unifiée avec InfoRow
- [Lot 3 — 1er commit] FilterChip (croix, état actif, cible 44) + PieceListRow + QuotePreviewBox
- [Lot 4 — 1er commit] ClientRow v2 (slots nameAccessory + statusWord) + PhotoViewer (photoScrim, chrome, gaté reduce-motion) + icône crayon dans icons.tsx + BobSwitch (track/thumb tokenisés)
- [Lot 5 — 1er commit] TrendBars (barres animées fail-closed, état final identique) + GlassPanelDark (white07/white10/radius 18) + Button slot icône leading
- [REPORTÉ — lane GPT] WizardHeader (retour · badge · croix) : partagé avec devis/new.tsx qui est dans la lane GPT — le token wizardTitle est créé en Lot 0, l'extraction du composant attend la restitution de la lane

## Lots ordonnés

### Lot 0 — Fondations kit & doctrine (invisible, mergeable seul, débloque tout)
Écrans/fichiers : `packages/tokens/src/index.ts`, `packages/ui/src/hooks/use-reduce-motion.ts + use-accessibility-preference.ts (réexport)`, `packages/ui/src/components (error-sheet promu, toast, status-badge, veil, back-header, sticky-action-bar, sticky-back-row, status-strip, search-field, form-field, header-icon-button)`, `apps/mobile/src/components/ErrorSheet.tsx et screen-header.tsx (sources de promotion, dépréciés en réexports)`
Commits estimés : ~7

**Interventions**
- `packages/tokens/src/index.ts` — Ajouter en 2 commits : échelle spacing (gutter 20 canonique), crans sheetTitle/wizardTitle/héros MoneyText, encres warningInk/successInk, rôles journaux + catégories dépense + tone 'document' + indigo.accent, overlays.photoScrim + rôles AA on-dark, +2 teintes vault + util pure `folderTintFor({ id, systemKey })`.
  - Pourquoi : Toutes les décisions de langage (espace, typo, couleur) se figent AVANT que les écrans ne bougent — c'est ce qui empêche les 5 lots de re-négocier chacun leur canon.
  - Risque : bas — additif pur, aucun consommateur encore
- `packages/ui/src/hooks/use-reduce-motion.ts + resolveScanReadingMotion` — Basculer useReduceMotion en fail-closed (préférence non résolue = pas d'animation), exposer publiquement useReduceMotionPreference (3 états), étendre resolveScanReadingMotion à unknown/reduced/full.
  - Pourquoi : Une seule correction kit remplace les 5 corrections d'écran demandées par les audits ; la doctrine tab bar v2 (unknown = rien d'animé) devient la loi de TOUTE l'app dès le premier merge.
  - Risque : moyen — change la première frame de tous les consommateurs existants (au pire : une animation en moins) ; vérifier les tests motion existants
- `packages/ui (error-sheet, toast, error-notice, status-badge)` — Promouvoir ErrorSheet (portant ErrorNotice 2 faces), donner un tone success/danger à Toast, créer la face sombre d'ErrorNotice, ajouter le variant 'ai' à StatusBadge + table de mapping BadgeTone→variant testée.
  - Pourquoi : La grammaire d'erreur unique et la table de mapping doivent exister avant les extinctions legacy des lots 1-3 — sinon chaque migration improvise son équivalence.
  - Risque : bas — composants nouveaux ou additifs, mapping couvert par tests unitaires
- `packages/ui (progressive-blur veil + back-header + sticky-action-bar + sticky-back-row + status-strip + search-field + form-field + header-icon-button)` — Construire les 8 primitives transversales : voile header unique (variantes AppHeaderNavy/InnerScreenHeader/StickyBackRow), BackHeader promu du screen-header local, StickyActionBar 2 variantes, StickyBackRow, StatusStrip, SearchField, FormField/DateField, HeaderIconButton.
  - Pourquoi : Chacune est consommée par au moins 2 lots ; les construire une fois avec logique pure extraite (testable) évite 6 duplications de StatusStrip, 5 de StickyBackRow, 3 de BackHeader, 3 de SearchField.
  - Risque : bas — aucune adoption d'écran dans ce lot, rendu validé par stories/tests de rendu

**Critères de preuve**
- Zéro changement visuel attendu sur l'app : captures avant/après identiques (seule tolérance : premières frames sans animation, à démontrer en vidéo reduce-motion ON/OFF/unknown)
- Mutants sur la logique pure : folderTintFor (stabilité du hash), mapping BadgeTone→variant (exhaustivité des tones), resolveScanReadingMotion 3 états, logique des variantes StickyActionBar
- Tests de rendu des nouvelles primitives dans les 4 personnalités/thèmes + face sombre ErrorNotice
- Voile : préférence transparence inconnue ⇒ aplat opaque (test hostile, patron progressive-blur-bob.hostile.test.tsx existant)
- Rituel repo : tsc -p complet (tests inclus) + pnpm lint + suite mobile verte
- Tab bar flag OFF : arbre strictement identique (test bottom-tab-bar existant vert)

### Lot 1 — Cœur quotidien (Accueil + Argent + chrome) — fréquentation maximale, la matière v2 devient visible
Écrans/fichiers : `apps/mobile/app/(tabs)/index.tsx`, `apps/mobile/app/(tabs)/argent.tsx`, `apps/mobile/app/(tabs)/_layout.tsx`, `packages/ui/src/components/app-header-navy.tsx + inner-screen-header.tsx (montée du voile)`, `packages/ui/src/components/bottom-tab-bar.tsx (statiques seulement)`
Commits estimés : ~9

**Interventions**
- `packages/ui — 1er commit du lot` — Construire les primitives mono-lot : états loading/failed de FloatingBalanceCard et HeroMoneyCard, SkeletonKpiTile/SkeletonPriorityCard, MoneyRow skeleton/empty, DeadlineRow, TipCard, clés i18n tabs.*.
  - Pourquoi : Les gabarits de chargement vivent dans le kit à côté des composants qu'ils miment : plus jamais de saut skeleton→contenu à la première retouche de padding.
  - Risque : bas
- `app-header-navy.tsx (kit) puis index.tsx l.1124-1149` — Monter le voile ProgressiveBlurBob v2 en pied d'AppHeaderNavy (variante kit du Lot 0) ; le contenu défile sous le voile teinté navy, fallback opaque fail-closed.
  - Pourquoi : Le geste signature : la FloatingBalanceCard qui chevauche devient réellement flottante sur une matière vivante — l'écran ouvert chaque matin passe de « propre » à « direction artistique ».
  - Risque : moyen — rendu double plateforme à valider, comportement inchangé
- `inner-screen-header.tsx (kit) puis argent.tsx l.824-828 et l.888-892` — Monter le même voile sur InnerScreenHeader — les 7 écrans consommateurs héritent de la signature sans une ligne d'écran.
  - Pourquoi : Un seul point de montée dans le kit propage la matière v2 à tout le niveau intérieur ; pendant que Bob parle, le titre reste lisible au-dessus du contenu qui fond.
  - Risque : moyen
- `index.tsx l.84 + l.406/444/496/544/711, l.755-771, l.230-285` — Extinction locale : 5 Badge legacy → StatusBadge (mapping Lot 0), Pressable corbeille → DeleteIconButton kit (flux ConfirmSheet+busy conservé), HeroPlaceholder → état loading intégré de FloatingBalanceCard, purge de l'import src/components/ui.
  - Pourquoi : Une seule table chromatique dans la pile de priorités et fin de la géométrie du héros dupliquée écran/kit.
  - Risque : bas
- `index.tsx l.1195-1201, l.1355-1362, littéraux d'espacement` — ErrorNotice 2 faces sur l'erreur d'écran (CTA retry conservé, ErrorRetry reste pour les sous-sections), footer slate300 → slate500 AA, espacement sur tokens spacing (gouttière 20).
  - Pourquoi : Sur l'écran le plus vu, une erreur sans corrélation est un ticket support aveugle ; le footer signature doit se lire au soleil.
  - Risque : bas
- `argent.tsx — passe transversale (15+ overrides fontSize, marginTop erratiques, FadeIn index 3→5)` — Résorber les demi-tailles sur les crans existants (arbitrage : aucun cran nouveau hors sheetTitle), rythme vertical sur intraGap 14 / sectionGap 20, cascade FadeIn réindexée 0-4 sans trou.
  - Pourquoi : Quinze demi-tailles ad hoc = plus d'échelle ; le scroll long est LE geste de cet écran, un rythme régulier sépare « propre » de « DA ».
  - Risque : moyen — passe volumineuse, purement visuelle, à relire capture par capture
- `argent.tsx l.135-381 (sous-cartes ad hoc) + l.1105-1121 + a11y l.186/263/1296-1308` — HeroPlaceholder/EmptyMoneyRow/Skeleton* → états kit (−150 lignes) ; badge « LE SOLDE MENT » → variant 'ai' (arbitrage : Bob pédagogise) ; labels distincts des 2 SegmentedControl (« Horizon » / « Scénario ») ; labels honnêtes « non renseigné » + explain/confidence sur FiscalDeadlineRow.
  - Pourquoi : Le message-signature de l'écran doit porter la voix de Bob, pas un ton clientèle ; deux contrôles indiscernables au lecteur d'écran sur LA carte financière est une faute à coût nul.
  - Risque : bas
- `(tabs)/_layout.tsx l.57-63 + l.173-177` — Labels des 5 onglets via t() tabs.*, options.title dérivées d'ITEMS (source unique) ; AUCUN style dans ce fichier (sanctuarisé, levier rollback PERF-13).
  - Pourquoi : La voix de Bob ne doit pas s'arrêter à la tab bar ; chaînes identiques au premier jour = zéro changement visible.
  - Risque : bas
- `packages/ui/src/components/bottom-tab-bar.tsx (barre LIVRÉE)` — Porter uniquement les raffinements STATIQUES déjà validés sur la portée (géométrie/teinte de bob-tab-bar.logic) — rien d'animé, rien de comportemental.
  - Pourquoi : Moins l'ON/OFF de PERF-13 diffère cosmétiquement, plus l'expérience mesurera les comportements et non le maquillage.
  - Risque : moyen — borné aux statiques, comparaison même-commit préservée

**Critères de preuve**
- Captures avant/après iPhone SE / 15 Pro / Pro Max + Android petit/grand, 4 personnalités sur l'accueil
- Vidéo de scroll continu : voile progressif sous les deux headers, rythme vertical régulier, cascade FadeIn 0-4 sans trou de 40 ms
- reduce-motion ON et préférence NON RÉSOLUE : première frame sans aucune animation (corbeille sans scale, cascade coupée) — vidéo des 3 états
- reduce-transparency ON : voile = aplat opaque, contraste titre intact (capture)
- Dynamic Type XL/XXXL sur le héros (HERO.numberSize) et les KPI — aucun débordement
- VoiceOver : deux SegmentedControl distincts, « non renseigné » au lieu du tiret, explain + « à confirmer » annoncés
- Contraste mesuré ≥ 4.5:1 sur footer et compteurs
- Enregistrement skeleton→contenu : zéro saut de layout
- Flag mobile_tabs_experiment_v1 OFF : arbre identique (test existant) ; captures barre livrée avant/après raffinements statiques
- tsc complet + pnpm lint + suite mobile verte (rituel)

### Lot 2 — Coffre & scan (extinction legacy partie 1, signature « papier »)
Écrans/fichiers : `apps/mobile/app/(tabs)/documents.tsx`, `apps/mobile/app/documents/[id].tsx`, `apps/mobile/app/documents/folder/[id].tsx`, `apps/mobile/app/scan-document.tsx`, `apps/mobile/src/documents/document-insight-card.tsx (importateur legacy oublié des audits)`
Commits estimés : ~10

**Interventions**
- `packages/ui — 1er commit du lot` — Construire : PaperThumb (46×58 / 120×154), VaultRow, FolderTile, AiHintRow, MetricChip, SuccessBanner, RadioRow, ChoiceChip, KeyValueRow unifiée avec InfoRow.
  - Pourquoi : La matière « papier » du coffre devient une primitive identitaire au lieu de trois copies (DocThumb, ScanReadingCard, aperçu non-image) ; AiHintRow incarne la voix de Bob dupliquée 3× dans PendingCard.
  - Risque : bas
- `documents/[id].tsx l.51 + scan-document.tsx l.65 + src/documents/document-insight-card.tsx` — Extinction : bascule complète sur @bob/ui (Button avec press scale + minHeight 44, Card, StatusBadge via mapping), fontWeight/uppercase inline → font(key,weight)/Eyebrow, chaînes en dur → t().
  - Pourquoi : Les 2 plus gros consommateurs legacy s'éteignent + un importateur non audité découvert au grep ; le Button legacy sans retour de pression est une faute tactile pour un artisan ganté.
  - Risque : moyen — swap de bordures/radius à valider visuellement carte par carte
- `documents/[id].tsx l.938-939, folder/[id].tsx l.629-637, scan-document.tsx l.1806-1807` — Règle sélection unifiée : les 3 sélections peintes en semantic.success passent en theme.ink teinté + CheckIcon (ARBITRAGE — pas semantic.ai proposé par l'audit : l'indigo reste à Bob).
  - Pourquoi : Le vert prématuré banalise la vraie confirmation ; l'indigo dévoyé diluerait le canal exclusif de Bob — la couleur redevient une promesse.
  - Risque : bas
- `documents.tsx l.1068-1139, gouttières 18, l.252-1506 (slate300 <13px), press states hétérogènes` — SectionHeader kit ×2, gouttière 18→20 (token), métadonnées small → slate500, tous les press states → PressableScale, micro-rythme PendingCard 12/13/14 → intraGap.
  - Pourquoi : Le bord gauche cesse de zigzaguer de 2 px entre titre et cartes ; « il y a 2 h » redevient lisible au soleil ; un seul langage de pression.
  - Risque : bas
- `documents.tsx l.131-141 + l.806-820, folder/[id].tsx l.796-801` — 6 teintes distinctes pour les dossiers système via leur `systemKey` + `folderTintFor({ id, systemKey })` (Lot 0) pour les personnalisés, teinte d'identité propagée aux sous-dossiers (FolderRow).
  - Pourquoi : La couleur-repère doit coder l'identité (retrouver « Assurances » d'un coup d'œil) et survivre à la navigation dans l'arborescence.
  - Risque : bas
- `documents.tsx l.571-575/599-602/670/750, folder/[id].tsx l.649-651, scan-document.tsx l.1419-1461` — Grammaire d'erreur : échecs de mutation (classement, confirmation, export FEC, suppression, réconciliation unresolved/stale/rejected) → ErrorSheet kit avec face développeur/corrélation ; Toast réservé aux succès.
  - Pourquoi : Ce sont exactement les erreurs où l'artisan appelle le support depuis le chantier — la face partage-sans-PII est faite pour ça.
  - Risque : moyen — contenant différent, mêmes déclencheurs, à tester sur les enchaînements de feuilles
- `scan-document.tsx l.1682-1713 + l.1746-1762` — Ligne de scan sur useReduceMotionPreference 3 états (unknown = pulse/statique, sweep seulement si préférence résolue à false) ; glow Android : elevation → halo dégradé dessiné (vault.scanLineGlow → transparent).
  - Pourquoi : Doctrine fail-closed jusque dans la première frame du geste le plus scénarisé ; l'ombre grise Android était l'inverse de l'effet lumière voulu.
  - Risque : bas
- `scan-document.tsx l.974-1216 et l.1278-1394, documents/[id].tsx l.786-838` — MotionPresence/MorphReplace sur la pile de cartes d'état du scan et l'accordéon Traçabilité (chevron en rotation) ; émojis/signes texte → SparkSmallIcon/CheckIcon teintés avec importantForAccessibility no.
  - Pourquoi : « Bob lit ton document » devient une narration continue au lieu de pops secs ; l'étincelle IA doit être LE glyphe indigo du système, pas un caractère OS-dépendant verbalisé par VoiceOver.
  - Risque : moyen — préserver les live regions et l'ordre des annonces
- `documents/[id].tsx l.332-504 + Ionicons ×12, l.575-591 ; folder/[id].tsx l.775-840, l.426, l.519-676` — BackHeader kit sur les 3 rendus, Ionicons → icons.tsx, aperçu non-image → PaperThumb, radius 17 → radius.card via VaultRow, FadeIn sections 0/1/2, Eyebrow + sheetTitle, carte garantie → patron monthReady adouci.
  - Pourquoi : Deux familles d'icônes = deux graisses de trait à l'écran ; l'écran d'UN document est le seul du coffre sans la matière papier ; la réassurance ne doit pas crier.
  - Risque : bas

**Critères de preuve**
- Captures 3 tailles × 2 OS sur les 4 écrans + capture superposée bord gauche (gouttière 20 alignée header/cartes)
- Vidéo des 3 états de préférence motion sur la ligne de scan : unknown = JAMAIS de balayage (mutants sur resolveScanReadingMotion 3 états)
- Vidéo du parcours scan complet : transitions MotionPresence, reduce-motion = coupes sèches actuelles
- VoiceOver : plus aucun émoji verbalisé, MetricChip groupé, annonces de classement préservées
- Contraste mesuré sur horodatages/compteurs/sous-titres (≥ 4.5:1)
- grep : zéro import src/components/ui sur les 4 écrans + document-insight-card
- Capture Android du halo de scan (aucune ombre grise)
- Mutants sur folderTintFor (6 dossiers système distincts, stabilité du hash personnalisé)
- tsc complet + pnpm lint + suite mobile verte

### Lot 3 — Ventes & pièces (extinction legacy partie 2, StatusStrip, l'indigo rendu à Bob)
Écrans/fichiers : `apps/mobile/app/ventes.tsx`, `apps/mobile/app/devis/[id].tsx`, `apps/mobile/app/facture/[id].tsx`, `apps/mobile/app/facture/new.tsx`, `apps/mobile/app/facture/transmission/[id].tsx`, `apps/mobile/src/components/DocumentActions.tsx`, `apps/mobile/src/components/PieceDetailView.tsx`
Commits estimés : ~9

**Interventions**
- `packages/ui — 1er commit du lot` — Construire FilterChip (croix, actif, cible 44), PieceListRow, QuotePreviewBox.
  - Pourquoi : ActiveFilterChip/DateRangeChips/chips d'autocomplete dupliquent le motif ; la rangée de pièce resservira à la recherche.
  - Risque : bas
- `ventes.tsx:14 + DocumentActions.tsx:34 (migration dans le MÊME commit)` — Extinction : Card/Badge/MoneyText/SectionHeader/font → @bob/ui avec la table de mapping figée en Lot 0 (tone 'ai' → variant 'ai') ; QuoteActions/InvoiceActions rendent DANS les mêmes cartes, migration atomique.
  - Pourquoi : Dernier gros consommateur : jalon « zéro importateur hors lane GPT » atteint à la fin de ce lot (assistant.tsx, lane GPT, reste le seul — suppression physique du kit local reportée à la restitution).
  - Risque : moyen — QUOTE_BADGE/INVOICE_BADGE typés sur BadgeTone et testés ; la table de mapping est déjà figée et testée
- `ventes.tsx:449-531, 55-93, 744-767, 882-934` — Purge de l'indigo dévoyé : kindFilter → SegmentedControl kit sélection theme.ink (state ventes.filterKind STRICTEMENT conservé — parité vocale), bouton filtres actifs → ink, chips liées ≥ 28 pt + hitSlop 44 + fontSize 12 + PressableScale, FilterChip kit.
  - Pourquoi : L'indigo redevient le canal exclusif « Bob agit » que toute l'app construit ; des cibles de navigation à 24 pt sont infranchissables avec des gants.
  - Risque : moyen — vérifier accessibilityState selected → sémantique radiogroup du SegmentedControl
- `ventes.tsx:415-432, 643-684, 720/849, 119-137` — Header → BackHeader kit + i18n « Devis & Factures » ; carte brouillon : « Reprendre » → Button kit, poubelle → DeleteIconButton ; FadeIn de bloc → StaggeredList par carte ; catch sur deletePersistedDraft → ErrorSheet (jamais un échec muet).
  - Pourquoi : Le CTA le plus chaud de l'écran mérite le press feedback standard ; un échec réseau de suppression ne produit RIEN aujourd'hui — trou dans un système d'états par ailleurs exemplaire.
  - Risque : moyen pour le catch (comportement visible ajouté, cadré correction d'état)
- `devis/[id].tsx:37+721-729, 354-374, 225/296/339, 746 ; PieceDetailView.tsx:426-441, 155` — Badge → StatusBadge 'warning' (casse au composant) ; Alert TVA 3 boutons → QuestionSheet kit + LegalHint (les 3 branches runDuplicate STRICTEMENT identiques, couvertes par le test duplicate existant) ; Alerts « Oups » → ErrorSheet ; aperçu relance → QuotePreviewBox ; croix Fermer 38→44 ; LinkedCard → PressableScale.
  - Pourquoi : La pédagogie légale au point de décision est impossible dans un Alert système ; une carte de navigation qui ne répond pas au doigt paraît cassée (partagé avec facture/[id], double dividende).
  - Risque : moyen — flux TVA critique, verrouillé par le test existant
- `facture/[id].tsx:613-648, 720-725, ~15 overrides typo, 871-905, 191-538, 611-845` — dueLine/emailSentLine/neverTransmitted → StatusStrip (« jamais transmise » en TÊTE de colonne, ambre) ; relance « en attente » b2b → neutral ; purge fontSize inline sur les crans ; feuille période → FormField (label visible) ; Alerts → ErrorSheet ; FadeIn sur extra (parité devis/[id]).
  - Pourquoi : « Émise mais jamais transmise » est LE risque cash — il doit dominer visuellement ; l'artisan doit voir la même grammaire d'état du devis au dépôt.
  - Risque : bas à moyen (Alerts)
- `facture/new.tsx:857-872, 975-987, 449-460, 400/586/812, 990-1011` — Récap : montant NET de ligne (même formule que l'étape 2 — la vérité visuelle somme vers le total) ; guardMsg/serverError → ErrorNotice 2 faces (rôle alert/liveRegion porté) ; borderWidth constant 2 (fin du saut d'1 px) ; fontSize 24 → wizardTitle ; TTC dans la sticky (StickyActionBar 'bar') — SUSPENDU à un GO fondateur explicite.
  - Pourquoi : Au moment de confirmer, des montants de ligne qui ne somment pas vers le total attaquent la confiance — et la confiance dans les chiffres est le produit.
  - Risque : bas (récap/bordure) à moyen (sticky TTC, gate fondateur)
- `transmission/[id].tsx:176-179, 185-230, 276-315, 139-332, 107-116` — useBobAwareScrollInsets (les CTA restent atteignables pendant que Bob guide le dépôt Chorus) ; checklist « à faire soi-même » : semantic.ai → neutral + encres AA + 12 px ; « Déposée/Acceptée le » → StatusStrip avec check ; StaggeredList d'entrée ; skeleton 3 cartes fidèle.
  - Pourquoi : Papa vocal : le suivi en 2 taps pendant le guidage vocal est le scénario nominal ; l'indigo disait « Bob s'en occupe » là où c'est précisément ce que Bob ne fait pas.
  - Risque : bas

**Critères de preuve**
- Captures de la chaîne complète devis → facture → transmission : la MÊME grammaire StatusStrip de l'acompte au dépôt Chorus (planche comparative)
- Test duplicate TVA existant vert — les 3 branches runDuplicate byte-identiques (revue de diff)
- VoiceOver : flux TVA dans QuestionSheet lisible avec LegalHint, radiogroup du kindFilter annoncé
- Parité vocale : ventes.filterKind piloté à la voix produit le même state qu'avant (test existant)
- Cibles mesurées : chips liées ≥ 28 pt + hitSlop 44, croix PieceDetailView 44
- Orbe Bob actif : boutons « Marquer déposée » atteignables (capture avec GlobalBobAccess ouvert)
- grep : zéro import src/components/ui hors assistant.tsx (jalon d'extinction documenté)
- Mutants sur la table BadgeTone→variant (déjà en Lot 0, re-exécutés ici)
- reduce-motion : cascades = 0, aucune animation première frame
- tsc complet + pnpm lint + tests quote-invoice-actions.logic verts

### Lot 4 — Clients, chantiers & équipements (CRM terrain, fil rouge « couleur de l'argent »)
Écrans/fichiers : `apps/mobile/app/(tabs)/clients.tsx`, `apps/mobile/app/client/[id].tsx`, `apps/mobile/app/chantiers.tsx`, `apps/mobile/app/chantier/[id].tsx`, `apps/mobile/app/equipements/[chantierId].tsx`, `apps/mobile/app/equipement/[id].tsx`, `apps/mobile/app/contrat/[id].tsx`, `apps/mobile/app/contrat/new.tsx`
Commits estimés : ~11

**Interventions**
- `packages/ui + src/components/icons.tsx — 1er commit du lot` — Construire ClientRow v2 (slots nameAccessory/statusWord), PhotoViewer (photoScrim + chrome-sur-scrim, gaté reduce-motion), icône crayon, BobSwitch.
  - Pourquoi : La seule primitive CRM du kit était inutilisée faute de slots ; la visionneuse devient réutilisable (documents, scan) au lieu d'une poche de hex.
  - Risque : bas
- `clients.tsx:255-320, 314, 284-291, 208-239, 146-175` — CustomerRowCard → ClientRow v2 kit (−60 lignes) ; statusWord slate300/11 → slate400/11.5 ; press → PressableScale ; SearchField kit ; « + » → HeaderIconButton (géométrie unifiée avec chantiers).
  - Pourquoi : Le kit fait autorité sur le seul écran fait pour ClientRow ; le mot de statut doit se lire au soleil.
  - Risque : bas
- `client/[id].tsx:1113-1143, 215-283, 1612-1640, 1294-1606, 999-1025, 1766-1798, métas 11` — Héros sur BobSurface marine raised (nom en pageTitle, encours en MoneyText teinté par le standing) ; ActionTile→QuickAction, KpiCell→KpiTile ; CTA sticky → StickyActionBar 'floating' avec liseré de la MÊME teinte sémantique que le standing (fil rouge couleur de l'argent, dérivation deriveCustomerStandings inchangée) ; FadeIn au changement d'onglet ; « … » → crayon ; erreurs de Sheet → ErrorNotice ; métas ≥ 11.5.
  - Pourquoi : La teinte du standing survit du carnet au geste : montant de rangée, KPI et CTA partagent exactement le même token — l'artisan suit la couleur de son argent d'un coup d'œil.
  - Risque : moyen — le plus gros écran du lot, purement présentational, zéro logique nouvelle
- `chantiers.tsx:149-197, 267-303, 299, 271` — Bloc retour + InnerScreenHeader → BackHeader kit (fin du sur-espace, retour device fondateur) ; StaggeredList ; PressableScale ; chevron → controls.chevron ; accessibilityLabel enrichi (statut, date, compteurs).
  - Pourquoi : Deux listes sœurs du CRM : l'une respire, l'autre était inerte ; l'œil voit quatre faits, le lecteur d'écran n'en entendait qu'un.
  - Risque : bas
- `chantier/[id].tsx:785-823, 113, 395-691, 784, 373-392, 531-535, 520` — Visionneuse → PhotoViewer tokenisé (dernière violation zéro-hex du lot) ; BUG personality:'pote' hardcodée → personality de useTheme (correction voix sous freeze) ; 5 titres maison → SectionHeader + marginTop 28 ; Modal gaté reduce-motion ; héros → BobSurface marine (parité fiche équipement) ; upload en tuile fantôme visible ; grille photos en points numériques.
  - Pourquoi : L'utilisateur en personnalité « pro » entendait la voix « pote » sur chaque miniature ; sur un chantier en 3G, l'artisan doit voir que Bob travaille sans re-taper.
  - Risque : bas à moyen (héros)
- `equipements/[chantierId].tsx:390-423, 285-315, 318-319 ; equipement/[id].tsx:366-399, 111-119, 97-104, 254-270, 503-507` — FormField ×7 (labels visibles persistants) + DateField ; draftError/editError → semantic.danger + role alert ; SearchField kit ; « Actifs · 3 » ; Alerts reopen/retire/reactivate → ErrorSheet ; rangée 3 boutons → primaire pleine largeur + 2 secondaires ; dots timeline teintés par type d'entrée (statusBadgeColors) ; entry.status → i18n.
  - Pourquoi : Sept champs anonymes dès la première lettre, hostiles aux gants et aux interruptions ; l'historique — LA valeur de l'écran — devient scannable par couleur.
  - Risque : moyen (FormField et rangée d'actions changent la silhouette du formulaire)
- `contrat/[id].tsx:500-504/604/692, 543-568, 536, 1008-1012` — sectionTitle maison → Eyebrow kit (l'étalon ne réinvente pas le kit) ; liens '›' texte → ChevronRightIcon + PressableScale + vraie structure row/gap ; MorphReplace sur le badge de statut (parité fiche équipement, reduce-motion = bascule + annonce existante) ; terminateError → danger + alert ; totalPerYear en MoneyText.
  - Pourquoi : Après « Résilier », le badge doit morpher sous les yeux ; résilier est le geste le plus grave de la fiche, son erreur ne peut pas chuchoter.
  - Risque : bas
- `contrat/new.tsx:85-86+247-275, 210-229, 314-326, 379-383, 436-440, 247-434` — États manquants : customers/chantiers isPending → SkeletonRow ×3, isError → ErrorRetry (doctrine « jamais une collection vide », additif pur) ; pickRow sélectionné → teinte INK + CheckIcon (ARBITRAGE : pas successBg proposé par l'audit) ; '✕' → DeleteIconButton ; Switch → BobSwitch tokenisé ; erreurs → danger + alert ; titre d'étape (stepLabels en section/700) + FadeIn entre étapes.
  - Pourquoi : Une liste de clients vide par erreur réseau était indistinguable d'un carnet sans client pro ; le vert-sélection aurait recréé la faute purgée aux lots 2-3.
  - Risque : bas

**Critères de preuve**
- Planche « couleur de l'argent » : capture triple carnet → fiche → CTA montrant le MÊME token sémantique du standing (vert/ambre/rouge) aux trois niveaux
- Mutants sur la dérivation standing → teinte (logique pure extraite pour la StickyActionBar floating)
- Test unitaire : PhotoThumbnail utilise la personality du thème (bug 'pote' verrouillé)
- reduce-motion : visionneuse sans fade (Modal animationType 'none'), MorphReplace = bascule sèche + annonce, FadeIn onglets = 0
- Dynamic Type XL/XXXL : rangée d'actions équipement (primaire pleine largeur) et FormField sans troncature
- VoiceOver : labels chantiers enrichis (statut/date/compteurs), timeline équipement en phrases i18n, crayon annoncé « Modifier » ET dessiné crayon
- Contraste mesuré : statusWord, erreurs danger, métas ≥ 11.5
- Captures 3 tailles × 2 OS des 8 écrans, héros BobSurface alignés sur les étalons contrat/équipement
- grep : zéro hex sur chantier/[id] (visionneuse tokenisée)
- tsc complet + pnpm lint + suite mobile verte

### Lot 5 — Pilotage, compta & recherche (la matière argent unifiée, dataviz vivante)
Écrans/fichiers : `apps/mobile/app/pilotage.tsx`, `apps/mobile/app/comptabilite.tsx`, `apps/mobile/app/cloture.tsx`, `apps/mobile/app/diagnostic.tsx`, `apps/mobile/app/recherche.tsx`, `apps/mobile/app/depenses.tsx`
Commits estimés : ~10

**Interventions**
- `packages/ui — 1er commit du lot` — Construire TrendBars (largeur animée 0→n%, 400 ms ease-out, PreferenceState unknown = statique, état final identique), GlassPanelDark (white07/white10/radius 18), Button slot icône leading.
  - Pourquoi : La seule dataviz de l'app mérite d'entrer au kit avec le fail-closed par construction ; la matière verre sombre vivait en triple copie.
  - Risque : bas
- `pilotage.tsx:411-449, 279-298+378-389, 656-668, 421/528/556, 735-753, 397-681` — Carte Mois en cours → héros matière (recette HeroMoneyCard, encaissé en MoneyText héros) ; SeriesBars/barres de part → TrendBars ; badge « ! » 'particulier' → 'warning' avec label textuel « Risque » ; formatEUR inline → MoneyText ; rangée retour → StickyBackRow 44 pt + voile ; Text nus → EmptyState ×3.
  - Pourquoi : La revue business met le chiffre-héros dans une matière dédiée et des barres qui poussent — la signature motion des meilleures fintechs, éteinte par construction sous reduce-motion.
  - Risque : bas
- `comptabilite.tsx:499-504+176, 455-477, 415-450, 63-68, 191-213, 418-437` — Toast tone danger sur exportError (fin de la coche verte sur un échec — le seul vrai mensonge visuel du lot) ; carte Clôture → PressableScale ; StaggeredList écritures ; JOURNAL_TONE → rôles journaux dédiés (Lot 0) ; StickyBackRow ; carte écriture groupée accessible (une phrase VoiceOver).
  - Pourquoi : Une coche verte qui annonce un échec d'export comptable est l'antithèse de la confiance fintech ; « particulier » doit cesser de signifier « journal achats ».
  - Risque : bas
- `cloture.tsx:717-768, 204-230, 240-263, 532-559, 383-791, 311-329` — Les 2 CTA artisanaux → Button kit avec slot icône (parité disabled/loading : sendingDossier, exportFec.isPending vérifiée) ; Alerts « Oups » → ErrorSheet, avertissements FEC → Sheet listée ; CheckRow pressed ; colonnes balance → flexBasis+minWidth (Dynamic Type) ; StaggeredList ; StickyBackRow.
  - Pourquoi : L'envoi au comptable est le moment le plus anxiogène : la voix et la matière de Bob doivent y survivre, pas l'alerte système grise.
  - Risque : moyen — parité d'états des CTA et enchaînement partage→alerte à tester
- `diagnostic.tsx:708-1039, 903, 258/579/697, 690-1027, 614-1083, 149-215, 265` — Panneaux verre → GlassPanelDark ×3 ; fade-through des phases intro/steps/result (MorphReplace, announceForAccessibility et focus PRÉSERVÉS) ; rôles AA on-dark (détails ≥ white70, corps ≥ white80) ; accent → themes.indigo.accent (fin de l'emprunt vault.scanChipIcon) ; scale pressed manuels → PressableScale ; ProgressBar/count-up sur PreferenceState strict ; chevron on-dark.
  - Pourquoi : Le flux le plus narratif changeait de scène par coupure sèche et empruntait son accent au coffre ; 12 px à 55 % d'opacité sur indigo échoue l'AA plein soleil.
  - Risque : moyen — les transitions de phase ne doivent pas casser les annonces (test dédié)
- `recherche.tsx:72-84, 295-410, 398, 236-249, 55-101` — accessibilityLabel des ResultRow composés (titre + meta + montant : « FA-2026-012, Mairie de Lyon, 1 250 € ») ; FadeIn borné des sections à l'arrivée des résultats ; tuile documents 'success' → tone 'document' neutre (Lot 0) ; bouton clear 44 pt ; évaluer la promotion de ResultRow au kit.
  - Pourquoi : Papa vocal : un résultat doit se comprendre à l'oreille sans regarder l'écran ; le vert reste réservé à l'argent.
  - Risque : bas
- `depenses.tsx:418-459, 390-467, 218/233, 469-476, 489-701, 319-346` — Mini-stats fond lineSoft → KpiTile kit ; héros teinté par l'état (voile warningBg si dette > 0, neutre/success à zéro — pendant « sortant » du vert comptable) ; Toast tone danger sur les erreurs chantier ; EmptyState ; StaggeredList + MorphReplace sur le passage payé (tester l'aller-retour onError qui rouvre la feuille) ; MoneyText héros ; StickyBackRow.
  - Pourquoi : La dette fournisseurs vivante mérite une matière d'urgence ; le moment le plus gratifiant (la dette qui se règle) était un saut sec de layout.
  - Risque : moyen — MorphReplace autour d'un état serveur, aller-retour d'erreur couvert

**Critères de preuve**
- Planche « matière argent » : les 3 héros (pilotage success, comptabilite vert prêt, depenses ambre dette) dans la même grammaire matière — capture comparative
- Vidéo TrendBars dans les 3 états de préférence : unknown = statique dès la première frame, état final au pixel identique (mutants sur la logique de résolution)
- Capture d'un échec d'export FEC : toast tone danger, plus jamais de CheckIcon (comptabilite ET depenses)
- Contraste on-dark mesuré sur diagnostic (corps/détails ≥ AA sur indigo)
- Test : annonces et focus des phases diagnostic préservés à travers le fade-through
- VoiceOver : écriture comptable lue en une phrase, ResultRow avec montant, « ! » remplacé par « Risque » annoncé
- Dynamic Type XXL : balance générale sans troncature (flexBasis), cibles retour 44 pt mesurées sur les 5 écrans
- MorphReplace payé : aller-retour onError rejoué (la feuille se rouvre, aucun état fantôme)
- tsc complet + pnpm lint + suite mobile verte

## Exclusions — lane agent/voix (contrat binaire, claims GPT actifs)
- apps/mobile/app/(tabs)/assistant.tsx — lane agent/voix GPT (contrat binaire LECTURE SEULE) ; c'est AUSSI un importateur de src/components/ui : la suppression physique du kit legacy est donc reportée à la restitution de la lane (jalon Lot 3 reformulé « zéro importateur hors lane »)
- apps/mobile/app/voix.tsx — lane voix/realtime GPT, aucun audit, aucune intervention
- apps/mobile/app/devis/new.tsx — claim GPT actif (catalogue-in-quote fail-closed) ; le token wizardTitle est créé en Lot 0 pour qu'il n'invente pas une 4e valeur, mais son écran n'est pas touché ; l'extraction WizardHeader (partagée avec facture/new) est REPORTÉE
- apps/mobile/app/_layout.tsx (racine) — claimé par GPT pour Bob Live monobrain ; seul (tabs)/_layout.tsx est dans le Lot 1
- apps/mobile/src/audio/**, apps/mobile/src/data/voice.ts, apps/api/src/voice/**, packages/ai/** — périmètre agent/voix/realtime du contrat binaire, intouchable jusqu'au bâton explicite
- apps/mobile/app/catalogue.tsx et apps/mobile/app/onboarding.tsx — claims GPT documentés (catalogue-screen fail-closed, onboarding portfolio persistence) ; hors des 5 lots audités de toute façon — à réauditer après restitution
- Nota : notifications.tsx, compte.tsx, reglages-facturation.tsx, profil-fiscal.tsx, diagnostic-technique.tsx, src/screens (auth) ne sont PAS lane GPT mais hors périmètre des audits — vague ultérieure avec le kit complet

## Addendum contractuel post-review — O6/LOT0-CORRECTION-01 (02/08/2026)

La revue adversariale de la PR #51 a réfuté quatre contrats du Lot 0 malgré une CI verte. Ce
micro-lot correctif est requis avant tout consommateur des fondations et avant la reprise du train
Bob Live O5.

**Objectif.** Rendre le socle Lot 0 réellement commun à React Native et au Web, fidèle aux
identités métier persistées et strictement fail-closed pour l'accessibilité.

**Périmètre.** `@bob/tokens` et son miroir de handoff, CSS générée, `useReduceMotion`, contrat
accessible de `SearchField`, tests de dérive domaine↔tokens et tests de régression. **Hors
périmètre.** Adoption visuelle dans les écrans (Lots 1–5), nouvelle direction artistique, ajout de
données ou modification d'un use case métier.

**Invariants.** Les six clés système sont exactement `projects`, `purchases`, `insurance`,
`tax_social`, `bank`, `accounting` ; un UUID système n'est jamais haché comme un dossier
personnalisé. Tout rôle ajouté par le Lot 0 existe dans `toCssVars()` et dans `variables.css`. Une
préférence reduce-motion non résolue ou illisible ferme l'animation à chaque montage ; un événement
système récent ne peut jamais être écrasé par le snapshot initial plus ancien. Aucun libellé
accessible visible ou vocal n'est fabriqué dans `@bob/ui` : il vient de l'appelant i18n. Le champ de
recherche canonique respecte 4,5:1 pour son placeholder et 3:1 pour ses contrôles graphiques.

**Critères d'acceptation binaires.** (1) garde croisée contre `DOCUMENT_FOLDER_SYSTEM_KEYS` verte,
six index distincts et hash personnalisé stable ; (2) assertions exactes des nouveaux rôles CSS sur
les quatre thèmes et fichier généré sans dérive ; (3) régression « lecture `false` → démontage →
nouvelle lecture rejetée » rendant `true` dès la première et la dernière valeur, course « événement
actif → snapshot initial inactif » conservant l'événement et exception synchrone restant inconnue ;
(4) compilation refusant un `SearchField` effaçable sans `clearAccessibilityLabel`, décor SVG masqué
et contrastes mesurés verts ; (5) tests et typechecks `@bob/tokens`, `@bob/ui`, mobile et Web verts,
`git diff --check` vert.

**Definition of Done.** `implemented` après preuves locales et revue adversariale sans P0/P1 ;
`certified` reste interdit tant que les preuves device ON/OFF/unknown et les captures prévues par le
Lot 0 ne sont pas produites.
