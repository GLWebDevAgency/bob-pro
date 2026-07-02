# Specs de composants — Bob Pro (redlines)

Anatomie exacte des primitives réutilisables. Valeurs en **dp** (= px du proto). Tokens dans `tokens.ts`. Rendu : `Bob Pro.dc.html` + section 07 de `Design System.dc.html`.

Coque : **402 × 874**, safe-top 54, fond app `#EFF2F7`.

---

## Fondations

- **Carte standard** : `bg #fff` · `radius 18` (18–22 selon densité) · bordure `#EAEEF3` · ombre `e1` (repos) / `e2` (surélevée). Padding 15–18.
- **Séparateur interne** (lignes de tableau) : `1dp #F1F4F7`.
- **Pastille d'icône** : carré `28–34` · `radius 9–11` · fond pastel sémantique · icône stroke 2, couleur pleine assortie.
- **Badge de statut** : `fontSize 11 / 700` · padding `2/7` · `radius 6` · texte+fond pastel (voir variantes).

---

## 1. FloatingBalanceCard  *(geste signature — accueil)*
- Conteneur : `marginTop:-30`, `marginHorizontal:16`, `bg #fff`, `borderRadius 22`, `border #EAEEF3`, ombre **e3**, padding `17/18/16`.
- Doit suivre un en-tête dégradé à `paddingBottom:46` (le chevauchement reste sur navy).
- Eyebrow `eyebrow` slate400 → **Money 31 / 800 / #0C2340 / tabular-nums**.
- Chevron : cercle 30, `bg #F1F4F7`, flèche `#8A99A8`.
- Divider `#EEF1F5` (marge V 13) → rangée verte : pastille 30 `#EAF2EC` + `<DepositIcon #0E7C5A>` + phrase Hanken-600 13.5 `#0E7C5A` (jamais un pill).

## 2. AppHeaderNavy  *(accueil uniquement)*
- `LinearGradient(168deg, #0C2340→#122E52→#163763)`, padding `54/20/46`, `borderBottomRadius 30`, `overflow:hidden`.
- 2 halos radiaux (indigo top-right, vert bottom-left) `pointerEvents:none`.
- Topbar : avatar rond 38 (dégradé bleu→indigo, initiales Schibsted-700 14) + date eyebrow rgba blanc + société 13/600 blanc ; cloche 40 rond `rgba(255,255,255,.1)` bord `.14`, point non-lu `#FF7A6B` bord navy.
- Titre `heroTitle` 30 blanc + sous-titre 15 `rgba(255,255,255,.66)`.

## 3. InnerScreenHeader  *(Argent / Clients / Documents / Assistant)*
- Fond clair, `paddingTop:56`. Eyebrow slate400 uppercase → titre `pageTitle` 30/700 `#0F2235` → sous-titre `sub` 14.5 `#5B6B7B`.
- ⚠ L'accueil est le **seul** en-tête dégradé. Les écrans internes = en-tête clair.

## 4. PriorityCard  *(À régler)*
- `bg #fff`, `radius 20`, padding `15/16/15/17`, ombre `0 7px 20px rgba(13,38,68,.06)`, `position:relative`.
- **Barre d'accent** gauche : `4dp`, `radius 0 4 4 0`, top/bottom 16 ; couleur = statut (`#E5544B` retard · `ink600` marine · `#4338CA` conformité).
- Checkbox : 26 rond, `border 2 #D6DEE6`, `bg #fff` → coché = `#EAF2EC`/check `#0E7C5A`.
- Badge statut → titre 15.5/700 `#0F2235` → sub 13.5 `#5B6B7B` → CTA (bouton).
- État **fait** : carte pleine `#EAF2EC` bord `#CFE6D6`, check + libellé `#0E7C5A`.

## 5. KpiTile  *(En un coup d'œil — grille 2×2)*
- `bg #fff`, `radius 18`, padding 15, ombre `e1`, `Pressable`.
- Ligne icône 16 + label 12.5/600 slate500 → **Money 21 / 800** teinté (success/dangerVivid/warning/ink900).

## 6. QuickAction  *(Vite fait — grille 4)*
- `bg #fff`, `radius 16`, padding `14/6`, ombre douce ; colonne centrée.
- Pastille 34 `radius 11` pastel + icône 18 → label 11.5/600 slate500.

## 7. StatusBadge — variantes
| Usage | Texte | Fond |
|---|---|---|
| Retard / impayé | `#C8463C` | `#FBE7E4` |
| Devis accepté / B2B | `#1B3A63` | `#E6EDF6` |
| E-facture / IA / B2G | `#4338CA` | `#EDEAFE` |
| Particulier / échéance | `#C77A12` | `#FBF0DF` |
| Payé / à jour | `#0E7C5A` | `#EAF2EC` |

## 8. Avatar
- Squircle `radius 14` (client) ou rond (user). Taille 34–44.
- Fond : dégradé bleu→indigo (user) / dégradé graphite (entreprise) / pastel. Initiales **Schibsted-700**, blanc.

## 9. ClientRow
- `Pressable`, padding V 12–14. Avatar squircle 44 → (nom 14.5/700 + sous-titre 12.5 slate400) `flex:1` → **Money** teinté par statut → chevron `#C4CDD8`.

## 10. MoneyRow  *(grand-livre « le solde ment »)*
- Ligne `space-between`, padding V 9, séparateur bas `#F1F4F7`.
- Label gauche (14 slate500 ; le 1ᵉʳ en 600 ink800 avec icône) → montant droite **tabular-nums** teinté par signe (`+ #0E7C5A` / `− #E5544B`).
- Total : padding-top 13, label 15/700, **Money 20 / 800 / #0C2340**.

## 11. SegmentedControl  *(7/30/60/90 j · scénarios)*
- Piste `bg #EFF2F6`, `radius 12`, padding 4, `flexDirection:row`, `gap 4`.
- Segment : `flex:1`, `radius 9`, padding V 7, texte 13/700.
- **Actif** : `bg #fff` + ombre `e1` + texte ink900. Inactif : transparent, texte slate400.

## 12. HeroMoneyCard  *(Argent — « te verser »)*
- `LinearGradient(150deg, #0C2340→#163763)`, `radius 24`, padding 20, ombre `0 12px 30px rgba(12,35,64,.22)`, halo vert radial.
- Label 13/600 rgba blanc → **Money 42 / 800 blanc** + pill « sans risque » (`bg rgba(52,211,153,.18)`, texte `#6EE7B7` 12/700) → phrase explicative 13.5 rgba blanc.

## 13. ScoreRing  *(diagnostic, /100)*  &  ScoreBar  *(client)*
- Ring : SVG cercle r≈52, piste `#E6EBF1`, arc animé (couleur = tranche : <50 danger, 50–75 warning, >75 success), `strokeDashoffset` animé 900 ms ; centre = nombre `bigNum`.
- Bar : piste `radius pill` `#EEF1F5` h 8, remplissage teinté par score, largeur = `score%`.

## 14. BottomTabBar
- Conteneur : `bg #fff`, `radius 22`, padding `8/6`, ombre `0 8px 24px rgba(13,38,68,.08)`, marge basse = `insets.bottom` (26 proto).
- 5 items `flex:1`, colonne, `gap 3` : icône 23 (stroke 1.9) + label 10/600.
- Actif = `ink900` (ou couleur d'onglet Assistant = `#4338CA`) ; inactif = `#A9B4C0`.
- Fondu de fond derrière la barre (dégradé transparent→`#EFF2F7`).

## 15. FAB
- 58×58, `radius 20`, `LinearGradient(145deg, ink2→d1)`, icône `+` blanc stroke 2.4, ombre **e3**.
- Position : `absolute`, `right:18`, `bottom:104` (au-dessus de la tab bar). `hitSlop` pour ≥44.

## 16. Sheet  *(bottom, @gorhom)*
- Scrim `rgba(12,35,64,.45)`. Feuille `bg #fff`, `borderTopRadius 26`, poignée 36×5 `#DDE3EB` centrée, padding 18–20.

## 17. Toast
- `bg` = `ink` du thème, texte blanc 13.5/600, `radius 12`, padding `12/16`, icône check 16.
- Position `absolute`, `bottom:122` (au-dessus de la tab bar), centré. Entrée translateY+opacity, auto-dismiss 2,4 s.

## 18. Button
| Type | Fond | Texte | Radius |
|---|---|---|---|
| Primaire | `ink900` (ou dégradé `cta`) | blanc 700 | 11–15 |
| Secondaire | `#fff` + bord `#D9E0E8` | `ink600` 700 | 11–15 |
| IA | `#4338CA` (dégradé `#4338CA→#3730A3`) | blanc | 11–15 |
| Danger (léger) | transparent + bord | `#C8463C` | 11 |
| Désactivé | `#EFF2F6` | `#A9B4C0` | — |
- Hauteur ≥ 44. Icône optionnelle 15–17 stroke 2, `gap 7`. Press : scale 0.94 + haptic.

---

### Densité (réglage utilisateur)
`Cockpit` (défaut) montre les blocs secondaires (« En un coup d'œil », « Vite fait ») ; `Zen` les masque. Piloter via le `ThemeProvider`/préférences, pas en dur.

### Thème (réglage utilisateur)
4 thèmes (`marine` défaut · `foret` · `graphite` · `indigo`). Toute surface de marque lit `themes[active]` — jamais un hex figé pour le navy. Le vert (success), l'indigo (IA) et les statuts restent constants quel que soit le thème.
