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
  readonly cancel: (frame: JarvisRunFrame, ports: JarvisRunPorts) => Promise<JarvisRunCall>;
};

function stubCoordinator(result: JarvisRunCall = { status: 'completed', value: receipt() }) {
  return {
    acknowledgePresentation: vi.fn(async () => result),
    confirm: vi.fn(async () => result),
    reject: vi.fn(async () => result),
    cancel: vi.fn(async () => result),
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
): Promise<{ renderer: ReactTestRenderer; onAuthoritativeRefresh: () => void }> {
  let renderer!: ReactTestRenderer;
  await act(async () => {
    renderer = create(
      <JarvisConfirmationCard
        frame={frame}
        coordinator={coordinator as unknown as JarvisRunCoordinator}
        ports={PORTS}
        onAuthoritativeRefresh={onAuthoritativeRefresh}
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

function texts(renderer: ReactTestRenderer): string[] {
  return renderer.root
    .findAllByType(HOST_TEXT)
    .flatMap((node) => node.children.filter((child): child is string => typeof child === 'string'));
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
    // U1-h — `resolving_customer` et `preparing_proposal` ne disent plus la meme chose : pendant
    // que Bob CHERCHE des doublons rien n'est attendu de l'artisan, alors qu'en preparation c'est
    // LUI qui doit dicter. Les confondre le laissait attendre un tour qui ne venait pas.
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
