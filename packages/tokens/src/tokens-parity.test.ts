import { describe, it, expect } from 'vitest';
import * as handoff from '../../../design_handoff_bob_pro/tokens';
import * as current from './index';

/**
 * Parité stricte avec la référence figée (contrat C01) :
 * chaque valeur DATA du handoff existe à l'identique dans @bob/tokens, et
 * @bob/tokens n'ajoute aucune donnée absente du handoff (les fonctions —
 * gradients, toCssVars — sont hors comparaison : ce sont des dérivations).
 */
type Flat = Map<string, string>;

function flatten(value: unknown, prefix = '', out: Flat = new Map()): Flat {
  if (typeof value === 'function') return out;
  if (value !== null && typeof value === 'object') {
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      flatten(v, prefix ? `${prefix}.${k}` : k, out);
    }
    return out;
  }
  out.set(prefix, String(value));
  return out;
}

describe('tokens-parity (handoff v1.1 ↔ @bob/tokens)', () => {
  const ref = flatten(handoff);
  const impl = flatten(current);

  it('aucune valeur du handoff ne manque ou ne dévie', () => {
    const ecarts: string[] = [];
    for (const [key, value] of ref) {
      if (!impl.has(key)) ecarts.push(`MANQUANT: ${key} = ${value}`);
      else if (impl.get(key) !== value)
        ecarts.push(`DIFF: ${key} → handoff=${value} / impl=${impl.get(key)}`);
    }
    expect(ecarts).toEqual([]);
  });

  it("@bob/tokens n'ajoute aucune donnée hors référence", () => {
    const extras = [...impl.keys()].filter((k) => !ref.has(k));
    expect(extras).toEqual([]);
  });
});
