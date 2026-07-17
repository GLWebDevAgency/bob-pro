import { describe, expect, it } from 'vitest';
import type { CompanyLookupResult } from '@bob/core';
import { registerInputFromLookup } from './company-draft';

const lookup: CompanyLookupResult = {
  siren: '552100554',
  siret: '55210055400013',
  denomination: 'Entreprise réelle',
  nafApe: '4322A',
  trade: 'plombier',
  natureJuridiqueCode: '1000',
  legalForm: 'EI',
  dateCreation: '2024-01-01',
  address: { line1: '1 rue Réelle', zip: '75001', city: 'Paris' },
  tvaIntracom: null,
  rge: false,
};

describe('registerInputFromLookup', () => {
  it.each(['franchise', 'reel_simpl', 'reel_normal'] as const)(
    'persiste le régime TVA explicitement confirmé: %s',
    (vatRegime) => {
      expect(registerInputFromLookup(lookup, 'EI', vatRegime).vatRegime).toBe(vatRegime);
    },
  );
});
