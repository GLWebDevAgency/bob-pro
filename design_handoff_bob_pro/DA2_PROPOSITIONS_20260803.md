# DA 2.0 — Propositions pour décision fondateur (03/08/2026)

> **Statut : ⛔ ANNULÉ DÉFINITIVEMENT PAR LE FONDATEUR (03/08/2026). NE RIEN IMPLÉMENTER.**
> Verdict verbatim : « notre système est beaucoup plus beau et je préfère garder celui-là de manière cohérente. » Le système visuel 1.x (kit matière + tokens, refonte mergée à `893e5d85`) EST la direction artistique de Bob Pro — l'exigence est désormais sa cohérence et sa finition, pas une nouvelle DA. Rien n'a été codé ni mergé : l'étude était en lecture seule. Archive conservée à titre historique uniquement.
> Mandat verbatim : « Ok, go direction artistique deux point zéro. Avec possibilité de rollback. » + « avec de la cohérence entre les pages ».
> Document visuel de décision : artifact « DA 2.0 — Le choix » (https://claude.ai/code/artifact/b7932ed2-4d77-44b4-9b0c-5bd0247c68a8).
> Spécifications d'exécution au pixel : `design_handoff_bob_pro/da2/*.json` (sorties brutes des 7 agents de l'étude).

## Le cadre

- La refonte 1.x (systématisation sous freeze, 45 écrans, mergée à `893e5d85`) est la **base de rollback** et la fondation technique — elle est dépassée, pas jetée.
- Le freeze est levé pour le VISUEL/UX seulement : aucune feature métier nouvelle, iso-information stricte (les « — » restent des « — »).
- Invariants non négociables : indigo = canal exclusif de Bob · reduce-motion fail-closed · AA mesuré · cibles 44 dp · immobilité pendant que Bob parle · pédagogie légale jamais animée · lanes GPT et zones compliance intouchées.
- Chemins interdits : assistant.tsx, voix.tsx, devis/new.tsx, catalogue.tsx, onboarding.tsx, `app/_layout.tsx` racine, `src/{audio,realtime,agent}`, `packages/ai`, `apps/api/src/voice`, documents/dossiers (chantier GPT en vol), pied légal + CloseAccountSheet de compte.tsx.

## Rollback 3 niveaux (exigence fondateur, intégré à chaque lot)

1. **Par lot** : un lot = un merge unique, revert à blanc PROUVÉ avant merge (revert + build + captures + suites vertes).
2. **Par APK** : l'APK n−1 reste installable à chaque train — retour utilisateur en 2 minutes.
3. **Par flag** : SEUL le lot transitions vit derrière un flag build-time fail-closed (patron exact `bob-tab-bar-flag.ts` : accès statique `process.env.EXPO_PUBLIC_*`, TRUTHY {'1','true'}, garde source testée). Flag absent = navigation stock. **Pas de double thème généralisé** (doctrine anti-double-dev maintenue).

## Les 3 directions (résumé — détail complet dans les JSON)

### A — L'Atelier Premium (« ton travail vaut de l'or »)
Nuit d'atelier d0 #081426 sur les 6 phares, encre carte #0C2340, ivoire display #F7F2E9, champagne #F2E3B3, or #D9B45B (filet 1 dp — matière, JAMAIS information, jamais sur papier), cuivre #D98B5F, papier ivoire #FCF9F2 pour les pièces. Fraunces (mots display uniquement, à charger HORS _layout racine), Schibsted pour 100 % des chiffres (héros 56/800). Moment signature : l'ouverture de l'écrin (lampe + comptage + filet qui se trace + silence). Complexités : Accueil XL, Argent L, Pilotage L, Client L, Pièce M, Compte M.
**Risque n° 1 assumé : lisibilité plein soleil** — mitigation : contrastes 15-16:1 mesurés, nuit = consultation courte, gate terrain 3 artisans ÉLIMINATOIRE, repli d0→d1 à un token. Wow le plus frontal, coût le plus lourd.

### B — Le Chantier Vivant (« cette app se lève avec toi »)
Plein jour réchauffé #F7F4EE (mutation canvas = régénération MÉCANIQUE de fade tab bar + surfaceVeil + veilLocations dans le même commit), 3 canaux lintés : orange #E8590C/#9C3B00/#FDEDE2 = l'artisan agit, indigo = Bob, vert = l'argent ; terracotta #B8552F = les sorties. displayMural 56/900 (livré en 800 d'abord — Black 900 exige le _layout racine, lane GPT ; token fail-closed), pictos métier dessinés maison, springJoyful, compteur 600 ms, étincelle UNIQUEMENT sur encaissement réel. Complexités : Accueil L, Argent L, Pilotage M, Client L, Pièce M, Compte M.
**Meilleure lisibilité chantier par construction ; la moins différenciante** (registre Monzo/Lydia/Duolingo occupé). Risques : frontière orange/ambre (test de non-cooccurrence), perception gadget (joie indexée sur le réel uniquement).

### C — La Fintech Éditoriale (« on ne consulte plus, on LIT »)
Papier éclairci #F5F7FB (tous les contrastes montent mécaniquement), ink950 #081426 (~18:1), le trait remplace l'ombre (cartes = papier bordé hairline + e0 ; e2/e3 = privilège du flottant), UN chiffre héros 56 par écran, standfirst 18 (la phrase de Bob en chapô), eyebrows +1,2, filet éditorial 28×2, dataviz monochrome (data.primary #1B3A63 / data.muted #A9B4C0 / rouge = dépassement seul, étiquettes directes). DEUX scènes sombres seulement (ouverture Argent + revue Pilotage, rampe d1→d3 existante). NumberFlight niveau 1 garanti (clone overlay transform/opacity) avec honnêteté mécanique : un chiffre ne se transforme jamais en vol (égalité stricte sinon fade-through). JAMAIS de count-up nulle part. Aucune nouvelle fonte. Complexités : Accueil M, Argent L, Pilotage L, Client M, Pièce M, Compte S.
**Risque a11y le plus bas, coût le mieux amorti, zéro contact lane GPT ; wow différé au premier geste.**

## Avis du directeur de création — le mix recommandé « L'Atelier Éditorial »

Colonne vertébrale : **C intégrale**. Greffe : **la matière de nuit d'A exactement sur les deux scènes sombres que C prévoit déjà** (ouverture Argent + revue Pilotage : rampe de nuit, halo de lampe, filet d'or strictement matière). Le moment signature du mix : la page se tourne, le chiffre voyage, il atterrit dans l'écrin. Le pari plein soleil tombe de 6 écrans à 2 scènes courtes, gateées, à double repli (cran de rampe côté tokens + bascule claire par flag).
Le mix REFUSE : Fraunces généralisée (une seule display : Schibsted) et le count-up généralisé (la règle d'honnêteté de C prime).
Deux lois retenues de B quel que soit le choix : protocole terrain comme gate de merge + discipline des canaux. B = assurance-vie si le terrain disqualifie tout sombre (la grammaire éditoriale survit sur papier).
Si direction pure : C si la sécurité de lecture prime ; A si le pari est pleinement assumé (gate terrain ÉLIMINATOIRE).

## Plan de lots (quel que soit le choix)

| Lot | Contenu | Rollback |
|---|---|---|
| 0 | Fondation invisible : tokens mutés + régénération mécanique des recettes pré-composées (même merge) + paires dans index.test.ts + primitives NON consommées + police hors _layout | Revert = 1.x au pixel près ; invisible par construction |
| 1 | Accueil (moment signature) — iso-structure/iso-information, a11y re-mesurée, perf device témoin ; si sombre : gate terrain AVANT merge | Revert = Accueil 1.x, primitives en place ; APK locale archivée |
| 2 | Argent — héros/scène selon direction ; qualification (~600 l.) intouchée ; saisie claire | + double repli si scène sombre |
| 3 | Pilotage — dataviz vivante (svg installé, zéro graphe aujourd'hui = gain net), iso-données | Dataviz additive : rangées existantes = fallback du revert |
| 4 | Fiche client — en-tête + carte maîtresse encours ; formulaires intouchés | Périmètre chirurgical |
| 5 | Pièce — mutation concentrée PieceDetailView (facture ET devis) ; devis/new intouché ; LegalHint jamais animés | UN revert = les deux routes |
| 6 | Compte hors compliance + correction infraction indigo Parrainage (aiBg, vérifiée compte.tsx) ; ZÉRO diff pied légal/clôture — revue PR ligne à ligne | Sans risque légal par construction |
| 7 | Généralisation 39 écrans par trains de gabarits ; chemins interdits exclus | Chaque train revertable seul |
| 8 | Transitions — SEUL lot sous flag `EXPO_PUBLIC_*` fail-closed, posé par écran, jamais _layout ; niveau 1 overlay garanti | Flag absent = stock ; + revert ; + APK n−1 |
| Train | APK locale par lot (JAMAIS de build EAS cloud sans GO fondateur) ; PR → staging → prod ; captures versionnées ; registre des reverts prouvés | Le dispositif de preuve lui-même |

## Les 3 questions posées au fondateur

1. **La direction** : A / B / C / mix « L'Atelier Éditorial » (recommandé) ?
2. **Le premier lot** : Lot 0 seul, ou Lot 0 + Accueil ? Et confirmation du gate terrain éliminatoire pour tout écran sombre ?
3. **Le niveau de motion** : M0 statique / M1 entrées one-shot (recommandé) / M2 continuité (M1 + transitions sous flag) ?

## Faits vérifiés dans le code pendant l'étude (7 agents, lecture seule, ~956 k tokens)

- `surfaceTint.dark` : rampe sombre certifiée AA déjà livrée dans les tokens, jamais branchée par aucun écran.
- `react-native-reanimated 4.5.0` : déclaré et mainline via la tab bar — le constat « dépendance fantôme » gravé dans PieceDetailView (l. 14/251) est PÉRIMÉ.
- `react-native-svg 15.15.4` installé ; Pilotage ne rend aujourd'hui AUCUN graphe — dataviz = gain net iso-données.
- Infraction indigo réelle : teaser Parrainage de compte.tsx (~l. 534) en `aiBg` hors canal Bob — à corriger au lot 6 quel que soit le choix.
- Les polices se chargent dans `app/_layout.tsx` (lane GPT) ; seules Schibsted 700/800 sont chargées.
- Recettes pré-composées dérivées du fond (surfaceVeil.canvas, bottomTabBar.fade, veilLocations — tokens l. ~338/652) : toute mutation du canvas exige leur régénération dans le MÊME merge.
