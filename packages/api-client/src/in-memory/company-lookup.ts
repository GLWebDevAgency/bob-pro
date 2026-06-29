import { frenchVatNumber, type CompanyLookupPort, type CompanyLookupResult } from '@bob/core';

/** Profils déterministes pour la démo/offline (clés = SIRET sans espaces). */
const FIXTURES: Record<string, CompanyLookupResult> = {
  '40483304800010': {
    siren: '404833048',
    siret: '40483304800010',
    denomination: 'MERCIER PLOMBERIE',
    nafApe: '43.22A',
    trade: 'plombier',
    address: { line1: '12 rue des Artisans', zip: '69003', city: 'Lyon' },
    tvaIntracom: frenchVatNumber('404833048'),
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
