/**
 * Bob Pro — Design Tokens (figés, v1.5)
 * Source unique de vérité pour apps/mobile (React Native) ET apps/web (Next.js).
 * Primitives neutres + sémantiques + 4 thèmes de marque. Zéro dépendance.
 *
 * ┌─ DIRECTION ARTISTIQUE — 6 principes (le north-star, à ne pas transgresser) ─┐
 * │ 1. Profondeur, pas déco    — ombres basses/larges/bleutées (#0D2644) ; cartes  │
 * │                              qui flottent sur la couture navy→clair.           │
 * │ 2. Le chiffre est le héros  — montants Schibsted 800, navy sur blanc,           │
 * │                              tabular-nums partout.                            │
 * │ 3. Navy = contexte,         — en-tête dégradé rassure, contenu clair agit.      │
 * │    blanc = action             IA en indigo, positif en vert.                   │
 * │ 4. La voix de Bob EST la DA — « tu peux te verser ~2 000 € sans te mettre dans  │
 * │                              le rouge », jamais « solde disponible ».           │
 * │ 5. Un seul système          — une carte, un header, un badge, une pastille.     │
 * │ 6. Terrain-first            — cibles ≥44dp, jamais d'opacity-0 au repos,        │
 * │                              lisible en plein soleil.                         │
 * └─────────────────────────────────────────────────────────────┐
 *
 * Web  : génère des CSS custom properties à partir de ces valeurs (ou un preset Tailwind).
 * RN   : consomme directement les valeurs ; pour les dégradés, utilise expo-linear-gradient
 *        avec les `colors[]` + l'angle indiqué.
 */

// ----------------------------------------------------------------------------
// NEUTRES — encre & surfaces
// ----------------------------------------------------------------------------
export const neutrals = {
  ink900:   '#0C2340', // titres sur clair, CTA primaire
  ink800:   '#0F2235', // texte principal
  ink600:   '#1B3A63', // accent marine (liens, puces B2B)
  slate500: '#5B6B7B', // texte courant
  slate400: '#8A99A8', // légendes / labels
  slate300: '#A9B4C0', // discret / inactif
  line:     '#E0E6EE', // bordures
  lineSoft: '#F1F4F7', // séparateurs internes (lignes de tableau)
  bg:       '#EFF2F7', // fond d'app
  surface:  '#FFFFFF', // cartes
} as const;

// ----------------------------------------------------------------------------
// SÉMANTIQUE — statuts, argent, IA (chaque statut = teinte texte + fond pastel)
// ----------------------------------------------------------------------------
export const semantic = {
  success:    '#0E7C5A', successBg:  '#EAF2EC', successOnDark: '#6EE7B7', // payé, à jour
  warning:    '#C77A12', warningBg:  '#FBF0DF',                          // en attente, échéance
  danger:     '#C8463C', dangerBg:   '#FBEAE8', dangerVivid:  '#E5544B', // retard, impayé
  b2b:        '#1B3A63', b2bBg:      '#E6EDF6',                          // entreprise
  b2g:        '#4338CA', b2gBg:      '#EDEAFE',                          // public (Chorus Pro)
  particulier:'#C77A12', particulierBg:'#FBF0DF',                        // B2C
  ai:         '#4338CA', aiBg:       '#F1EBFA', aiInk: '#4B2A86',        // Bob / fonctions IA
} as const;

// ----------------------------------------------------------------------------
// MARQUE — 4 thèmes (marine = défaut). Chaque thème = 5 valeurs.
//   d1/d2/d3 = rampe de dégradé (sombre→clair) ; ink/ink2 = aplats (CTA, puces, FAB)
// ----------------------------------------------------------------------------
export type ThemeName = 'marine' | 'foret' | 'graphite' | 'indigo';
export interface BrandTheme { d1: string; d2: string; d3: string; ink: string; ink2: string; }

export const themes: Record<ThemeName, BrandTheme> = {
  marine:   { d1: '#0C2340', d2: '#122E52', d3: '#163763', ink: '#0C2340', ink2: '#1B3A63' },
  foret:    { d1: '#0A3A2B', d2: '#0E5A43', d3: '#117A5A', ink: '#0C4A37', ink2: '#0E6B4F' },
  graphite: { d1: '#15181E', d2: '#242A33', d3: '#36404E', ink: '#1B2028', ink2: '#2C333F' },
  indigo:   { d1: '#272363', d2: '#3A36A0', d3: '#4F46E5', ink: '#312C8A', ink2: '#4338CA' },
};
export const defaultTheme: ThemeName = 'marine';

/** Dégradés dérivés du thème actif. Web → string CSS. RN → parse en {colors, angle}. */
export const gradients = (t: BrandTheme) => ({
  header: `linear-gradient(168deg, ${t.d1} 0%, ${t.d2} 58%, ${t.d3} 100%)`, // en-têtes d'écran
  hero:   `linear-gradient(150deg, ${t.d1}, ${t.d3})`,                       // cartes héros (tréso)
  fab:    `linear-gradient(145deg, ${t.ink2}, ${t.d1})`,                     // bouton flottant
  cta:    `linear-gradient(135deg, ${t.d1}, ${t.ink2})`,                     // boutons primaires
});

// ----------------------------------------------------------------------------
// TYPOGRAPHIE
// ----------------------------------------------------------------------------
export const fonts = {
  display: 'Schibsted Grotesk', // titres, chiffres, montants — 700, 800
  text:    'Hanken Grotesk',    // corps, boutons, labels — 500, 600, 700
} as const;

/** Échelle type. `family` = clé de `fonts`. Tailles en px (RN: dp). */
export const type = {
  heroNum:   { family: 'display', size: 42,   weight: 800, tracking: -1   }, // montant héros
  pageTitle: { family: 'display', size: 30,   weight: 700, tracking: -0.5 }, // titre d'écran
  screenH1:  { family: 'display', size: 27,   weight: 700, tracking: -0.4 }, // titres de surcouche
  section:   { family: 'display', size: 17,   weight: 700 },                 // en-tête de bloc
  cardTitle: { family: 'display', size: 16,   weight: 700 },
  bigNum:    { family: 'display', size: 21,   weight: 800 },                 // stats, totaux
  body:      { family: 'text',    size: 14.5, weight: 500 },                 // texte courant
  sub:       { family: 'text',    size: 13.5, weight: 500 },                 // sous-texte
  button:    { family: 'text',    size: 16,   weight: 700 },
  label:     { family: 'text',    size: 13,   weight: 600 },
  eyebrow:   { family: 'text',    size: 12,   weight: 700, tracking: 0.4, uppercase: true }, // sur-titre
  meta:      { family: 'text',    size: 12,   weight: 600 },                 // légendes
} as const;

// ----------------------------------------------------------------------------
// FORME & PROFONDEUR
// ----------------------------------------------------------------------------
export const radius = {
  sm: 8, chip: 11, squircle: 14, card: 16, cardLg: 18, cardXl: 22, pill: 999, circle: '50%',
} as const;

/** Ombres web (string) — basses, larges, bleutées (#0D2644), jamais grises. */
export const shadow = {
  e0: '0 1px 2px rgba(13,38,68,.05)',                                 // hairline
  e1: '0 1px 2px rgba(13,38,68,.04), 0 6px 16px rgba(13,38,68,.06)',  // carte au repos
  e2: '0 1px 2px rgba(13,38,68,.04), 0 8px 22px rgba(13,38,68,.06)',  // carte surélevée
  e3: '0 18px 36px rgba(12,35,64,.17)',                               // pop (héros, carte flottante) — réf dc.html
} as const;

/** MOTION — durées nommées du produit (fast/base/content/ambient), reduced-motion coupé. */
export const motion = {
  fast: 200,
  base: 220,
  content: 360,
  ambient: 1500,
} as const;

/** Équivalents RN (shadowColor #0D2644). */
export const shadowNative = {
  e1: { shadowColor: '#0D2644', shadowOpacity: 0.06, shadowRadius: 16, shadowOffset: { width: 0, height: 6 }, elevation: 3 },
  e2: { shadowColor: '#0D2644', shadowOpacity: 0.06, shadowRadius: 22, shadowOffset: { width: 0, height: 8 }, elevation: 5 },
  e3: { shadowColor: '#0C2340', shadowOpacity: 0.17, shadowRadius: 36, shadowOffset: { width: 0, height: 18 }, elevation: 12 },
} as const;

// Espacements récurrents du proto (px / dp)
export const space = [0, 4, 7, 8, 11, 12, 14, 16, 18, 20, 22, 26, 28, 54] as const;

// Coque de l'app mobile (référence du proto)
export const frame = { width: 402, height: 874, safeTop: 54 } as const;

// Réglages utilisateur exposés dans le proto (à câbler sur le ThemeProvider / préférences)
export const userSettings = {
  personality: ['Pote', 'Pro', 'Direct'] as const,   // ton de Bob — défaut 'Pote'
  density:     ['Cockpit', 'Zen'] as const,           // densité de l'accueil — défaut 'Cockpit'
  brand:       ['Marine', 'Forêt', 'Graphite', 'Indigo'] as const, // thème — défaut 'Marine'
};

// ----------------------------------------------------------------------------
// CONTRÔLES — neutres d'UI des redlines (v1.2, COMPONENT_SPECS.md)
// ----------------------------------------------------------------------------
export const controls = {
  cardBorder: '#EAEEF3', // bordure de carte standard
  checkboxBorder: '#D6DEE6', // checkbox PriorityCard au repos
  sheetHandle: '#DDE3EB', // poignée de bottom-sheet
  chevron: '#C4CDD8', // chevrons de navigation (ClientRow…)
  segmentedTrack: '#EFF2F6', // piste SegmentedControl + bouton désactivé
  ringTrack: '#E6EBF1', // piste du ScoreRing
  buttonSecondaryBorder: '#D9E0E8', // bord du bouton secondaire
  dangerBadgeBg: '#FBE7E4', // fond badge retard/impayé (redlines §7)
  tabInactive: '#9AA7B4', // item de tab bar au repos (réf §14)
} as const;

// ----------------------------------------------------------------------------
// VOILES & HALOS — usage sur navy (header, héros) + scrim (v1.2, redlines/dc.html)
// ----------------------------------------------------------------------------
export const overlays = {
  white70: 'rgba(255,255,255,.7)',
  white66: 'rgba(255,255,255,.66)', // sous-titre header navy
  white60: 'rgba(255,255,255,.6)',
  white50: 'rgba(255,255,255,.5)',
  white16: 'rgba(255,255,255,.16)',
  white14: 'rgba(255,255,255,.14)', // bord cloche
  white10: 'rgba(255,255,255,.1)', // fond cloche
  white08: 'rgba(255,255,255,.08)', // séparateur sur navy
  white07: 'rgba(255,255,255,.07)',
  scrim: 'rgba(12,35,64,.45)', // voile des sheets
  successPill: 'rgba(52,211,153,.18)', // pill « sans risque » (texte = successOnDark)
  unreadDot: '#FF7A6B', // point non-lu de la cloche
  haloIndigo: ['rgba(67,56,202,.55)', 'rgba(67,56,202,0)'], // halo header top-right
  haloGreen: ['rgba(16,185,129,.4)', 'rgba(16,185,129,0)'], // halo héros Argent (émeraude)
  haloGreenDeep: ['rgba(14,124,90,.4)', 'rgba(14,124,90,0)'], // halo header bottom-left (success)
  haloMint: ['rgba(110,231,183,.32)', 'rgba(110,231,183,0)'],
  haloWhite: ['rgba(255,255,255,.16)', 'rgba(255,255,255,0)'],
} as const;

/** Pastille utilisateur (initiales) — dégradé bleu→indigo constant sur tous les thèmes (§8). */
export const avatarGradient = 'linear-gradient(135deg, #3B82F6, #4338CA)';

/** Carte info « Conformité » (lavande) — la seule priorité non actionnable (réf p. Aujourd'hui). */
export const conformityCard = {
  bgTop: '#F3F1FE', // dégradé 180° — haut
  bgBottom: '#FBFAFF', // dégradé 180° — bas
  border: '#E3DEFB',
} as const;

/** Écran Documents — coffre-fort & compta (v1.4, réf dc.html §isDocs). */
export const vault = {
  aiDeep: '#6D28D9', // violet fournisseur/OCR (badge, dossier Fiscal, mémoire)
  aiDeepBg: '#E5DBF6', // puce du bandeau mémoire fournisseurs
  scanChipBg: 'rgba(124,108,246,.2)', // puce caméra de la carte Scan (sur dégradé cta)
  scanChipBorder: 'rgba(124,108,246,.34)',
  scanChipIcon: '#B7AEFB',
  scanShadow: '0 10px 24px rgba(12,35,64,.2)',
  metricChipBg: '#F6F8FA', // chips Montant / TVA / Date de la carte à valider
  toValidateBorder: '#ECEAFB', // bordure lavande de la carte à valider
  classifiedBorder: '#CFE6D6', // bandeau vert « {nom} classé · {destination} » (fond = semantic.successBg)
  readerBorder: '#E2E7EF', // miniature papier de l'overlay « Je lis ton document… »
  readerLineTitle: '#D9E0E8', // ligne de titre du squelette papier (overlay scan)
  readerLineBody: '#E6EBF1', // lignes de corps du squelette papier (overlay scan)
  scanLineGlow: 'rgba(67,56,202,.7)', // glow de la ligne de scan indigo (couleur = semantic.ai)
  thumbTop: '#F1F3F7', // vignette document (dégradé 160°)
  thumbBottom: '#E2E7EF',
  thumbBorder: '#DCE2EA',
  thumbBar: '#C9D2DD',
  monthReadyTop: '#F0F7F3', // carte « mois prêt » (dégradé 180°)
  monthReadyBottom: '#FBFEFC',
  monthReadyBorder: '#DCEDE3',
} as const;

export const vaultShadowNative = {
  scan: { shadowColor: '#0C2340', shadowOpacity: 0.2, shadowRadius: 24, shadowOffset: { width: 0, height: 10 }, elevation: 8 },
} as const;

/** Détail pièce (C16) — nav croisée : avoir (ambre), situation (bleu acier), pièce liée. */
export const pieceDetail = {
  creditBorder: '#F0DEBE', // carte « avoir émis » (fond = warningBg)
  creditChipBg: '#F6E4C6',
  creditInk: '#8A5A12',
  creditInkStrong: '#6B4310',
  situationBg: '#E9EFF7', // carte « situation de travaux »
  situationBorder: '#D3E0EF',
  situationChipBg: '#D7E3F2',
  situationInk: '#3B5B85',
  linkedLabelInk: '#6B5FC7', // libellé de la pièce liée (carte lavande conformityCard)
} as const;

// Ombres de composants (v1.2, redlines) — web string + équivalent RN
export const shadowComponents = {
  priorityCard: '0 7px 20px rgba(13,38,68,.06)',
  conformityCard: '0 7px 20px rgba(67,56,202,.07)', // ombre douce indigo de la carte lavande
  heroMoney: '0 12px 30px rgba(12,35,64,.22)',
  tabBar: '0 8px 24px rgba(13,38,68,.08)',
} as const;

export const shadowComponentsNative = {
  priorityCard: { shadowColor: '#0D2644', shadowOpacity: 0.06, shadowRadius: 20, shadowOffset: { width: 0, height: 7 }, elevation: 4 },
  conformityCard: { shadowColor: '#4338CA', shadowOpacity: 0.07, shadowRadius: 20, shadowOffset: { width: 0, height: 7 }, elevation: 4 },
  heroMoney: { shadowColor: '#0C2340', shadowOpacity: 0.22, shadowRadius: 30, shadowOffset: { width: 0, height: 12 }, elevation: 10 },
  tabBar: { shadowColor: '#0D2644', shadowOpacity: 0.08, shadowRadius: 24, shadowOffset: { width: 0, height: 8 }, elevation: 8 },
} as const;

// ----------------------------------------------------------------------------
// PATTERNS SIGNATURE — recettes de composition figées (le « geste » Bob Pro)
// ----------------------------------------------------------------------------
export const patterns = {
  /** Carte trésorerie flottante — le geste signature de l'accueil.
   *  L'en-tête dégradé (paddingBottom 46) est suivi d'une carte BLANCHE tirée
   *  vers le haut (marginTop -30) : elle chevauche la couture navy→clair.
   *  Le chiffre = héros navy (ink900) sur blanc, 31/800, tabular-nums.
   *  La ligne verte = 1 phrase à la voix de Bob (success) — jamais un pill qui casse. */
  floatingBalanceCard: {
    headerPaddingBottom: 46,      // dp — navy visible sous le titre
    overlap: -30,                 // dp — marginTop de la carte (chevauchement)
    sideInset: 16,                // dp — marge latérale
    radius: 22,                   // = radius.cardXl
    padding: [17, 18, 16],        // dp — haut / côtés / bas
    numberSize: 31, numberWeight: 800, numberColor: '#0C2340', // ink900
    numberTracking: -0.6,         // letter-spacing du montant héros (réf dc.html)
    elevation: shadow.e3,         // ombre profonde = effet flottant
    divider: '#EEF1F5',
    voiceLineColor: '#0E7C5A',    // phrase « te verser », en success
  },
  /** En-tête d'écran interne (Argent / Clients / Documents) sur fond clair :
   *  eyebrow (slate400, uppercase) + titre 30/700 + sous-titre slate500.
   *  L'ACCUEIL est le seul en-tête dégradé (le briefing du jour). */
  innerScreenHeader: { paddingTop: 56, eyebrow: 'eyebrow', title: 'pageTitle', sub: 'sub' },
  /** Rangée d'argent (grand-livre) : label à gauche, montant tabular-nums à droite,
   *  coloré par signe (success / dangerVivid). Séparateur lineSoft entre les lignes. */
  moneyRow: { divider: '#F1F4F7', positive: '#0E7C5A', negative: '#E5544B', total: '#0C2340' },
  /** Tab bar pill flottante (§14) : le contenu défile dessous et s'estompe dans le fondu
   *  (bg teinté 0 → .92 → opaque) ; padding du conteneur absolu (26 = safe-area proto). */
  bottomTabBar: {
    fade: ['rgba(239,242,247,0)', 'rgba(239,242,247,.92)', '#EFF2F7'],
    fadeLocations: [0, 0.32, 0.6],
    padding: [8, 10, 26], // haut / côtés / bas
  },
} as const;
