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
  /** Encre AA sur successBg (6,99:1, index.test.ts) — texte des bandeaux d'état pastel
   *  (StatusStrip, checklist transmission, facture/[id]) ; même vert profond que
   *  surfaceTint.light.success.ink : une seule encre verte foncée dans le système. */
  successInk: '#0E5C44',
  warning: '#C77A12',
  warningBg: '#FBF0DF', // en attente, échéance
  /** Encre AA sur warningBg (5,25:1, index.test.ts) — patron pieceDetail.creditInk
   *  GÉNÉRALISÉ (même valeur) : texte ambre foncé des bandeaux d'état pastel là où
   *  semantic.warning (2,99:1) ne passe pas le petit texte. */
  warningInk: '#8A5A12',
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
// RÔLES DE COULEUR — contenu lisible vs états non éditoriaux
// ----------------------------------------------------------------------------
/**
 * Couleurs sémantiques destinées au CONTENU et à la navigation.
 *
 * Les rôles `text` et `navigation` sont certifiés WCAG AA pour du petit texte
 * sur leurs surfaces déclarées (voir index.test.ts). `nonContent` conserve la
 * hiérarchie visuelle historique des états désactivés et des ornements : ces
 * valeurs ne doivent jamais porter seules une information ni du texte lisible.
 *
 * Plusieurs rôles peuvent volontairement référencer une même primitive. Le
 * rôle documente le contrat d'usage et permet de les faire évoluer séparément
 * sans assombrir globalement les gris décoratifs.
 */
const COLOR_ROLE_VALUES = {
  'text.primary': neutrals.ink800,
  'text.secondary': neutrals.slate500,
  'text.muted': neutrals.slate500,
  'navigation.active': neutrals.ink900,
  'navigation.assistantActive': semantic.ai,
  'navigation.inactive': neutrals.slate500,
  'nonContent.disabled': neutrals.slate400,
  'nonContent.decorative': neutrals.slate300,
} as const;

export type ColorRole = keyof typeof COLOR_ROLE_VALUES;

/** Résout un rôle sémantique vers sa primitive, sans exposer le gris comme contrat d'usage. */
export function resolveColorRole<Role extends ColorRole>(role: Role): (typeof COLOR_ROLE_VALUES)[Role] {
  return COLOR_ROLE_VALUES[role];
}

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
  /**
   * Accent clair ON-DARK du thème (Lot 0, arbitrage TONS RECYCLÉS) — icônes et détails posés
   * sur la rampe d1/d2/d3 (diagnostic, panneaux sombres). `indigo.accent` REPREND la valeur
   * de l'emprunt historique `vault.scanChipIcon` (#B7AEFB) : même pixel, rôle enfin dédié.
   * Les 3 autres accents sont dérivés du MÊME patron (teinte de `ink2`, saturation ~91 % et
   * luminosité ~83 % de #B7AEFB en HSL) — contraste ≥ 3:1 certifié sur d3 (index.test.ts).
   */
  accent: string;
}

export const themes: Record<ThemeName, BrandTheme> = {
  marine: { d1: '#0C2340', d2: '#122E52', d3: '#163763', ink: '#0C2340', ink2: '#1B3A63', accent: '#AECFFB' },
  foret: { d1: '#0A3A2B', d2: '#0E5A43', d3: '#117A5A', ink: '#0C4A37', ink2: '#0E6B4F', accent: '#AEFBE4' },
  graphite: { d1: '#15181E', d2: '#242A33', d3: '#36404E', ink: '#1B2028', ink2: '#2C333F', accent: '#AECAFB' },
  indigo: { d1: '#272363', d2: '#3A36A0', d3: '#4F46E5', ink: '#312C8A', ink2: '#4338CA', accent: '#B7AEFB' },
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
  // ── Crans ajoutés au Lot 0 (plan DA 01/08 — AUCUNE demi-taille tokenisée) ──
  /** Titre de feuille/sheet — remplace les 8 recompositions inline
   *  `font('pageTitle') + fontSize 20` (même famille/graisse/tracking que pageTitle). */
  sheetTitle: { family: 'display', size: 20, weight: 700, tracking: -0.5 },
  /** Titre d'étape de wizard (facture/new, devis/new après restitution) — remplace les
   *  recompositions `font('screenH1') + fontSize 24` (même tracking que screenH1). */
  wizardTitle: { family: 'display', size: 24, weight: 700, tracking: -0.4 },
  /** Montant héros d'écran de pilotage (pilotage 26→27, depenses 27) — entre bigNum 21 et
   *  heroNum 42 ; consommé via le variant héros de MoneyText (tabular-nums côté composant). */
  moneyHero: { family: 'display', size: 27, weight: 800 },
} as const;

// ----------------------------------------------------------------------------
// ESPACEMENT — rôles nommés (Lot 0, plan DA 01/08). La gouttière canonique est 20
// (celle d'InnerScreenHeader) : les écrans à 18 migrent lot par lot, jamais en
// passe globale. Remplace les littéraux 10/11/13/14/18/20/22 des 5 lots.
// ----------------------------------------------------------------------------
export const spacing = {
  /** Gouttière horizontale d'écran — bord gauche unique du titre aux cartes. */
  gutter: 20,
  /** Espace entre deux SECTIONS d'un écran (SectionHeader → carte suivante). */
  sectionGap: 20,
  /** Espace entre deux cartes/rangées d'une même liste. */
  itemGap: 12,
  /** Rythme vertical INTERNE d'une carte (entre ses lignes de contenu). */
  intraGap: 14,
  /** Padding interne standard d'une carte. */
  cardPad: 16,
  /** Padding interne d'une carte héros (matière, chiffre en avant). */
  heroPad: 20,
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
  e3: '0 18px 36px rgba(12,35,64,.17)', // pop (héros, carte flottante) — réf dc.html
} as const;

/** Équivalents RN (shadowColor #0D2644). */
/**
 * MOTION — les durées/easing du produit, NOMMÉES (chantier états/transitions 14/07).
 * Ces valeurs ne sont pas inventées : elles FIGENT les constantes déjà dominantes dans le
 * code (Toast 200, Sheet 220, transitions de contenu assistant/diagnostic 360, respirations
 * voix/halo 1500+). Trois registres, une règle :
 * · fast   — micro-feedback (toast, apparition/disparition d'un élément) ;
 * · base   — transitions d'UI (sheet, bascule d'état d'un composant) ;
 * · content — changement de CONTENU (étape de wizard, onglet, section) ;
 * · ambient — respirations décoratives (halo, orbe) — TOUJOURS coupées en reduced-motion.
 * Easing par défaut : Easing.inOut(Easing.ease) pour base/content, linéaire pour fast.
 */
export const motion = {
  fast: 200,
  base: 220,
  content: 360,
  ambient: 1500,
} as const;

/**
 * MOTION SÉMANTIQUE — kit « matière Bob » (P1 §1.4), ADDITIF au registre `motion` historique.
 * Durées NOMMÉES PAR INTENTION (feedback, entrée, sortie, remplacement) pour les NOUVEAUX
 * composants P1 (parc, contrats, fiches de passage) — transform/opacity uniquement,
 * interruptible, et la table reduce-motion = ÉQUIVALENCE D'INFORMATION (immédiat + annonce),
 * jamais une info perdue. Les écrans existants gardent `motion` (jamais de restyling).
 */
export const motionSemantic = {
  /** Micro-feedback d'appui (pressed) — perceptible, jamais spongieux. */
  feedbackIn: 80,
  feedbackOut: 160,
  /** Sortie d'un élément (rangée retirée) — plus rapide que l'entrée (l'œil suit l'arrivée). */
  exitFast: 140,
  /** Entrée d'un élément secondaire (chip de synchro, badge). */
  enterFast: 180,
  /** Entrée de contenu après ACK (nouvelle rangée insérée). */
  enter: 240,
  /** Remplacement d'un état par un autre (badge morph success → neutral). */
  replace: 280,
  /** Ressort standard des layout transitions (interruptible, sans rebond excessif). */
  spring: { damping: 26, stiffness: 300, mass: 1 },
} as const;

/**
 * SURFACE TINT — kit « matière Bob » (P1 §1.1) : surfaces TEINTÉES OPAQUES (jamais la
 * transparence iOS — opacités pré-composées en hex), 2 apparences livrées dès P1.
 * `light` = résolution par défaut tant qu'UX-ADR-004 n'active pas le dark ; `dark` sur la
 * rampe marine d1/d2/d3. `surface` porte le fond, `border` le liseré (renforcé en Increase
 * Contrast côté composant), `ink` le texte principal certifié AA sur `surface`
 * (index.test.ts). Chaque tone a 2 niveaux : `flat` (fond) et `raised` (carte posée).
 */
export type SurfaceTintTone = 'neutral' | 'marine' | 'ai' | 'success' | 'warning' | 'danger';
export type SurfaceTintAppearance = 'light' | 'dark';

export interface SurfaceTintSpec {
  /** Fond `flat` (aplat calme). */
  flat: string;
  /** Fond `raised`/`floating` (carte détachée du fond). */
  raised: string;
  border: string;
  /** Encre principale certifiée AA (4,5:1) sur `flat` ET `raised`. */
  ink: string;
  /** Encre secondaire certifiée AA sur `flat` ET `raised`. */
  inkMuted: string;
}

export const surfaceTint: Record<
  SurfaceTintAppearance,
  Record<SurfaceTintTone, SurfaceTintSpec>
> = {
  light: {
    neutral: { flat: '#FFFFFF', raised: '#EAEEF3', border: '#E0E6EE', ink: '#0F2235', inkMuted: '#5B6B7B' },
    marine: { flat: '#F4F7FB', raised: '#E2E9F2', border: '#D3DEEC', ink: '#0C2340', inkMuted: '#43587A' },
    ai: { flat: '#F6F4FD', raised: '#E7E2F8', border: '#DAD2F1', ink: '#4B2A86', inkMuted: '#5A4795' },
    success: { flat: '#EAF2EC', raised: '#DCEDE3', border: '#C9E2D2', ink: '#0E5C44', inkMuted: '#20654F' },
    warning: { flat: '#FBF0DF', raised: '#F6E4C6', border: '#EED9B4', ink: '#7A4A0A', inkMuted: '#8A5A12' },
    danger: { flat: '#FBEAE8', raised: '#F6DBD8', border: '#EFC9C4', ink: '#8F2F27', inkMuted: '#A03A31' },
  },
  dark: {
    neutral: { flat: '#0C2340', raised: '#122E52', border: '#1E3D66', ink: '#F1F5FA', inkMuted: '#A9BBD4' },
    marine: { flat: '#122E52', raised: '#163763', border: '#234879', ink: '#F1F5FA', inkMuted: '#AFC2DB' },
    ai: { flat: '#221D45', raised: '#2C2560', border: '#3A3178', ink: '#E9E4FB', inkMuted: '#BCB1E8' },
    success: { flat: '#0D2E24', raised: '#123D30', border: '#1B5343', ink: '#CFF2E2', inkMuted: '#8FCDB3' },
    warning: { flat: '#33230A', raised: '#463010', border: '#5E431A', ink: '#F8E5C4', inkMuted: '#DBB97E' },
    danger: { flat: '#351312', raised: '#481B19', border: '#622825', ink: '#FADDD9', inkMuted: '#E5A9A2' },
  },
} as const;

/**
 * SURFACE VEIL — voile de RETOMBÉE DE BORD du kit « matière Bob »
 * (04 § Retombée de bord). C'est la SEULE matière du produit qui porte un canal alpha, et
 * elle ne porte JAMAIS d'information : zone décorative, `pointerEvents="none"`, jamais de
 * texte, jamais animée. Elle dissout le contenu qui défile SOUS un chrome flottant, dans
 * NOTRE teinte — là où la référence (`davidmokos/revolut-expo-clone` → `progressive-blur.tsx`)
 * pose un voile noir `rgba(0,0,0,.70)`, inversion complète d'identité sur notre fond clair.
 *
 * Trois stops PRÉ-COMPOSÉS par ton : transparent → 92 % → opaque. `solid` est le bord ANCRÉ
 * (celui qui touche le chrome) et vaut exactement le `flat` du même ton de `surfaceTint` —
 * les encres `ink`/`inkMuted` déjà certifiées AA y restent donc certifiées, ce que
 * `surface-veil.test.ts` re-prouve sur la couleur du VOILE et non sur celle de la surface.
 * Le ton `canvas` n'existe pas dans `surfaceTint` : c'est le FOND D'APP (`neutrals.bg` en
 * clair, la même encre navy que `neutral` en sombre), et il reproduit à l'identique
 * `patterns.bottomTabBar.fade`, déjà livré — le voile n'invente pas une seconde recette de
 * fondu, il généralise celle qui existe.
 *
 * Les positions des stops sont communes à tous les tons : `patterns.edgeFalloff.veilLocations`.
 */
export type SurfaceVeilTone = SurfaceTintTone | 'canvas';

export interface SurfaceVeilSpec {
  /** Stops pré-composés du dégradé : transparent → 92 % → opaque, dans la teinte du ton. */
  stops: readonly [string, string, string];
  /**
   * Couleur OPAQUE du bord ancré. C'est elle qui rend le repli LISIBLE : le repli opaque
   * unique n'est jamais un trou visuel, jamais un aplat gris, jamais un sous-contraste.
   */
  solid: string;
}

export const surfaceVeil: Record<SurfaceTintAppearance, Record<SurfaceVeilTone, SurfaceVeilSpec>> = {
  light: {
    canvas: { stops: ['rgba(239,242,247,0)', 'rgba(239,242,247,.92)', '#EFF2F7'], solid: '#EFF2F7' },
    neutral: { stops: ['rgba(255,255,255,0)', 'rgba(255,255,255,.92)', '#FFFFFF'], solid: '#FFFFFF' },
    marine: { stops: ['rgba(244,247,251,0)', 'rgba(244,247,251,.92)', '#F4F7FB'], solid: '#F4F7FB' },
    ai: { stops: ['rgba(246,244,253,0)', 'rgba(246,244,253,.92)', '#F6F4FD'], solid: '#F6F4FD' },
    success: { stops: ['rgba(234,242,236,0)', 'rgba(234,242,236,.92)', '#EAF2EC'], solid: '#EAF2EC' },
    warning: { stops: ['rgba(251,240,223,0)', 'rgba(251,240,223,.92)', '#FBF0DF'], solid: '#FBF0DF' },
    danger: { stops: ['rgba(251,234,232,0)', 'rgba(251,234,232,.92)', '#FBEAE8'], solid: '#FBEAE8' },
  },
  dark: {
    canvas: { stops: ['rgba(12,35,64,0)', 'rgba(12,35,64,.92)', '#0C2340'], solid: '#0C2340' },
    neutral: { stops: ['rgba(12,35,64,0)', 'rgba(12,35,64,.92)', '#0C2340'], solid: '#0C2340' },
    marine: { stops: ['rgba(18,46,82,0)', 'rgba(18,46,82,.92)', '#122E52'], solid: '#122E52' },
    ai: { stops: ['rgba(34,29,69,0)', 'rgba(34,29,69,.92)', '#221D45'], solid: '#221D45' },
    success: { stops: ['rgba(13,46,36,0)', 'rgba(13,46,36,.92)', '#0D2E24'], solid: '#0D2E24' },
    warning: { stops: ['rgba(51,35,10,0)', 'rgba(51,35,10,.92)', '#33230A'], solid: '#33230A' },
    danger: { stops: ['rgba(53,19,18,0)', 'rgba(53,19,18,.92)', '#351312'], solid: '#351312' },
  },
} as const;

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
    shadowOpacity: 0.17,
    shadowRadius: 36,
    shadowOffset: { width: 0, height: 18 },
    elevation: 12,
  },
} as const;

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
  // Référence visuelle historique : ne pas employer pour du texte (utiliser navigation.inactive).
  tabInactive: '#9AA7B4', // item de tab bar au repos dans le handoff §14
} as const;

// ----------------------------------------------------------------------------
// VOILES & HALOS — usage sur navy (header, héros) + scrim (v1.2, redlines/dc.html)
// ----------------------------------------------------------------------------
export const overlays = {
  /** Corps de texte AA on-dark (Lot 0) — la doctrine « corps ≥ white80, détail ≥ white70 » :
   *  certifié ≥ 4,5:1 composé sur photoScrim et sur les rampes d1/d2 (index.test.ts). */
  white80: 'rgba(255,255,255,.8)',
  white70: 'rgba(255,255,255,.7)', // détail on-dark (plancher de la doctrine Lot 0)
  white66: 'rgba(255,255,255,.66)', // sous-titre header navy
  white60: 'rgba(255,255,255,.6)',
  white50: 'rgba(255,255,255,.5)',
  white16: 'rgba(255,255,255,.16)',
  white14: 'rgba(255,255,255,.14)', // bord cloche
  white10: 'rgba(255,255,255,.1)', // fond cloche
  white08: 'rgba(255,255,255,.08)', // séparateur sur navy
  white07: 'rgba(255,255,255,.07)',
  scrim: 'rgba(12,35,64,.45)', // voile des sheets
  /** Scrim de la visionneuse photo plein écran (Lot 0 — PhotoViewer) : noir ≈ .92, la valeur
   *  déjà posée par chantier/[id] (rgba(0,0,0,0.92)) enfin tokenisée. */
  photoScrim: 'rgba(0,0,0,.92)',
  /** Chrome (fermer, supprimer) posé SUR photoScrim — blanc plein, jamais un gris. */
  scrimChrome: '#FFFFFF',
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
  // ── +2 teintes dossiers (Lot 0) — 6 teintes distinctes pour 6 dossiers système ──
  folderSteel: '#3B5B85', // dossier « Banque » — bleu acier, 6,01:1 sur folderSteelBg
  folderSteelBg: '#E9EFF7',
  folderTeal: '#0E6E73', // dossier « Comptable » — sarcelle, 5,07:1 sur folderTealBg
  folderTealBg: '#DFEFF0',
} as const;

// ----------------------------------------------------------------------------
// TEINTES DES DOSSIERS DU COFFRE (Lot 0, plan DA 01/08) — la couleur-repère code
// l'IDENTITÉ d'un dossier (retrouver « Assurances » d'un coup d'œil) et doit survivre
// à la navigation. Avant : 4 paires pour 6 dossiers système (banque ≡ chantiers,
// comptable ≡ achats). Désormais : 6 paires DISTINCTES + un hachage stable pour les
// dossiers personnalisés.
// ----------------------------------------------------------------------------
export interface VaultFolderTint {
  /** Teinte de l'icône/du libellé du dossier. */
  readonly tint: string;
  /** Fond pastel de la tuile. */
  readonly bg: string;
}

/** Palette ORDONNÉE des 6 paires — l'ordre EST le contrat de `folderTintFor` (hash % 6). */
export const vaultFolderTints: readonly [
  VaultFolderTint,
  VaultFolderTint,
  VaultFolderTint,
  VaultFolderTint,
  VaultFolderTint,
  VaultFolderTint,
] = [
  { tint: semantic.b2b, bg: semantic.b2bBg }, // 0 — marine (Chantiers)
  { tint: semantic.success, bg: semantic.successBg }, // 1 — vert (Achats)
  { tint: semantic.particulier, bg: semantic.particulierBg }, // 2 — ambre (Assurances)
  { tint: vault.aiDeep, bg: semantic.aiBg }, // 3 — violet (Fiscal)
  { tint: vault.folderSteel, bg: vault.folderSteelBg }, // 4 — acier (Banque, NOUVEAU)
  { tint: vault.folderTeal, bg: vault.folderTealBg }, // 5 — sarcelle (Comptable, NOUVEAU)
] as const;

/** Index de teinte des 6 dossiers SYSTÈME — bijection sur la palette (6 identités distinctes). */
export const systemVaultFolderTintIndex = {
  chantiers: 0,
  achats: 1,
  assurances: 2,
  fiscal: 3,
  banque: 4,
  comptable: 5,
} as const;

/**
 * Hachage djb2-xor 32 bits d'un identifiant de dossier — STABLE par construction (aucune
 * dépendance à l'ordre d'insertion ni au runtime) : le même dossier garde sa couleur d'une
 * session à l'autre et d'un appareil à l'autre.
 */
function hashFolderId(folderId: string): number {
  let hash = 5381;
  for (let index = 0; index < folderId.length; index += 1) {
    hash = ((hash * 33) ^ folderId.charCodeAt(index)) >>> 0;
  }
  return hash;
}

/**
 * Teinte d'un dossier du coffre — PURE (testable par mutants) :
 *  · dossier SYSTÈME → sa teinte dédiée (6 distinctes, `systemVaultFolderTintIndex`) ;
 *  · dossier personnalisé → hachage stable sur la palette (`hashFolderId(id) % 6`).
 */
export function folderTintFor(folderId: string): VaultFolderTint {
  const systemIndex =
    systemVaultFolderTintIndex[folderId as keyof typeof systemVaultFolderTintIndex];
  if (systemIndex !== undefined) return vaultFolderTints[systemIndex] as VaultFolderTint;
  return vaultFolderTints[hashFolderId(folderId) % vaultFolderTints.length] as VaultFolderTint;
}

// ----------------------------------------------------------------------------
// RÔLES DÉDIÉS — fin du recyclage des tons (Lot 0, arbitrage TONS RECYCLÉS).
// Un rôle peut RÉFÉRENCER la même primitive qu'aujourd'hui (adoption iso-visuelle,
// doctrine des rôles de couleur ci-dessus) : c'est le CONTRAT d'usage qui change,
// et il permet l'évolution séparée sans re-négocier la typologie client.
// ----------------------------------------------------------------------------
/**
 * Journaux comptables (comptabilite.tsx — JOURNAL_TONE recyclait la typologie client).
 * Valeurs actuelles CONSERVÉES (adoption Lot 5 sans changement visuel). Honnêteté
 * contraste : `achats` hérite du 2,99:1 de l'ambre sur pastel — usage ICÔNE/pastille
 * uniquement, jamais du petit texte (l'évolution est désormais possible rôle par rôle).
 */
export const journal = {
  ventes: { ink: semantic.b2b, bg: semantic.b2bBg },
  achats: { ink: semantic.particulier, bg: semantic.particulierBg },
  banque: { ink: semantic.success, bg: semantic.successBg },
  od: { ink: semantic.b2g, bg: semantic.b2gBg }, // opérations diverses
} as const;

/**
 * Catégories de dépense (depenses.tsx — CAT_TONE recyclait la typologie client).
 * Mêmes clés que le domaine `ExpenseCategory` ; valeurs actuelles conservées
 * (même réserve de contraste que `journal` pour carburant/repas — usage icône).
 */
export const expenseCategory = {
  fournitures: { ink: semantic.success, bg: semantic.successBg },
  materiel: { ink: semantic.b2b, bg: semantic.b2bBg },
  carburant: { ink: semantic.particulier, bg: semantic.particulierBg },
  repas: { ink: semantic.particulier, bg: semantic.particulierBg },
  sous_traitance: { ink: semantic.b2g, bg: semantic.b2gBg },
  autre: { ink: semantic.b2g, bg: semantic.b2gBg },
} as const;

/**
 * Tuile « document » NEUTRE (recherche.tsx peignait la tuile documents en 'success' —
 * le vert reste réservé à l'argent ; l'intérim 'b2g' est REFUSÉ par l'arbitrage).
 * Mêmes primitives que le badge `neutral` (slate sur séparateur doux), contrat distinct :
 * ici une famille de CONTENU (papier), pas un état sorti du flux. 4,96:1 (icône et texte).
 */
export const documentTile = {
  ink: neutrals.slate500,
  bg: neutrals.lineSoft,
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
  /**
   * RETOMBÉE DE BORD (`ProgressiveBlurBob`, 04 § Retombée de bord) : la zone NON INTERACTIVE
   * qui dissout le contenu défilant avant qu'il n'atteigne un chrome flottant.
   *
   * Le mode NOMINAL est `defaultLayers: 0` — un seul `LinearGradient` teinté, un draw call,
   * zéro échantillon de flou. Le PROFIL DE HAUTEURS est celui du contrat, écrit dans son
   * unité d'origine (le POUR CENT), parce que c'est celle que le port reçoit
   * (`BlurLayerSpec.heightPercent`) : le stocker en ratio obligerait à le reconvertir, et
   * `0.88 * 100` ne vaut pas `88` en binaire.
   *
   * Le caractère PROGRESSIF ne vient PAS d'une rampe d'intensité — chaque couche porte la
   * MÊME intensité faible — mais du RECOUVREMENT géométrique de couches FRÈRES : un pixel à
   * la profondeur d est couvert par toutes les couches dont la hauteur ≥ 1 − d, donc
   * l'intensité effective monte de 5 (extrémité libre) à 5 × N (bord ancré), par marches
   * de 5. C'est ce qui rend correcte la troncature aux N PREMIÈRES couches : on garde les
   * plus hautes, celles qui portent le haut de la rampe, là où l'œil lit la dissolution.
   *
   * `maxLayers` est le plafond STRUCTUREL (= longueur du profil) ; le plafond de PRODUCTION
   * vient de `PERF-CALIBRATION` (10 § Budget de la retombée de bord), jamais du confort
   * visuel. `veilLocations` reprend `bottomTabBar.fadeLocations` : le repli opaque doit
   * montrer la MÊME courbe que le mode flouté — même géométrie, même courbe, même couleur,
   * seuls les échantillons de flou disparaissent.
   */
  edgeFalloff: {
    bleed: 44, // dp — débord au-dessus du chrome (BLUR_BLEED de la référence)
    /** Profil du contrat, en POUR CENT : `100 / 88 / 76 / 64 / 54 / 44 / 36 / 28 / 22 / 16 %`. */
    layerHeightsPercent: [100, 88, 76, 64, 54, 44, 36, 28, 22, 16],
    layerIntensity: 5, // uniforme : l'intensité effective vient du recouvrement
    maxLayers: 10, // plafond structurel = longueur du profil
    defaultLayers: 0, // défaut normatif : aucun échantillon de flou
    veilLocations: [0, 0.32, 0.6],
    /**
     * LAVIS DE COUCHE — part MAXIMALE de NOTRE teinte que le kit compose PAR-DESSUS
     * l'échantillon de flou, DANS chaque bande. Le lavis est une RAMPE (0 → cette valeur, du
     * bord libre vers le bord ancré), jamais un aplat : un aplat poserait une couture visible
     * là où le voile vaut encore 0. 0,3 est le compromis du socle — la teinte s'épaissit avec
     * le recouvrement (1 − 0,7^k), exactement au rythme où l'intensité monte de 5 à 5 × N.
     *
     * CE QUE CE TOKEN NE FAIT PAS. Première rédaction : « la dernière couleur composée dans sa
     * bande reste la nôtre, et il n'a aucun moyen de la réduire ». FAUX, et mesuré : parce que
     * la rampe part de ZÉRO, la part du port vaut 1,0000 à la profondeur 0 et 0,5071 encore à
     * 0,16 (canvas / light, N = 10). Notre part ne devient majoritaire qu'après la première
     * marche, atteint 0,9347 au stop médian et 1 dès 0,60.
     *
     * Ce qui rend la doctrine STRUCTURELLE est dans le composant, pas dans ce nombre :
     * `@bob/ui` vérifie que l'élément rendu par le port porte `intensity`, `tint` et `style`
     * tels qu'il les a remis, et ferme la pile sinon. Ce token, lui, garantit la CONFORMITÉ :
     * ce qu'un port honnête peut montrer de sa propre matière, et où.
     */
    layerWash: 0.3,
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

// ----------------------------------------------------------------------------
// WEB — CSS custom properties dérivées du thème actif (consommées par apps/web)
// ----------------------------------------------------------------------------
const px = (value: number): string => `${value}px`;

/**
 * Variables CSS complètes : primitives, sémantiques, contrôles, profondeur et thème actif.
 * À poser sur `:root` (ou un conteneur) côté web. Le web ne recopie donc aucune couleur brute :
 * une évolution de ce fichier est immédiatement reflétée au prochain rendu serveur.
 */
export const toCssVars = (t: BrandTheme): Record<string, string> => {
  const g = gradients(t);
  return {
    '--bob-color-ink-900': neutrals.ink900,
    '--bob-color-ink-800': neutrals.ink800,
    '--bob-color-ink-600': neutrals.ink600,
    '--bob-color-slate-500': neutrals.slate500,
    '--bob-color-slate-400': neutrals.slate400,
    '--bob-color-slate-300': neutrals.slate300,
    '--bob-color-line': neutrals.line,
    '--bob-color-line-soft': neutrals.lineSoft,
    '--bob-color-bg': neutrals.bg,
    '--bob-color-surface': neutrals.surface,
    '--bob-color-success': semantic.success,
    '--bob-color-success-bg': semantic.successBg,
    '--bob-color-success-on-dark': semantic.successOnDark,
    '--bob-color-warning': semantic.warning,
    '--bob-color-warning-bg': semantic.warningBg,
    '--bob-color-danger': semantic.danger,
    '--bob-color-danger-bg': semantic.dangerBg,
    '--bob-color-danger-vivid': semantic.dangerVivid,
    '--bob-color-b2b': semantic.b2b,
    '--bob-color-b2b-bg': semantic.b2bBg,
    '--bob-color-b2g': semantic.b2g,
    '--bob-color-b2g-bg': semantic.b2gBg,
    '--bob-color-ai': semantic.ai,
    '--bob-color-ai-bg': semantic.aiBg,
    '--bob-color-ai-ink': semantic.aiInk,
    '--bob-color-text-primary': resolveColorRole('text.primary'),
    '--bob-color-text-secondary': resolveColorRole('text.secondary'),
    '--bob-color-text-muted': resolveColorRole('text.muted'),
    '--bob-color-navigation-active': resolveColorRole('navigation.active'),
    '--bob-color-navigation-assistant-active': resolveColorRole('navigation.assistantActive'),
    '--bob-color-navigation-inactive': resolveColorRole('navigation.inactive'),
    '--bob-color-disabled': resolveColorRole('nonContent.disabled'),
    '--bob-color-decorative': resolveColorRole('nonContent.decorative'),
    '--bob-control-card-border': controls.cardBorder,
    '--bob-control-checkbox-border': controls.checkboxBorder,
    '--bob-control-sheet-handle': controls.sheetHandle,
    '--bob-control-chevron': controls.chevron,
    '--bob-control-segmented-track': controls.segmentedTrack,
    '--bob-control-ring-track': controls.ringTrack,
    '--bob-control-button-secondary-border': controls.buttonSecondaryBorder,
    '--bob-control-danger-badge-bg': controls.dangerBadgeBg,
    '--bob-control-tab-inactive': controls.tabInactive,
    '--bob-overlay-white-70': overlays.white70,
    '--bob-overlay-white-66': overlays.white66,
    '--bob-overlay-white-60': overlays.white60,
    '--bob-overlay-white-50': overlays.white50,
    '--bob-overlay-white-16': overlays.white16,
    '--bob-overlay-white-14': overlays.white14,
    '--bob-overlay-white-10': overlays.white10,
    '--bob-overlay-white-08': overlays.white08,
    '--bob-overlay-white-07': overlays.white07,
    '--bob-overlay-scrim': overlays.scrim,
    '--bob-overlay-success-pill': overlays.successPill,
    '--bob-shadow-e0': shadow.e0,
    '--bob-shadow-e1': shadow.e1,
    '--bob-shadow-e2': shadow.e2,
    '--bob-shadow-e3': shadow.e3,
    '--bob-shadow-priority-card': shadowComponents.priorityCard,
    '--bob-shadow-conformity-card': shadowComponents.conformityCard,
    '--bob-shadow-hero-money': shadowComponents.heroMoney,
    '--bob-shadow-tab-bar': shadowComponents.tabBar,
    '--bob-radius-sm': px(radius.sm),
    '--bob-radius-chip': px(radius.chip),
    '--bob-radius-squircle': px(radius.squircle),
    '--bob-radius-card': px(radius.card),
    '--bob-radius-card-lg': px(radius.cardLg),
    '--bob-radius-card-xl': px(radius.cardXl),
    '--bob-radius-pill': px(radius.pill),
    '--bob-radius-circle': radius.circle,
    '--bob-font-family-display': fonts.display,
    '--bob-font-family-text': fonts.text,
    '--brand-d1': t.d1,
    '--brand-d2': t.d2,
    '--brand-d3': t.d3,
    '--brand-ink': t.ink,
    '--brand-ink2': t.ink2,
    '--brand-gradient-header': g.header,
    '--brand-gradient-hero': g.hero,
    '--brand-gradient-fab': g.fab,
    '--brand-gradient-cta': g.cta,
  };
};
