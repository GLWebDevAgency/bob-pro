import { describe, expect, it } from 'vitest';
import { isIanaTimeZone, parseIanaTimeZone } from './iana-time-zone';

describe('parseIanaTimeZone', () => {
  it.each([
    ['Europe/Paris', 'Europe/Paris'],
    ['America/Martinique', 'America/Martinique'],
    ['Indian/Reunion', 'Indian/Reunion'],
    ['UTC', 'UTC'],
  ])('accepte et canonicalise un fuseau IANA explicite : %s', (input, expected) => {
    expect(parseIanaTimeZone(input)).toBe(expected);
    expect(isIanaTimeZone(input)).toBe(true);
  });

  it.each([
    'CET',
    'EET',
    'GMT',
    'EST5EDT',
    'CST6CDT',
  ])('accepte une zone IANA historique mono-segment : %s', (input) => {
    expect(parseIanaTimeZone(input)).not.toBeNull();
    expect(isIanaTimeZone(input)).toBe(true);
  });

  it.each([
    null,
    undefined,
    '',
    ' Europe/Paris',
    'Europe/Paris ',
    'Europe Paris',
    '+01:00',
    'Europe/Introuvable',
    'x'.repeat(65),
    123,
  ])("refuse %j sans inventer de valeur de repli", (input) => {
    expect(parseIanaTimeZone(input)).toBeNull();
    expect(isIanaTimeZone(input)).toBe(false);
  });
});
