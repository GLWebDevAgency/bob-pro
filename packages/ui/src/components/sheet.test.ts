import { describe, expect, it } from 'vitest';
import {
  SHEET_EDGE_GAP,
  SHEET_HEADER_HEIGHT,
  resolveSheetGeometry,
} from './sheet.logic';

describe('resolveSheetGeometry', () => {
  it('réserve les safe areas haute, basse et latérales', () => {
    expect(
      resolveSheetGeometry(844, { top: 47, right: 0, bottom: 34, left: 0 }),
    ).toEqual({
      maxHeight: 844 - 47 - SHEET_EDGE_GAP,
      contentMaxHeight: 844 - 47 - SHEET_EDGE_GAP - SHEET_HEADER_HEIGHT,
      paddingLeft: 20,
      paddingRight: 20,
      paddingBottom: 34,
    });
  });

  it('reste borné en paysage avec une encoche latérale', () => {
    const geometry = resolveSheetGeometry(390, {
      top: 0,
      right: 47,
      bottom: 21,
      left: 47,
    });

    expect(geometry.maxHeight).toBe(382);
    expect(geometry.contentMaxHeight).toBe(334);
    expect(geometry.paddingLeft).toBe(67);
    expect(geometry.paddingRight).toBe(67);
    expect(geometry.paddingBottom).toBe(21);
  });

  it('ne produit jamais de hauteur négative dans une fenêtre transitoire', () => {
    expect(
      resolveSheetGeometry(40, { top: 47, right: 0, bottom: 34, left: 0 }),
    ).toMatchObject({ maxHeight: 0, contentMaxHeight: 0 });
  });
});
