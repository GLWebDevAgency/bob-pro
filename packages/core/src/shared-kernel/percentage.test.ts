import { describe, it, expect } from 'vitest';
import { Percentage } from './percentage';

describe('Percentage', () => {
  it('accepte 0..100', () => {
    expect(Percentage.of(30).ok).toBe(true);
  });
  it('refuse hors bornes', () => {
    expect(Percentage.of(120).ok).toBe(false);
    expect(Percentage.of(-1).ok).toBe(false);
  });
});
