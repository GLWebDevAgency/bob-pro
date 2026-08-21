import type { ElementType, ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import type {
  CustomerContactPresentationV1,
  JarvisCommandReceiptView,
  JarvisRunView,
} from '@bob/api-client';
import type {
  JarvisRunCall,
  JarvisRunCoordinator,
  JarvisRunFrame,
  JarvisRunPorts,
} from '../agent/jarvis-run-coordinator';
import {
  JarvisConfirmationCard,
  deriveJarvisConfirmationCardMode,
  deriveJarvisProposalDiff,
} from './jarvis-confirmation-card';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const announceForAccessibility = vi.hoisted(() => vi.fn());

vi.mock('react-native', () => ({
  AccessibilityInfo: { announceForAccessibility },
  ActivityIndicator: 'ActivityIndicator',
  Platform: { OS: 'ios' },
  Text: 'Text',
  View: 'View',
}));

vi.mock('@expo/vector-icons', () => ({ Ionicons: 'Ionicons' }));

vi.mock('@bob/ui', async () => {
  const { createElement } = await import('react');
  return {
    Button: (props: Record<string, unknown> & { children?: ReactNode }) =>
      createElement('Button', props, props.title as string),
    Card: (props: Record<string, unknown> & { children?: ReactNode }) =>
      createElement('Card', props, props.children),
    font: () => ({ fontFamily: 'MockFont' }),
    useTheme: () => ({
      colors: {
        ink900: '#ink900',
        ink800: '#ink800',
        slate500: '#slate500',
        slate400: '#slate400',
        line: '#line',
        lineSoft: '#lineSoft',
      },
      semantic: { ai: '#ai', danger: '#danger' },
      controls: { cardBorder: '#cardBorder' },
      radius: { cardLg: 18 },
    }),
  };
});

const HOST_BUTTON = 'Button' as unknown as ElementType;
const HOST_TEXT = 'Text' as unknown as ElementType;

const RUN_ID = '11111111-1111-4111-8111-111111111111';
const CONFIRMATION_ID = '33333333-3333-4333-8333-333333333333';
const NEXT_CONFIRMATION_ID = '22222222-2222-4222-8222-222222222222';
const PROPOSAL_ID = '44444444-4444-4444-8444-444444444444';
const CUSTOMER_ID = '55555555-5555-4555-8555-555555555555';
const REVIEW_ID = '66666666-6666-4666-8666-666666666666';
const CHOICE_A = '77777777-7777-4777-8777-777777777777';
const CHOICE_B = '88888888-8888-4888-8888-888888888888';
const CHOICE_UNAVAILABLE = '99999999-9999-4999-8999-999999999999';
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

/** Proposition SUIVANTE, `issued` : ce que Bob repousse après un « Modifier ». */
function nextIssued(): CustomerContactPresentationV1['confirmation'] {
  return {
    confirmationId: NEXT_CONFIRMATION_ID,
    status: 'issued',
    expiresAt: '2026-08-19T10:07:00.000Z',
    presentedAt: null,
  };
}

function presented(): Partial<CustomerContactPresentationV1> {
  return {
    confirmation: {
      confirmationId: CONFIRMATION_ID,
      status: 'presented',
      expiresAt: '2026-08-19T10:05:00.000Z',
      presentedAt: '2026-08-19T10:00:10.000Z',
    },
  };
}

function duplicateReview(): NonNullable<CustomerContactPresentationV1['duplicateReview']> {
  return {
    reviewId: REVIEW_ID,
    // L'ordre wire est volontairement l'inverse de l'ordre alphabétique : le composant ne doit
    // jamais retrier les libellés ni combler le rang dont le libellé n'a pas pu être rendu.
    choices: [
      { ordinal: 1, choiceId: CHOICE_A, label: 'Zulu Couverture' },
      { ordinal: 2, choiceId: CHOICE_B, label: 'Alpha Plomberie' },
      { ordinal: 3, choiceId: CHOICE_UNAVAILABLE, label: null },
    ],
  };
}

function reviewing(
  review: CustomerContactPresentationV1['duplicateReview'] = duplicateReview(),
): CustomerContactPresentationV1 {
  return presentation({
    phase: 'awaiting_duplicate_review',
    duplicateReview: review,
    proposal: null,
    confirmation: null,
  });
}

function receipt(): JarvisCommandReceiptView {
  return {
    outcome: 'admitted',
    run: run({ revision: 5 }),
    presentation: presentation(presented()),
    eventSequence: 9,
  };
}

/** Ce que la carte consomme du coordinateur — la surface exacte, jamais la classe entière. */
type CardCoordinator = {
  readonly acknowledgePresentation: (
    frame: JarvisRunFrame,
    ports: JarvisRunPorts,
  ) => Promise<JarvisRunCall>;
  readonly confirm: (frame: JarvisRunFrame, ports: JarvisRunPorts) => Promise<JarvisRunCall>;
  readonly reject: (frame: JarvisRunFrame, ports: JarvisRunPorts) => Promise<JarvisRunCall>;
  readonly cancel: (run: JarvisRunView, ports: JarvisRunPorts) => Promise<JarvisRunCall>;
  readonly chooseExistingCustomer: (
    frame: JarvisRunFrame,
    choiceId: string,
    ports: JarvisRunPorts,
  ) => Promise<JarvisRunCall>;
  readonly continueCreation: (
    frame: JarvisRunFrame,
    ports: JarvisRunPorts,
  ) => Promise<JarvisRunCall>;
};

function stubCoordinator(result: JarvisRunCall = { status: 'completed', value: receipt() }) {
  return {
    acknowledgePresentation: vi.fn(async () => result),
    confirm: vi.fn(async () => result),
    reject: vi.fn(async () => result),
    cancel: vi.fn(async () => result),
    chooseExistingCustomer: vi.fn(async () => result),
    continueCreation: vi.fn(async () => result),
  };
}

/** Coordinateur dont seul l'accusé est piloté : les autres gestes ne sont pas le sujet. */
function ackCoordinator(
  acknowledgePresentation: (frame: JarvisRunFrame, ports: JarvisRunPorts) => Promise<JarvisRunCall>,
): CardCoordinator {
  return {
    acknowledgePresentation,
    confirm: vi.fn(async () => ({ status: 'invalid_response' }) as JarvisRunCall),
    reject: vi.fn(async () => ({ status: 'invalid_response' }) as JarvisRunCall),
    cancel: vi.fn(async () => ({ status: 'invalid_response' }) as JarvisRunCall),
    chooseExistingCustomer: vi.fn(async () => ({ status: 'invalid_response' }) as JarvisRunCall),
    continueCreation: vi.fn(async () => ({ status: 'invalid_response' }) as JarvisRunCall),
  };
}

/** Vol tenu ouvert à la main : c'est la seule façon de remplacer une frame EN VOL. */
function deferred<T>(): { readonly promise: Promise<T>; readonly settle: (value: T) => void } {
  let settle!: (value: T) => void;
  const promise = new Promise<T>((resolve) => {
    settle = resolve;
  });
  return { promise, settle };
}

const NETWORK_LOSS: JarvisRunCall = {
  status: 'failed',
  error: { kind: 'dependency', port: 'api', cause: 'Délai réseau dépassé.' },
};

const PORTS = { submitCommand: vi.fn() } as unknown as JarvisRunPorts;

async function render(
  frame: JarvisRunFrame,
  coordinator: CardCoordinator,
  onAuthoritativeRefresh = vi.fn(),
  visible = true,
): Promise<{ renderer: ReactTestRenderer; onAuthoritativeRefresh: () => void }> {
  let renderer!: ReactTestRenderer;
  await act(async () => {
    renderer = create(
      <JarvisConfirmationCard
        frame={frame}
        coordinator={coordinator as unknown as JarvisRunCoordinator}
        ports={PORTS}
        onAuthoritativeRefresh={onAuthoritativeRefresh}
        visible={visible}
      />,
    );
  });
  return { renderer, onAuthoritativeRefresh };
}

function buttons(renderer: ReactTestRenderer): Record<string, Record<string, unknown>> {
  return Object.fromEntries(
    renderer.root
      .findAllByType(HOST_BUTTON)
      .map((node) => [node.props.title as string, node.props as Record<string, unknown>]),
  );
}

function buttonNodes(renderer: ReactTestRenderer, title: string) {
  return renderer.root.findAllByType(HOST_BUTTON).filter((node) => node.props.title === title);
}

function texts(renderer: ReactTestRenderer): string[] {
  return renderer.root
    .findAllByType(HOST_TEXT)
    .flatMap((node) => node.children.filter((child): child is string => typeof child === 'string'));
}

function textLines(renderer: ReactTestRenderer): string[] {
  return renderer.root
    .findAllByType(HOST_TEXT)
    .map((node) =>
      node.children.filter((child): child is string => typeof child === 'string').join(''),
    );
}

function labels(renderer: ReactTestRenderer): string[] {
  return renderer.root
    .findAll((node) => typeof node.props.accessibilityLabel === 'string')
    .map((node) => node.props.accessibilityLabel as string);
}

afterEach(() => {
  announceForAccessibility.mockClear();
});

describe('deriveJarvisConfirmationCardMode', () => {
  it('projette toute phase hors confirmation vers un état informatif', () => {
    expect(deriveJarvisConfirmationCardMode(presentation({ phase: 'resolving_customer' }))).toEqual(
      { kind: 'notice', reason: 'resolving' },
    );
    expect(deriveJarvisConfirmationCardMode(presentation({ phase: 'preparing_proposal' }))).toEqual(
      { kind: 'notice', reason: 'preparing' },
    );
    expect(deriveJarvisConfirmationCardMode(presentation({ phase: 'completed' }))).toEqual({
      kind: 'notice',
      reason: 'completed',
    });
    expect(deriveJarvisConfirmationCardMode(presentation({ phase: 'failed' }))).toEqual({
      kind: 'notice',
      reason: 'failed',
    });
    expect(deriveJarvisConfirmationCardMode(presentation({ phase: 'awaiting_receipt' }))).toEqual({
      kind: 'notice',
      reason: 'recording',
    });
    expect(deriveJarvisConfirmationCardMode(presentation({ phase: 'cancelling' }))).toEqual({
      kind: 'notice',
      reason: 'cancelling',
    });
  });

  it('projette la revue scellée sans trier ni reconstruire ses rangs', () => {
    const review = duplicateReview();
    const mode = deriveJarvisConfirmationCardMode(reviewing(review));

    expect(mode).toEqual({
      kind: 'duplicate_review',
      reviewId: REVIEW_ID,
      choices: review.choices,
    });
    expect(mode.kind === 'duplicate_review' ? mode.choices : null).toBe(review.choices);
    expect(deriveJarvisConfirmationCardMode(reviewing(null))).toEqual({
      kind: 'notice',
      reason: 'duplicate_labels_unavailable',
    });
  });

  it('n’ouvre la confirmation qu’après l’accusé d’affichage', () => {
    expect(deriveJarvisConfirmationCardMode(presentation())).toEqual({
      kind: 'proposal',
      ackable: true,
      confirmable: false,
    });
    expect(deriveJarvisConfirmationCardMode(presentation(presented()))).toEqual({
      kind: 'proposal',
      ackable: false,
      confirmable: true,
    });
  });

  it('explique les issues fermées d’une confirmation', () => {
    for (const [status, reason] of [
      ['consumed', 'consumed'],
      ['rejected', 'rejected'],
      ['expired', 'expired'],
      ['invalidated', 'invalidated'],
    ] as const) {
      expect(
        deriveJarvisConfirmationCardMode(
          presentation({
            confirmation: {
              confirmationId: CONFIRMATION_ID,
              status,
              expiresAt: '2026-08-19T10:05:00.000Z',
              presentedAt: null,
            },
          }),
        ),
      ).toEqual({ kind: 'notice', reason });
    }
  });
});

describe('deriveJarvisProposalDiff', () => {
  it('ne fabrique aucun « avant » : une création n’a pas de diff', () => {
    expect(deriveJarvisProposalDiff(presentation())).toBeNull();
  });

  it('rend les champs REMPLACÉS dans la grammaire avant/après de l’assistant', () => {
    const diff = deriveJarvisProposalDiff(
      presentation({
        intent: 'update',
        targetCustomerId: CUSTOMER_ID,
        proposal: {
          proposalId: PROPOSAL_ID,
          proposalHash: HASH,
          fieldsDigest: DIGEST,
          fields: [
            {
              field: 'email',
              label: 'E-mail',
              before: 'ancien@exemple.fr',
              after: 'nouveau@exemple.fr',
              sensitiveField: 'recipient',
            },
            {
              field: 'phone',
              label: 'Téléphone',
              before: null,
              after: '06 12 34 56 78',
              sensitiveField: null,
            },
          ],
        },
      }),
    );
    expect(diff?.fields).toEqual([
      { label: 'E-mail', before: 'ancien@exemple.fr', after: 'nouveau@exemple.fr' },
    ]);
  });
});

describe('JarvisConfirmationCard', () => {
  it('accuse l’affichage AU RENDU RÉEL, une seule fois, et garde « Confirmer » fermé', async () => {
    const coordinator = stubCoordinator();
    const { renderer, onAuthoritativeRefresh } = await render(
      { run: run(), presentation: presentation() },
      coordinator,
    );

    expect(coordinator.acknowledgePresentation).toHaveBeenCalledTimes(1);
    expect(onAuthoritativeRefresh).toHaveBeenCalledTimes(1);
    expect(onAuthoritativeRefresh).toHaveBeenCalledWith(receipt());
    expect(announceForAccessibility).toHaveBeenCalledWith('Bob attend votre confirmation.');
    expect(buttons(renderer).Confirmer?.disabled).toBe(true);

    // Une republication de props ne reproduit jamais l'accusé de la même confirmation.
    await act(async () => {
      renderer.update(
        <JarvisConfirmationCard
          frame={{ run: run(), presentation: presentation() }}
          coordinator={coordinator as unknown as JarvisRunCoordinator}
          ports={PORTS}
          onAuthoritativeRefresh={onAuthoritativeRefresh}
        />,
      );
    });
    expect(coordinator.acknowledgePresentation).toHaveBeenCalledTimes(1);
  });

  it('n’accuse jamais un écran qui ne montre pas la proposition, mais laisse toujours abandonner', async () => {
    const coordinator = stubCoordinator();
    const { renderer } = await render(
      { run: run(), presentation: presentation({ phase: 'preparing_proposal' }) },
      coordinator,
    );

    expect(coordinator.acknowledgePresentation).not.toHaveBeenCalled();
    expect(texts(renderer)).toContain('Dites à Bob ce qu’il faut mettre dans la fiche.');
    // UN SEUL geste ici, et c'est l'abandon : ni confirmer (il n'y a rien à confirmer) ni
    // écarter. Sans lui, un run PARKÉ — celui dont la résolution de cible n'a pas abouti —
    // tiendrait le premier plan de l'artisan sans aucun recours à l'écran.
    const boutons = renderer.root.findAllByType(HOST_BUTTON);
    expect(boutons).toHaveLength(1);
    expect(boutons[0]?.props.title).toBe('Annuler');
  });

  it('rend la revue dans l’ordre scellé, garde le rang illisible et n’émet aucune commande au montage', async () => {
    const coordinator = stubCoordinator();
    const frame: JarvisRunFrame = { run: run(), presentation: reviewing() };
    const { renderer, onAuthoritativeRefresh } = await render(frame, coordinator);

    expect(textLines(renderer).filter((line) => /^\d+\. /u.test(line))).toEqual([
      '1. Zulu Couverture',
      '2. Alpha Plomberie',
      '3. Fiche introuvable',
    ]);
    expect(coordinator.acknowledgePresentation).not.toHaveBeenCalled();
    expect(coordinator.chooseExistingCustomer).not.toHaveBeenCalled();
    expect(coordinator.continueCreation).not.toHaveBeenCalled();
    expect(coordinator.cancel).not.toHaveBeenCalled();
    expect(onAuthoritativeRefresh).not.toHaveBeenCalled();
    expect(announceForAccessibility).toHaveBeenCalledTimes(1);
    expect(announceForAccessibility).toHaveBeenCalledWith(
      'Bob a trouvé des fiches proches. Choisissez une fiche, créez-en une nouvelle, ou annulez.',
    );

    const choices = buttonNodes(renderer, 'Choisir cette fiche');
    expect(choices).toHaveLength(2);
    expect(choices.map((button) => button.props.accessibilityLabel)).toEqual([
      '1. Zulu Couverture. Choisir cette fiche existante.',
      '2. Alpha Plomberie. Choisir cette fiche existante.',
    ]);
    const unavailable = buttonNodes(renderer, 'Choix indisponible');
    expect(unavailable).toHaveLength(1);
    expect(unavailable[0]?.props).toMatchObject({
      disabled: true,
      accessibilityState: { disabled: true },
      accessibilityLabel: '3. Fiche introuvable. Choix indisponible.',
    });

    // Même si une couche native déclenchait à tort le handler d'un bouton désactivé, la carte
    // garde la frontière : aucun choix aveugle n'atteint le coordinateur.
    await act(async () => {
      (unavailable[0]?.props.onPress as () => void)();
    });
    expect(coordinator.chooseExistingCustomer).not.toHaveBeenCalled();
  });

  it('annonce une revue à VoiceOver seulement lorsqu’elle devient réellement visible', async () => {
    const coordinator = stubCoordinator();
    const frame: JarvisRunFrame = { run: run(), presentation: reviewing() };
    const onAuthoritativeRefresh = vi.fn();
    const { renderer } = await render(frame, coordinator, onAuthoritativeRefresh, false);

    expect(announceForAccessibility).not.toHaveBeenCalled();
    await act(async () => {
      renderer.update(
        <JarvisConfirmationCard
          frame={frame}
          coordinator={coordinator as unknown as JarvisRunCoordinator}
          ports={PORTS}
          onAuthoritativeRefresh={onAuthoritativeRefresh}
          visible
        />,
      );
    });
    expect(announceForAccessibility).toHaveBeenCalledTimes(1);

    // Une republication de la même revue ne la fait pas parler une seconde fois.
    await act(async () => {
      renderer.update(
        <JarvisConfirmationCard
          frame={frame}
          coordinator={coordinator as unknown as JarvisRunCoordinator}
          ports={PORTS}
          onAuthoritativeRefresh={onAuthoritativeRefresh}
          visible
        />,
      );
    });
    expect(announceForAccessibility).toHaveBeenCalledTimes(1);
  });

  it('choisit exactement la fiche rendue et transmet le reçu autoritaire à L7', async () => {
    const coordinator = stubCoordinator();
    const frame: JarvisRunFrame = { run: run(), presentation: reviewing() };
    const { renderer, onAuthoritativeRefresh } = await render(frame, coordinator);

    await act(async () => {
      (buttonNodes(renderer, 'Choisir cette fiche')[1]?.props.onPress as () => void)();
    });

    expect(coordinator.chooseExistingCustomer).toHaveBeenCalledTimes(1);
    expect(coordinator.chooseExistingCustomer).toHaveBeenCalledWith(frame, CHOICE_B, PORTS);
    expect(coordinator.continueCreation).not.toHaveBeenCalled();
    expect(coordinator.cancel).not.toHaveBeenCalled();
    expect(onAuthoritativeRefresh).toHaveBeenCalledTimes(1);
    expect(onAuthoritativeRefresh).toHaveBeenCalledWith(receipt());
  });

  it('poursuit la création et annule par les deux autorités exactes, sans promesse trompeuse', async () => {
    const frame: JarvisRunFrame = { run: run(), presentation: reviewing() };
    const continueCoordinator = stubCoordinator();
    const continued = await render(frame, continueCoordinator);

    await act(async () => {
      (buttons(continued.renderer)['Créer quand même']?.onPress as () => void)();
    });
    expect(continueCoordinator.continueCreation).toHaveBeenCalledTimes(1);
    expect(continueCoordinator.continueCreation).toHaveBeenCalledWith(frame, PORTS);
    expect(continued.onAuthoritativeRefresh).toHaveBeenCalledWith(receipt());

    const cancelCoordinator = stubCoordinator();
    const cancelled = await render(frame, cancelCoordinator);
    await act(async () => {
      (buttons(cancelled.renderer).Annuler?.onPress as () => void)();
    });
    expect(cancelCoordinator.cancel).toHaveBeenCalledTimes(1);
    expect(cancelCoordinator.cancel).toHaveBeenCalledWith(frame.run, PORTS);
    expect(cancelled.onAuthoritativeRefresh).toHaveBeenCalledWith(receipt());
    expect(
      [...textLines(cancelled.renderer), ...labels(cancelled.renderer)].join(' '),
    ).not.toContain('rien ne sera enregistré');
  });

  it('un conflit de revue relit seulement l’autorité, sans afficher un faux échec', async () => {
    const coordinator = stubCoordinator({
      status: 'failed',
      error: { kind: 'conflict', entity: 'jarvis_run', reason: 'stale_revision' },
    });
    const { renderer, onAuthoritativeRefresh } = await render(
      { run: run(), presentation: reviewing() },
      coordinator,
    );

    await act(async () => {
      (buttonNodes(renderer, 'Choisir cette fiche')[0]?.props.onPress as () => void)();
    });

    expect(coordinator.chooseExistingCustomer).toHaveBeenCalledTimes(1);
    expect(onAuthoritativeRefresh).toHaveBeenCalledTimes(1);
    expect(onAuthoritativeRefresh).toHaveBeenCalledWith();
    expect(texts(renderer)).not.toContain(
      'Bob n’a pas pu vérifier votre geste. Relisez la demande avant de réessayer.',
    );
  });

  it('borne un vol différé, annonce la panne et relit sans transmettre l’événement tactile', async () => {
    const flight = deferred<JarvisRunCall>();
    const coordinator = stubCoordinator();
    coordinator.chooseExistingCustomer.mockImplementation(() => flight.promise);
    const { renderer, onAuthoritativeRefresh } = await render(
      { run: run(), presentation: reviewing() },
      coordinator,
    );
    const choose = buttonNodes(renderer, 'Choisir cette fiche')[0];
    announceForAccessibility.mockClear();

    await act(async () => {
      (choose?.props.onPress as () => void)();
      (choose?.props.onPress as () => void)();
      await Promise.resolve();
    });
    expect(coordinator.chooseExistingCustomer).toHaveBeenCalledTimes(1);
    expect(
      renderer.root.findAllByType(HOST_BUTTON).every((button) => button.props.disabled === true),
    ).toBe(true);

    await act(async () => {
      flight.settle(NETWORK_LOSS);
      await flight.promise;
    });
    expect(texts(renderer)).toContain(
      'Bob n’a pas pu vérifier votre geste. Relisez la demande avant de réessayer.',
    );
    expect(renderer.root.findAll((node) => node.props.accessibilityRole === 'alert')).toHaveLength(
      1,
    );
    expect(
      renderer.root.findAll(
        (node) =>
          node.props.accessibilityRole === 'alert' &&
          node.props.accessibilityLiveRegion === 'polite',
      ),
    ).toHaveLength(1);
    expect(announceForAccessibility).toHaveBeenCalledTimes(1);
    expect(announceForAccessibility).toHaveBeenCalledWith(
      'Bob n’a pas pu vérifier votre geste. Relisez la demande avant de réessayer.',
    );
    expect(onAuthoritativeRefresh).not.toHaveBeenCalled();

    await act(async () => {
      (buttons(renderer)['Relire la demande']?.onPress as (event: unknown) => void)({
        nativeEvent: { source: 'test' },
      });
    });
    expect(onAuthoritativeRefresh).toHaveBeenCalledTimes(1);
    expect(onAuthoritativeRefresh).toHaveBeenCalledWith();
  });

  it('ignore la panne tardive d’une revue remplacée par une frame autoritaire plus récente', async () => {
    const flight = deferred<JarvisRunCall>();
    const coordinator = stubCoordinator();
    coordinator.chooseExistingCustomer.mockImplementation(() => flight.promise);
    const onAuthoritativeRefresh = vi.fn();
    const { renderer } = await render(
      { run: run(), presentation: reviewing() },
      coordinator,
      onAuthoritativeRefresh,
    );
    announceForAccessibility.mockClear();

    await act(async () => {
      (buttonNodes(renderer, 'Choisir cette fiche')[0]?.props.onPress as () => void)();
      await Promise.resolve();
    });
    await act(async () => {
      renderer.update(
        <JarvisConfirmationCard
          frame={{ run: run({ revision: 5 }), presentation: presentation(presented()) }}
          coordinator={coordinator as unknown as JarvisRunCoordinator}
          ports={PORTS}
          onAuthoritativeRefresh={onAuthoritativeRefresh}
        />,
      );
    });

    await act(async () => {
      flight.settle(NETWORK_LOSS);
      await flight.promise;
    });
    expect(texts(renderer)).not.toContain(
      'Bob n’a pas pu vérifier votre geste. Relisez la demande avant de réessayer.',
    );
    expect(texts(renderer)).not.toContain('Bob n’a pas pu enregistrer votre geste.');
    expect(buttons(renderer).Confirmer?.disabled).toBe(false);
    expect(onAuthoritativeRefresh).not.toHaveBeenCalled();
    expect(announceForAccessibility).not.toHaveBeenCalled();
  });

  it('nomme une revue illisible, offre seulement relecture et annulation, sans faux geste', async () => {
    const coordinator = stubCoordinator();
    const frame: JarvisRunFrame = { run: run(), presentation: reviewing(null) };
    const { renderer, onAuthoritativeRefresh } = await render(frame, coordinator);

    expect(texts(renderer)).toContain(
      'Bob n’arrive pas à afficher les fiches proches. Relisez la demande ou annulez-la.',
    );
    expect(renderer.root.findAll((node) => node.props.accessibilityRole === 'alert')).toHaveLength(
      1,
    );
    expect(renderer.root.findAllByType(HOST_BUTTON).map((button) => button.props.title)).toEqual([
      'Relire la demande',
      'Annuler',
    ]);
    expect(coordinator.acknowledgePresentation).not.toHaveBeenCalled();
    expect(coordinator.chooseExistingCustomer).not.toHaveBeenCalled();
    expect(coordinator.continueCreation).not.toHaveBeenCalled();

    await act(async () => {
      (buttons(renderer)['Relire la demande']?.onPress as (event: unknown) => void)({
        nativeEvent: { source: 'test' },
      });
    });
    expect(onAuthoritativeRefresh).toHaveBeenCalledWith();

    await act(async () => {
      (buttons(renderer).Annuler?.onPress as () => void)();
    });
    expect(coordinator.cancel).toHaveBeenCalledTimes(1);
    expect(coordinator.cancel).toHaveBeenCalledWith(frame.run, PORTS);
  });

  it('rend et annonce l’échec d’annulation sans promettre une revue absente', async () => {
    const coordinator = stubCoordinator(NETWORK_LOSS);
    const { renderer } = await render(
      {
        run: run(),
        presentation: presentation({
          phase: 'resolving_customer',
          duplicateReview: null,
          proposal: null,
          confirmation: null,
        }),
      },
      coordinator,
    );
    announceForAccessibility.mockClear();

    await act(async () => {
      (buttons(renderer).Annuler?.onPress as () => void)();
    });

    expect(texts(renderer)).toContain(
      'Bob n’a pas pu vérifier l’annulation. Relisez la demande avant de réessayer.',
    );
    expect(buttons(renderer)['Relire la demande']?.accessibilityLabel).toBe(
      'Relire la demande après l’échec de l’annulation.',
    );
    expect(announceForAccessibility).toHaveBeenCalledTimes(1);
    expect(announceForAccessibility).toHaveBeenCalledWith(
      'Bob n’a pas pu vérifier l’annulation. Relisez la demande avant de réessayer.',
    );
  });

  it('montre les détails critiques de façon vocalisable et confirme le geste', async () => {
    const coordinator = stubCoordinator();
    const { renderer, onAuthoritativeRefresh } = await render(
      { run: run(), presentation: presentation(presented()) },
      coordinator,
    );

    expect(coordinator.acknowledgePresentation).not.toHaveBeenCalled();
    expect(labels(renderer)).toContain('Nom du client : Dupont Plomberie.');
    expect(buttons(renderer).Confirmer?.disabled).toBe(false);

    await act(async () => {
      (buttons(renderer).Confirmer?.onPress as () => void)();
    });
    expect(coordinator.confirm).toHaveBeenCalledTimes(1);
    expect(onAuthoritativeRefresh).toHaveBeenCalledTimes(1);
    expect(onAuthoritativeRefresh).toHaveBeenCalledWith(receipt());
  });

  it('explique la garde des champs sensibles au point de décision', async () => {
    const coordinator = stubCoordinator();
    const { renderer } = await render(
      {
        run: run(),
        presentation: presentation({
          ...presented(),
          proposal: {
            proposalId: PROPOSAL_ID,
            proposalHash: HASH,
            fieldsDigest: DIGEST,
            fields: [
              {
                field: 'address',
                label: 'Adresse de facturation',
                before: null,
                after: '12 rue des Lilas, Sèvres',
                sensitiveField: 'address',
              },
            ],
          },
        }),
      },
      coordinator,
    );

    expect(texts(renderer).some((text) => text.includes('relit ces informations'))).toBe(true);
  });

  it('rend l’échec lisible et rejouable sans inventer un succès', async () => {
    const coordinator = stubCoordinator({
      status: 'failed',
      error: { kind: 'dependency', port: 'api', cause: 'Délai réseau dépassé.' },
    });
    const { renderer, onAuthoritativeRefresh } = await render(
      { run: run(), presentation: presentation(presented()) },
      coordinator,
    );

    await act(async () => {
      (buttons(renderer).Annuler?.onPress as () => void)();
    });
    expect(coordinator.cancel).toHaveBeenCalledTimes(1);
    expect(coordinator.cancel).toHaveBeenCalledWith(run(), PORTS);
    expect(onAuthoritativeRefresh).not.toHaveBeenCalled();
    expect(texts(renderer)).toContain('Bob n’a pas pu enregistrer votre geste.');
    expect(buttons(renderer)['Réessayer']).toBeDefined();
  });

  it('relit l’autorité quand une autre autorité a déjà avancé le run', async () => {
    const coordinator = stubCoordinator({
      status: 'failed',
      error: { kind: 'conflict', entity: 'jarvis_run', reason: 'stale_revision' },
    });
    const { renderer, onAuthoritativeRefresh } = await render(
      { run: run(), presentation: presentation(presented()) },
      coordinator,
    );

    await act(async () => {
      (buttons(renderer).Modifier?.onPress as () => void)();
    });
    expect(coordinator.reject).toHaveBeenCalledTimes(1);
    expect(onAuthoritativeRefresh).toHaveBeenCalledTimes(1);
    expect(onAuthoritativeRefresh).toHaveBeenCalledWith();
    expect(texts(renderer)).not.toContain('Bob n’a pas pu enregistrer votre geste.');
  });

  /**
   * REVUE C8 — un accusé de présentation PERDU condamnerait la carte : sans lui la confirmation
   * reste `issued`, « Confirmer » ne s'ouvre jamais, et §7.1 est bloqué à vie. Les trois preuves
   * qui suivent tiennent la propriété « l'accusé n'est jamais avalé » : un échec se DIT et se
   * rejoue, un vol concurrent le DIFFÈRE, et ce qui repart accuse la proposition RÉELLEMENT à
   * l'écran.
   */
  it('dit l’accusé perdu et le rejoue sur la MÊME proposition, sans inventer un succès', async () => {
    const acknowledgePresentation = vi
      .fn<(frame: JarvisRunFrame, ports: JarvisRunPorts) => Promise<JarvisRunCall>>()
      .mockResolvedValueOnce(NETWORK_LOSS)
      .mockResolvedValue({ status: 'completed', value: receipt() });
    const coordinator = ackCoordinator(acknowledgePresentation);
    const { renderer, onAuthoritativeRefresh } = await render(
      { run: run(), presentation: presentation() },
      coordinator,
    );

    // L'échec est NOMMÉ (c'est l'AFFICHAGE qui n'a pas été enregistré, pas un geste humain) et
    // « Confirmer » reste fermé : la carte ne prétend jamais avoir accusé.
    expect(acknowledgePresentation).toHaveBeenCalledTimes(1);
    expect(texts(renderer)).toContain(
      'Bob n’a pas pu enregistrer l’affichage de cette proposition.',
    );
    expect(buttons(renderer).Confirmer?.disabled).toBe(true);
    expect(onAuthoritativeRefresh).not.toHaveBeenCalled();

    await act(async () => {
      (buttons(renderer)['Réessayer']?.onPress as () => void)();
    });
    expect(acknowledgePresentation).toHaveBeenCalledTimes(2);
    expect(
      acknowledgePresentation.mock.calls[1]?.[0].presentation.confirmation?.confirmationId,
    ).toBe(CONFIRMATION_ID);
    // Le succès seul déclenche la relecture autoritative — et rouvre « Confirmer ».
    expect(onAuthoritativeRefresh).toHaveBeenCalledTimes(1);
    expect(onAuthoritativeRefresh).toHaveBeenCalledWith(receipt());
    expect(texts(renderer)).not.toContain(
      'Bob n’a pas pu enregistrer l’affichage de cette proposition.',
    );
  });

  it('un accusé bloqué par un geste EN VOL n’est pas avalé : il part quand la voie se libère', async () => {
    // Scénario voix+écran concurrents (revue C8) : « Modifier » vole, la voix repropose, le
    // parent pousse la nouvelle confirmation. L'accusé ne doit pas mourir dans cet interstice.
    const gesture = deferred<JarvisRunCall>();
    const acknowledgePresentation = vi
      .fn<(frame: JarvisRunFrame, ports: JarvisRunPorts) => Promise<JarvisRunCall>>()
      .mockResolvedValue({ status: 'completed', value: receipt() });
    const coordinator: CardCoordinator = {
      acknowledgePresentation,
      confirm: vi.fn(async () => ({ status: 'invalid_response' }) as JarvisRunCall),
      reject: vi.fn(() => gesture.promise),
      cancel: vi.fn(async () => ({ status: 'invalid_response' }) as JarvisRunCall),
      chooseExistingCustomer: vi.fn(async () => ({ status: 'invalid_response' }) as JarvisRunCall),
      continueCreation: vi.fn(async () => ({ status: 'invalid_response' }) as JarvisRunCall),
    };
    const onAuthoritativeRefresh = vi.fn();
    // La proposition est DÉJÀ présentée : rien n'est dû au montage, seul « Modifier » part.
    const { renderer } = await render(
      { run: run(), presentation: presentation(presented()) },
      coordinator,
      onAuthoritativeRefresh,
    );
    await act(async () => {
      (buttons(renderer).Modifier?.onPress as () => void)();
    });
    expect(coordinator.reject).toHaveBeenCalledTimes(1);
    expect(acknowledgePresentation).not.toHaveBeenCalled();

    // Bob repropose PENDANT le vol : nouvelle confirmation `issued`, révision neuve.
    await act(async () => {
      renderer.update(
        <JarvisConfirmationCard
          frame={{
            run: run({ revision: 6 }),
            presentation: presentation({ confirmation: nextIssued() }),
          }}
          coordinator={coordinator as unknown as JarvisRunCoordinator}
          ports={PORTS}
          onAuthoritativeRefresh={onAuthoritativeRefresh}
        />,
      );
    });
    // Un seul geste à la fois : l'accusé attend son tour, il n'est pas perdu pour autant.
    expect(acknowledgePresentation).not.toHaveBeenCalled();

    await act(async () => {
      gesture.settle({ status: 'completed', value: receipt() });
      await gesture.promise;
    });
    expect(acknowledgePresentation).toHaveBeenCalledTimes(1);
    expect(
      acknowledgePresentation.mock.calls[0]?.[0].presentation.confirmation?.confirmationId,
    ).toBe(NEXT_CONFIRMATION_ID);
    expect(acknowledgePresentation.mock.calls[0]?.[0].run.revision).toBe(6);
  });

  it('une proposition remplacée EN VOL déplace l’accusé sur la NOUVELLE confirmation', async () => {
    const flight = deferred<JarvisRunCall>();
    let departures = 0;
    const acknowledgePresentation = vi.fn<
      (frame: JarvisRunFrame, ports: JarvisRunPorts) => Promise<JarvisRunCall>
    >(async () => {
      departures += 1;
      return departures === 1 ? flight.promise : { status: 'completed', value: receipt() };
    });
    const coordinator = ackCoordinator(acknowledgePresentation);
    const onAuthoritativeRefresh = vi.fn();
    const { renderer } = await render(
      { run: run(), presentation: presentation() },
      coordinator,
      onAuthoritativeRefresh,
    );
    expect(acknowledgePresentation).toHaveBeenCalledTimes(1);

    // La voix a reproposé pendant que l'accusé volait : nouvelle confirmation, nouvelle
    // révision. Un seul vol reste ouvert — la carte ne double jamais un geste.
    const republished: JarvisRunFrame = {
      run: run({ revision: 6 }),
      presentation: presentation({ confirmation: nextIssued() }),
    };
    await act(async () => {
      renderer.update(
        <JarvisConfirmationCard
          frame={republished}
          coordinator={coordinator as unknown as JarvisRunCoordinator}
          ports={PORTS}
          onAuthoritativeRefresh={onAuthoritativeRefresh}
        />,
      );
    });
    expect(acknowledgePresentation).toHaveBeenCalledTimes(1);

    // Le vol se pose : l'accusé DÛ part alors sur la proposition réellement à l'écran, jamais
    // sur celle qui n'est plus montrée.
    await act(async () => {
      flight.settle({ status: 'completed', value: receipt() });
      await flight.promise;
    });
    expect(acknowledgePresentation).toHaveBeenCalledTimes(2);
    const second = acknowledgePresentation.mock.calls[1]?.[0];
    expect(second?.presentation.confirmation?.confirmationId).toBe(NEXT_CONFIRMATION_ID);
    expect(second?.run.revision).toBe(6);
  });

  it('ferme toute action sur une proposition invalidée et dit pourquoi', async () => {
    const coordinator = stubCoordinator();
    const { renderer } = await render(
      {
        run: run(),
        presentation: presentation({
          confirmation: {
            confirmationId: CONFIRMATION_ID,
            status: 'invalidated',
            expiresAt: '2026-08-19T10:05:00.000Z',
            presentedAt: '2026-08-19T10:00:10.000Z',
          },
        }),
      },
      coordinator,
    );

    expect(renderer.root.findAllByType(HOST_BUTTON)).toHaveLength(0);
    expect(coordinator.acknowledgePresentation).not.toHaveBeenCalled();
    expect(
      texts(renderer).some((text) => text.includes('Bob va vous en proposer une nouvelle')),
    ).toBe(true);
  });
});
