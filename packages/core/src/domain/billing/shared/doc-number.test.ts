import { describe, it, expect } from 'vitest';
import { DocNumber } from './doc-number';

describe('DocNumber', () => {
  it('formate D-2026-0014', () => {
    expect(DocNumber.format('D', 2026, 14).value).toBe('D-2026-0014');
  });
  it('valide un numero bien forme', () => {
    expect(DocNumber.of('F-2026-0118').ok).toBe(true);
  });
  it('rejette un format invalide', () => {
    expect(DocNumber.of('2026/118').ok).toBe(false);
  });
});
