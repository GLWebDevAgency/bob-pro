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
export * from './components/button';
export * from './components/status-badge';
export { statusBadgeColors } from './components/status-badge.logic';
export * from './components/avatar';
export * from './components/card';
export * from './components/skeleton';
export * from './components/ui-states';
export * from './hooks/use-reduce-motion';
export * from './components/fade-in';
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

// Chrome
export * from './components/bottom-tab-bar';
export * from './components/fab';
export * from './components/sheet';
export * from './components/question-sheet';
export * from './components/toast';

// Flux (réserve C03 — devis C21)
export * from './components/stepper';
export * from './components/signature-pad';
