import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';
import { themes, toCssVars } from './index';

const GENERATED_CSS = readFileSync(
  fileURLToPath(new URL('./variables.css', import.meta.url)),
  'utf8',
);

function generatedThemeBlock(themeName: keyof typeof themes): string {
  const selector = `[data-bob-theme="${themeName}"] {`;
  const start = GENERATED_CSS.indexOf(selector);
  if (start < 0) throw new Error(`Bloc CSS ${selector} introuvable.`);
  const end = GENERATED_CSS.indexOf('\n}', start);
  if (end < 0) throw new Error(`Fin du bloc CSS ${selector} introuvable.`);
  return GENERATED_CSS.slice(start, end + 2);
}

function generatedThemeVariables(themeName: keyof typeof themes): Record<string, string> {
  const declarations = generatedThemeBlock(themeName)
    .split('\n')
    .slice(1, -1)
    .filter((line) => line.trim().length > 0)
    .map((line) => {
      const match = /^\s*(--[^:]+):\s*(.*);$/.exec(line);
      if (match?.[1] === undefined || match[2] === undefined) {
        throw new Error(`Déclaration CSS invalide dans ${themeName}: ${line}`);
      }
      return [match[1], match[2]] as const;
    });
  const variables = Object.fromEntries(declarations);
  if (Object.keys(variables).length !== declarations.length) {
    throw new Error(`Variable CSS dupliquée dans le thème ${themeName}.`);
  }
  return variables;
}

describe('toCssVars (web)', () => {
  it('expose le thème actif en variables CSS --brand-*', () => {
    const vars = toCssVars(themes.marine);
    expect(vars['--brand-d1']).toBe('#0C2340');
    expect(vars['--brand-ink2']).toBe('#1B3A63');
    expect(vars['--brand-gradient-header']).toContain('linear-gradient(168deg');
    expect(vars['--brand-gradient-header']).toContain('#0C2340');
  });

  it('expose aussi les primitives et sémantiques partagées, sans valeur web parallèle', () => {
    const vars = toCssVars(themes.marine);
    expect(vars['--bob-color-ink-900']).toBe('#0C2340');
    expect(vars['--bob-color-success']).toBe('#0E7C5A');
    expect(vars['--bob-control-button-secondary-border']).toBe('#D9E0E8');
    expect(vars['--bob-shadow-e2']).toContain('rgba(13,38,68');
    expect(vars['--bob-font-family-display']).toBe('Schibsted Grotesk');
    expect(vars['--bob-font-family-text']).toBe('Hanken Grotesk');
  });

  it('suit le switch de thème', () => {
    expect(toCssVars(themes.indigo)['--brand-d3']).toBe('#4F46E5');
    expect(toCssVars(themes.foret)['--brand-d1']).toBe('#0A3A2B');
  });

  it.each([
    ['marine', '#AECFFB'],
    ['foret', '#AEFBE4'],
    ['graphite', '#AECAFB'],
    ['indigo', '#B7AEFB'],
  ] as const)('publie l’accent exact du thème %s', (themeName, accent) => {
    expect(toCssVars(themes[themeName])['--brand-accent']).toBe(accent);
  });

  it('publie tous les rôles transverses ajoutés par le Lot 0', () => {
    expect(toCssVars(themes.marine)).toMatchObject({
      '--bob-color-success-ink': '#0E5C44',
      '--bob-color-warning-ink': '#8A5A12',
      '--bob-overlay-white-80': 'rgba(255,255,255,.8)',
      '--bob-overlay-photo-scrim': 'rgba(0,0,0,.92)',
      '--bob-overlay-scrim-chrome': '#FFFFFF',
      '--bob-spacing-gutter': '20px',
      '--bob-spacing-section-gap': '20px',
      '--bob-spacing-item-gap': '12px',
      '--bob-spacing-intra-gap': '14px',
      '--bob-spacing-card-pad': '16px',
      '--bob-spacing-hero-pad': '20px',
      '--bob-type-sheet-title-family': 'Schibsted Grotesk',
      '--bob-type-sheet-title-size': '20px',
      '--bob-type-sheet-title-weight': '700',
      '--bob-type-sheet-title-tracking': '-0.5px',
      '--bob-type-wizard-title-family': 'Schibsted Grotesk',
      '--bob-type-wizard-title-size': '24px',
      '--bob-type-wizard-title-weight': '700',
      '--bob-type-wizard-title-tracking': '-0.4px',
      '--bob-type-money-hero-family': 'Schibsted Grotesk',
      '--bob-type-money-hero-size': '27px',
      '--bob-type-money-hero-weight': '800',
      '--bob-journal-ventes-ink': '#1B3A63',
      '--bob-journal-achats-ink': '#C77A12',
      '--bob-journal-banque-ink': '#0E7C5A',
      '--bob-journal-od-ink': '#4338CA',
      '--bob-expense-category-fournitures-ink': '#0E7C5A',
      '--bob-expense-category-materiel-ink': '#1B3A63',
      '--bob-expense-category-carburant-ink': '#C77A12',
      '--bob-expense-category-repas-ink': '#C77A12',
      '--bob-expense-category-sous-traitance-ink': '#4338CA',
      '--bob-expense-category-autre-ink': '#4338CA',
      '--bob-document-tile-ink': '#5B6B7B',
      '--bob-document-tile-bg': '#F1F4F7',
      '--bob-vault-folder-projects-tint': '#1B3A63',
      '--bob-vault-folder-purchases-tint': '#0E7C5A',
      '--bob-vault-folder-insurance-tint': '#C77A12',
      '--bob-vault-folder-tax-social-tint': '#6D28D9',
      '--bob-vault-folder-bank-tint': '#3B5B85',
      '--bob-vault-folder-accounting-tint': '#0E6E73',
    });
  });

  it.each(Object.keys(themes) as Array<keyof typeof themes>)(
    'garde variables.css strictement identique à toCssVars pour le thème %s',
    (themeName) => {
      expect(generatedThemeVariables(themeName)).toEqual(toCssVars(themes[themeName]));
    },
  );

  it('épingle les angles des dégradés dérivés (header 168 · hero 150 · fab 145 · cta 135)', () => {
    const vars = toCssVars(themes.marine);
    expect(vars['--brand-gradient-header']).toContain('168deg');
    expect(vars['--brand-gradient-hero']).toContain('150deg');
    expect(vars['--brand-gradient-fab']).toContain('145deg');
    expect(vars['--brand-gradient-cta']).toContain('135deg');
  });
});
