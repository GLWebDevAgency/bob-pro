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
    // U1-h — LOCKSTEP : le type de presentation est TOTAL. Une cle ajoutee au wire doit
    // apparaitre dans chaque fixture, sinon la compilation le dit — et c'est voulu.
    duplicateReview: null,
    completion: null,
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
  it('scelle l’accusé d’affichage avec l’action ouverte dérivée de l’intention', async () => {
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

  it('bascule sur client-modifier@1 quand la proposition vise une fiche existante', async () => {
    const ports = acceptingPort();
    const coordinator = new JarvisRunCoordinator(() => COMMAND_ID);

    await coordinator.acknowledgePresentation(
      frame({}, { intent: 'update', targetCustomerId: CUSTOMER_ID }),
      ports,
    );
    expect(ports.submitCommand.mock.calls[0]?.[0]).toMatchObject({
      actionId: 'client-modifier',
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

  it('ne touche jamais un run terminal', async () => {
    const ports = acceptingPort();
    const coordinator = new JarvisRunCoordinator(() => COMMAND_ID);

    await expect(
      coordinator.cancel(
        frame({ status: 'completed', terminalAt: '2026-08-19T10:02:00.000Z' }),
        ports,
      ),
    ).resolves.toEqual({ status: 'invalid_response' });
    expect(ports.submitCommand).not.toHaveBeenCalled();
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

describe('JarvisRunCoordinator — U1-h : la revue de doublons se résout au doigt', () => {
  const REVIEW_ID = '77777777-7777-4777-8777-777777777777';
  const CHOICE_A = '88888888-8888-4888-8888-888888888888';
  const CHOICE_B = '99999999-9999-4999-8999-999999999999';

  function revue(
    overrides: Partial<NonNullable<CustomerContactPresentationV1['duplicateReview']>> = {},
  ): CustomerContactPresentationV1['duplicateReview'] {
    return {
      reviewId: REVIEW_ID,
      choices: [
        { ordinal: 1, choiceId: CHOICE_A, label: 'Dupont Plomberie' },
        { ordinal: 2, choiceId: CHOICE_B, label: 'Dupont Plomberie SARL' },
      ],
      ...overrides,
    };
  }

  function enRevue(
    review: CustomerContactPresentationV1['duplicateReview'] = revue(),
  ): ReturnType<typeof frame> {
    return frame(
      {},
      {
        phase: 'awaiting_duplicate_review',
        proposal: null,
        confirmation: null,
        duplicateReview: review,
      },
    );
  }

  it('« c’est celle-là » retient la fiche ÉNONCÉE, sous l’action ouverte de la création', async () => {
    const ports = acceptingPort();
    const coordinator = new JarvisRunCoordinator(() => COMMAND_ID);

    await expect(
      coordinator.chooseExistingCustomer(enRevue(), CHOICE_B, ports),
    ).resolves.toMatchObject({ status: 'completed' });
    expect(ports.submitCommand).toHaveBeenCalledWith({
      runId: RUN_ID,
      kind: 'customer_contact',
      definitionVersion: 1,
      commandId: COMMAND_ID,
      expectedRevision: 4,
      // Le run reste une CRÉATION : retenir une fiche existante ne fait pas muter l'action.
      actionId: 'client-creer',
      actionVersion: 1,
      command: {
        type: 'choose_duplicate_resolution',
        reviewId: REVIEW_ID,
        decision: { kind: 'use_existing', choiceId: CHOICE_B },
      },
    });
  });

  it('« créer quand même » poursuit la création, sans exiger de choix', async () => {
    const ports = acceptingPort();
    const coordinator = new JarvisRunCoordinator(() => COMMAND_ID);

    await expect(coordinator.continueCreation(enRevue(), ports)).resolves.toMatchObject({
      status: 'completed',
    });
    expect(ports.submitCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        command: {
          type: 'choose_duplicate_resolution',
          reviewId: REVIEW_ID,
          decision: { kind: 'continue_create' },
        },
      }),
    );
  });

  it('REFUSE SANS RÉSEAU un choix absent du jeu rendu — jamais un rattachement inventé', async () => {
    const ports = acceptingPort();
    const coordinator = new JarvisRunCoordinator(() => COMMAND_ID);

    await expect(
      coordinator.chooseExistingCustomer(enRevue(), '11111111-1111-4111-8111-111111111111', ports),
    ).resolves.toMatchObject({ status: 'invalid_response' });
    // LE POINT QUI COMPTE : rien n'est parti. Un identifiant qui ne vient pas de l'écran ne doit
    // pas même atteindre le serveur, sans quoi l'appareil deviendrait une source d'autorité.
    expect(ports.submitCommand).not.toHaveBeenCalled();
  });

  it('REFUSE SANS RÉSEAU un rang dont le nom ne s’est pas résolu — on ne choisit pas à l’aveugle', async () => {
    const ports = acceptingPort();
    const coordinator = new JarvisRunCoordinator(() => COMMAND_ID);
    const aveugle = revue({
      choices: [
        { ordinal: 1, choiceId: CHOICE_A, label: null },
        { ordinal: 2, choiceId: CHOICE_B, label: 'Dupont Plomberie SARL' },
      ],
    });

    await expect(
      coordinator.chooseExistingCustomer(enRevue(aveugle), CHOICE_A, ports),
    ).resolves.toMatchObject({ status: 'invalid_response' });
    expect(ports.submitCommand).not.toHaveBeenCalled();

    // Le rang VOISIN, lui, reste choisissable : un nom manquant ne condamne pas toute la liste.
    await expect(
      coordinator.chooseExistingCustomer(enRevue(aveugle), CHOICE_B, ports),
    ).resolves.toMatchObject({ status: 'completed' });
  });

  it('REFUSE SANS RÉSEAU hors de la phase de revue, et sans revue rendue', async () => {
    const ports = acceptingPort();
    const coordinator = new JarvisRunCoordinator(() => COMMAND_ID);

    // Phase d'écriture : la revue est passée, le choix n'a plus de sens.
    const horsPhase = frame({}, { phase: 'committing', duplicateReview: revue() });
    await expect(
      coordinator.chooseExistingCustomer(horsPhase, CHOICE_A, ports),
    ).resolves.toMatchObject({ status: 'invalid_response' });
    await expect(coordinator.continueCreation(horsPhase, ports)).resolves.toMatchObject({
      status: 'invalid_response',
    });

    // Bonne phase mais AUCUNE revue rendue (libellés indisponibles) : l'écran ne devine rien.
    const sansRevue = enRevue(null);
    await expect(
      coordinator.chooseExistingCustomer(sansRevue, CHOICE_A, ports),
    ).resolves.toMatchObject({ status: 'invalid_response' });
    await expect(coordinator.continueCreation(sansRevue, ports)).resolves.toMatchObject({
      status: 'invalid_response',
    });

    expect(ports.submitCommand).not.toHaveBeenCalled();
  });

  it('DÉDUPLIQUE les vols : deux taps sur le même rang ne partent qu’une fois', async () => {
    const ports = acceptingPort();
    const coordinator = new JarvisRunCoordinator(() => COMMAND_ID);
    const cadre = enRevue();

    const [un, deux] = await Promise.all([
      coordinator.chooseExistingCustomer(cadre, CHOICE_A, ports),
      coordinator.chooseExistingCustomer(cadre, CHOICE_A, ports),
    ]);

    expect(un).toMatchObject({ status: 'completed' });
    expect(deux).toMatchObject({ status: 'completed' });
    expect(ports.submitCommand).toHaveBeenCalledTimes(1);
  });
});
