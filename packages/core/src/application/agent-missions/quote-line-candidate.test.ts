import { describe, expect, it } from 'vitest';
import {
  createQueuedAgentMissionQuoteLineWork,
  normalizeAgentMissionQuoteLineCandidate,
} from './quote-line-candidate';

const candidate = (patch: Readonly<Record<string, unknown>> = {}) => ({
  serviceReference: 'Main-d’œuvre plomberie',
  categoryHint: 'labor',
  quantityDecimal: '2',
  unitReference: 'heure',
  unitPriceDecimal: '55',
  currency: 'EUR',
  priceBasis: 'per_unit',
  vatRateHint: '20',
  ...patch,
});

describe('normalizeAgentMissionQuoteLineCandidate', () => {
  it('convertit par arithmétique décimale exacte vers millièmes et centimes', () => {
    expect(normalizeAgentMissionQuoteLineCandidate(candidate({
      quantityDecimal: '2.125',
      unitPriceDecimal: '55.07',
      vatRateHint: '2.1',
    }))).toEqual({
      ok: true,
      value: {
        serviceReference: 'Main-d’œuvre plomberie',
        category: 'labor',
        quantityMilli: 2_125,
        unit: 'heure',
        unitPriceCents: 5_507,
        requestedVatRate: 2.1,
        priceBasis: 'per_unit',
      },
    });
  });

  it('préserve un prix total sans division ni arrondi caché', () => {
    expect(normalizeAgentMissionQuoteLineCandidate(candidate({
      quantityDecimal: '3',
      unitReference: 'machine',
      unitPriceDecimal: '400',
      priceBasis: 'total',
    }))).toMatchObject({
      ok: true,
      value: {
        quantityMilli: 3_000,
        unitPriceCents: 40_000,
        priceBasis: 'total',
      },
    });
  });

  it('canonise les alias sûrs d’unité et conserve les unités métier libres', () => {
    expect(normalizeAgentMissionQuoteLineCandidate(candidate({
      unitReference: 'heures',
    }))).toMatchObject({
      ok: true,
      value: { unit: 'heure' },
    });
    expect(normalizeAgentMissionQuoteLineCandidate(candidate({
      unitReference: 'machine',
    }))).toMatchObject({
      ok: true,
      value: { unit: 'machine' },
    });
  });

  it('accepte les faits absents sans fabriquer de valeur', () => {
    expect(normalizeAgentMissionQuoteLineCandidate(candidate({
      categoryHint: null,
      quantityDecimal: null,
      unitReference: null,
      unitPriceDecimal: null,
      currency: null,
      priceBasis: null,
      vatRateHint: null,
    }))).toEqual({
      ok: true,
      value: {
        serviceReference: 'Main-d’œuvre plomberie',
        category: null,
        quantityMilli: null,
        unit: null,
        unitPriceCents: null,
        requestedVatRate: null,
        priceBasis: null,
      },
    });
  });

  it.each([
    ['virgule', { quantityDecimal: '2,5' }, 'quantityDecimal'],
    ['zéro préfixé', { unitPriceDecimal: '055' }, 'unitPriceDecimal'],
    ['précision quantité', { quantityDecimal: '1.0001' }, 'quantityDecimal'],
    ['précision prix', { unitPriceDecimal: '1.001' }, 'unitPriceDecimal'],
    ['zéro quantité', { quantityDecimal: '0' }, 'quantityDecimal'],
    ['zéro prix', { unitPriceDecimal: '0' }, 'unitPriceDecimal'],
    ['devise sans prix', {
      unitPriceDecimal: null,
      currency: 'EUR',
      priceBasis: null,
    }, 'price'],
    ['prix sans base', { priceBasis: null }, 'price'],
    ['unité N-1 trop longue', { unitReference: 'u'.repeat(41) }, 'unitReference'],
    ['clé inconnue', { secret: 'x' }, '$'],
  ])('rejette %s', (_label, patch, field) => {
    expect(normalizeAgentMissionQuoteLineCandidate(candidate(patch))).toMatchObject({
      ok: false,
      error: { field },
    });
  });
});

describe('createQueuedAgentMissionQuoteLineWork', () => {
  it('crée une tête de file fermée, non résolue et sans proposition', () => {
    expect(createQueuedAgentMissionQuoteLineWork({
      id: '11111111-1111-4111-8111-111111111111',
      companyId: 'company-1',
      ownerUserId: 'owner-1',
      missionId: '22222222-2222-4222-8222-222222222222',
      ordinal: 1,
      origin: 'user_voice',
      candidate: candidate(),
      occurredAt: '2026-07-29T12:00:00.000Z',
    })).toMatchObject({
      ok: true,
      value: {
        revision: 1,
        state: 'queued',
        catalogueResolution: 'pending',
        catalogueItemId: null,
        expectedCatalogueRevision: null,
        requiredFact: null,
        proposalId: null,
        quantityMilli: 2_000,
        unitPriceCents: 5_500,
      },
    });
  });

  it('repasse par le parseur strict des identités et bornes', () => {
    expect(createQueuedAgentMissionQuoteLineWork({
      id: 'invalid',
      companyId: 'company-1',
      ownerUserId: 'owner-1',
      missionId: '22222222-2222-4222-8222-222222222222',
      ordinal: 1,
      origin: 'user_voice',
      candidate: candidate(),
      occurredAt: '2026-07-29T12:00:00.000Z',
    })).toMatchObject({
      ok: false,
      error: { field: 'id', reason: 'invalid_value' },
    });
  });
});
