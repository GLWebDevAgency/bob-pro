import { describe, it, expect } from 'vitest';
import { formatEUR, formatEURWhole } from './money';

const NBSP = String.fromCharCode(0x202f); // espace fine insecable
const EUR = String.fromCharCode(0x20ac); // signe euro

describe('formatEUR', () => {
  it('formate les milliers avec espace fine insecable et virgule decimale', () => {
    expect(formatEUR(162800)).toBe(`1${NBSP}628,00${NBSP}${EUR}`);
  });
  it('formate un petit montant', () => {
    expect(formatEUR(48840)).toBe(`488,40${NBSP}${EUR}`);
  });
  it('gere zero et les negatifs', () => {
    expect(formatEUR(0)).toBe(`0,00${NBSP}${EUR}`);
    expect(formatEUR(-5000)).toBe(`-50,00${NBSP}${EUR}`);
  });
});

describe('formatEURWhole (agrégats du briefing — jamais de centimes)', () => {
  it('formate les milliers sans decimales', () => {
    expect(formatEURWhole(495000)).toBe(`4${NBSP}950${NBSP}${EUR}`);
  });
  it('arrondit a l euro le plus proche', () => {
    expect(formatEURWhole(48840)).toBe(`488${NBSP}${EUR}`);
    expect(formatEURWhole(48850)).toBe(`489${NBSP}${EUR}`);
  });
  it('gere zero et les negatifs (dont -0 arrondi)', () => {
    expect(formatEURWhole(0)).toBe(`0${NBSP}${EUR}`);
    expect(formatEURWhole(-5000)).toBe(`-50${NBSP}${EUR}`);
    expect(formatEURWhole(-40)).toBe(`0${NBSP}${EUR}`);
  });
});
