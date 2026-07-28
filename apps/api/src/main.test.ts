import type { IncomingMessage } from 'node:http';
import { describe, expect, it } from 'vitest';
import { CIBS_TVA_ENTREE_EN_VIGUEUR } from '@bob/core';
import {
  journaliserVeilleMentionsLegales,
  usesDefaultJsonBodyParser,
  usesLargeJsonBodyParser,
  veilleMentionsLegalesAuDemarrage,
} from './main';

function request(method: string, url: string, contentType = 'application/json'): IncomingMessage {
  return {
    method,
    url,
    headers: { 'content-type': contentType },
  } as IncomingMessage;
}

describe('API JSON ingress policy', () => {
  it.each([
    '/documents/upload',
    '/documents/intakes',
    '/documents/ocr',
    '/expenses/import-facturx',
    '/expenses/import-facturx/confirm',
    '/voice/transcribe',
  ])('réserve la grande enveloppe au POST %s', (url) => {
    expect(usesLargeJsonBodyParser(request('POST', url))).toBe(true);
    expect(usesDefaultJsonBodyParser(request('POST', url))).toBe(false);
  });

  it('réserve la grande enveloppe à la seule sauvegarde structurée d’un dossier FEC', () => {
    expect(usesLargeJsonBodyParser(request(
      'PUT',
      '/cabinet/v1/cabinets/cabinet-1/dossiers/552100554',
    ))).toBe(true);
    expect(usesDefaultJsonBodyParser(request(
      'PUT',
      '/cabinet/v1/cabinets/cabinet-1/dossiers/552100554',
    ))).toBe(false);
    expect(usesLargeJsonBodyParser(request(
      'POST',
      '/cabinet/v1/cabinets/cabinet-1/dossiers/552100554',
    ))).toBe(false);
    expect(usesLargeJsonBodyParser(request(
      'PUT',
      '/cabinet/v1/cabinets/cabinet-1/dossiers/not-a-siren',
    ))).toBe(false);
  });

  it('tolère query string et slash terminal sur une route autorisée', () => {
    expect(usesLargeJsonBodyParser(request('post', '/documents/upload/?source=mobile'))).toBe(true);
  });

  it('réserve la grande enveloppe à l’upload de photo de chantier (id dynamique)', () => {
    expect(usesLargeJsonBodyParser(request('POST', '/chantiers/chantier-123/photos'))).toBe(true);
    expect(usesDefaultJsonBodyParser(request('POST', '/chantiers/chantier-123/photos'))).toBe(false);
    expect(usesLargeJsonBodyParser(request('POST', '/chantiers/chantier-123/photos/?src=mobile'))).toBe(true);
    expect(usesLargeJsonBodyParser(request('GET', '/chantiers/chantier-123/photos'))).toBe(false);
    expect(usesLargeJsonBodyParser(request('POST', '/chantiers/chantier-123/notes'))).toBe(false);
    expect(usesLargeJsonBodyParser(request('POST', '/chantiers//photos'))).toBe(false);
    expect(usesLargeJsonBodyParser(request('POST', '/chantiers/a/b/photos'))).toBe(false);
    expect(usesLargeJsonBodyParser(request('POST', '/chantiers/chantier-123/photos/evil'))).toBe(false);
  });

  it.each([
    ['POST', '/documents/123/classify'],
    ['GET', '/documents/upload'],
    ['POST', '/documents/upload/evil'],
    ['POST', '/voice/synthesize'],
    ['POST', '/ai/ask'],
  ])('maintient la petite enveloppe pour %s %s', (method, url) => {
    expect(usesLargeJsonBodyParser(request(method, url))).toBe(false);
    expect(usesDefaultJsonBodyParser(request(method, url))).toBe(true);
  });

  it('ne traite pas un autre type de contenu avec les parseurs JSON', () => {
    const nonJson = request('POST', '/documents/upload', 'application/octet-stream');
    expect(usesLargeJsonBodyParser(nonJson)).toBe(false);
    expect(usesDefaultJsonBodyParser(nonJson)).toBe(false);
  });
});

// Troisième canal du régime d'alarme du bloc mentions (@bob/core, veille-mentions-legales.ts) :
// le rapporteur de CI porte l'étage 1 (préavis, non bloquant), le test-sentinelle porte l'étage 2
// (échéance atteinte, CI rouge), et celui-ci couvre l'instance déployée qui tourne des mois sans
// qu'une PR repasse. Un signal muet serait un signal inexistant : on prouve chaque état.
describe('veille des mentions légales au démarrage', () => {
  it('hors préavis : silence — le démarrage ne journalise rien', () => {
    expect(veilleMentionsLegalesAuDemarrage('2026-07-28')).toBeNull();
  });

  it('préavis en cours : le démarrage AVERTIT — mais rien ici n’empêche l’API de servir', () => {
    const message = veilleMentionsLegalesAuDemarrage('2026-10-03');
    expect(message).toContain('ÉTAGE 1, PRÉAVIS (non bloquant)');
    expect(message).toContain('cibs-decret-formulation-franchise');
  });

  it('échéance atteinte : message explicite, avec le geste à faire et les sources', () => {
    const message = veilleMentionsLegalesAuDemarrage(CIBS_TVA_ENTREE_EN_VIGUEUR);
    expect(message).toContain('le décret de formulation CIBS doit être vérifié et la mention mise à jour');
    expect(message).toContain('Ordonnance n° 2026-671 du 27/07/2026');
    expect(message).toContain('cibs-decret-formulation-franchise');
  });

  describe('journalisation au boot — bruyante, jamais fatale', () => {
    const journal = () => {
      const warns: string[] = [];
      const errors: string[] = [];
      return {
        warns,
        errors,
        logger: {
          warn: (message: string) => void warns.push(message),
          error: (message: string) => void errors.push(message),
        },
      };
    };

    it('rien à signaler : aucun log — un log répété à chaque boot finit par être ignoré', () => {
      const { logger, warns, errors } = journal();
      journaliserVeilleMentionsLegales(logger, '2026-07-28');
      expect(warns).toEqual([]);
      expect(errors).toEqual([]);
    });

    it('échéance atteinte : un warn qui porte le geste — le service, lui, continue de servir', () => {
      const { logger, warns, errors } = journal();
      journaliserVeilleMentionsLegales(logger, CIBS_TVA_ENTREE_EN_VIGUEUR);
      expect(warns).toHaveLength(1);
      expect(warns[0]).toContain('ÉTAGE 2, BLOQUANT');
      expect(errors).toEqual([]);
    });

    it('veille inévaluable : ERROR bruyante, et surtout AUCUNE exception — une API ne tombe pas pour une veille', () => {
      const { logger, warns, errors } = journal();
      // La date ne peut pas être invalide en production (parisDateOnly), mais le domaine est
      // fail-closed : si un jour il lève, le boot doit hurler sans mourir.
      expect(() => journaliserVeilleMentionsLegales(logger, '2027-13-45')).not.toThrow();
      expect(warns).toEqual([]);
      expect(errors).toHaveLength(1);
      expect(errors[0]).toContain('inévaluable au démarrage');
      expect(errors[0]).toContain('DÉFAUT à corriger');
      expect(errors[0]).toContain('2027-13-45');
    });
  });
});
