import { type Result, ok } from '../../shared-kernel/result';
import { type AppError } from '../result';
import { type AddressAutocompletePort, type AddressSuggestion } from '../ports/address-autocomplete';

export class SearchAddress {
  constructor(private readonly deps: { addresses: AddressAutocompletePort }) {}

  async execute(input: { query: string }): Promise<Result<AddressSuggestion[], AppError>> {
    const q = input.query.trim();
    if (q.length < 3) return ok([]); // évite les requêtes inutiles (quota BAN)
    return ok(await this.deps.addresses.search(q));
  }
}
