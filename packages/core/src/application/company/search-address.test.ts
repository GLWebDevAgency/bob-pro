import { describe, it, expect } from 'vitest';
import { SearchAddress } from './search-address';
import { type AddressAutocompletePort, type AddressSuggestion } from '../ports/address-autocomplete';

const SUGG: AddressSuggestion = { label: '8 Boulevard du Port 95000 Cergy', line1: '8 Boulevard du Port', zip: '95000', city: 'Cergy' };
const port = (out: AddressSuggestion[]): AddressAutocompletePort => ({ async search() { return out; } });

describe('SearchAddress', () => {
  it('renvoie les suggestions pour une requête >= 3 caractères', async () => {
    const r = await new SearchAddress({ addresses: port([SUGG]) }).execute({ query: '8 bd du port' });
    expect(r.ok && r.value.length).toBe(1);
    if (r.ok) expect(r.value[0]?.zip).toBe('95000');
  });

  it('court-circuite (quota) si la requête fait < 3 caractères', async () => {
    let called = false;
    const spy: AddressAutocompletePort = { async search() { called = true; return [SUGG]; } };
    const r = await new SearchAddress({ addresses: spy }).execute({ query: 'ab' });
    expect(r.ok && r.value.length).toBe(0);
    expect(called).toBe(false);
  });
});
