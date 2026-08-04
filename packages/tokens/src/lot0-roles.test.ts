/**
 * Lot 0 (plan DA 01/08) — rôles couleur dédiés, teintes dossiers du coffre, overlays on-dark.
 * Les attendus sont des LITTÉRAUX calculés à la main (formules WCAG identiques à index.test.ts,
 * calculs en commentaire) — jamais recalculés depuis l'implémentation.
 */
import { describe, expect, it } from 'vitest';
import {
  documentTile,
  expenseCategory,
  folderTintFor,
  journal,
  neutrals,
  overlays,
  semantic,
  systemVaultFolderTintIndex,
  themes,
  vault,
  vaultFolderTints,
} from './index';

function relativeLuminance(hex: string): number {
  if (!/^#[\da-f]{6}$/i.test(hex)) throw new Error(`#RRGGBB attendu, reçu: ${hex}`);
  const channels = [1, 3, 5].map((start) => Number.parseInt(hex.slice(start, start + 2), 16) / 255);
  const linear = channels.map((channel) =>
    channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4,
  );
  return 0.2126 * (linear[0] ?? 0) + 0.7152 * (linear[1] ?? 0) + 0.0722 * (linear[2] ?? 0);
}

function contrastRatio(foreground: string, background: string): number {
  const fg = relativeLuminance(foreground);
  const bg = relativeLuminance(background);
  return (Math.max(fg, bg) + 0.05) / (Math.min(fg, bg) + 0.05);
}

/** Compose `rgba(r,g,b,a)` sur un fond hex opaque → hex composé (canal par canal, arrondi). */
function composeOver(rgba: string, backgroundHex: string): string {
  const match = /^rgba\((\d+),(\d+),(\d+),(\.?[\d.]+)\)$/.exec(rgba.replaceAll(' ', ''));
  if (match === null) throw new Error(`rgba(r,g,b,a) attendu, reçu: ${rgba}`);
  const alpha = Number(match[4]);
  const fg = [Number(match[1]), Number(match[2]), Number(match[3])];
  const bg = [1, 3, 5].map((start) => Number.parseInt(backgroundHex.slice(start, start + 2), 16));
  const out = fg.map((channel, index) => Math.round(channel * alpha + (bg[index] ?? 0) * (1 - alpha)));
  return `#${out.map((channel) => channel.toString(16).padStart(2, '0')).join('')}`;
}

describe('Lot 0 — teintes des dossiers du coffre (folderTintFor)', () => {
  it('donne 6 teintes DISTINCTES aux 6 dossiers système (bijection sur la palette)', () => {
    const systemKeys = ['projects', 'purchases', 'insurance', 'tax_social', 'bank', 'accounting'] as const;
    const pairs = systemKeys.map((systemKey) => folderTintFor({ id: `folder-${systemKey}`, systemKey }));
    // 6 fonds distincts ET 6 encres distinctes — la couleur-repère code l'identité.
    expect(new Set(pairs.map((pair) => pair.bg)).size).toBe(6);
    expect(new Set(pairs.map((pair) => pair.tint)).size).toBe(6);
    // Affectation exacte, épinglée en littéraux (l'ordre de la palette est le contrat).
    expect(folderTintFor({ id: 'uuid-projects', systemKey: 'projects' })).toEqual({ tint: '#1B3A63', bg: '#E6EDF6' }); // marine
    expect(folderTintFor({ id: 'uuid-purchases', systemKey: 'purchases' })).toEqual({ tint: '#0E7C5A', bg: '#EAF2EC' }); // vert
    expect(folderTintFor({ id: 'uuid-insurance', systemKey: 'insurance' })).toEqual({ tint: '#C77A12', bg: '#FBF0DF' }); // ambre
    expect(folderTintFor({ id: 'uuid-tax', systemKey: 'tax_social' })).toEqual({ tint: '#6D28D9', bg: '#E5DBF6' }); // violet
    expect(folderTintFor({ id: 'uuid-bank', systemKey: 'bank' })).toEqual({ tint: '#3B5B85', bg: '#E9EFF7' }); // acier (NOUVEAU)
    expect(folderTintFor({ id: 'uuid-accounting', systemKey: 'accounting' })).toEqual({ tint: '#0E6E73', bg: '#DFEFF0' }); // sarcelle (NOUVEAU)
  });

  it("utilise systemKey comme identité stable même si l'UUID serveur change", () => {
    expect(folderTintFor({ id: 'uuid-a', systemKey: 'bank' })).toBe(
      folderTintFor({ id: 'uuid-b', systemKey: 'bank' }),
    );
  });

  it('hache STABLEMENT les dossiers personnalisés sur la palette (djb2-xor % 6, littéraux vérifiés à la main)', () => {
    // djb2-xor (h=5381 ; h = (h*33 ^ code) >>> 0) calculé à la main via Node :
    //  'garanties-decennales' → 2396616772 ; 2396616772 % 6 = 4 → acier.
    //  'photos-avant-apres'   → 282092707  ; 282092707  % 6 = 1 → vert.
    //  'sous-traitants-2026'  → 3549554955 ; 3549554955 % 6 = 3 → violet.
    expect(folderTintFor({ id: 'garanties-decennales', systemKey: null })).toEqual({ tint: '#3B5B85', bg: '#E9EFF7' });
    expect(folderTintFor({ id: 'photos-avant-apres', systemKey: null })).toEqual({ tint: '#0E7C5A', bg: '#EAF2EC' });
    expect(folderTintFor({ id: 'sous-traitants-2026', systemKey: null })).toEqual({ tint: '#6D28D9', bg: '#E5DBF6' });
    // Stabilité : le même id rend la MÊME paire à chaque appel (référence de palette comprise).
    expect(folderTintFor({ id: 'garanties-decennales', systemKey: null })).toBe(
      folderTintFor({ id: 'garanties-decennales', systemKey: null }),
    );
  });

  it('expose la palette ordonnée et l’index système comme contrat public', () => {
    expect(vaultFolderTints).toHaveLength(6);
    expect(systemVaultFolderTintIndex).toEqual({
      projects: 0,
      purchases: 1,
      insurance: 2,
      tax_social: 3,
      bank: 4,
      accounting: 5,
    });
  });

  it('certifie les 2 teintes NOUVELLES : acier 6,01:1 et sarcelle 5,07:1 sur leur pastel', () => {
    // L(#3B5B85)=0.1053… ; L(#E9EFF7)=0.8434… ; (0.8434+0.05)/(0.1053+0.05) = 6.009.
    expect(Number(contrastRatio(vault.folderSteel, vault.folderSteelBg).toFixed(3))).toBe(6.009);
    // L(#0E6E73)=0.1249… ; L(#DFEFF0)=0.8375… ; (0.8375+0.05)/(0.1249+0.05) = 5.074.
    expect(Number(contrastRatio(vault.folderTeal, vault.folderTealBg).toFixed(3))).toBe(5.074);
  });
});

describe('Lot 0 — accents on-dark des thèmes (fin de l’emprunt vault.scanChipIcon)', () => {
  it('indigo.accent REPREND exactement la valeur empruntée (#B7AEFB = vault.scanChipIcon)', () => {
    expect(themes.indigo.accent).toBe('#B7AEFB');
    expect(themes.indigo.accent).toBe(vault.scanChipIcon);
  });

  it('chaque thème porte un accent ≥ 3:1 sur d3, le bord le plus CLAIR de sa rampe (littéraux)', () => {
    // Ratios calculés à la main (mêmes formules WCAG) : accent / d3 du thème.
    // marine  #AECFFB / #163763 = 7.450 · foret #AEFBE4 / #117A5A = 4.480
    // graphite #AECAFB / #36404E = 6.320 · indigo #B7AEFB / #4F46E5 = 3.132
    expect(Number(contrastRatio(themes.marine.accent, themes.marine.d3).toFixed(3))).toBe(7.45);
    expect(Number(contrastRatio(themes.foret.accent, themes.foret.d3).toFixed(3))).toBe(4.48);
    expect(Number(contrastRatio(themes.graphite.accent, themes.graphite.d3).toFixed(3))).toBe(6.32);
    expect(Number(contrastRatio(themes.indigo.accent, themes.indigo.d3).toFixed(3))).toBe(3.132);
    for (const theme of Object.values(themes)) {
      expect(contrastRatio(theme.accent, theme.d3)).toBeGreaterThanOrEqual(3);
    }
  });
});

describe('Lot 0 — overlays on-dark (photoScrim, chrome, corps ≥ white80 / détail ≥ white70)', () => {
  it('photoScrim est le noir .92 déjà posé par la visionneuse, et le chrome est blanc plein', () => {
    expect(overlays.photoScrim).toBe('rgba(0,0,0,.92)');
    expect(overlays.scrimChrome).toBe('#FFFFFF');
    expect(overlays.white80).toBe('rgba(255,255,255,.8)');
  });

  it('corps white80 : AA (≥ 4,5) composé sur le PIRE cas du scrim (photo blanche dessous)', () => {
    // Scrim .92 sur photo blanche : 0×.92 + 255×.08 = 20.4 → arrondi 20 → #141414.
    const scrimOnWhite = composeOver(overlays.photoScrim, '#ffffff');
    expect(scrimOnWhite).toBe('#141414');
    // white80 composé sur #141414 : 255×.8 + 20×.2 = 208 → #d0d0d0 ; ratio = 11.944.
    const body = composeOver(overlays.white80, scrimOnWhite);
    expect(body).toBe('#d0d0d0');
    expect(Number(contrastRatio(body, scrimOnWhite).toFixed(3))).toBe(11.944);
  });

  it('détail white70 : AA composé sur le scrim (9,39:1) — le plancher de la doctrine', () => {
    const scrimOnWhite = composeOver(overlays.photoScrim, '#ffffff');
    // white70 sur #141414 : 255×.7 + 20×.3 = 184.5 → arrondi 185 → #b9b9b9 ; ratio = 9.389.
    const detail = composeOver(overlays.white70, scrimOnWhite);
    expect(detail).toBe('#b9b9b9');
    expect(Number(contrastRatio(detail, scrimOnWhite).toFixed(3))).toBe(9.389);
  });

  it('sur les rampes sombres (diagnostic — indigo) : corps AA sur d1/d2, détail ≥ 3 jusqu’à d3', () => {
    // white80 sur d1 #272363 = 9.419 ; sur d2 #3A36A0 = 6.704 — AA petit texte.
    expect(
      contrastRatio(composeOver(overlays.white80, themes.indigo.d1), themes.indigo.d1),
    ).toBeGreaterThanOrEqual(4.5);
    expect(
      contrastRatio(composeOver(overlays.white80, themes.indigo.d2), themes.indigo.d2),
    ).toBeGreaterThanOrEqual(4.5);
    // Borne honnête : white70 sur d3 #4F46E5 (le bord le plus clair) = 3.927 — ≥ 3 (grand
    // texte / icône), PAS ≥ 4,5 : sur d3, le petit texte doit monter à white80 (4.626).
    const detailOnD3 = contrastRatio(composeOver(overlays.white70, themes.indigo.d3), themes.indigo.d3);
    expect(detailOnD3).toBeGreaterThanOrEqual(3);
    expect(detailOnD3).toBeLessThan(4.5);
    expect(
      contrastRatio(composeOver(overlays.white80, themes.indigo.d3), themes.indigo.d3),
    ).toBeGreaterThanOrEqual(4.5);
  });
});

describe('Lot 0 — rôles dédiés (journaux, catégories de dépense, tuile document)', () => {
  it('épingle les journaux sur les primitives ACTUELLES (adoption Lot 5 iso-visuelle)', () => {
    expect(journal.ventes).toEqual({ ink: semantic.b2b, bg: semantic.b2bBg });
    expect(journal.achats).toEqual({ ink: semantic.particulier, bg: semantic.particulierBg });
    expect(journal.banque).toEqual({ ink: semantic.success, bg: semantic.successBg });
    expect(journal.od).toEqual({ ink: semantic.b2g, bg: semantic.b2gBg });
  });

  it('épingle les catégories de dépense sur les primitives ACTUELLES (clés = ExpenseCategory)', () => {
    expect(Object.keys(expenseCategory)).toEqual([
      'fournitures',
      'materiel',
      'carburant',
      'repas',
      'sous_traitance',
      'autre',
    ]);
    expect(expenseCategory.fournitures).toEqual({ ink: semantic.success, bg: semantic.successBg });
    expect(expenseCategory.materiel).toEqual({ ink: semantic.b2b, bg: semantic.b2bBg });
    expect(expenseCategory.carburant).toEqual({ ink: semantic.particulier, bg: semantic.particulierBg });
    expect(expenseCategory.repas).toEqual({ ink: semantic.particulier, bg: semantic.particulierBg });
    expect(expenseCategory.sous_traitance).toEqual({ ink: semantic.b2g, bg: semantic.b2gBg });
    expect(expenseCategory.autre).toEqual({ ink: semantic.b2g, bg: semantic.b2gBg });
  });

  it('tuile document = NEUTRE (slate sur séparateur doux), 4,96:1 — le vert reste à l’argent', () => {
    expect(documentTile).toEqual({ ink: neutrals.slate500, bg: neutrals.lineSoft });
    // L(#5B6B7B)=0.1360… ; L(#F1F4F7)=0.8730… ; (0.8730+0.05)/(0.1360+0.05) = 4.962.
    expect(Number(contrastRatio(documentTile.ink, documentTile.bg).toFixed(3))).toBe(4.962);
  });
});
