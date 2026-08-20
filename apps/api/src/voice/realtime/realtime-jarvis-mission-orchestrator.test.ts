import { describe, expect, it, vi } from 'vitest';
import { isPlannerSafeHistoryText } from '@bob/ai';
import {
  type CustomerCandidate,
  CUSTOMER_CONTACT_STATE_SCHEMA,
  computeCustomerContactFieldsDigest,
  computeCustomerContactProposalHash,
  computeCustomerContactSensitiveDigest,
  type CustomerContactProposedFieldsV1,
  type CustomerContactSemanticFrameV1,
  type JarvisAdmissionResult,
  type JarvisAdmissionUnitOfWorkPort,
  type JarvisProposalPayloadSealResult,
  type JarvisProposalPayloadStorePort,
  type JarvisRunEnvelope,
  type JarvisUserAdmissionEnvelope,
} from '@bob/core';
import {
  RealtimeJarvisMissionOrchestrator,
  computeCustomerContactCanonicalInputDigest,
  deriveRealtimeCustomerContactRunId,
  type RealtimeJarvisMissionOrchestrationInput,
} from './realtime-jarvis-mission-orchestrator';

const SESSION_ID = '20000000-0000-4000-8000-000000000001';
const TURN_ID = '10000000-0000-4000-8000-000000000001';
const EFFECT_ID = '30000000-0000-4000-8000-000000000001';
const CONFIRMATION_ID = '40000000-0000-4000-8000-000000000001';
const PROPOSAL_ID = '50000000-0000-4000-8000-000000000001';
const NOW = new Date('2026-08-19T10:00:00.000Z');

const AUTHORITY = Object.freeze({
  owner: Object.freeze({ companyId: 'company-1', ownerUserId: 'owner-1' }),
  proof: Object.freeze({
    protocolVersion: 1 as const,
    subjectHashCandidates: Object.freeze(['a'.repeat(64)]),
    principalBindingHash: 'b'.repeat(64),
    capabilityHash: 'c'.repeat(64),
  }),
  realtimeSessionId: SESSION_ID,
});

function request(signal = new AbortController().signal): RealtimeJarvisMissionOrchestrationInput {
  return {
    authority: AUTHORITY,
    turnId: TURN_ID,
    transcript: 'Crée la fiche de Dupont Plomberie.',
    history: [],
    contextRevision: 3,
    contextDigest: 'd'.repeat(64),
    signal,
  };
}

function fields(
  over: Partial<CustomerContactProposedFieldsV1> = {},
): CustomerContactProposedFieldsV1 {
  return {
    displayName: 'Dupont Plomberie',
    legalName: null,
    email: null,
    phone: null,
    addressLine: null,
    postalCode: null,
    city: 'Paris',
    vatNumber: null,
    billingChannel: null,
    recipientName: null,
    ...over,
  };
}

function frame(
  operation: CustomerContactSemanticFrameV1['operation'],
): CustomerContactSemanticFrameV1 {
  return {
    schema: 'bob.semantic.customer-contact',
    version: 1,
    operation,
    model: 'gpt-test',
  };
}

function state(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schema: CUSTOMER_CONTACT_STATE_SCHEMA,
    version: 1,
    phase: 'preparing_proposal',
    steps: 2,
    effectId: EFFECT_ID,
    intent: { mode: 'create' },
    duplicateReview: null,
    proposal: null,
    confirmation: null,
    receipt: null,
    resolvedExistingCustomerId: null,
    submittedJobRef: null,
    wakes: [],
    wakesScheduled: 0,
    cancelReason: null,
    failureReason: null,
    ...over,
  };
}

function runEnvelope(
  over: Partial<Extract<JarvisRunEnvelope, { stateVersion: number }>> = {},
): JarvisRunEnvelope {
  return {
    kind: 'customer_contact',
    runId: deriveRealtimeCustomerContactRunId(SESSION_ID, 0),
    companyId: 'company-1',
    createdBy: 'owner-1',
    definitionVersion: 1,
    status: 'active',
    revision: 4,
    stateVersion: 1,
    state: state(),
    nextWakeAt: null,
    terminalAt: null,
    ...over,
  };
}

function harness(
  options: {
    readonly run?: JarvisRunEnvelope | null;
    /** Runs supplémentaires par ordinal dérivé (balayage de session). */
    readonly runs?: readonly JarvisRunEnvelope[];
    readonly admissionResult?: JarvisAdmissionResult;
    readonly seal?: JarvisProposalPayloadSealResult;
    readonly admission?: JarvisAdmissionUnitOfWorkPort | null;
    readonly payloads?: JarvisProposalPayloadStorePort | null;
    /** Run courant de l'owner, TOUS SEMEURS CONFONDUS (U1-f §2) — `undefined` = vue sans annuaire. */
    readonly currentRun?: JarvisRunEnvelope | null;
    /**
     * Candidats de doublon (U1-g). `undefined` = vue SANS recherche (l'appelant doit échouer
     * fermé) ; `'throws'` = base indisponible ; un tableau = ce que la base rend.
     */
    readonly candidates?: readonly CustomerCandidate[] | 'throws';
  } = {},
) {
  const run = options.run === undefined ? runEnvelope() : options.run;
  const extraRuns = options.runs ?? [];
  const admitted: JarvisAdmissionResult = options.admissionResult ?? {
    status: 'admitted',
    postimage: runEnvelope({ revision: 5 }),
    eventSequence: 5,
    workItemIds: [],
  };
  const runJarvisAdmission = vi.fn(async (envelope: JarvisUserAdmissionEnvelope) => {
    // Le double imite l'admission RÉELLE sur le point qui compte pour le chaînage : un semis rend
    // un postimage à la révision 1, en `resolving_customer`. La garde anti-conflit du second
    // maillon s'y adosse — un double qui rendrait n'importe quelle révision la ferait mordre à
    // tort et masquerait ce qu'on veut prouver.
    const command = envelope.command as { readonly type?: string } | null;
    if (command?.type === 'start_run' && options.admissionResult === undefined) {
      return {
        status: 'admitted' as const,
        postimage: runEnvelope({
          revision: 1,
          state: state({ phase: 'resolving_customer', steps: 1 }),
        }),
        eventSequence: 1,
        workItemIds: [],
      };
    }
    return admitted;
  });
  const runJarvisSystemAdmission = vi.fn(async () => admitted);
  const readJarvisStateless = vi.fn(
    async (
      _owner: { readonly companyId: string; readonly ownerUserId: string },
      read: (view: {
        readonly runById: (runId: string) => Promise<JarvisRunEnvelope | null>;
        readonly currentRun?: () => Promise<JarvisRunEnvelope | null>;
        readonly customerCandidates?: (query: string) => Promise<readonly CustomerCandidate[]>;
      }) => Promise<unknown>,
    ) => ({
      status: 'executed' as const,
      value: await read({
        runById: async (runId) =>
          extraRuns.find((candidate) => candidate.runId === runId) ??
          (run !== null && run.runId === runId ? run : null),
        ...(options.currentRun === undefined
          ? {}
          : { currentRun: async () => options.currentRun ?? null }),
        ...(options.candidates === undefined
          ? {}
          : {
              customerCandidates: async () => {
                if (options.candidates === 'throws') throw new Error('base indisponible');
                return options.candidates ?? [];
              },
            }),
      }),
      readAt: NOW.toISOString(),
    }),
  );
  const admission = {
    runJarvisAdmission,
    runJarvisSystemAdmission,
    readJarvisStateless,
  } as unknown as JarvisAdmissionUnitOfWorkPort;
  const sealProposalPayload = vi.fn(
    async () => options.seal ?? ({ status: 'sealed' } as JarvisProposalPayloadSealResult),
  );
  const readProposalPayload = vi.fn(async () => null);
  const payloads = { sealProposalPayload, readProposalPayload };
  return {
    orchestrator: new RealtimeJarvisMissionOrchestrator(
      options.admission === undefined ? admission : options.admission,
      options.payloads === undefined ? payloads : options.payloads,
      () => NOW,
    ),
    runJarvisAdmission,
    readJarvisStateless,
    sealProposalPayload,
  };
}

describe('RealtimeJarvisMissionOrchestrator — prepare', () => {
  it('projette la lentille sémantique sans lecture métier ni écriture', async () => {
    const h = harness();

    const prepared = await h.orchestrator.prepare(request());

    expect(prepared).toMatchObject({
      status: 'prepared',
      prepared: {
        missionKind: 'customer_contact@1',
        runId: deriveRealtimeCustomerContactRunId(SESSION_ID, 0),
        expectedRevision: 4,
        semanticContext: {
          runAlias: 'R1',
          phase: 'preparing_proposal',
          intentMode: 'create',
          presentedDuplicateCount: 0,
          proposalPresented: false,
        },
      },
    });
    expect(h.runJarvisAdmission).not.toHaveBeenCalled();
  });

  it('rend une lentille inactive et la graine dérivée quand aucun run n’existe', async () => {
    const h = harness({ run: null });

    await expect(h.orchestrator.prepare(request())).resolves.toMatchObject({
      status: 'prepared',
      prepared: {
        expectedRevision: 0,
        semanticContext: { phase: 'inactive', runAlias: null, intentMode: null },
      },
    });
  });

  it('U1-f §2 : adopte le run COURANT de l’artisan, même semé par l’écran', async () => {
    // CONTINUITÉ §14. Le foreground est UNIQUE par propriétaire : un run ouvert depuis la fiche
    // client occupe la place. Si la voix ne balayait que ses propres graines, elle serait aveugle
    // à ce run — elle refuserait tout en `foreground_busy` sans jamais pouvoir le faire avancer,
    // et la modification ouverte à l'écran n'aurait AUCUN émetteur de proposition.
    const runEcran = runEnvelope({
      runId: '77777777-7777-4777-8777-777777777777',
      revision: 9,
      state: state({ phase: 'preparing_proposal' }),
    });
    const h = harness({ run: null, currentRun: runEcran });

    await expect(h.orchestrator.prepare(request())).resolves.toMatchObject({
      status: 'prepared',
      prepared: {
        runId: runEcran.runId,
        expectedRevision: 9,
        // La voix peut PROPOSER dessus : c'est exactement le maillon qui manquait.
        availableCapabilities: ['customer_contact.proposal.stage', 'customer_contact.run.cancel'],
      },
    });
  });

  it('U1-f §2 : sans annuaire (vue sans currentRun), la voix retombe sur ses graines', async () => {
    // `currentRun` est OPTIONNEL : un adaptateur qui ne sait pas énumérer n'en fournit pas une
    // moitié. La voix ne devine alors rien — elle reprend son balayage déterministe.
    const h = harness({ run: null });

    await expect(h.orchestrator.prepare(request())).resolves.toMatchObject({
      status: 'prepared',
      prepared: {
        runId: deriveRealtimeCustomerContactRunId(SESSION_ID, 0),
        expectedRevision: 0,
        semanticContext: { phase: 'inactive' },
      },
    });
  });

  it('verrouille la lentille d’un run vivant non actionnable et saute les runs terminaux', async () => {
    const locked = harness({
      run: runEnvelope({
        status: 'waiting_external',
        state: state({
          phase: 'committing',
          steps: 4,
          proposal: {
            proposalId: PROPOSAL_ID,
            proposalCommandId: TURN_ID,
            fieldsDigest: computeCustomerContactFieldsDigest(fields()),
            sensitiveDigest: computeCustomerContactSensitiveDigest(fields()),
            targetRevision: null,
            // Sceau de cible §9.1 : une création n'a pas de cible relue.
            targetSensitiveDigest: null,
            proposalHash: 'e'.repeat(64),
          },
          confirmation: {
            confirmationId: CONFIRMATION_ID,
            status: 'consumed',
            issuedAt: NOW.toISOString(),
            presentedAt: NOW.toISOString(),
            expiresAt: new Date(NOW.getTime() + 300_000).toISOString(),
            consumedByCommandId: TURN_ID,
            wakeId: CONFIRMATION_ID,
          },
          wakes: [],
          wakesScheduled: 1,
        }),
      }),
    });
    await expect(locked.orchestrator.prepare(request())).resolves.toMatchObject({
      status: 'prepared',
      prepared: { semanticContext: { phase: 'locked' } },
    });

    // Un run TERMINÉ ne bloque pas la session : la graine suivante est libre.
    const finished = harness({
      run: runEnvelope({
        status: 'completed',
        state: state({ phase: 'completed', resolvedExistingCustomerId: 'customer-9' }),
      }),
    });
    await expect(finished.orchestrator.prepare(request())).resolves.toMatchObject({
      status: 'prepared',
      prepared: {
        runId: deriveRealtimeCustomerContactRunId(SESSION_ID, 1),
        expectedRevision: 0,
        semanticContext: { phase: 'inactive' },
      },
    });
  });

  it('échoue fermé quand la session a épuisé ses runs et sans port d’admission', async () => {
    const terminalState = state({ phase: 'completed', resolvedExistingCustomerId: 'customer-9' });
    const exhausted = harness({
      run: null,
      runs: [0, 1, 2, 3].map((ordinal) =>
        runEnvelope({
          runId: deriveRealtimeCustomerContactRunId(SESSION_ID, ordinal),
          status: 'completed',
          state: terminalState,
        }),
      ),
    });
    await expect(exhausted.orchestrator.prepare(request())).resolves.toMatchObject({
      status: 'failed',
    });

    const unwired = harness({ admission: null });
    await expect(unwired.orchestrator.prepare(request())).resolves.toMatchObject({
      status: 'failed',
    });
  });
});

describe('RealtimeJarvisMissionOrchestrator — runPlanned', () => {
  it('scelle la PII AVANT de proposer, puis compose l’enveloppe exacte', async () => {
    const h = harness();
    const prepared = await h.orchestrator.prepare(request());
    if (prepared.status !== 'prepared') throw new Error('préparation attendue');

    const outcome = await h.orchestrator.runPlanned({
      request: request(),
      prepared: prepared.prepared,
      frame: frame({ kind: 'propose_fields', fields: fields() }),
    });

    expect(outcome.status).toBe('handled');
    expect(h.sealProposalPayload).toHaveBeenCalledOnce();
    const sealOrder = h.sealProposalPayload.mock.invocationCallOrder[0]!;
    const admitOrder = h.runJarvisAdmission.mock.invocationCallOrder[0]!;
    expect(sealOrder).toBeLessThan(admitOrder);

    const envelope = h.runJarvisAdmission.mock.calls[0]![0];
    const runId = deriveRealtimeCustomerContactRunId(SESSION_ID, 0);
    expect(envelope).toMatchObject({
      companyId: 'company-1',
      ownerUserId: 'owner-1',
      kind: 'customer_contact',
      definitionVersion: 1,
      runId,
      commandId: TURN_ID,
      expectedRevision: 4,
      actionId: 'client-creer',
      actionVersion: 1,
      authority: { source: 'realtime_capability', proof: AUTHORITY.proof },
      occurredAt: NOW.toISOString(),
    });
    expect(envelope.command).toMatchObject({
      type: 'stage_proposal',
      fieldsDigest: computeCustomerContactFieldsDigest(fields()),
      sensitiveDigest: computeCustomerContactSensitiveDigest(fields()),
      targetRevision: null,
    });
    // Digest d'entrée calculé SERVEUR sur la commande canonique, jamais fourni par l'appelant.
    expect(envelope.canonicalInputDigest).toBe(
      computeCustomerContactCanonicalInputDigest({
        runId,
        commandId: TURN_ID,
        command: envelope.command,
      }),
    );
    // La proposition vocale n'est jamais « déjà présentée » : elle reste à accuser puis confirmer.
    expect(outcome.status === 'handled' && outcome.canonicalSpeech).toContain('Dupont Plomberie');
  });

  it('rejoue le même tour à l’identique — même enveloppe, même digest', async () => {
    const h = harness();
    const prepared = await h.orchestrator.prepare(request());
    if (prepared.status !== 'prepared') throw new Error('préparation attendue');
    const planned = {
      request: request(),
      prepared: prepared.prepared,
      frame: frame({ kind: 'propose_fields', fields: fields() }),
    };

    await h.orchestrator.runPlanned(planned);
    await h.orchestrator.runPlanned(planned);

    const [first, second] = h.runJarvisAdmission.mock.calls.map((call) => call[0]);
    expect(second).toEqual(first);
  });

  it('n’admet AUCUNE enveloppe si la charge PII ne peut pas être scellée', async () => {
    const conflict = harness({ seal: { status: 'conflict' } });
    const prepared = await conflict.orchestrator.prepare(request());
    if (prepared.status !== 'prepared') throw new Error('préparation attendue');

    const outcome = await conflict.orchestrator.runPlanned({
      request: request(),
      prepared: prepared.prepared,
      frame: frame({ kind: 'propose_fields', fields: fields() }),
    });

    expect(outcome.status).toBe('failed');
    expect(conflict.runJarvisAdmission).not.toHaveBeenCalled();

    const unwired = harness({ payloads: null });
    const preparedUnwired = await unwired.orchestrator.prepare(request());
    if (preparedUnwired.status !== 'prepared') throw new Error('préparation attendue');
    await expect(
      unwired.orchestrator.runPlanned({
        request: request(),
        prepared: preparedUnwired.prepared,
        frame: frame({ kind: 'propose_fields', fields: fields() }),
      }),
    ).resolves.toMatchObject({ status: 'failed' });
    expect(unwired.runJarvisAdmission).not.toHaveBeenCalled();
  });

  it('parle fail-closed sur chaque refus d’admission, sans jamais prétendre avoir écrit', async () => {
    const refusals: readonly JarvisAdmissionResult[] = [
      { status: 'stale_revision', actualRevision: 9 },
      { status: 'command_conflict' },
      { status: 'capability_rejected', reason: 'lease_missing' },
      { status: 'action_refused', reason: 'admission_kill_switch' },
      { status: 'quarantined' },
    ];
    for (const refusal of refusals) {
      const h = harness({ admissionResult: refusal });
      const prepared = await h.orchestrator.prepare(request());
      if (prepared.status !== 'prepared') throw new Error('préparation attendue');

      const outcome = await h.orchestrator.runPlanned({
        request: request(),
        prepared: prepared.prepared,
        frame: frame({ kind: 'propose_fields', fields: fields() }),
      });

      expect(outcome.status).toBe('failed');
      expect(outcome.canonicalSpeech).toMatch(/Rien n’a été exécuté|actualisé|repars/u);
    }
  });

  it('U1-g : sans doublon, le tour produit DEUX admissions chaînées et le run n’est pas parqué', async () => {
    // LE BLOCAGE QUE CE LOT LÈVE. Avant lui, `start_run{create}` laissait le run en
    // `resolving_customer` sans aucun émetteur de résolution : parqué à vie, hors `cancel_run`.
    const h = harness({ run: null, candidates: [] });
    const prepared = await h.orchestrator.prepare(request());
    if (prepared.status !== 'prepared') throw new Error('préparation attendue');

    const outcome = await h.orchestrator.runPlanned({
      request: request(),
      prepared: prepared.prepared,
      frame: frame({ kind: 'open_customer_creation', customerName: 'Dupont Plomberie' }),
    });

    expect(outcome.status).toBe('handled');
    expect(h.runJarvisAdmission).toHaveBeenCalledTimes(2);
    const [semis, resolution] = h.runJarvisAdmission.mock.calls.map((call) => call[0]);
    expect(semis?.command).toEqual({ type: 'start_run', intent: { mode: 'create' } });
    expect(semis?.commandId).toBe(TURN_ID);
    expect(semis?.expectedRevision).toBe(0);
    // Le SECOND maillon : résolution serveur, commandId DÉRIVÉ, révision de semis FIGÉE.
    expect(resolution?.command).toEqual({
      type: 'record_customer_resolution',
      resolution: { kind: 'no_duplicates' },
    });
    expect(resolution?.commandId).not.toBe(TURN_ID);
    expect(resolution?.expectedRevision).toBe(1);
    // Et Bob dit VRAI : il a cherché.
    expect(outcome.canonicalSpeech).toContain('J’ai vérifié');
  });

  it('U1-g : une vue SANS recherche n’écrit RIEN — on ne certifie jamais ce qu’on n’a pas vérifié', async () => {
    // LA GARDE CENTRALE. Un adaptateur qui ne sait pas chercher ne doit pas produire
    // `no_duplicates` : ce serait un fait CERTIFIÉ FAUX dans un journal immuable, et l'unique
    // fenêtre de résolution du run serait brûlée.
    const h = harness({ run: null });
    const prepared = await h.orchestrator.prepare(request());
    if (prepared.status !== 'prepared') throw new Error('préparation attendue');

    const outcome = await h.orchestrator.runPlanned({
      request: request(),
      prepared: prepared.prepared,
      frame: frame({ kind: 'open_customer_creation', customerName: 'Dupont Plomberie' }),
    });

    expect(outcome.status).toBe('failed');
    expect(h.runJarvisAdmission).not.toHaveBeenCalled();
    expect(outcome.canonicalSpeech).toContain('Je n’ai rien ouvert');
  });

  it('U1-g : une base indisponible n’ouvre RIEN non plus — l’échec est gratuit', async () => {
    // La recherche précède le semis : si elle tombe, ne rien ouvrir ne retire aucune
    // disponibilité, alors qu'ouvrir d'abord laisserait un run parqué qui confisque Jarvis.
    const h = harness({ run: null, candidates: 'throws' });
    const prepared = await h.orchestrator.prepare(request());
    if (prepared.status !== 'prepared') throw new Error('préparation attendue');

    const outcome = await h.orchestrator.runPlanned({
      request: request(),
      prepared: prepared.prepared,
      frame: frame({ kind: 'open_customer_creation', customerName: 'Dupont Plomberie' }),
    });

    expect(outcome.status).toBe('failed');
    expect(h.runJarvisAdmission).not.toHaveBeenCalled();
  });

  it('U1-g : sans nom, Bob DEMANDE — il n’ouvre pas un run à l’aveugle', async () => {
    const h = harness({ run: null, candidates: [] });
    const prepared = await h.orchestrator.prepare(request());
    if (prepared.status !== 'prepared') throw new Error('préparation attendue');

    const outcome = await h.orchestrator.runPlanned({
      request: request(),
      prepared: prepared.prepared,
      frame: frame({ kind: 'open_customer_creation', customerName: null }),
    });

    expect(outcome.status).toBe('handled');
    expect(h.runJarvisAdmission).not.toHaveBeenCalled();
    expect(outcome.canonicalSpeech).toContain('Pour quel client');
  });

  it('U1-g : des doublons sont ANNONCÉS par leur nom, dans l’ordre, et rien n’est créé', async () => {
    const h = harness({
      run: null,
      candidates: [
        { customerId: 'c-1', canonicalName: 'Dupont Plomberie', matchKind: 'exact', score: 1 },
        { customerId: 'c-2', canonicalName: 'Dupont Plomberie SARL', matchKind: 'fuzzy', score: 0.7 },
      ],
    });
    const prepared = await h.orchestrator.prepare(request());
    if (prepared.status !== 'prepared') throw new Error('préparation attendue');

    const outcome = await h.orchestrator.runPlanned({
      request: request(),
      prepared: prepared.prepared,
      frame: frame({ kind: 'open_customer_creation', customerName: 'Dupont Plomberie' }),
    });

    expect(outcome.status).toBe('handled');
    expect(outcome.canonicalSpeech).toContain('Dupont Plomberie SARL');
    expect(outcome.canonicalSpeech).toContain('Rien n’a été créé');
    const resolution = h.runJarvisAdmission.mock.calls[1]?.[0]?.command as {
      resolution?: { kind?: string; candidates?: readonly { customerId: string }[] };
    };
    expect(resolution?.resolution?.kind).toBe('duplicate_candidates');
    expect(resolution?.resolution?.candidates?.map((one) => one.customerId)).toEqual(['c-1', 'c-2']);
    // ZÉRO NOM dans ce qui est scellé : le durable ne porte que des identités et des digests.
    expect(JSON.stringify(h.runJarvisAdmission.mock.calls[1]?.[0]?.command)).not.toContain('Dupont');
  });

  it('U1-g : la REPRISE d’un run parqué résout sans jamais le rouvrir', async () => {
    // Le second maillon a été refusé au tour précédent : le run est resté en `resolving_customer`.
    // `probe_duplicates` est la seule issue autre que l'annulation — et elle doit produire UNE
    // commande, pas un nouveau semis : le run existe déjà et tient le premier plan.
    const parque = runEnvelope({ revision: 1, state: state({ phase: 'resolving_customer', steps: 1 }) });
    const h = harness({ run: parque, candidates: [] });
    const prepared = await h.orchestrator.prepare(request());
    if (prepared.status !== 'prepared') throw new Error('préparation attendue');

    const outcome = await h.orchestrator.runPlanned({
      request: request(),
      prepared: prepared.prepared,
      frame: frame({ kind: 'probe_duplicates', customerName: 'Dupont Plomberie' }),
    });

    expect(outcome.status).toBe('handled');
    expect(h.runJarvisAdmission).toHaveBeenCalledTimes(1);
    expect(h.runJarvisAdmission.mock.calls[0]?.[0]?.command).toEqual({
      type: 'record_customer_resolution',
      resolution: { kind: 'no_duplicates' },
    });
    // Bob RACONTE l'état réel : il reprend une fiche ouverte, il n'en ouvre pas une seconde.
    expect(outcome.canonicalSpeech).toContain('Je reprends la fiche');
    expect(outcome.canonicalSpeech).not.toContain('J’ouvre une fiche');
  });

  it('U1-g : recherche indisponible À LA REPRISE — Bob ne prétend PAS n’avoir rien ouvert', async () => {
    // DÉFAUT TROUVÉ PAR LA REVUE. La garde d'entrée de cette branche vient d'établir qu'un run EST
    // ouvert et confisque le premier plan de l'artisan jusqu'à 24 h. Lui dire « je n'ai rien
    // ouvert » était faux sur l'état durable — et personne n'annule ce qu'on lui dit inexistant.
    const parque = runEnvelope({ revision: 1, state: state({ phase: 'resolving_customer', steps: 1 }) });
    for (const candidates of ['throws' as const, undefined]) {
      const h = harness({ run: parque, candidates });
      const prepared = await h.orchestrator.prepare(request());
      if (prepared.status !== 'prepared') throw new Error('préparation attendue');

      const outcome = await h.orchestrator.runPlanned({
        request: request(),
        prepared: prepared.prepared,
        frame: frame({ kind: 'probe_duplicates', customerName: 'Dupont Plomberie' }),
      });

      expect(outcome.status).toBe('failed');
      expect(h.runJarvisAdmission).not.toHaveBeenCalled();
      expect(outcome.canonicalSpeech).toContain('La fiche reste ouverte');
      expect(outcome.canonicalSpeech).toContain('annule');
      expect(outcome.canonicalSpeech).not.toContain('Je n’ai rien ouvert');
    }
  });

  it('U1-g : un libellé porteur d’un invisible ne peut PAS empoisonner la parole', async () => {
    // Le nom relu en base n'est pas de confiance : U+200B franchit le validateur de création, se
    // stocke, et ressortirait ici dans une parole que le planner refuserait au tour suivant —
    // rendant l'assistant muet sur TOUTES les lanes, devis compris.
    const h = harness({
      run: null,
      candidates: [
        {
          customerId: 'c-1',
          canonicalName: 'Dupont\u200b\u00a0Plomberie',
          matchKind: 'exact',
          score: 1,
        },
      ],
    });
    const prepared = await h.orchestrator.prepare(request());
    if (prepared.status !== 'prepared') throw new Error('préparation attendue');

    const outcome = await h.orchestrator.runPlanned({
      request: request(),
      prepared: prepared.prepared,
      frame: frame({ kind: 'open_customer_creation', customerName: 'Dupont Plomberie' }),
    });

    expect(outcome.status).toBe('handled');
    expect(outcome.canonicalSpeech).toContain('Dupont Plomberie');
    expect(outcome.canonicalSpeech).not.toContain('\u200b');
    expect(outcome.canonicalSpeech).not.toContain('\u00a0');
  });

  it('U1-g : la PIRE parole possible reste recevable par le planner du tour suivant', async () => {
    // LA PROPRIÉTÉ QUI COMPTE, prouvée contre le planner lui-même et non contre un nombre recopié.
    // Cinq fiches aux noms saturés, page saturée, un invisible glissé dans chacune : c'est la
    // parole la plus longue et la plus hostile que ce lot puisse produire. Si elle franchit
    // `isPlannerSafeHistoryText`, aucune fiche de la base ne peut rendre l'assistant muet.
    const nomHostile = `${'Ateliers Bâtiment & Fils de Dupont-Plomberie '.repeat(6)}\u200b`;
    const h = harness({
      run: null,
      candidates: Array.from({ length: 6 }, (_, index) => ({
        customerId: `c-${index}`,
        canonicalName: `${nomHostile}${index}`,
        matchKind: 'fuzzy' as const,
        score: 0.9,
      })),
    });
    const prepared = await h.orchestrator.prepare(request());
    if (prepared.status !== 'prepared') throw new Error('préparation attendue');

    const outcome = await h.orchestrator.runPlanned({
      request: request(),
      prepared: prepared.prepared,
      frame: frame({ kind: 'open_customer_creation', customerName: 'Dupont Plomberie' }),
    });

    expect(outcome.status).toBe('handled');
    const parole = outcome.status === 'handled' ? outcome.canonicalSpeech : '';
    expect(isPlannerSafeHistoryText(parole)).toBe(true);
    // Et la saturation est DITE : on ne prétend jamais avoir montré toutes les fiches.
    expect(parole).toContain('au moins');
  });

  it('CORRÉLATION REALTIME : l’enveloppe la porte, sinon l’admission refuse TOUTE commande vocale', async () => {
    // DÉFAUT TROUVÉ PAR LA REVUE. L'enveloppe déclarait `authority.source = realtime_capability`
    // SANS `realtimeCorrelation` : l'admission refuse alors `capability_rejected` /
    // `missing_realtime_correlation` (le CHECK SQL du journal exige qu'un événement vocal porte sa
    // session, son tour et le contexte réellement vu). Autrement dit, AUCUNE commande Jarvis à la
    // voix ne pouvait aboutir — le vertical vocal était mort sans que rien ne le dise.
    const h = harness();
    const prepared = await h.orchestrator.prepare(request());
    if (prepared.status !== 'prepared') throw new Error('préparation attendue');

    await h.orchestrator.runPlanned({
      request: request(),
      prepared: prepared.prepared,
      frame: frame({ kind: 'propose_fields', fields: fields() }),
    });

    expect(h.runJarvisAdmission).toHaveBeenCalledTimes(1);
    const envelope = h.runJarvisAdmission.mock.calls[0]?.[0];
    expect(envelope?.realtimeCorrelation).toEqual({
      realtimeSessionId: SESSION_ID,
      turnId: TURN_ID,
      contextRevision: 3,
      contextDigest: 'd'.repeat(64),
    });
  });

  it('U1-f §6 : une DÉRIVE DE CIBLE se dit, elle ne se cache pas derrière un générique', async () => {
    // `target_revision_stale` signifie que la fiche a changé depuis la vérification de Bob. Le
    // message générique (« l'étape enregistrée ne permet pas cette action ») laissait l'artisan
    // croire à une erreur de sa part et rejouer indéfiniment le même tour.
    const h = harness({
      admissionResult: {
        status: 'refused',
        error: { code: 'invalid_command', reason: 'target_revision_stale' },
      } as unknown as JarvisAdmissionResult,
    });
    const prepared = await h.orchestrator.prepare(request());
    if (prepared.status !== 'prepared') throw new Error('préparation attendue');

    const outcome = await h.orchestrator.runPlanned({
      request: request(),
      prepared: prepared.prepared,
      frame: frame({ kind: 'propose_fields', fields: fields() }),
    });

    expect(outcome.status).toBe('failed');
    expect(outcome.canonicalSpeech).toContain('La fiche a changé');
    // Et l'engagement fondamental tient : rien n'a été exécuté.
    expect(outcome.canonicalSpeech).toContain('Rien n’a été exécuté');
  });

  it('refuse une opération que la phase relue n’admet pas', async () => {
    const h = harness();
    const prepared = await h.orchestrator.prepare(request());
    if (prepared.status !== 'prepared') throw new Error('préparation attendue');

    await expect(
      h.orchestrator.runPlanned({
        request: request(),
        prepared: prepared.prepared,
        frame: frame({ kind: 'confirm_proposal' }),
      }),
    ).resolves.toMatchObject({ status: 'failed' });
    expect(h.runJarvisAdmission).not.toHaveBeenCalled();
  });

  it('accuse la présentation vocale puis confirme la création avec le hash scellé', async () => {
    const proposalHash = computeCustomerContactProposalHash({
      runId: deriveRealtimeCustomerContactRunId(SESSION_ID, 0),
      proposalId: PROPOSAL_ID,
      actionId: 'client-creer',
      fieldsDigest: computeCustomerContactFieldsDigest(fields()),
      sensitiveDigest: computeCustomerContactSensitiveDigest(fields()),
      targetRevision: null,
      effectId: EFFECT_ID,
    });
    const confirmationState = (status: 'issued' | 'presented') =>
      state({
        phase: 'awaiting_confirmation',
        steps: 3,
        proposal: {
          proposalId: PROPOSAL_ID,
          proposalCommandId: TURN_ID,
          fieldsDigest: computeCustomerContactFieldsDigest(fields()),
          sensitiveDigest: computeCustomerContactSensitiveDigest(fields()),
          targetRevision: null,
          // Sceau de cible §9.1 : une création n'a pas de cible relue.
          targetSensitiveDigest: null,
          proposalHash,
        },
        confirmation: {
          confirmationId: CONFIRMATION_ID,
          status,
          issuedAt: NOW.toISOString(),
          presentedAt: status === 'presented' ? NOW.toISOString() : null,
          expiresAt: new Date(NOW.getTime() + 300_000).toISOString(),
          consumedByCommandId: null,
          wakeId: CONFIRMATION_ID,
        },
        wakes: [
          {
            wakeId: CONFIRMATION_ID,
            kind: 'confirmation_ttl',
            dueAt: new Date(NOW.getTime() + 300_000).toISOString(),
          },
        ],
        wakesScheduled: 1,
      });

    const issued = harness({ run: runEnvelope({ state: confirmationState('issued') }) });
    const preparedIssued = await issued.orchestrator.prepare(request());
    if (preparedIssued.status !== 'prepared') throw new Error('préparation attendue');
    expect(preparedIssued.prepared.semanticContext.proposalPresented).toBe(false);
    await issued.orchestrator.runPlanned({
      request: request(),
      prepared: preparedIssued.prepared,
      frame: frame({ kind: 'acknowledge_presentation' }),
    });
    expect(issued.runJarvisAdmission.mock.calls[0]![0].command).toEqual({
      type: 'record_presentation_ack',
      confirmationId: CONFIRMATION_ID,
      ack: 'voice_presentation_ack',
    });

    const presented = harness({ run: runEnvelope({ state: confirmationState('presented') }) });
    const preparedPresented = await presented.orchestrator.prepare(request());
    if (preparedPresented.status !== 'prepared') throw new Error('préparation attendue');
    expect(preparedPresented.prepared.semanticContext.proposalPresented).toBe(true);
    await presented.orchestrator.runPlanned({
      request: request(),
      prepared: preparedPresented.prepared,
      frame: frame({ kind: 'confirm_proposal' }),
    });
    // U1-e §2 : trois clés, comme le tap — la cible relue n'est pas une donnée de commande.
    expect(presented.runJarvisAdmission.mock.calls[0]![0].command).toEqual({
      type: 'confirm',
      confirmationId: CONFIRMATION_ID,
      proposalHash,
    });
  });

  it('refuse de confirmer une MODIFICATION à la voix : l’écran revérifie la cible', async () => {
    const h = harness({
      run: runEnvelope({
        state: state({
          phase: 'awaiting_confirmation',
          steps: 3,
          intent: { mode: 'update', target: { customerId: 'customer-7', revision: 2 } },
          proposal: {
            proposalId: PROPOSAL_ID,
            proposalCommandId: TURN_ID,
            fieldsDigest: computeCustomerContactFieldsDigest(fields()),
            sensitiveDigest: computeCustomerContactSensitiveDigest(fields()),
            targetRevision: 2,
            // Sceau de la cible RELUE par l'admission à la mise en proposition (§7.1).
            targetSensitiveDigest: 'f'.repeat(64),
            proposalHash: 'e'.repeat(64),
          },
          confirmation: {
            confirmationId: CONFIRMATION_ID,
            status: 'presented',
            issuedAt: NOW.toISOString(),
            presentedAt: NOW.toISOString(),
            expiresAt: new Date(NOW.getTime() + 300_000).toISOString(),
            consumedByCommandId: null,
            wakeId: CONFIRMATION_ID,
          },
          wakes: [],
          wakesScheduled: 1,
        }),
      }),
    });
    const prepared = await h.orchestrator.prepare(request());
    if (prepared.status !== 'prepared') throw new Error('préparation attendue');
    // U1-f — ET LA CAPACITÉ N'EST MÊME PAS ANNONCÉE. Offrir `confirm` puis le refuser
    // systématiquement ferait répéter l'artisan pour rien : Bob promettrait ce qu'il refuse.
    // L'outil n'est pas offert, et la parole renvoie à l'écran.
    expect(prepared.prepared.availableCapabilities).not.toContain(
      'customer_contact.proposal.confirm',
    );
    expect(prepared.prepared.availableCapabilities).toEqual([
      'customer_contact.proposal.reject',
      'customer_contact.run.cancel',
    ]);

    const outcome = await h.orchestrator.runPlanned({
      request: request(),
      prepared: prepared.prepared,
      frame: frame({ kind: 'confirm_proposal' }),
    });

    expect(outcome.status).toBe('failed');
    expect(h.runJarvisAdmission).not.toHaveBeenCalled();
  });
});
