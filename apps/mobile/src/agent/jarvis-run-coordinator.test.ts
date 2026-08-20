import { describe, expect, it, vi } from 'vitest';
import type {
  CustomerContactPresentationV1,
  JarvisCommandReceiptView,
  JarvisRunView,
  JarvisSubmitCommandClientInput,
} from '@bob/api-client';
import { JarvisRunCoordinator, type JarvisRunFrame } from './jarvis-run-coordinator';

const RUN_ID = '11111111-1111-4111-8111-111111111111';
const OTHER_RUN_ID = '99999999-9999-4999-8999-999999999999';
const CONFIRMATION_ID = '33333333-3333-4333-8333-333333333333';
const NEXT_CONFIRMATION_ID = '22222222-2222-4222-8222-222222222222';
const PROPOSAL_ID = '44444444-4444-4444-8444-444444444444';
const CUSTOMER_ID = '55555555-5555-4555-8555-555555555555';
const COMMAND_ID = '66666666-6666-4666-8666-666666666666';
const OTHER_COMMAND_ID = '77777777-7777-4777-8777-777777777777';
const HASH = 'a'.repeat(64);
const DIGEST = 'b'.repeat(64);

function run(overrides: Partial<JarvisRunView> = {}): JarvisRunView {
  return {
    runId: RUN_ID,
    kind: 'customer_contact',
    definitionVersion: 1,
    actionReference: { actionId: 'client-creer', actionVersion: 1 },
    status: 'waiting_user',
    revision: 4,
    nextWakeAt: null,
    terminalAt: null,
    ...overrides,
  };
}

function presentation(
  overrides: Partial<CustomerContactPresentationV1> = {},
): CustomerContactPresentationV1 {
  return {
    schema: 'bob.jarvis-run.customer-contact-presentation',
    version: 1,
    phase: 'awaiting_confirmation',
    intent: 'create',
    targetCustomerId: null,
    targetLabel: null,
    duplicateReview: null,
    proposal: {
      proposalId: PROPOSAL_ID,
      proposalHash: HASH,
      fieldsDigest: DIGEST,
      fields: [
        {
          field: 'name',
          label: 'Nom du client',
          before: null,
          after: 'Dupont Plomberie',
          sensitiveField: null,
        },
      ],
    },
    confirmation: {
      confirmationId: CONFIRMATION_ID,
      status: 'issued',
      expiresAt: '2026-08-19T10:05:00.000Z',
      presentedAt: null,
    },
    completion: null,
    ...overrides,
  };
}

function frame(
  runOverrides: Partial<JarvisRunView> = {},
  presentationOverrides: Partial<CustomerContactPresentationV1> = {},
): JarvisRunFrame {
  return { run: run(runOverrides), presentation: presentation(presentationOverrides) };
}

function receipt(overrides: Partial<JarvisCommandReceiptView> = {}): JarvisCommandReceiptView {
  return {
    outcome: 'admitted',
    run: run({ revision: 5 }),
    presentation: presentation({
      confirmation: {
        confirmationId: CONFIRMATION_ID,
        status: 'presented',
        expiresAt: '2026-08-19T10:05:00.000Z',
        presentedAt: '2026-08-19T10:00:10.000Z',
      },
    }),
    eventSequence: 9,
    ...overrides,
  };
}

function acceptingPort(value: JarvisCommandReceiptView = receipt()) {
  return {
    submitCommand: vi.fn<
      (
        input: JarvisSubmitCommandClientInput,
      ) => Promise<{ ok: true; value: JarvisCommandReceiptView }>
    >(async () => ({ ok: true, value })),
  };
}

describe('JarvisRunCoordinator — enveloppe du canal tactile', () => {
  it('scelle l’accusé d’affichage avec l’action autoritaire renvoyée par le serveur', async () => {
    const ports = acceptingPort();
    const coordinator = new JarvisRunCoordinator(() => COMMAND_ID);

    await expect(coordinator.acknowledgePresentation(frame(), ports)).resolves.toMatchObject({
      status: 'completed',
    });
    expect(ports.submitCommand).toHaveBeenCalledWith({
      runId: RUN_ID,
      kind: 'customer_contact',
      definitionVersion: 1,
      commandId: COMMAND_ID,
      expectedRevision: 4,
      actionId: 'client-creer',
      actionVersion: 1,
      command: {
        type: 'record_presentation_ack',
        confirmationId: CONFIRMATION_ID,
        ack: 'screen_ack',
      },
    });
  });

  it('utilise client-modifier@1 quand le run serveur porte cette action', async () => {
    const ports = acceptingPort();
    const coordinator = new JarvisRunCoordinator(() => COMMAND_ID);

    await coordinator.acknowledgePresentation(
      frame(
        { actionReference: { actionId: 'client-modifier', actionVersion: 1 } },
        { intent: 'update', targetCustomerId: CUSTOMER_ID },
      ),
      ports,
    );
    expect(ports.submitCommand.mock.calls[0]?.[0]).toMatchObject({
      actionId: 'client-modifier',
      actionVersion: 1,
    });
  });

  it('ne redérive jamais l’action depuis l’intention de présentation', async () => {
    const ports = acceptingPort();
    const coordinator = new JarvisRunCoordinator(() => COMMAND_ID);

    await coordinator.acknowledgePresentation(
      frame({}, { intent: 'update', targetCustomerId: CUSTOMER_ID }),
      ports,
    );
    expect(ports.submitCommand.mock.calls[0]?.[0]).toMatchObject({
      actionId: 'client-creer',
      actionVersion: 1,
    });
  });

  it('confirme avec le hash de proposition, jamais avec une revalidation locale', async () => {
    const ports = acceptingPort();
    const coordinator = new JarvisRunCoordinator(() => COMMAND_ID);

    await coordinator.confirm(
      frame(
        {},
        {
          confirmation: {
            confirmationId: CONFIRMATION_ID,
            status: 'presented',
            expiresAt: '2026-08-19T10:05:00.000Z',
            presentedAt: '2026-08-19T10:00:10.000Z',
          },
        },
      ),
      ports,
    );
    expect(ports.submitCommand.mock.calls[0]?.[0].command).toEqual({
      type: 'confirm',
      confirmationId: CONFIRMATION_ID,
      proposalHash: HASH,
    });
  });
});

describe('JarvisRunCoordinator — idempotence §5.4', () => {
  it('conserve le MÊME commandId quand le geste identique est rejoué', async () => {
    const createCommandId = vi.fn(() => COMMAND_ID);
    const ports = {
      submitCommand: vi
        .fn<
          (
            input: JarvisSubmitCommandClientInput,
          ) => Promise<
            | { ok: true; value: JarvisCommandReceiptView }
            | { ok: false; error: { kind: 'dependency'; port: string; cause: string } }
          >
        >()
        .mockResolvedValueOnce({
          ok: false,
          error: { kind: 'dependency', port: 'api', cause: 'Délai réseau dépassé.' },
        })
        .mockResolvedValue({ ok: true, value: receipt({ outcome: 'replayed' }) }),
    };
    const coordinator = new JarvisRunCoordinator(createCommandId);

    await expect(coordinator.acknowledgePresentation(frame(), ports)).resolves.toMatchObject({
      status: 'failed',
    });
    await expect(coordinator.acknowledgePresentation(frame(), ports)).resolves.toMatchObject({
      status: 'completed',
      value: { outcome: 'replayed' },
    });

    expect(createCommandId).toHaveBeenCalledTimes(1);
    expect(ports.submitCommand.mock.calls[0]?.[0].commandId).toBe(
      ports.submitCommand.mock.calls[1]?.[0].commandId,
    );
  });

  it('rejoue une annulation SBA avec le même commandId et l’action serveur', async () => {
    const createCommandId = vi.fn(() => COMMAND_ID);
    const sba = run({
      kind: 'single_business_action',
      status: 'active',
      actionReference: { actionId: 'relance-envoyer', actionVersion: 3 },
    });
    const ports = {
      submitCommand: vi
        .fn<
          (
            input: JarvisSubmitCommandClientInput,
          ) => Promise<
            | { ok: true; value: JarvisCommandReceiptView }
            | { ok: false; error: { kind: 'dependency'; port: string; cause: string } }
          >
        >()
        .mockResolvedValueOnce({
          ok: false,
          error: { kind: 'dependency', port: 'api', cause: 'Délai réseau dépassé.' },
        })
        .mockResolvedValue({
          ok: true,
          value: receipt({
            outcome: 'replayed',
            run: { ...sba, revision: 5 },
            presentation: null,
          }),
        }),
    };
    const coordinator = new JarvisRunCoordinator(createCommandId);

    await coordinator.cancel(sba, ports);
    await coordinator.cancel(sba, ports);

    expect(createCommandId).toHaveBeenCalledTimes(1);
    expect(ports.submitCommand).toHaveBeenCalledTimes(2);
    expect(ports.submitCommand.mock.calls[0]?.[0]).toMatchObject({
      actionId: 'relance-envoyer',
      actionVersion: 3,
      command: { type: 'cancel_run' },
    });
    expect(ports.submitCommand.mock.calls[0]?.[0].commandId).toBe(
      ports.submitCommand.mock.calls[1]?.[0].commandId,
    );
  });

  it('deux appareils produisent deux commandId distincts sur le même geste (G5)', async () => {
    const ports = acceptingPort();
    const appareilA = new JarvisRunCoordinator(() => COMMAND_ID);
    const appareilB = new JarvisRunCoordinator(() => OTHER_COMMAND_ID);

    await appareilA.confirm(frame({}, presentedConfirmation()), ports);
    await appareilB.confirm(frame({}, presentedConfirmation()), ports);

    expect(ports.submitCommand.mock.calls[0]?.[0].commandId).toBe(COMMAND_ID);
    expect(ports.submitCommand.mock.calls[1]?.[0].commandId).toBe(OTHER_COMMAND_ID);
    expect(ports.submitCommand.mock.calls[0]?.[0].expectedRevision).toBe(
      ports.submitCommand.mock.calls[1]?.[0].expectedRevision,
    );
  });

  it('partage le vol : un rendu qui rappelle l’accusé n’ouvre pas un second départ', async () => {
    const ports = acceptingPort();
    const coordinator = new JarvisRunCoordinator(() => COMMAND_ID);

    const first = coordinator.acknowledgePresentation(frame(), ports);
    const second = coordinator.acknowledgePresentation(frame(), ports);
    expect(second).toBe(first);
    await Promise.all([first, second]);

    expect(ports.submitCommand).toHaveBeenCalledTimes(1);
  });

  /**
   * REVUE C8 — l'écran peut devoir accuser une NOUVELLE proposition pendant que l'accusé de la
   * précédente vole encore. Le partage de vol ne doit alors surtout PAS confondre les deux : ce
   * serait perdre l'accusé de celle qui est réellement à l'écran.
   */
  it('n’assimile jamais l’accusé d’une AUTRE confirmation au vol en cours', async () => {
    const ids = ['1', '2'].map((suffix) => `6666666${suffix}-6666-4666-8666-666666666666`);
    const createCommandId = vi.fn(() => ids.shift() ?? 'épuisé');
    const ports = acceptingPort(receipt({ run: run({ revision: 6 }) }));
    const coordinator = new JarvisRunCoordinator(createCommandId);

    const inFlight = coordinator.acknowledgePresentation(frame(), ports);
    const republished = coordinator.acknowledgePresentation(
      frame(
        { revision: 6 },
        {
          confirmation: {
            confirmationId: NEXT_CONFIRMATION_ID,
            status: 'issued',
            expiresAt: '2026-08-19T10:07:00.000Z',
            presentedAt: null,
          },
        },
      ),
      ports,
    );
    expect(republished).not.toBe(inFlight);
    await expect(Promise.all([inFlight, republished])).resolves.toMatchObject([
      { status: 'completed' },
      { status: 'completed' },
    ]);

    expect(ports.submitCommand).toHaveBeenCalledTimes(2);
    expect(ports.submitCommand.mock.calls[1]?.[0].command).toEqual({
      type: 'record_presentation_ack',
      confirmationId: NEXT_CONFIRMATION_ID,
      ack: 'screen_ack',
    });
    expect(ports.submitCommand.mock.calls[0]?.[0].commandId).not.toBe(
      ports.submitCommand.mock.calls[1]?.[0].commandId,
    );
  });

  it('un geste DIFFÉRENT ne réutilise jamais le commandId d’un autre', async () => {
    const ids = ['1', '2'].map((suffix) => `6666666${suffix}-6666-4666-8666-666666666666`);
    const createCommandId = vi.fn(() => ids.shift() ?? 'épuisé');
    const ports = acceptingPort();
    const coordinator = new JarvisRunCoordinator(createCommandId);

    await coordinator.acknowledgePresentation(frame(), ports);
    await coordinator.reject(frame(), ports);

    expect(ports.submitCommand.mock.calls[0]?.[0].commandId).not.toBe(
      ports.submitCommand.mock.calls[1]?.[0].commandId,
    );
  });
});

describe('JarvisRunCoordinator — gardes §7.1 et écho de reçu', () => {
  it('n’accuse pas deux fois : une confirmation déjà présentée est refusée localement', async () => {
    const ports = acceptingPort();
    const coordinator = new JarvisRunCoordinator(() => COMMAND_ID);

    await expect(
      coordinator.acknowledgePresentation(frame({}, presentedConfirmation()), ports),
    ).resolves.toEqual({ status: 'invalid_response' });
    expect(ports.submitCommand).not.toHaveBeenCalled();
  });

  it('ne confirme jamais avant que la proposition ait été présentée', async () => {
    const ports = acceptingPort();
    const coordinator = new JarvisRunCoordinator(() => COMMAND_ID);

    await expect(coordinator.confirm(frame(), ports)).resolves.toEqual({
      status: 'invalid_response',
    });
    await expect(
      coordinator.confirm(frame({}, { phase: 'preparing_proposal' }), ports),
    ).resolves.toEqual({ status: 'invalid_response' });
    expect(ports.submitCommand).not.toHaveBeenCalled();
  });

  it('ne touche ni un run terminal ni un run sans action serveur', async () => {
    const ports = acceptingPort();
    const createCommandId = vi.fn(() => COMMAND_ID);
    const coordinator = new JarvisRunCoordinator(createCommandId);

    await expect(coordinator.cancel(run({ actionReference: null }), ports)).resolves.toEqual({
      status: 'invalid_response',
    });
    await expect(coordinator.cancel(run({ status: 'cancelling' }), ports)).resolves.toEqual({
      status: 'invalid_response',
    });

    await expect(
      coordinator.cancel(
        run({
          status: 'completed',
          terminalAt: '2026-08-19T10:02:00.000Z',
        }),
        ports,
      ),
    ).resolves.toEqual({ status: 'invalid_response' });
    expect(ports.submitCommand).not.toHaveBeenCalled();
    expect(createCommandId).not.toHaveBeenCalled();
  });

  it('refuse un reçu qui parle d’un autre run ou dont la postimage recule', async () => {
    const coordinator = new JarvisRunCoordinator(() => COMMAND_ID);

    await expect(
      coordinator.acknowledgePresentation(
        frame(),
        acceptingPort(receipt({ run: run({ runId: OTHER_RUN_ID, revision: 5 }) })),
      ),
    ).resolves.toEqual({ status: 'invalid_response' });

    await expect(
      coordinator.reject(frame(), acceptingPort(receipt({ run: run({ revision: 3 }) }))),
    ).resolves.toEqual({ status: 'invalid_response' });
  });

  it('remonte l’erreur serveur telle quelle : l’écran décide de relire', async () => {
    const ports = {
      submitCommand: vi.fn(async () => ({
        ok: false as const,
        error: { kind: 'conflict' as const, entity: 'jarvis_run', reason: 'stale_revision' },
      })),
    };
    const coordinator = new JarvisRunCoordinator(() => COMMAND_ID);

    await expect(
      coordinator.confirm(frame({}, presentedConfirmation()), ports),
    ).resolves.toMatchObject({ status: 'failed', error: { kind: 'conflict' } });
  });
});

function presentedConfirmation(): Partial<CustomerContactPresentationV1> {
  return {
    confirmation: {
      confirmationId: CONFIRMATION_ID,
      status: 'presented',
      expiresAt: '2026-08-19T10:05:00.000Z',
      presentedAt: '2026-08-19T10:00:10.000Z',
    },
  };
}
