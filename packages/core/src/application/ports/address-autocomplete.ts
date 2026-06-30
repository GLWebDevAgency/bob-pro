import { type Address } from '../../shared-kernel/contact';

export interface AddressSuggestion extends Address {
  /** Libellé complet affichable (ex. « 8 Boulevard du Port 95000 Cergy »). */
  label: string;
}

/**
 * Port d'autocomplétion d'adresse (Base Adresse Nationale).
 * Graceful : renvoyer [] en cas d'indisponibilité amont (jamais lever).
 */
export interface AddressAutocompletePort {
  search(query: string): Promise<AddressSuggestion[]>;
}
