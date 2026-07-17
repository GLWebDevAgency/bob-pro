import { type Address } from '../../shared-kernel/contact';

export interface AddressSuggestion extends Address {
  /** Libellé complet affichable (ex. « 8 Boulevard du Port 95000 Cergy »). */
  label: string;
}

/**
 * Port d'autocomplétion d'adresse (Base Adresse Nationale).
 * `[]` signifie exclusivement « aucune suggestion trouvée ». Une panne amont doit lever afin
 * que le use case la transforme en indisponibilité explicite plutôt qu'en faux état vide.
 */
export interface AddressAutocompletePort {
  search(query: string): Promise<AddressSuggestion[]>;
}
