import { describe, expect, it } from 'vitest';
import {
  redactTelemetryText,
  scrubTelemetryBreadcrumb,
  scrubTelemetryEvent,
  telemetryTagsFrom,
} from './telemetry-scrubbing';

const IBAN = 'FR76 3000 6000 0112 3456 7890 189';
const EMAIL = 'jean.dupont@client-mercier.fr';
const SIRET = '73282932000074';
const PHONE = '06 12 34 56 78';
const AMOUNT = '12 480,50 €';
const JWT =
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NSJ9.aBcDeFgHiJkLmNoPqRsTuVwXyZ012345';
const CARD = '4970 1000 0000 0000';

/** Tout ce qui ne doit JAMAIS franchir la frontière réseau du crash reporting. */
const SECRETS = [IBAN, EMAIL, SIRET, PHONE, AMOUNT, JWT, CARD];

function expectNoLeak(payload: unknown): void {
  const serialized = JSON.stringify(payload) ?? '';
  for (const secret of SECRETS) {
    expect(serialized, `fuite de « ${secret} » dans la télémétrie`).not.toContain(secret);
  }
  // Fragments partiels : un masquage qui laisserait la moitié d'un IBAN reste une fuite.
  expect(serialized).not.toContain('3000 6000');
  expect(serialized).not.toContain('jean.dupont');
  expect(serialized).not.toContain('73282932');
}

describe('redactTelemetryText — masquage du PII et de la donnée financière', () => {
  it('masque IBAN, e-mail, téléphone, SIREN/SIRET, montant, carte et jeton', () => {
    const raw = `virement ${IBAN} pour ${EMAIL} (${SIRET}) tel ${PHONE} de ${AMOUNT} carte ${CARD} auth ${JWT}`;
    const redacted = redactTelemetryText(raw);

    expect(redacted).toContain('[iban]');
    expect(redacted).toContain('[email]');
    expect(redacted).toContain('[tel]');
    expect(redacted).toContain('[siren]');
    expect(redacted).toContain('[montant]');
    expect(redacted).toContain('[carte]');
    expect(redacted).toContain('[jeton]');
    expectNoLeak(redacted);
  });

  it('masque le montant quel que soit le côté du symbole', () => {
    expect(redactTelemetryText('reste 1 320,00 € à payer')).toBe('reste [montant] à payer');
    expect(redactTelemetryText('total € 890,00')).toBe('total [montant]');
    expect(redactTelemetryText('acompte 450 EUR')).toBe('acompte [montant]');
  });

  it('est idempotent : un texte déjà masqué ne bouge plus', () => {
    const once = redactTelemetryText(`${IBAN} ${EMAIL} ${AMOUNT} ${PHONE}`);
    expect(redactTelemetryText(once)).toBe(once);
  });

  it('laisse intact un texte de diagnostic sans donnée personnelle', () => {
    expect(redactTelemetryText('TypeError: cannot read property of undefined'))
      .toBe('TypeError: cannot read property of undefined');
    expect(redactTelemetryText('')).toBe('');
  });

  it("un secret À CHEVAL sur la borne de troncature ne laisse pas fuir son début", () => {
    // Tronquer AVANT de masquer coupe le secret : le fragment restant ne correspond plus au
    // motif et part donc EN CLAIR. Mesuré : « iban=FR7612548 » survivait à la sortie.
    const iban = 'FR7612548029981234567890161';
    const message = `${'contexte '.repeat(54)}iban=${iban}`;
    expect(message.indexOf('FR76')).toBeGreaterThan(480); // le secret commence juste avant la coupe
    const event = scrubTelemetryEvent({
      exception: { values: [{ type: 'Error', value: message }] },
    });
    const sortie = JSON.stringify(event);
    expect(sortie).not.toContain('FR761');
    expect(sortie).toContain('[iban]');
  });
});

describe('scrubTelemetryEvent — liste blanche structurelle', () => {
  it('redacte un événement porteur d’un IBAN et d’un e-mail avant tout envoi', () => {
    const event = {
      event_id: 'abc123',
      level: 'error',
      exception: {
        values: [
          {
            type: 'DomainError',
            value: `paiement refusé pour ${EMAIL} sur ${IBAN} (${AMOUNT})`,
            stacktrace: {
              frames: [
                {
                  filename: 'src/billing/pay.ts',
                  function: 'settleInvoice',
                  lineno: 42,
                  in_app: true,
                  context_line: `const iban = '${IBAN}';`,
                  // Variables locales capturées : la fuite la plus grave d'un rapport natif.
                  vars: { iban: IBAN, email: EMAIL, montant: AMOUNT },
                },
              ],
            },
          },
        ],
      },
    };

    const scrubbed = scrubTelemetryEvent(event);

    expectNoLeak(scrubbed);
    const values = (scrubbed.exception as { values: Array<Record<string, unknown>> }).values;
    expect(values[0]?.type).toBe('DomainError');
    expect(String(values[0]?.value)).toContain('[iban]');
    expect(String(values[0]?.value)).toContain('[email]');
    expect(String(values[0]?.value)).toContain('[montant]');
    const frame = (values[0]?.stacktrace as { frames: Array<Record<string, unknown>> }).frames[0];
    // La ligne de source survit (elle vient du dépôt) mais masquée ; `vars` disparaît.
    expect(frame).not.toHaveProperty('vars');
    expect(String(frame?.context_line)).toContain('[iban]');
    expect(frame?.function).toBe('settleInvoice');
    expect(frame?.lineno).toBe(42);
  });

  it('écarte par défaut request, user, extra et tout champ non listé', () => {
    const scrubbed = scrubTelemetryEvent({
      event_id: 'e1',
      request: {
        url: 'https://api.bobpro.fr/invoices?email=' + EMAIL,
        headers: { authorization: `Bearer ${JWT}`, cookie: 'sb-access-token=secret' },
        data: { iban: IBAN, total: AMOUNT },
      },
      user: { id: 'u-1', email: EMAIL, ip_address: '81.2.3.4' },
      extra: { transcriptVocal: `vire ${AMOUNT} à ${EMAIL}`, siret: SIRET },
      server_name: 'railway-replica-3',
      // Champ inconnu : la liste blanche doit l'écarter sans avoir eu à le prévoir.
      futureSdkField: { payload: IBAN },
    });

    expect(scrubbed).not.toHaveProperty('request');
    expect(scrubbed).not.toHaveProperty('user');
    expect(scrubbed).not.toHaveProperty('extra');
    expect(scrubbed).not.toHaveProperty('server_name');
    expect(scrubbed).not.toHaveProperty('futureSdkField');
    expect(scrubbed.event_id).toBe('e1');
    expectNoLeak(scrubbed);
  });

  it('ne garde que les étiquettes autorisées et masque leur valeur', () => {
    const scrubbed = scrubTelemetryEvent({
      tags: {
        correlationId: 'c-42',
        kind: 'dependency',
        customerEmail: EMAIL,
        clientName: 'SARL Mercier',
        reason: `solde ${AMOUNT} sur ${IBAN}`,
      },
    });

    const tags = scrubbed.tags as Record<string, unknown>;
    expect(tags).toEqual({
      correlationId: 'c-42',
      kind: 'dependency',
      reason: 'solde [montant] sur [iban]',
    });
    expectNoLeak(scrubbed);
  });

  it('ne garde que les contextes techniques demandés', () => {
    const scrubbed = scrubTelemetryEvent(
      {
        contexts: {
          runtime: { name: 'node', version: '22.11.0' },
          device: { model: 'Pixel 7', memory: 8 },
          state: { fiscalProfile: { siret: SIRET, email: EMAIL } },
        },
      },
      { allowedContexts: ['runtime', 'device'] },
    );

    const contexts = scrubbed.contexts as Record<string, unknown>;
    expect(contexts).toEqual({
      runtime: { name: 'node', version: '22.11.0' },
      device: { model: 'Pixel 7', memory: 8 },
    });
    expect(contexts).not.toHaveProperty('state');
    expectNoLeak(scrubbed);
  });

  it('minimise les miettes : message masqué, charge utile réduite au transport', () => {
    const scrubbed = scrubTelemetryEvent({
      breadcrumbs: [
        {
          category: 'http',
          level: 'info',
          message: `POST /invoices ${AMOUNT} pour ${EMAIL}`,
          data: {
            method: 'POST',
            status_code: 500,
            url: `https://api.bobpro.fr/invoices?siret=${SIRET}`,
            body: { iban: IBAN },
          },
        },
      ],
    });

    const breadcrumbs = scrubbed.breadcrumbs as Array<Record<string, unknown>>;
    expect(breadcrumbs[0]?.data).toEqual({ method: 'POST', status_code: 500 });
    expect(String(breadcrumbs[0]?.message)).toBe('POST /invoices [montant] pour [email]');
    expectNoLeak(scrubbed);
  });

  it('borne le nombre de miettes conservées et garde les plus récentes', () => {
    const scrubbed = scrubTelemetryEvent({
      breadcrumbs: Array.from({ length: 80 }, (_, index) => ({
        category: 'navigation',
        message: `écran ${index}`,
      })),
    });

    const breadcrumbs = scrubbed.breadcrumbs as Array<Record<string, unknown>>;
    expect(breadcrumbs).toHaveLength(30);
    expect(breadcrumbs.at(-1)?.message).toBe('écran 79');
  });

  it('tronque un message d’erreur kilométrique', () => {
    const scrubbed = scrubTelemetryEvent({
      exception: { values: [{ type: 'Error', value: 'x'.repeat(5_000) }] },
    });

    const values = (scrubbed.exception as { values: Array<Record<string, unknown>> }).values;
    expect(String(values[0]?.value)).toHaveLength(500);
  });
});

describe('scrubTelemetryBreadcrumb / telemetryTagsFrom', () => {
  it('rejette une miette vide de tout champ exploitable', () => {
    expect(scrubTelemetryBreadcrumb({ unknown: IBAN })).toBeNull();
  });

  it('n’élève jamais une clé de contexte arbitraire en étiquette', () => {
    expect(
      telemetryTagsFrom({
        correlationId: 'c-7',
        kind: 'dependency',
        customerIban: IBAN,
        transcript: `vire ${AMOUNT}`,
        nested: { email: EMAIL },
      }),
    ).toEqual({ correlationId: 'c-7', kind: 'dependency' });
  });
});
