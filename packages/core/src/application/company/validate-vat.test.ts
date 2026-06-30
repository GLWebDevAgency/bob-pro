import { describe, it, expect } from 'vitest';
import { ValidateVatNumber, normalizeVatNumber } from './validate-vat';
import { type VatValidationPort, type VatCheckOutcome } from '../ports/vat-validation';

const clock = { today: () => '2026-06-30', now: () => '2026-06-30T00:00:00.000Z' } as const;
const port = (o: VatCheckOutcome): VatValidationPort => ({ async check() { return o; } });

describe('ValidateVatNumber', () => {
  it('normalise et renvoie le statut + la date', async () => {
    const r = await new ValidateVatNumber({ vat: port({ status: 'valid', name: 'SA LA POSTE', consultationNumber: null }), clock }).execute({ vatNumber: 'fr 39 356000000' });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.vatNumber).toBe('FR39356000000');
      expect(r.value.status).toBe('valid');
      expect(r.value.checkedAt).toBe('2026-06-30');
    }
  });

  it('rejette un format invalide sans appeler le port', async () => {
    let called = false;
    const spy: VatValidationPort = { async check() { called = true; return { status: 'valid', name: null, consultationNumber: null }; } };
    const r = await new ValidateVatNumber({ vat: spy, clock }).execute({ vatNumber: '123' });
    expect(r.ok).toBe(false);
    expect(called).toBe(false);
  });

  it("propage 'unverified' (service indispo, jamais bloquant)", async () => {
    const r = await new ValidateVatNumber({ vat: port({ status: 'unverified', name: null, consultationNumber: null }), clock }).execute({ vatNumber: 'FR39356000000' });
    expect(r.ok && r.value.status).toBe('unverified');
  });
});

describe('normalizeVatNumber', () => {
  it('majuscule + sans espaces', () => {
    expect(normalizeVatNumber(' fr39 356000000 ')).toBe('FR39356000000');
  });
});
