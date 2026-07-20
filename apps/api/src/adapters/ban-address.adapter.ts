import { type AddressAutocompletePort, type AddressSuggestion } from '@bob/core';

/**
 * Adapter réel de l'AddressAutocompletePort sur la Base Adresse Nationale (gratuite, sans clé).
 * GET /search/?q=...&limit=5 -> features[].properties { label, name, postcode, city }.
 * URL env-driven (BAN_URL) : migration DINUM -> IGN/Geoplateforme (api-adresse maintenu jusqu'à janv. 2026).
 * `[]` est réservé à une réponse valide sans suggestion. Une panne/timeout lève afin que
 * le domaine remonte un état indisponible distinct d'un vrai résultat vide.
 */
export class AddressLookupUnavailableError extends Error {
  constructor(cause: string) {
    super(cause);
    this.name = 'AddressLookupUnavailableError';
  }
}

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
      if (!res.ok) throw new AddressLookupUnavailableError(`BAN HTTP ${res.status}`);
      let d: { features?: Array<{ properties?: BanProps }> };
      try {
        d = (await res.json()) as { features?: Array<{ properties?: BanProps }> };
      } catch {
        throw new AddressLookupUnavailableError('Réponse BAN illisible.');
      }
      if (d.features !== undefined && !Array.isArray(d.features)) {
        throw new AddressLookupUnavailableError('Réponse BAN invalide.');
      }
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
    } catch (error: unknown) {
      if (error instanceof AddressLookupUnavailableError) throw error;
      throw new AddressLookupUnavailableError(
        error instanceof Error ? error.message : 'BAN indisponible.',
      );
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
