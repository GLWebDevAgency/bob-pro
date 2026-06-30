import { type AddressAutocompletePort, type AddressSuggestion } from '@bob/core';

/**
 * Adapter réel de l'AddressAutocompletePort sur la Base Adresse Nationale (gratuite, sans clé).
 * GET /search/?q=...&limit=5 -> features[].properties { label, name, postcode, city }.
 * URL env-driven (BAN_URL) : migration DINUM -> IGN/Geoplateforme (api-adresse maintenu jusqu'à janv. 2026).
 * GRACEFUL : ne lève jamais ; toute panne/timeout -> [].
 */
export class BanAddressAdapter implements AddressAutocompletePort {
  constructor(
    private readonly baseUrl = process.env.BAN_URL ?? 'https://api-adresse.data.gouv.fr',
    private readonly timeoutMs = 4000,
  ) {
    try {
      if (new URL(this.baseUrl).protocol !== 'https:') throw new Error('scheme');
    } catch {
      throw new Error(`BAN_URL invalide (https requis): ${this.baseUrl}`);
    }
  }

  async search(query: string): Promise<AddressSuggestion[]> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const res = await fetch(`${this.baseUrl}/search/?q=${encodeURIComponent(query)}&limit=5`, {
        headers: { accept: 'application/json' },
        signal: controller.signal,
      });
      if (!res.ok) return [];
      const d = (await res.json()) as { features?: Array<{ properties?: BanProps }> };
      return (d.features ?? [])
        .map((f) => {
          const p = f.properties ?? {};
          return {
            label: p.label ?? '',
            line1: p.name ?? p.label ?? '',
            zip: p.postcode ?? '',
            city: p.city ?? '',
          };
        })
        .filter((s) => s.zip !== '' && s.city !== '');
    } catch {
      return [];
    } finally {
      clearTimeout(timer);
    }
  }
}

interface BanProps {
  label?: string;
  name?: string;
  postcode?: string;
  city?: string;
}
