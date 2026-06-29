import { frenchVatNumber, type CompanyLookupPort, type CompanyLookupResult } from '@bob/core';

/** Profils déterministes pour la démo/offline (clés = SIRET Luhn-valides, sans espaces).
 * Aligné sur l'entreprise de seed (MERCIER_PROPS) pour que l'autofill du SIRET démo soit atteignable. */
const FIXTURES: Record<string, CompanyLookupResult> = {
  '73282932000074': {
    siren: '732829320',
    siret: '73282932000074',
    denomination: 'Mercier Plomberie',
    nafApe: '43.22A',
    trade: 'plombier',
    address: { line1: '12 rue des Artisans', zip: '92000', city: 'Nanterre' },
    tvaIntracom: frenchVatNumber('732829320'),
    rge: true,
  },
};

/** Adapter de recherche d'entreprise déterministe (aucun réseau) — démo + tests. */
export class DemoCompanyLookupAdapter implements CompanyLookupPort {
  async lookupBySiret(siret: string): Promise<CompanyLookupResult | null> {
    const v = siret.replace(/\s/g, '');
    if (FIXTURES[v]) return FIXTURES[v];
    if (!/^\d{14}$/.test(v)) return null;
    // Profil dérivé plausible (le n° TVA reste mathématiquement correct).
    const siren = v.slice(0, 9);
    return {
      siren,
      siret: v,
      denomination: `Entreprise ${siren}`,
      nafApe: null,
      trade: null,
      address: null,
      tvaIntracom: frenchVatNumber(siren),
      rge: false,
    };
  }
}
