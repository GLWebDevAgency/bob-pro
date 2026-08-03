/**
 * @bob/ui — primitives UI natives (claim C03, COMPONENT_SPECS.md).
 * Toute couleur vient de @bob/tokens via useTheme() — zéro hex/rgba ici (token-lint).
 */

export {
  ThemeProvider,
  useTheme,
  font,
  parseGradient,
  type PrefsStorage,
  type ThemeContextValue,
  type Personality,
  type Density,
} from './theme';

// Fondamentaux
export * from './components/bob-surface';
export { bobSurfaceColors } from './components/bob-surface.logic';
export * from './components/button';
export * from './components/status-badge';
export {
  STATUS_BADGE_VARIANT_BY_LEGACY_TONE,
  statusBadgeColors,
  statusBadgeRoleColors,
  statusBadgeVariantForLegacyTone,
  type LegacyBadgeTone,
} from './components/status-badge.logic';
export * from './components/avatar';
export * from './components/card';
export * from './components/skeleton';
export * from './components/ui-states';
export * from './hooks/use-reduce-motion';
export * from './components/fade-in';
export * from './components/motion-presence';
export {
  diffRowPresence,
  mergeExitingKeys,
  resolvePresenceMotion,
  type PresenceMotion,
} from './components/motion-presence.logic';
export * from './components/pressable-scale';
export * from './components/icon-tile';
// Lot 5 — dataviz vivante & verre sombre (plan DA 01/08)
export * from './components/trend-bars';
export {
  TREND_BARS_ANIMATION_MS,
  clampTrendBarPct,
  resolveTrendBarsMotion,
  type TrendBarsMotion,
} from './components/trend-bars.logic';
export * from './components/glass-panel-dark';
export { glassPanelDarkStyle } from './components/glass-panel-dark.logic';
export * from './components/delete-icon-button';
export * from './components/eyebrow';
export * from './components/section-header';
export * from './components/money-text';
export * from './components/error-notice';
export {
  errorNoticeDarkFace,
  errorNoticeReportText,
  resolveErrorNoticeCopy,
  type ErrorNoticeDarkFace,
  type ErrorNoticeFacts,
} from './components/error-notice.logic';
// Grammaire d'erreur (Lot 0) — la feuille d'échec de mutation appelable au support.
export * from './components/error-sheet';

// Accueil
export * from './components/app-header-navy';
export * from './components/floating-balance-card';
export * from './components/priority-card';
export * from './components/kpi-tile';
export * from './components/quick-action';

// Argent & Clients
export * from './components/inner-screen-header';
// Lot 0 — BackHeader canonique (promotion du screen-header local d'apps/mobile).
export * from './components/back-header';
// Lot 0 — barres sticky (fusion StickyCtaBar/StickyActionBar) + rangée retour sticky.
export * from './components/sticky-action-bar';
export {
  STICKY_FLOATING_ACCENT_WIDTH,
  STICKY_FLOATING_MIN_HEIGHT,
  stickyBarContainerStyle,
  stickyFloatingContainerStyle,
  stickyFloatingPillStyle,
  type StickyActionBarVariant,
  type StickyBarPalette,
} from './components/sticky-action-bar.logic';
export * from './components/sticky-back-row';
export {
  STICKY_BACK_ROW_MIN_TARGET,
  stickyBackRowContainerStyle,
} from './components/sticky-back-row.logic';
// Lot 0 — bandeau d'état pastel + encre foncée AA (résorbe 6 duplications).
export * from './components/status-strip';
export {
  statusStripColors,
  type StatusStripColors,
  type StatusStripPalette,
} from './components/status-strip.logic';
// Lot 0 — champ de recherche (loupe + clear 44) et champs de formulaire à label visible.
export * from './components/search-field';
export { searchClearVisible } from './components/search-field.logic';
export * from './components/form-field';
export { applyDateMask, formFieldBorderColor } from './components/form-field.logic';
// Lot 0 — bouton d'icône de header (squircle 44×44, radius 13 — l'arbitrage).
export * from './components/header-icon-button';
export {
  HEADER_ICON_BUTTON_RADIUS,
  HEADER_ICON_BUTTON_SIZE,
  headerIconButtonStyle,
} from './components/header-icon-button.logic';
export * from './components/hero-money-card';
export * from './components/money-row';
// Lot 1 — cœur quotidien : échéance (promotion du FiscalDeadlineRow local) + coach-mark.
export * from './components/deadline-row';
export * from './components/tip-card';
export * from './components/segmented-control';
// Lot 3 — ventes & pièces : chip de filtre actif (croix, cible 44, sélection ink),
// rangée de pièce de vente, aperçu de message pré-rédigé.
export * from './components/filter-chip';
export {
  FILTER_CHIP_HEIGHT,
  FILTER_CHIP_TINT_SHARE,
  filterChipColors,
  type FilterChipColors,
  type FilterChipPalette,
} from './components/filter-chip.logic';
export * from './components/piece-list-row';
export * from './components/quote-preview-box';
export * from './components/client-row';
export * from './components/score';
// Lot 4 — CRM terrain : fil rouge « couleur de l'argent » + visionneuse + interrupteur kit.
export {
  standingAccentColor,
  standingAccentRole,
  type StandingAccentPalette,
  type StandingAccentRole,
} from './components/standing-accent.logic';
export * from './components/photo-viewer';
export { photoViewerAnimationType, type PhotoViewerAnimation } from './components/photo-viewer.logic';
export * from './components/bob-switch';
export {
  bobSwitchThumbOffset,
  bobSwitchTrackColor,
  type BobSwitchPalette,
} from './components/bob-switch.logic';

// Conformité (divulgation progressive des protections légales)
export * from './components/legal-hint';
export * from './components/legal-hint.logic';

// Chrome
export * from './components/bottom-tab-bar';
export * from './components/fab';
export * from './components/sheet';
export * from './components/question-sheet';
export * from './components/toast';
export {
  toastToneAccent,
  type ToastToneAccent,
  type ToastTonePalette,
} from './components/toast.logic';

// Flux (réserve C03 — devis C21)
export * from './components/stepper';
export * from './components/signature-pad';

// ----------------------------------------------------------------------------
// KIT « MATIÈRE BOB » — retombée de bord (04 § Retombée de bord)
// `@bob/ui` n'importe NI `expo-blur` NI aucune dépendance nouvelle : le port est INJECTÉ par
// l'application, et le voile teinté — celui qui porte NOTRE identité — est rendu ici.
// ----------------------------------------------------------------------------
export {
  ProgressiveBlurBob,
  type ProgressiveBlurBobViewProps,
} from './components/progressive-blur-bob';
// Lot 0 — le voile de header : mécanisme UNIQUE décliné en variantes de montée.
export * from './components/header-veil';
export {
  DEFAULT_HEADER_VEIL_HEIGHT,
  headerVeilPreset,
  type HeaderVeilPreset,
  type HeaderVeilVariant,
} from './components/header-veil.logic';
export {
  defineBlurPort,
  isSealedBlurPort,
  resolveBlurPort,
  type ResolvedBlurPort,
} from './components/progressive-blur-bob.port';
export type {
  BlurLayerSpec,
  ProgressiveBlurBobProps,
  RenderBlurLayer,
} from './components/progressive-blur-bob.types';
export {
  BLUR_PORT_FAILURE_WARNINGS,
  DEFAULT_EDGE_FALLOFF_LAYERS,
  EDGE_FALLOFF_HEIGHT_PROFILE,
  MAX_EDGE_FALLOFF_LAYERS,
  blurLayerStyle,
  bobTintShareAt,
  edgeFalloffHeight,
  edgeVeilGradient,
  edgeWashGradient,
  effectiveIntensityAt,
  layerHeightPoints,
  layerVisibility,
  progressiveBlurPlan,
  progressiveBlurWarnings,
  resolveBlurMaterial,
  resolveBlurTint,
  veilOpacityAt,
  veilResidual,
  visibleLayerCount,
  washRampAt,
  type BlurAnchor,
  type BlurPortFailure,
  type BlurPortStatus,
  type BlurRenderCapability,
  type BlurSurfaceUnder,
  type BobBlurMaterial,
  type EdgeFalloffMode,
  type EdgeFalloffReason,
  type ProgressiveBlurPlan,
  type TransparencyPreference,
} from './components/progressive-blur-bob.logic';
export { useTransparencyPreference } from './hooks/use-transparency-preference';

// ----------------------------------------------------------------------------
// PORTAGE DE LA TAB BAR — 04 § Comportement normatif de la tab bar (les SIX comportements).
// `@bob/ui` ne porte ici que la LOGIQUE PURE et les PORTS : ni `react-native-reanimated`, ni
// `react-native-gesture-handler`, ni `expo-haptics` ne franchissent cette frontière. Le rendu
// animé vit dans `apps/mobile`, où ces runtimes sont déclarés.
// ----------------------------------------------------------------------------
export {
  ASSISTANT_TAB_KEY,
  MINIMIZE_DEAD_ZONE,
  MINIMIZE_TOP_GUARD,
  SCRUB_ACTIVE_OFFSET_X,
  SCRUB_FAIL_OFFSET_Y,
  SCRUB_TAP_MAX_DISTANCE,
  SCRUB_TAP_MAX_DURATION,
  TAB_BAR_BLEED,
  TAB_BAR_BORDER_WIDTH,
  TAB_BAR_EXPANDED_VISUAL,
  TAB_BAR_MARGIN,
  TAB_BAR_MINIMIZED_VISUAL,
  TAB_BAR_MINIMIZE_SPRING,
  TAB_BAR_MIN_BOTTOM,
  TAB_BAR_OUTER_RHYTHM,
  TAB_BAR_ROW_PAD_H,
  TAB_BAR_SAFE_AREA_TRIM,
  TAB_BAR_SIDE_INSET,
  TAB_BAR_SLIDE_SPRING,
  TAB_BAR_TOUCH_TARGET,
  TAB_LABEL_MAX_LINES,
  TAB_SLOT_ENTER_SCALE,
  boundaryTick,
  contrastRatio,
  effectiveDuration,
  fadeThroughPlan,
  affordableSideInset,
  highlightProximity,
  highlightTranslateX,
  longestWord,
  minimizeDecision,
  minimumWindowWidth,
  mixTint,
  motionAllowed,
  resolveBarLabelTier,
  resolveTabLabelTier,
  sampleTintCourse,
  scrubAllowed,
  shouldRetargetMinimize,
  tabActiveTint,
  tabBarBottomOffset,
  tabBarGeometry,
  tabBarGeometryBounds,
  tabIndexAtX,
  tabTintPalette,
  touchTargetFloor,
  type FadeThroughInput,
  type FadeThroughPlan,
  type MinimizeScrollDecision,
  type MinimizeScrollInput,
  type PreferenceState,
  type TabBarGeometry,
  type TabBarGeometryBounds,
  type TabBarMetrics,
  type TabBarPlatform,
  type TabLabelMeasurement,
  type TabLabelTier,
  type TabTintPalette,
  type TintCourseSample,
} from './components/bob-tab-bar.logic';
export {
  defineTabHapticPort,
  isSealedTabHapticPort,
  resolveTabHapticPort,
  tickSafely,
  type ResolvedTabHapticPort,
  type TabHapticGate,
  type TabHapticKind,
  type TabHapticPort,
  type TabHapticPortStatus,
} from './components/bob-tab-bar.haptics';
export {
  useReduceMotionPreference,
  useScreenReaderPreference,
} from './hooks/use-accessibility-preference';
