/**
 * Bob Pro — Design Tokens (figés, v1.0)
 * Source unique de vérité pour apps/mobile (React Native) ET apps/web (Next.js).
 * Primitives neutres + sémantiques + 4 thèmes de marque. Zéro dépendance.
 *
 * Web  : génère des CSS custom properties à partir de ces valeurs (ou un preset Tailwind).
 * RN   : consomme directement les valeurs ; pour les dégradés, utilise expo-linear-gradient
 *        avec les `colors[]` + l'angle indiqué.
 */

// ----------------------------------------------------------------------------
// NEUTRES — encre & surfaces
// ----------------------------------------------------------------------------
export const neutrals = {
  ink900: '#0C2340', // titres sur clair, CTA primaire
  ink800: '#0F2235', // texte principal
  ink600: '#1B3A63', // accent marine (liens, puces B2B)
  slate500: '#5B6B7B', // texte courant
  slate400: '#8A99A8', // légendes / labels
  slate300: '#A9B4C0', // discret / inactif
  line: '#E0E6EE', // bordures
  lineSoft: '#F1F4F7', // séparateurs internes (lignes de tableau)
  bg: '#EFF2F7', // fond d'app
  surface: '#FFFFFF', // cartes
} as const;

// ----------------------------------------------------------------------------
// SÉMANTIQUE — statuts, argent, IA (chaque statut = teinte texte + fond pastel)
// ----------------------------------------------------------------------------
export const semantic = {
  success: '#0E7C5A',
  successBg: '#EAF2EC',
  successOnDark: '#6EE7B7', // payé, à jour
  warning: '#C77A12',
  warningBg: '#FBF0DF', // en attente, échéance
  danger: '#C8463C',
  dangerBg: '#FBEAE8',
  dangerVivid: '#E5544B', // retard, impayé
  b2b: '#1B3A63',
  b2bBg: '#E6EDF6', // entreprise
  b2g: '#4338CA',
  b2gBg: '#EDEAFE', // public (Chorus Pro)
  particulier: '#C77A12',
  particulierBg: '#FBF0DF', // B2C
  ai: '#4338CA',
  aiBg: '#F1EBFA',
  aiInk: '#4B2A86', // Bob / fonctions IA
} as const;

// ----------------------------------------------------------------------------
// MARQUE — 4 thèmes (marine = défaut). Chaque thème = 5 valeurs.
//   d1/d2/d3 = rampe de dégradé (sombre→clair) ; ink/ink2 = aplats (CTA, puces, FAB)
// ----------------------------------------------------------------------------
export type ThemeName = 'marine' | 'foret' | 'graphite' | 'indigo';
export interface BrandTheme {
  d1: string;
  d2: string;
  d3: string;
  ink: string;
  ink2: string;
}

export const themes: Record<ThemeName, BrandTheme> = {
  marine: { d1: '#0C2340', d2: '#122E52', d3: '#163763', ink: '#0C2340', ink2: '#1B3A63' },
  foret: { d1: '#0A3A2B', d2: '#0E5A43', d3: '#117A5A', ink: '#0C4A37', ink2: '#0E6B4F' },
  graphite: { d1: '#15181E', d2: '#242A33', d3: '#36404E', ink: '#1B2028', ink2: '#2C333F' },
  indigo: { d1: '#272363', d2: '#3A36A0', d3: '#4F46E5', ink: '#312C8A', ink2: '#4338CA' },
};
export const defaultTheme: ThemeName = 'marine';

/** Dégradés dérivés du thème actif. Web → string CSS. RN → parse en {colors, angle}. */
export const gradients = (t: BrandTheme) => ({
  header: `linear-gradient(168deg, ${t.d1} 0%, ${t.d2} 58%, ${t.d3} 100%)`, // en-têtes d'écran
  hero: `linear-gradient(150deg, ${t.d1}, ${t.d3})`, // cartes héros (tréso)
  fab: `linear-gradient(145deg, ${t.ink2}, ${t.d1})`, // bouton flottant
  cta: `linear-gradient(135deg, ${t.d1}, ${t.ink2})`, // boutons primaires
});

// ----------------------------------------------------------------------------
// TYPOGRAPHIE
// ----------------------------------------------------------------------------
export const fonts = {
  display: 'Schibsted Grotesk', // titres, chiffres, montants — 700, 800
  text: 'Hanken Grotesk', // corps, boutons, labels — 500, 600, 700
} as const;

/** Échelle type. `family` = clé de `fonts`. Tailles en px (RN: dp). */
export const type = {
  heroNum: { family: 'display', size: 42, weight: 800, tracking: -1 }, // montant héros
  pageTitle: { family: 'display', size: 30, weight: 700, tracking: -0.5 }, // titre d'écran
  screenH1: { family: 'display', size: 27, weight: 700, tracking: -0.4 }, // titres de surcouche
  section: { family: 'display', size: 17, weight: 700 }, // en-tête de bloc
  cardTitle: { family: 'display', size: 16, weight: 700 },
  bigNum: { family: 'display', size: 21, weight: 800 }, // stats, totaux
  body: { family: 'text', size: 14.5, weight: 500 }, // texte courant
  sub: { family: 'text', size: 13.5, weight: 500 }, // sous-texte
  button: { family: 'text', size: 16, weight: 700 },
  label: { family: 'text', size: 13, weight: 600 },
  eyebrow: { family: 'text', size: 12, weight: 700, tracking: 0.4, uppercase: true }, // sur-titre
  meta: { family: 'text', size: 12, weight: 600 }, // légendes
} as const;

// ----------------------------------------------------------------------------
// FORME & PROFONDEUR
// ----------------------------------------------------------------------------
export const radius = {
  sm: 8,
  chip: 11,
  squircle: 14,
  card: 16,
  cardLg: 18,
  cardXl: 22,
  pill: 999,
  circle: '50%',
} as const;

/** Ombres web (string) — basses, larges, bleutées (#0D2644), jamais grises. */
export const shadow = {
  e0: '0 1px 2px rgba(13,38,68,.05)', // hairline
  e1: '0 1px 2px rgba(13,38,68,.04), 0 6px 16px rgba(13,38,68,.06)', // carte au repos
  e2: '0 1px 2px rgba(13,38,68,.04), 0 8px 22px rgba(13,38,68,.06)', // carte surélevée
  e3: '0 14px 34px rgba(12,35,64,.3)', // pop (FAB, héros)
} as const;

/** Équivalents RN (shadowColor #0D2644). */
export const shadowNative = {
  e1: {
    shadowColor: '#0D2644',
    shadowOpacity: 0.06,
    shadowRadius: 16,
    shadowOffset: { width: 0, height: 6 },
    elevation: 3,
  },
  e2: {
    shadowColor: '#0D2644',
    shadowOpacity: 0.06,
    shadowRadius: 22,
    shadowOffset: { width: 0, height: 8 },
    elevation: 5,
  },
  e3: {
    shadowColor: '#0C2340',
    shadowOpacity: 0.3,
    shadowRadius: 34,
    shadowOffset: { width: 0, height: 14 },
    elevation: 12,
  },
} as const;

// Espacements récurrents du proto (px / dp)
export const space = [0, 4, 7, 8, 11, 12, 14, 16, 18, 20, 22, 26, 28, 54] as const;

// Coque de l'app mobile (référence du proto)
export const frame = { width: 402, height: 874, safeTop: 54 } as const;

// Réglages utilisateur exposés dans le proto (à câbler sur le ThemeProvider / préférences)
export const userSettings = {
  personality: ['Pote', 'Pro', 'Direct'] as const, // ton de Bob — défaut 'Pote'
  density: ['Cockpit', 'Zen'] as const, // densité de l'accueil — défaut 'Cockpit'
  brand: ['Marine', 'Forêt', 'Graphite', 'Indigo'] as const, // thème — défaut 'Marine'
};
