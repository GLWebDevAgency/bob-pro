import { describe, expect, it } from 'vitest';
import { CorrelationMiddleware } from './correlation.middleware';
import { getCorrelationId } from './logger';

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function run(headers: Record<string, string | string[] | undefined>): {
  observed: string;
  responseHeaders: Map<string, string>;
} {
  const responseHeaders = new Map<string, string>();
  let observed = '';
  new CorrelationMiddleware().use(
    { headers },
    { setHeader: (name, value) => responseHeaders.set(name, value) },
    () => {
      observed = getCorrelationId();
    },
  );
  return { observed, responseHeaders };
}

describe('CorrelationMiddleware — corrélation bout-en-bout (spec §3.1)', () => {
  it('reprend le x-correlation-id GÉNÉRÉ PAR LE CLIENT et le rend dans les deux headers', () => {
    const client = '0199aaaa-bbbb-4ccc-8ddd-eeeeffff0000';
    const { observed, responseHeaders } = run({ 'x-correlation-id': client });
    expect(observed).toBe(client);
    expect(responseHeaders.get('x-request-id')).toBe(client);
    expect(responseHeaders.get('x-correlation-id')).toBe(client);
  });

  it('x-correlation-id prime sur le x-request-id legacy ; le legacy reste accepté seul', () => {
    expect(
      run({ 'x-correlation-id': 'client-corr-123', 'x-request-id': 'edge-req-456' }).observed,
    ).toBe('client-corr-123');
    expect(run({ 'x-request-id': 'edge-req-456' }).observed).toBe('edge-req-456');
  });

  it('sans header, génère un UUID et le rend au client', () => {
    const { observed, responseHeaders } = run({});
    expect(observed).toMatch(UUID_V4);
    expect(responseHeaders.get('x-request-id')).toBe(observed);
    expect(responseHeaders.get('x-correlation-id')).toBe(observed);
  });

  it('REMPLACE tout header hors patron : injection de logs, taille, alphabet', () => {
    for (const hostile of [
      'abc\ndef-injection',      // saut de ligne — injection de ligne pino
      'a'.repeat(65),            // trop long
      'court',                   // trop court (< 8)
      'espace interdit-12345',   // caractère hors alphabet
      '',
    ]) {
      const { observed } = run({ 'x-correlation-id': hostile });
      expect(observed).toMatch(UUID_V4);
      expect(observed).not.toBe(hostile);
    }
  });

  it('un header multiple (tableau) est lu sur sa première valeur', () => {
    expect(run({ 'x-correlation-id': ['premier-corr-1', 'second-corr-2'] }).observed).toBe(
      'premier-corr-1',
    );
  });
});
