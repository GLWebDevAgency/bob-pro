import type { IncomingMessage } from 'node:http';
import { describe, expect, it } from 'vitest';
import { usesDefaultJsonBodyParser, usesLargeJsonBodyParser } from './main';

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
