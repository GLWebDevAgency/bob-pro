import {
  type VatValidationPort,
  type VatCheckOutcome,
  type AddressAutocompletePort,
  type AddressSuggestion,
} from '@bob/core';

/** Validation TVA déterministe (démo/offline) : un n° FR bien formé est « valide ». */
export class DemoVatAdapter implements VatValidationPort {
  async check(vatNumber: string): Promise<VatCheckOutcome> {
    const wellFormed = /^FR[0-9A-Z]{2}\d{9}$/.test(vatNumber);
    return wellFormed
      ? { status: 'valid', name: 'Mercier Plomberie', consultationNumber: 'DEMO-VIES-0001' }
      : { status: 'invalid', name: null, consultationNumber: null };
  }
}

/** Autocomplétion d'adresse déterministe (démo/offline). */
export class DemoAddressAdapter implements AddressAutocompletePort {
  async search(query: string): Promise<AddressSuggestion[]> {
    const q = query.trim();
    return [
      { label: `${q}, 92000 Nanterre`, line1: q, zip: '92000', city: 'Nanterre' },
      { label: `${q}, 75011 Paris`, line1: q, zip: '75011', city: 'Paris' },
    ];
  }
}
