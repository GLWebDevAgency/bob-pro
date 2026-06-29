import { describe, it, expect } from 'vitest';
import { Quantity } from './quantity';

describe('Quantity', () => {
  it('refuse <= 0', () => {
    expect(Quantity.of(0).ok).toBe(false);
  });
  it('refuse > 3 decimales', () => {
    expect(Quantity.of(1.2345).ok).toBe(false);
  });
  it('accepte 2.5', () => {
    expect(Quantity.of(2.5).ok).toBe(true);
  });
});
