import { describe, expect, it } from 'vitest';
import { AGENT_REFRESH_QUERY_KEY_PREFIXES } from './refresh-after-action';

/** Miroir de la sémantique de matching partiel de React Query v5 (préfixe élément par élément). */
const matchesPrefix = (prefix: readonly string[], key: readonly unknown[]): boolean =>
  prefix.length <= key.length && prefix.every((part, index) => key[index] === part);

const covered = (key: readonly unknown[]): boolean =>
  AGENT_REFRESH_QUERY_KEY_PREFIXES.some((prefix) => matchesPrefix(prefix, key));

describe('AGENT_REFRESH_QUERY_KEY_PREFIXES — fraîcheur après un run « done » (S8)', () => {
  it('couvre TOUTES les clés documents réellement montées (LOT 5 : valider/classer/renommer)', () => {
    // Clés concrètes des écrans documents (src/data/documents.ts) — chacune doit être invalidée.
    expect(covered(['documents'])).toBe(true); // liste racine
    expect(covered(['documents', 'folder', 'dossier-achats'])).toBe(true); // contenu d'un dossier
    expect(covered(['document', 'doc-ticket-aldi'])).toBe(true); // fiche document
    expect(covered(['document-folders', null])).toBe(true); // arborescence racine
    expect(covered(['document-folders', 'dossier-parent'])).toBe(true); // sous-dossiers
    expect(covered(['document-folder', 'dossier-achats'])).toBe(true); // détail du coffre
  });

  it('couvre les dépenses et écritures comptables (scan_depense / enregistrer_reglement_depense)', () => {
    expect(covered(['expenses'])).toBe(true);
    expect(covered(['accounting-entries'])).toBe(true);
  });

  it('non-régression : les clés facturation/pilotage historiques restent invalidées', () => {
    expect(covered(['invoices'])).toBe(true);
    expect(covered(['quotes'])).toBe(true);
    expect(covered(['customers'])).toBe(true);
    expect(covered(['cashflow'])).toBe(true);
    expect(covered(['notifications'])).toBe(true);
  });

  it('reste ciblé : les caches sans lien avec une action de Bob ne sont pas balayés', () => {
    expect(covered(['subscription'])).toBe(false);
    expect(covered(['profile'])).toBe(false);
    expect(covered(['company-me'])).toBe(false);
    expect(covered(['supplier-memory', 'company-1', 'ALDI', null, null, null])).toBe(false);
  });

  it('aucun préfixe redondant (un préfixe n’en couvre jamais un autre)', () => {
    for (const a of AGENT_REFRESH_QUERY_KEY_PREFIXES) {
      for (const b of AGENT_REFRESH_QUERY_KEY_PREFIXES) {
        if (a === b) continue;
        expect(matchesPrefix(a, b)).toBe(false);
      }
    }
  });

  it('chaque préfixe est non vide (invalidation JAMAIS globale par accident)', () => {
    for (const prefix of AGENT_REFRESH_QUERY_KEY_PREFIXES) {
      expect(prefix.length).toBeGreaterThan(0);
      for (const part of prefix) expect(part.length).toBeGreaterThan(0);
    }
  });
});
