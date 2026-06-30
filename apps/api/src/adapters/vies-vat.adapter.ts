import { type VatValidationPort, type VatCheckOutcome } from '@bob/core';

const UNVERIFIED: VatCheckOutcome = { status: 'unverified', name: null, consultationNumber: null };

/**
 * Adapter réel du VatValidationPort sur l'API REST VIES (Commission européenne, gratuite, sans clé).
 * GET /ms/{country}/vat/{number} -> { isValid, name, requestIdentifier, userError }.
 * GRACEFUL : ne lève jamais ; toute panne/timeout -> 'unverified' (on ne bloque pas la facturation).
 */
export class ViesVatAdapter implements VatValidationPort {
  constructor(
    private readonly baseUrl = process.env.VIES_URL ?? 'https://ec.europa.eu/taxation_customs/vies/rest-api',
    private readonly timeoutMs = 6000,
  ) {
    try {
      if (new URL(this.baseUrl).protocol !== 'https:') throw new Error('scheme');
    } catch {
      throw new Error(`VIES_URL invalide (https requis): ${this.baseUrl}`);
    }
  }

  async check(vatNumber: string): Promise<VatCheckOutcome> {
    const v = vatNumber.replace(/\s/g, '').toUpperCase();
    const country = v.slice(0, 2);
    const number = v.slice(2);
    if (!/^[A-Z]{2}$/.test(country) || !number) return UNVERIFIED;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const res = await fetch(`${this.baseUrl}/ms/${country}/vat/${encodeURIComponent(number)}`, {
        headers: { accept: 'application/json' },
        signal: controller.signal,
      });
      if (!res.ok) return UNVERIFIED;
      const d = (await res.json()) as { isValid?: boolean; name?: string; requestIdentifier?: string };
      const name = d.name && d.name !== '---' ? d.name.trim() : null;
      const consultationNumber = d.requestIdentifier ? d.requestIdentifier : null;
      if (d.isValid === true) return { status: 'valid', name, consultationNumber };
      if (d.isValid === false) return { status: 'invalid', name, consultationNumber };
      return UNVERIFIED;
    } catch {
      return UNVERIFIED;
    } finally {
      clearTimeout(timer);
    }
  }
}
