# Guide pixel-perfect — React Native + Expo

Comment reproduire **exactement** Bob Pro en RN/Expo. À lire avant d'écrire une ligne d'UI. Les valeurs viennent de `tokens.ts` (source unique). Le proto de référence : `Bob Pro.dc.html` (coque **402 × 874**, safe-top **54**).

---

## 1. Stack & dépendances

```bash
npx create-expo-app bob-pro -t tabs   # expo-router déjà câblé
# UI / rendu fidèle
npx expo install react-native-reanimated react-native-svg expo-linear-gradient \
  expo-blur react-native-safe-area-context @gorhom/bottom-sheet expo-haptics \
  react-native-gesture-handler @shopify/react-native-skia
# fonts
npx expo install expo-font @expo-google-fonts/schibsted-grotesk @expo-google-fonts/hanken-grotesk
# state léger
npm i zustand
```

- **expo-router** → cf. `NAVIGATION_MAP.md` (arborescence §4).
- **Reanimated** pour toutes les animations (jamais `Animated` legacy).
- **@gorhom/bottom-sheet** pour les feuilles (`create`, `profile`, `catalogue`, `new-client`, `doc`).
- **Skia** optionnel (courbe de trésorerie, anneau de score) — sinon `react-native-svg` suffit.
- **(amendé 2026-07-29)** **`expo-blur` n'est pas une dépendance du produit** et n'est déclaré nulle
  part dans le dépôt. Le défaut Bob est **sans flou**. Il ne peut entrer que par le port injecté
  `renderBlurLayer` de `ProgressiveBlurBob`, depuis `apps/mobile`, et jamais par `@bob/ui` — voir
  §4 ci-dessous et [04 § Retombée de bord](../docs/mobile-experience/04-navigation-scroll-surfaces.md#retombée-de-bord--progressiveblurbob).

---

## 2. Fonts

```ts
// app/_layout.tsx
import { useFonts, SchibstedGrotesk_700Bold, SchibstedGrotesk_800ExtraBold } from '@expo-google-fonts/schibsted-grotesk';
import { HankenGrotesk_500Medium, HankenGrotesk_600SemiBold, HankenGrotesk_700Bold } from '@expo-google-fonts/hanken-grotesk';

const [loaded] = useFonts({
  'Schibsted-700': SchibstedGrotesk_700Bold, 'Schibsted-800': SchibstedGrotesk_800ExtraBold,
  'Hanken-500': HankenGrotesk_500Medium, 'Hanken-600': HankenGrotesk_600SemiBold, 'Hanken-700': HankenGrotesk_700Bold,
});
if (!loaded) return null; // splash tant que non chargées
```

> RN ne connaît pas `font-weight` + `font-family` combinés : on charge **une font par graisse** et on référence la clé exacte (`fontFamily: 'Schibsted-800'`). Pas de `fontWeight` sur ces familles.

---

## 3. Le piège n°1 : pas de cascade CSS

En web, la couleur/typo hérite. En RN, **chaque `<Text>` porte son style**. On ne copie donc pas les styles inline un par un — on crée deux primitives et on ne s'en écarte jamais :

```tsx
// components/Txt.tsx — mappe l'échelle `type` de tokens.ts
const VARIANTS = {
  heroNum:   { fontFamily:'Schibsted-800', fontSize:42,   letterSpacing:-1,   color:'#0C2340' },
  pageTitle: { fontFamily:'Schibsted-700', fontSize:30,   letterSpacing:-0.5, color:'#0F2235' },
  section:   { fontFamily:'Schibsted-700', fontSize:17,   color:'#0F2235' },
  cardTitle: { fontFamily:'Schibsted-700', fontSize:16,   color:'#0F2235' },
  bigNum:    { fontFamily:'Schibsted-800', fontSize:21,   color:'#0F2235' },
  body:      { fontFamily:'Hanken-500',    fontSize:14.5, color:'#5B6B7B' },
  sub:       { fontFamily:'Hanken-500',    fontSize:13.5, color:'#5B6B7B' },
  button:    { fontFamily:'Hanken-700',    fontSize:16,   color:'#FFFFFF' },
  label:     { fontFamily:'Hanken-600',    fontSize:13,   color:'#5B6B7B' },
  eyebrow:   { fontFamily:'Hanken-700',    fontSize:12,   letterSpacing:0.4, color:'#8A99A8', textTransform:'uppercase' },
  meta:      { fontFamily:'Hanken-600',    fontSize:12,   color:'#8A99A8' },
} as const;
export const Txt = ({variant='body', style, ...p}) => <Text style={[VARIANTS[variant], style]} {...p} />;

// components/Money.tsx — l'argent est SACRÉ : toujours tabular-nums
export const Money = ({value, style}) =>
  <Text style={[{ fontVariant:['tabular-nums'], fontFamily:'Schibsted-800' }, style]}>{fmtEUR(value)}</Text>;
// fmtEUR: Intl.NumberFormat('fr-FR',{style:'currency',currency:'EUR',maximumFractionDigits:0}) → "4 950 €"
```

---

## 4. Table de traduction Web → RN (à connaître par cœur)

> **Amendé le 2026-07-29 — doctrine « matière Bob ».** Une ligne de cette table prescrivait un flou
> système à **teinte sombre** ; c'est exactement ce que la directive du fondateur exclut (« Je NE
> VEUX PAS une UI transparente à la iOS »). Le `backdrop-filter` du proto **web** ne se traduit pas
> par un `BlurView` : il se traduit par une **surface teintée opaque** de notre palette. Autorité :
> [UX-ADR-004 § Algorithme de surface](../docs/mobile-experience/adr/UX-ADR-004-adaptive-appearance.md)
> et [04 § Retombée de bord](../docs/mobile-experience/04-navigation-scroll-surfaces.md#retombée-de-bord--progressiveblurbob).
> Les prototypes `.dc.html` de ce dossier gardent leurs `backdrop-filter` : ce sont des artefacts
> **web**, pas des prescriptions RN.

| Web (proto) | React Native |
|---|---|
| `box-shadow: 0 8px 22px rgba(13,38,68,.06)` | `tokens.shadowNative.e2` (iOS `shadow*` + Android `elevation`) |
| `background: linear-gradient(168deg,…)` | `<LinearGradient colors={[…]} locations={[…]} {...angle(168)} />` (§5) |
| `position: fixed` / surcouche | route `presentation:'modal'` **ou** `<View style={StyleSheet.absoluteFill}>` |
| `overflow-y: auto` | `<ScrollView>` (jamais un `<View>` scrollable) |
| `backdrop-filter: blur(6px)` | **(amendé 2026-07-29)** `<BobSurface tone=… emphasis=…>` — surface **teintée opaque** (`surfaceTint`), aucune transparence, aucune capability runtime. Le flou n'est admis **que** en retombée de bord non interactive, via `ProgressiveBlurBob` et son port `renderBlurLayer` — jamais comme fond d'une surface qui porte une information. ~~`<BlurView intensity={20} tint="dark">` (expo-blur)~~ : `tint="dark"` inverse notre identité sur fond `#EFF2F7`, et `expo-blur` n'est déclaré nulle part dans le dépôt. |
| `font-variant-numeric: tabular-nums` | `fontVariant:['tabular-nums']` |
| `letter-spacing: -.5px` | `letterSpacing:-0.5` (dp, pas px) |
| `width: calc(100% - 32px)` | `marginHorizontal:16` sur un élément `alignSelf:'stretch'` |
| `gap:` (flex) | `gap:` (RN ≥ 0.71 OK) |
| `:hover` | inutile (tactile) — utiliser `<Pressable>` + état `pressed` (opacity/scale) |
| `cursor:pointer` | supprimer |
| `transition:` | Reanimated (`withTiming`/`withSpring`) |
| `text-wrap: pretty` | `<Text>` gère le wrap ; ne jamais fixer la hauteur d'un bloc de texte |
| `border-radius:50%` | `borderRadius: size/2` |
| `%` en layout | `flex` / `flexBasis` |

---

## 5. Dégradés : angle CSS → start/end

`expo-linear-gradient` prend `start`/`end` (points 0..1), pas un angle. Helper figé :

```ts
export const angle = (deg:number) => {
  const r = (deg % 360) * Math.PI/180, x = Math.sin(r), y = -Math.cos(r);
  return { start:{x:0.5-x/2, y:0.5-y/2}, end:{x:0.5+x/2, y:0.5+y/2} };
};
// Valeurs figées Bob Pro :
// header  linear-gradient(168deg,#0C2340,#122E52,#163763) locations={[0,.58,1]}
// hero    linear-gradient(150deg,#0C2340,#163763)
// fab     linear-gradient(145deg,#1B3A63,#0C2340)
// cta     linear-gradient(135deg,#0C2340,#1B3A63)
```

`168deg` ⇒ `start:{0.40,0.01} end:{0.60,0.99}` (quasi vertical, léger biais droite). Vérifs : `180deg` = haut→bas, `90deg` = gauche→droite.

---

## 6. Ombres (jamais grises — bleutées `#0D2644`)

```ts
// tokens.shadowNative — iOS lit shadow*, Android lit elevation
e1: { shadowColor:'#0D2644', shadowOpacity:.06, shadowRadius:16, shadowOffset:{width:0,height:6},  elevation:3 },  // carte au repos
e2: { shadowColor:'#0D2644', shadowOpacity:.06, shadowRadius:22, shadowOffset:{width:0,height:8},  elevation:5 },  // carte surélevée
e3: { shadowColor:'#0C2340', shadowOpacity:.30, shadowRadius:34, shadowOffset:{width:0,height:14}, elevation:12 }, // FAB, héros, carte flottante
```

> Android ne rend pas les ombres colorées < API 28 : ajouter un léger `borderWidth:1, borderColor:'#EAEEF3'` sur les cartes pour tenir la séparation. Un fond de carte **doit** être opaque (`backgroundColor:'#fff'`) sinon `elevation` ne s'affiche pas.

---

## 7. Le geste signature en RN — carte trésorerie flottante

```tsx
// (app)/today.tsx — cf. patterns.floatingBalanceCard dans tokens.ts
<LinearGradient colors={['#0C2340','#122E52','#163763']} locations={[0,.58,1]} {...angle(168)}
  style={{ paddingTop:54, paddingHorizontal:20, paddingBottom:46, borderBottomLeftRadius:30, borderBottomRightRadius:30 }}>
  {/* topbar + Txt heroTitle + sub */}
</LinearGradient>

<Pressable onPress={goMoney}
  style={{ marginTop:-30, marginHorizontal:16, backgroundColor:'#fff', borderWidth:1, borderColor:'#EAEEF3',
           borderRadius:22, paddingTop:17, paddingHorizontal:18, paddingBottom:16, ...shadowNative.e3 }}>
  <View style={{ flexDirection:'row', justifyContent:'space-between', alignItems:'flex-start' }}>
    <View>
      <Txt variant="eyebrow">Dispo réel aujourd'hui</Txt>
      <Money value={4950} style={{ fontSize:31, letterSpacing:-0.6, color:'#0C2340', marginTop:3 }} />
    </View>
    <ChevronCircle />
  </View>
  <View style={{ height:1, backgroundColor:'#EEF1F5', marginVertical:13 }} />
  <View style={{ flexDirection:'row', alignItems:'center', gap:10 }}>
    <IconTile bg="#EAF2EC"><DepositIcon color="#0E7C5A" /></IconTile>
    <Text style={{ flex:1, fontFamily:'Hanken-600', fontSize:13.5, color:'#0E7C5A', lineHeight:18 }}>
      Tu peux te verser <Text style={{fontFamily:'Hanken-700'}}>~2 000 €</Text> sans te mettre dans le rouge
    </Text>
  </View>
</Pressable>
```

Le `marginTop:-30` **après** le dégradé fait chevaucher la couture (le header dépasse aux coins). `paddingBottom:46` du header garantit que le chevauchement reste sur du navy.

---

## 8. Animations (Reanimated) — durées & courbes figées

| Élément | Anim | Détail |
|---|---|---|
| FAB / Pressable | scale press | `withTiming(0.94, {duration:90})` + `expo-haptics` `Light` |
| Feuille bottom | spring entrée | `@gorhom/bottom-sheet` ; snap `[0.6, 0.95]`, `damping:50` |
| Anneau de score (diagnostic) | strokeDashoffset | `withTiming(target, {duration:900, easing: Easing.out(Easing.cubic)})` |
| Onde vocale | boucle | 5 barres `withRepeat(withTiming(h,{duration:420}),-1,true)`, déphasées |
| Balayage OCR (scan) | ligne translateY | `withRepeat(withTiming(H,{duration:1400}),-1,false)` |
| Écran succès | scale+fade check | `withSpring(1,{damping:9})` sur le cercle vert |
| « Bob écrit… » | 3 points | opacity `withRepeat`, décalage 160 ms |
| Toast | translateY+opacity | entrée `withالسpring`, sortie auto à 2,4 s |
| Entrée de liste | **aucune** au repos | ⚠ jamais `opacity:0` initial sur du contenu affiché (règle d'or) |

---

## 9. Safe areas & barre de statut

- `useSafeAreaInsets()` — le safe-top du proto (**54**) ≈ `insets.top` + ~10. Utiliser `insets`, ne pas coder 54 en dur.
- `<StatusBar style="light">` sur navy (accueil, auth, onboarding, voice, diagnostic) ; `"dark"` sur fond clair.
- Tab bar : ajouter `insets.bottom` au `paddingBottom` (26 dans le proto = home-indicator).
- Clavier : `KeyboardAvoidingView` + `keyboardVerticalOffset` sur les écrans de saisie (devis, auth, nouveau client, chat assistant).

---

## 10. Règles d'or (interdits)

1. **Jamais** de `opacity:0` / `translateY` d'entrée sur du contenu au repos (ni fill-mode `both`). Le contenu est peint tout de suite.
2. **Toujours** `tabular-nums` sur un montant (composant `Money`).
3. Cibles tactiles **≥ 44 dp** (`hitSlop` si l'icône est plus petite).
4. Une carte = fond **opaque** + `borderRadius` 16–22 + ombre `e1/e2` + bordure `#EAEEF3` (pour Android).
5. Couleurs **uniquement** depuis `tokens.ts`. Zéro hex inventé, zéro dégradé décoratif.
6. Actions sensibles (envoyer/relancer/encaisser/mise en demeure/transmettre compta) = **confirmation utilisateur** obligatoire.
7. Le ton de Bob (`patterns` + `VOICE_AND_TONE.md`) fait partie du design : pas de jargon système.
8. Tester sur **Android milieu de gamme** (cible artisan), pas seulement iPhone.
