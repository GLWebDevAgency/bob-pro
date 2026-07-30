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
export { statusBadgeColors } from './components/status-badge.logic';
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
export * from './components/delete-icon-button';
export * from './components/eyebrow';
export * from './components/section-header';
export * from './components/money-text';

// Accueil
export * from './components/app-header-navy';
export * from './components/floating-balance-card';
export * from './components/priority-card';
export * from './components/kpi-tile';
export * from './components/quick-action';

// Argent & Clients
export * from './components/inner-screen-header';
export * from './components/hero-money-card';
export * from './components/money-row';
export * from './components/segmented-control';
export * from './components/client-row';
export * from './components/score';

// Conformité (divulgation progressive des protections légales)
export * from './components/legal-hint';
export * from './components/legal-hint.logic';

// Chrome
export * from './components/bottom-tab-bar';
export * from './components/fab';
export * from './components/sheet';
export * from './components/question-sheet';
export * from './components/toast';

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
