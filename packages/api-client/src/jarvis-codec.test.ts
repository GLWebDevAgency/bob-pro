import { describe, expect, it } from 'vitest';
import {
  JARVIS_PRESENTED_FIELDS_MAX,
  decodeCustomerContactPresentation,
  decodeJarvisCommandReceipt,
  decodeJarvisRun,
  decodeJarvisRunSnapshot,
  encodeJarvisRunCommand,
  isJarvisAdmissionKind,
  isJarvisOpenAction,
  isJarvisUserCommandId,
} from './jarvis-codec';

const RUN_ID = '11111111-1111-4111-8111-111111111111';
const PROPOSAL_ID = '22222222-2222-4222-8222-222222222222';
const CONFIRMATION_ID = '33333333-3333-4333-8333-333333333333';
const CUSTOMER_ID = '44444444-4444-4444-8444-444444444444';
const HASH = 'a'.repeat(64);
const DIGEST = 'b'.repeat(64);

function run(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    runId: RUN_ID,
    kind: 'customer_contact',
    definitionVersion: 1,
    status: 'waiting_user',
    revision: 4,
    nextWakeAt: '2026-08-19T10:05:00.000Z',
    terminalAt: null,
    ...overrides,
  };
}

function field(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    field: 'name',
    label: 'Nom du client',
    before: null,
    after: 'Dupont Plomberie',
    sensitiveField: null,
    ...overrides,
  };
}

function presentation(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schema: 'bob.jarvis-run.customer-contact-presentation',
    version: 1,
    phase: 'awaiting_confirmation',
    intent: 'create',
    targetCustomerId: null,
    proposal: {
      proposalId: PROPOSAL_ID,
      proposalHash: HASH,
      fieldsDigest: DIGEST,
      fields: [field()],
    },
    confirmation: {
      confirmationId: CONFIRMATION_ID,
      status: 'issued',
      expiresAt: '2026-08-19T10:05:00.000Z',
      presentedAt: null,
    },
    ...overrides,
  };
}

describe('jarvis-codec — projection du run', () => {
  it('décode un run projeté et refuse toute clé inconnue', () => {
    expect(decodeJarvisRun(run())).toMatchObject({ runId: RUN_ID, revision: 4 });
    expect(decodeJarvisRun({ ...run(), extra: 1 })).toBeNull();
    expect(decodeJarvisRun({ ...run(), state: { secret: true } })).toBeNull();
  });

  it('refuse la branche quote_creation : le writer N-1 ne traverse jamais ce wire', () => {
    expect(decodeJarvisRun(run({ kind: 'quote_creation' }))).toBeNull();
    expect(isJarvisAdmissionKind('quote_creation')).toBe(false);
    expect(isJarvisAdmissionKind('customer_contact')).toBe(true);
    expect(isJarvisAdmissionKind('single_business_action')).toBe(true);
  });

  it('refuse un statut hors des onze statuts §5.1 et une révision non entière', () => {
    expect(decodeJarvisRun(run({ status: 'en_cours' }))).toBeNull();
    expect(decodeJarvisRun(run({ revision: 1.5 }))).toBeNull();
    expect(decodeJarvisRun(run({ revision: 0 }))).toBeNull();
  });

  it('exige des instants ISO canoniques, aller-retour exact', () => {
    expect(decodeJarvisRun(run({ nextWakeAt: '2026-08-19T10:05:00Z' }))).toBeNull();
    expect(decodeJarvisRun(run({ terminalAt: '2026-08-19' }))).toBeNull();
    expect(decodeJarvisRun(run({ nextWakeAt: null }))).not.toBeNull();
  });
});

describe('jarvis-codec — présentation serveur', () => {
  it('décode une création et gèle les champs proposés', () => {
    const decoded = decodeCustomerContactPresentation(presentation());
    expect(decoded?.proposal?.fields[0]).toMatchObject({
      field: 'name',
      label: 'Nom du client',
      before: null,
      after: 'Dupont Plomberie',
    });
    expect(Object.isFrozen(decoded)).toBe(true);
  });

  it('lie l’intention à la cible : une modification sans cible relue n’existe pas', () => {
    expect(decodeCustomerContactPresentation(presentation({ intent: 'update' }))).toBeNull();
    expect(
      decodeCustomerContactPresentation(
        presentation({ intent: 'update', targetCustomerId: CUSTOMER_ID }),
      ),
    ).not.toBeNull();
    expect(
      decodeCustomerContactPresentation(presentation({ targetCustomerId: CUSTOMER_ID })),
    ).toBeNull();
  });

  it('refuse une confirmation sans proposition scellée', () => {
    expect(decodeCustomerContactPresentation(presentation({ proposal: null }))).toBeNull();
  });

  it('refuse un champ dupliqué, vide, non borné ou porteur de contrôle', () => {
    expect(
      decodeCustomerContactPresentation(
        presentation({
          proposal: {
            proposalId: PROPOSAL_ID,
            proposalHash: HASH,
            fieldsDigest: DIGEST,
            fields: [field(), field({ after: 'Autre' })],
          },
        }),
      ),
    ).toBeNull();
    expect(
      decodeCustomerContactPresentation(
        presentation({
          proposal: {
            proposalId: PROPOSAL_ID,
            proposalHash: HASH,
            fieldsDigest: DIGEST,
            fields: [field({ label: '   ' })],
          },
        }),
      ),
    ).toBeNull();
    expect(
      decodeCustomerContactPresentation(
        presentation({
          proposal: {
            proposalId: PROPOSAL_ID,
            proposalHash: HASH,
            fieldsDigest: DIGEST,
            fields: [field({ after: 'Dupont\u0007' })],
          },
        }),
      ),
    ).toBeNull();
    expect(
      decodeCustomerContactPresentation(
        presentation({
          proposal: {
            proposalId: PROPOSAL_ID,
            proposalHash: HASH,
            fieldsDigest: DIGEST,
            fields: [field({ after: 'D'.repeat(513) })],
          },
        }),
      ),
    ).toBeNull();
    expect(
      decodeCustomerContactPresentation(
        presentation({
          proposal: {
            proposalId: PROPOSAL_ID,
            proposalHash: HASH,
            fieldsDigest: DIGEST,
            fields: Array.from({ length: JARVIS_PRESENTED_FIELDS_MAX + 1 }, (_value, index) =>
              field({ field: `champ_${index}` }),
            ),
          },
        }),
      ),
    ).toBeNull();
  });

  it('n’accepte qu’un champ sensible du vocabulaire §9.1', () => {
    expect(
      decodeCustomerContactPresentation(
        presentation({
          proposal: {
            proposalId: PROPOSAL_ID,
            proposalHash: HASH,
            fieldsDigest: DIGEST,
            fields: [field({ sensitiveField: 'vat_profile' })],
          },
        }),
      ),
    ).not.toBeNull();
    expect(
      decodeCustomerContactPresentation(
        presentation({
          proposal: {
            proposalId: PROPOSAL_ID,
            proposalHash: HASH,
            fieldsDigest: DIGEST,
            fields: [field({ sensitiveField: 'iban' })],
          },
        }),
      ),
    ).toBeNull();
  });

  it('refuse un digest ou un hash non canonique', () => {
    expect(
      decodeCustomerContactPresentation(
        presentation({
          proposal: {
            proposalId: PROPOSAL_ID,
            proposalHash: HASH.toUpperCase(),
            fieldsDigest: DIGEST,
            fields: [field()],
          },
        }),
      ),
    ).toBeNull();
  });
});

describe('jarvis-codec — instantané et reçu', () => {
  it('accepte une présentation absente : le digest non revérifié ferme l’écran', () => {
    expect(decodeJarvisRunSnapshot({ run: run(), presentation: null })).toMatchObject({
      presentation: null,
    });
  });

  it('refuse un instantané dont la présentation est corrompue plutôt que de l’amputer', () => {
    expect(
      decodeJarvisRunSnapshot({ run: run(), presentation: presentation({ phase: 'inconnue' }) }),
    ).toBeNull();
    expect(decodeJarvisRunSnapshot({ run: run() })).toBeNull();
  });

  it('ne connaît que les deux issues d’un reçu : admitted et replayed', () => {
    expect(
      decodeJarvisCommandReceipt({
        outcome: 'replayed',
        run: run(),
        presentation: presentation(),
        eventSequence: 12,
      }),
    ).toMatchObject({ outcome: 'replayed', eventSequence: 12 });
    expect(
      decodeJarvisCommandReceipt({
        outcome: 'stale_revision',
        run: run(),
        presentation: null,
        eventSequence: 12,
      }),
    ).toBeNull();
    expect(
      decodeJarvisCommandReceipt({
        outcome: 'admitted',
        run: run(),
        presentation: null,
        eventSequence: 0,
      }),
    ).toBeNull();
  });
});

describe('jarvis-codec — canal des commandes humaines', () => {
  it('reconstruit les quatre gestes clé par clé', () => {
    expect(
      encodeJarvisRunCommand({
        type: 'record_presentation_ack',
        confirmationId: CONFIRMATION_ID,
        ack: 'screen_ack',
      }),
    ).toEqual({
      type: 'record_presentation_ack',
      confirmationId: CONFIRMATION_ID,
      ack: 'screen_ack',
    });
    expect(
      encodeJarvisRunCommand({
        type: 'confirm',
        confirmationId: CONFIRMATION_ID,
        proposalHash: HASH,
      }),
    ).toEqual({ type: 'confirm', confirmationId: CONFIRMATION_ID, proposalHash: HASH });
    expect(
      encodeJarvisRunCommand({ type: 'reject_proposal', confirmationId: CONFIRMATION_ID }),
    ).toEqual({ type: 'reject_proposal', confirmationId: CONFIRMATION_ID });
    expect(encodeJarvisRunCommand({ type: 'cancel_run', reason: 'user_cancelled' })).toEqual({
      type: 'cancel_run',
      reason: 'user_cancelled',
    });
  });

  it('ferme le canal : ni ack vocal, ni clé étrangère, ni commande système', () => {
    expect(
      encodeJarvisRunCommand({
        type: 'record_presentation_ack',
        confirmationId: CONFIRMATION_ID,
        ack: 'voice_presentation_ack',
      }),
    ).toBeNull();
    expect(
      encodeJarvisRunCommand({
        type: 'confirm',
        confirmationId: CONFIRMATION_ID,
        proposalHash: HASH,
        revalidatedTargetRevision: 3,
      }),
    ).toBeNull();
    expect(
      encodeJarvisRunCommand({
        type: 'record_effect_receipt',
        effectId: PROPOSAL_ID,
        outcome: { kind: 'succeeded', customerId: CUSTOMER_ID, customerRevision: 1 },
      }),
    ).toBeNull();
    expect(encodeJarvisRunCommand({ type: 'wake_run', wakeId: PROPOSAL_ID })).toBeNull();
    expect(
      encodeJarvisRunCommand({
        type: 'confirm',
        confirmationId: CONFIRMATION_ID,
        proposalHash: 'x',
      }),
    ).toBeNull();
  });
});

describe('jarvis-codec — bornes du lot et contrat du commandId', () => {
  it('n’ouvre que les deux actions de rollout.ts', () => {
    expect(isJarvisOpenAction('client-creer', 1)).toBe(true);
    expect(isJarvisOpenAction('client-modifier', 1)).toBe(true);
    expect(isJarvisOpenAction('client-supprimer', 1)).toBe(false);
    expect(isJarvisOpenAction('client-creer', 2)).toBe(false);
    expect(isJarvisOpenAction('client-creer', 1.5)).toBe(false);
  });

  it('exige un UUID v4 pour un commandId utilisateur (§5.4)', () => {
    expect(isJarvisUserCommandId(RUN_ID)).toBe(true);
    // v8 = commandId SYSTÈME (§5.6) : il n'entre jamais par le canal utilisateur.
    expect(isJarvisUserCommandId('11111111-1111-8111-8111-111111111111')).toBe(false);
    expect(isJarvisUserCommandId('aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee')).toBe(true);
    expect(isJarvisUserCommandId('AAAAAAAA-BBBB-4CCC-8DDD-EEEEEEEEEEEE')).toBe(false);
  });
});
