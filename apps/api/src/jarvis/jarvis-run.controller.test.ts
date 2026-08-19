import { HttpException } from '@nestjs/common';
import {
  computeCustomerContactFieldsDigest,
  computeCustomerContactSensitiveDigest,
  type CustomerContactProposedFieldsV1,
  type JarvisAdmissionOwner,
  type JarvisAdmissionResult,
  type JarvisAdmissionUnitOfWorkPort,
  type JarvisProposalPayloadRef,
  type JarvisProposalPayloadStorePort,
  type JarvisProposalPayloadV1,
  type JarvisRunEnvelope,
  type JarvisStatelessReadResult,
  type JarvisUserAdmissionEnvelope,
} from '@bob/core';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { AppLogger, requestContext } from '../observability/logger';
import { agentMissionPrincipalBindingHash } from '../voice/realtime/realtime-agent-mission-admission';

import {
  DisabledJarvisTapAuthority,
  DurableJarvisTapAuthority,
  JarvisRunController,
  computeJarvisTapCanonicalInputDigest,
  jarvisAdmissionRefusal,
  jarvisTapAuthorityProvider,
  parseJarvisSubmitCommandBody,
  presentCustomerContactFields,
  type JarvisTapAuthority,
} from './jarvis-run.controller';

const COMPANY_ID = 'company-1';
const OWNER_USER_ID = 'owner-1';
const RUN_ID = '20000000-0000-4000-8000-000000000001';
const COMMAND_ID = '30000000-0000-4000-8000-000000000001';
const PROPOSAL_ID = '21000000-0000-4000-8000-000000000001';
const PROPOSAL_COMMAND_ID = '25000000-0000-4000-8000-000000000001';
const CONFIRMATION_ID = '22000000-0000-4000-8000-000000000001';
const EFFECT_ID = '24000000-0000-4000-8000-000000000001';
const TARGET_CUSTOMER_ID = '26000000-0000-4000-8000-000000000001';
const WAKE_ID = '23000000-0000-4000-8000-000000000001';
const PROPOSAL_HASH = 'd'.repeat(64);
const READ_AT = '2026-08-19T10:00:00.000Z';

const FIELDS: CustomerContactProposedFieldsV1 = Object.freeze({
  displayName: 'Dupont Toiture',
  legalName: null,
  email: 'contact@dupont.fr',
  phone: null,
  addressLine: '12 rue des Lilas',
  postalCode: '69003',
  city: 'Lyon',
  vatNumber: null,
  billingChannel: 'email',
  recipientName: 'Jean Dupont',
});

const FIELDS_DIGEST = computeCustomerContactFieldsDigest(FIELDS);
const SENSITIVE_DIGEST = computeCustomerContactSensitiveDigest(FIELDS);

function stateWith(overrides: Record<string, unknown> = {}): unknown {
  return {
    schema: 'bob.jarvis-run.customer-contact',
    version: 1,
    phase: 'awaiting_confirmation',
    steps: 3,
    effectId: EFFECT_ID,
    intent: { mode: 'create' },
    duplicateReview: null,
    proposal: {
      proposalId: PROPOSAL_ID,
      proposalCommandId: PROPOSAL_COMMAND_ID,
      fieldsDigest: FIELDS_DIGEST,
      sensitiveDigest: SENSITIVE_DIGEST,
      targetRevision: null,
      proposalHash: PROPOSAL_HASH,
    },
    confirmation: {
      confirmationId: CONFIRMATION_ID,
      status: 'issued',
      issuedAt: '2026-08-19T09:59:00.000Z',
      presentedAt: null,
      expiresAt: '2026-08-19T10:04:00.000Z',
      consumedByCommandId: null,
      wakeId: WAKE_ID,
    },
    receipt: null,
    resolvedExistingCustomerId: null,
    submittedJobRef: null,
    wakes: [],
    wakesScheduled: 0,
    cancelReason: null,
    failureReason: null,
    ...overrides,
  };
}

function runWith(state: unknown, revision = 4): JarvisRunEnvelope {
  return {
    kind: 'customer_contact',
    runId: RUN_ID,
    companyId: COMPANY_ID,
    createdBy: OWNER_USER_ID,
    definitionVersion: 1,
    status: 'waiting_user',
    revision,
    stateVersion: 1,
    state,
    nextWakeAt: null,
    terminalAt: null,
  };
}

function admitted(run: JarvisRunEnvelope): JarvisAdmissionResult {
  return { status: 'admitted', postimage: run, eventSequence: run.revision, workItemIds: [] };
}

class FakeAdmission implements JarvisAdmissionUnitOfWorkPort {
  readonly envelopes: JarvisUserAdmissionEnvelope[] = [];
  readonly reads: JarvisAdmissionOwner[] = [];

  constructor(
    private readonly result: JarvisAdmissionResult,
    private readonly run: JarvisRunEnvelope | null = null,
  ) {}

  runJarvisAdmission(envelope: JarvisUserAdmissionEnvelope): Promise<JarvisAdmissionResult> {
    this.envelopes.push(envelope);
    return Promise.resolve(this.result);
  }

  runJarvisSystemAdmission(): Promise<JarvisAdmissionResult> {
    return Promise.reject(new Error('le canal tactile n’émet jamais de commande système'));
  }

  async readJarvisStateless<T>(
    owner: JarvisAdmissionOwner,
    read: (view: {
      readonly runById: (runId: string) => Promise<JarvisRunEnvelope | null>;
    }) => Promise<T>,
  ): Promise<JarvisStatelessReadResult<T>> {
    this.reads.push(owner);
    return {
      status: 'executed',
      value: await read({ runById: () => Promise.resolve(this.run) }),
      readAt: READ_AT,
    };
  }
}

class FakePayloads implements JarvisProposalPayloadStorePort {
  readonly refs: JarvisProposalPayloadRef[] = [];

  constructor(private readonly payload: JarvisProposalPayloadV1 | null) {}

  sealProposalPayload(): Promise<{ status: 'unavailable' }> {
    return Promise.resolve({ status: 'unavailable' });
  }

  readProposalPayload(ref: JarvisProposalPayloadRef): Promise<JarvisProposalPayloadV1 | null> {
    this.refs.push(ref);
    return Promise.resolve(this.payload);
  }
}

function sealedPayload(): JarvisProposalPayloadV1 {
  return {
    companyId: COMPANY_ID,
    ownerUserId: OWNER_USER_ID,
    runId: RUN_ID,
    proposalId: PROPOSAL_ID,
    fieldsDigest: FIELDS_DIGEST,
    sensitiveDigest: SENSITIVE_DIGEST,
    fields: FIELDS,
  };
}

function controller(options: {
  readonly admission?: JarvisAdmissionUnitOfWorkPort | null;
  readonly payloads?: JarvisProposalPayloadStorePort | null;
  readonly authority?: JarvisTapAuthority;
} = {}) {
  const logger = { audit: vi.fn(), warn: vi.fn(), error: vi.fn() } as unknown as AppLogger;
  return {
    logger,
    controller: new JarvisRunController(
      options.authority ?? new DurableJarvisTapAuthority(),
      logger,
      options.admission === undefined ? new FakeAdmission(admitted(runWith(null))) : options.admission,
      options.payloads ?? null,
    ),
  };
}

function asOwner<T>(work: () => Promise<T>): Promise<T> {
  return requestContext.run(
    {
      correlationId: 'jarvis-tap-test',
      principal: { userId: OWNER_USER_ID, companyId: COMPANY_ID },
    },
    work,
  );
}

function submitBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    kind: 'customer_contact',
    definitionVersion: 1,
    commandId: COMMAND_ID,
    expectedRevision: 3,
    actionId: 'client-creer',
    actionVersion: 1,
    command: { type: 'record_presentation_ack', confirmationId: CONFIRMATION_ID, ack: 'screen_ack' },
    ...overrides,
  };
}

async function caught(work: () => Promise<unknown>): Promise<HttpException> {
  try {
    await work();
  } catch (error) {
    expect(error).toBeInstanceOf(HttpException);
    return error as HttpException;
  }
  throw new Error('refus attendu');
}

afterEach(() => vi.restoreAllMocks());

describe('autorité du canal tactile (greffe G1)', () => {
  it('dérive owner ET hash de liaison du bearer — jamais du corps', async () => {
    const authority = new DurableJarvisTapAuthority();
    const prepared = await asOwner(async () => authority.prepare('submit_run_command'));

    expect(prepared).toEqual({
      ok: true,
      value: {
        operation: 'submit_run_command',
        owner: { companyId: COMPANY_ID, ownerUserId: OWNER_USER_ID },
        authority: {
          source: 'authenticated_principal',
          principalBindingHash: agentMissionPrincipalBindingHash(COMPANY_ID, OWNER_USER_ID),
        },
      },
    });
  });

  it('refuse sans principal authentifié, et refuse un principal sans tenant', async () => {
    const authority = new DurableJarvisTapAuthority();
    expect(authority.prepare('read_run')).toEqual({
      ok: false,
      error: { kind: 'forbidden', reason: 'authenticated_jarvis_owner_required' },
    });
    const withoutTenant = await requestContext.run(
      { correlationId: 'c', principal: { userId: OWNER_USER_ID, companyId: null } },
      async () => authority.prepare('read_run'),
    );
    expect(withoutTenant.ok).toBe(false);
  });

  it('kill switch OFF : les DEUX routes rendent 503 sans jamais toucher à l’admission', async () => {
    const admission = new FakeAdmission(admitted(runWith(null)), runWith(null));
    const { controller: candidate } = controller({
      admission,
      authority: new DisabledJarvisTapAuthority(),
    });

    const post = await caught(() => asOwner(() => candidate.submitCommand(RUN_ID, submitBody())));
    const get = await caught(() => asOwner(() => candidate.getRun(RUN_ID)));

    expect(post.getStatus()).toBe(503);
    expect(post.getResponse()).toEqual({
      ok: false,
      error: { kind: 'unavailable', service: 'jarvis_tap_authority' },
    });
    expect(get.getStatus()).toBe(503);
    expect(admission.envelopes).toHaveLength(0);
    expect(admission.reads).toHaveLength(0);
  });

  it('choisit l’autorité selon le drapeau, au boot', () => {
    const original = process.env.BOB_JARVIS_ADMISSION_ENABLED;
    try {
      const factory = (jarvisTapAuthorityProvider as { useFactory: () => JarvisTapAuthority })
        .useFactory;
      delete process.env.BOB_JARVIS_ADMISSION_ENABLED;
      expect(factory()).toBeInstanceOf(DurableJarvisTapAuthority);
      process.env.BOB_JARVIS_ADMISSION_ENABLED = 'false';
      expect(factory()).toBeInstanceOf(DisabledJarvisTapAuthority);
    } finally {
      if (original === undefined) delete process.env.BOB_JARVIS_ADMISSION_ENABLED;
      else process.env.BOB_JARVIS_ADMISSION_ENABLED = original;
    }
  });
});

describe('corps exact (422) — le serveur ne devine jamais', () => {
  const refusals: readonly (readonly [string, Record<string, unknown>, string])[] = [
    ['clé inconnue', { ...submitBody(), occurredAt: READ_AT }, 'occurredAt'],
    ['identité serveur refusée', { ...submitBody(), companyId: COMPANY_ID }, 'companyId'],
    ['digest imposé refusé', { ...submitBody(), canonicalInputDigest: 'a'.repeat(64) }, 'canonicalInputDigest'],
    ['commandId v8 (contrat user = v4)', submitBody({ commandId: '40000000-0000-8000-8000-000000000001' }), 'commandId'],
    ['révision de seed interdite au tap', submitBody({ expectedRevision: 0 }), 'expectedRevision'],
    ['action hors bornes d’ouverture', submitBody({ actionId: 'devis-creer' }), 'actionId'],
    ['kind de la branche devis', submitBody({ kind: 'quote_creation' }), 'kind'],
    [
      'accusé vocal sur le canal tactile',
      submitBody({
        command: { type: 'record_presentation_ack', confirmationId: CONFIRMATION_ID, ack: 'voice_presentation_ack' },
      }),
      'command.ack',
    ],
    [
      'commande système',
      submitBody({ command: { type: 'record_effect_receipt', effectId: EFFECT_ID } }),
      'command.type',
    ],
    [
      'confirm sans hash de proposition',
      submitBody({ command: { type: 'confirm', confirmationId: CONFIRMATION_ID } }),
      'proposalHash',
    ],
  ];

  it.each(refusals)('refuse %s en 422 sans rien exécuter', async (_label, body, field) => {
    const admission = new FakeAdmission(admitted(runWith(null)));
    const { controller: candidate } = controller({ admission });

    const error = await caught(() => asOwner(() => candidate.submitCommand(RUN_ID, body)));

    expect(error.getStatus()).toBe(422);
    expect(JSON.stringify(error.getResponse())).toContain(field);
    expect(admission.envelopes).toHaveLength(0);
  });

  it('refuse un corps qui n’est pas un objet, et un runId non canonique', async () => {
    const { controller: candidate } = controller();
    const body = await caught(() => asOwner(() => candidate.submitCommand(RUN_ID, [])));
    const runId = await caught(() => asOwner(() => candidate.submitCommand('pas-un-uuid', submitBody())));

    expect(body.getStatus()).toBe(422);
    expect(runId.getStatus()).toBe(404);
  });

  it('reconstruit la commande clé par clé — la garde de forme est la MÊME que le domaine', () => {
    expect(parseJarvisSubmitCommandBody(submitBody()).command).toEqual({
      type: 'record_presentation_ack',
      confirmationId: CONFIRMATION_ID,
      ack: 'screen_ack',
    });
    expect(parseJarvisSubmitCommandBody(submitBody({
      command: { type: 'cancel_run', reason: 'manual_handoff' },
    })).command).toEqual({ type: 'cancel_run', reason: 'manual_handoff' });
  });
});

describe('enveloppe d’admission — les faits serveur restent serveur (G7)', () => {
  it('stampe owner, autorité, digest et horloge SERVEUR, et rejoue le même digest', async () => {
    const admission = new FakeAdmission(admitted(runWith(null, 4)));
    const { controller: candidate } = controller({ admission });

    await asOwner(() => candidate.submitCommand(RUN_ID, submitBody()));
    await asOwner(() => candidate.submitCommand(RUN_ID, submitBody()));

    const [first, second] = admission.envelopes;
    expect(first?.companyId).toBe(COMPANY_ID);
    expect(first?.ownerUserId).toBe(OWNER_USER_ID);
    expect(first?.authority).toEqual({
      source: 'authenticated_principal',
      principalBindingHash: agentMissionPrincipalBindingHash(COMPANY_ID, OWNER_USER_ID),
    });
    expect(first?.canonicalInputDigest).toBe(computeJarvisTapCanonicalInputDigest({
      runId: RUN_ID,
      commandId: COMMAND_ID,
      command: { type: 'record_presentation_ack', confirmationId: CONFIRMATION_ID, ack: 'screen_ack' },
    }));
    // Même commandId, même empreinte : condition littérale du rejeu zéro-write §5.2.
    expect(second?.canonicalInputDigest).toBe(first?.canonicalInputDigest);
    expect(first?.occurredAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u);
    expect(first?.command).toEqual({
      type: 'record_presentation_ack',
      confirmationId: CONFIRMATION_ID,
      ack: 'screen_ack',
    });
  });

  it('confirme une CRÉATION avec `revalidated* = null` — le domaine l’exige littéralement', async () => {
    const admission = new FakeAdmission(admitted(runWith(stateWith(), 5)), runWith(stateWith()));
    const { controller: candidate } = controller({ admission });

    await asOwner(() => candidate.submitCommand(RUN_ID, submitBody({
      command: { type: 'confirm', confirmationId: CONFIRMATION_ID, proposalHash: PROPOSAL_HASH },
    })));

    expect(admission.envelopes[0]?.command).toEqual({
      type: 'confirm',
      confirmationId: CONFIRMATION_ID,
      proposalHash: PROPOSAL_HASH,
      revalidatedTargetRevision: null,
      revalidatedSensitiveDigest: null,
    });
  });

  it('refuse FERMÉ la confirmation d’une MODIFICATION : la relecture de cible §7.1 manque', async () => {
    const updateState = stateWith({
      intent: { mode: 'update', target: { customerId: TARGET_CUSTOMER_ID, revision: 2 } },
      proposal: {
        proposalId: PROPOSAL_ID,
        proposalCommandId: PROPOSAL_COMMAND_ID,
        fieldsDigest: FIELDS_DIGEST,
        sensitiveDigest: SENSITIVE_DIGEST,
        targetRevision: 2,
        proposalHash: PROPOSAL_HASH,
      },
    });
    const admission = new FakeAdmission(admitted(runWith(updateState)), runWith(updateState));
    const { controller: candidate } = controller({ admission });

    const error = await caught(() => asOwner(() => candidate.submitCommand(RUN_ID, submitBody({
      actionId: 'client-modifier',
      command: { type: 'confirm', confirmationId: CONFIRMATION_ID, proposalHash: PROPOSAL_HASH },
    }))));

    expect(error.getStatus()).toBe(503);
    expect(error.getResponse()).toEqual({
      ok: false,
      error: { kind: 'unavailable', service: 'jarvis_update_confirmation_revalidation' },
    });
    expect(admission.envelopes).toHaveLength(0);
  });

  it('une transaction qui casse (keyring absent, base injoignable) reste une INDISPONIBILITÉ', async () => {
    const broken = {
      runJarvisAdmission: () => Promise.reject(new Error('JARVIS_ADMISSION_FINGERPRINT_UNAVAILABLE')),
      runJarvisSystemAdmission: () => Promise.reject(new Error('hors canal')),
      readJarvisStateless: () => Promise.reject(new Error('base injoignable')),
    } as unknown as JarvisAdmissionUnitOfWorkPort;
    const { controller: candidate, logger } = controller({ admission: broken });

    const post = await caught(() => asOwner(() => candidate.submitCommand(RUN_ID, submitBody())));
    const get = await caught(() => asOwner(() => candidate.getRun(RUN_ID)));

    expect(post.getStatus()).toBe(503);
    expect(post.getResponse()).toEqual({
      ok: false,
      error: { kind: 'unavailable', service: 'jarvis_admission' },
    });
    expect(get.getStatus()).toBe(503);
    // La cause reste NOMMÉE dans le journal — jamais avalée derrière un 503 muet.
    expect(vi.mocked(logger.error).mock.calls[0]?.[0])
      .toContain('JARVIS_ADMISSION_FINGERPRINT_UNAVAILABLE');
  });

  it('sans adapter d’admission lié, tout refuse en 503 — jamais un 500 muet', async () => {
    const { controller: candidate } = controller({ admission: null });
    const error = await caught(() => asOwner(() => candidate.submitCommand(RUN_ID, submitBody())));
    expect(error.getStatus()).toBe(503);
    expect(error.getResponse()).toEqual({
      ok: false,
      error: { kind: 'unavailable', service: 'jarvis_admission' },
    });
  });
});

describe('mapping fermé résultat d’admission -> HTTP (greffe G6)', () => {
  const context = { runId: RUN_ID, companyId: COMPANY_ID };
  const table: readonly (readonly [
    Exclude<JarvisAdmissionResult, { status: 'admitted' | 'replayed' }>,
    number,
  ])[] = [
    [{ status: 'stale_revision', actualRevision: 7 }, 409],
    [{ status: 'command_conflict' }, 409],
    [{ status: 'run_not_found' }, 404],
    [{ status: 'foreground_busy' }, 409],
    [{ status: 'company_unavailable', reason: 'missing' }, 404],
    [{ status: 'company_unavailable', reason: 'closed' }, 403],
    [{ status: 'capability_rejected', reason: 'malformed_principal_binding' }, 403],
    [{ status: 'action_refused', reason: 'admission_kill_switch' }, 503],
    [{ status: 'action_refused', reason: 'unknown_action' }, 403],
    [{ status: 'action_refused', reason: 'action_closed' }, 403],
    [{ status: 'quarantined' }, 409],
    [{ status: 'foreground_unavailable', reason: 'lock_timeout' }, 503],
    [{ status: 'refused', error: { code: 'revision_conflict', expectedRevision: 3, actualRevision: 4 } }, 409],
    [{ status: 'refused', error: { code: 'invalid_command', reason: 'confirmation_not_presented' } }, 409],
    [{ status: 'refused', error: { code: 'run_terminal', status: 'completed' } }, 409],
    [
      {
        status: 'refused',
        error: {
          code: 'delegated_error',
          error: { code: 'invalid_command', reason: 'confirmation_expired' },
        },
      },
      409,
    ],
  ];

  it.each(table)('projette %j', async (result, status) => {
    const admission = new FakeAdmission(result);
    const { controller: candidate, logger } = controller({ admission });

    const error = await caught(() => asOwner(() => candidate.submitCommand(RUN_ID, submitBody())));

    expect(error.getStatus()).toBe(status);
    expect(admission.envelopes).toHaveLength(1);
    expect(logger.audit).toHaveBeenCalledWith('jarvis.tap.refused', expect.objectContaining({
      runId: RUN_ID,
      status: result.status,
    }));
  });

  it('nomme la règle refusée plutôt qu’un refus nu', () => {
    expect(jarvisAdmissionRefusal(
      { status: 'refused', error: { code: 'invalid_command', reason: 'proposal_hash_mismatch' } },
      context,
    )).toEqual({
      kind: 'conflict',
      entity: 'jarvis_run',
      reason: 'invalid_command:proposal_hash_mismatch',
    });
    expect(jarvisAdmissionRefusal(
      {
        status: 'refused',
        error: { code: 'delegated_error', error: { code: 'invalid_command', reason: 'confirmation_expired' } },
      },
      context,
    )).toEqual({
      kind: 'conflict',
      entity: 'jarvis_run',
      reason: 'invalid_command:confirmation_expired',
    });
    expect(jarvisAdmissionRefusal(
      { status: 'refused', error: { code: 'delegated_error', error: 'opaque' } },
      context,
    )).toEqual({ kind: 'conflict', entity: 'jarvis_run', reason: 'delegated_error' });
    expect(jarvisAdmissionRefusal({ status: 'run_not_found' }, context)).toEqual({
      kind: 'not_found',
      entity: 'jarvis_run',
      id: RUN_ID,
    });
  });
});

describe('présentation écran (greffe G4) — jamais une proposition non scellée', () => {
  it('recompose depuis la charge scellée : libellés humains, champs sensibles, canal vocalisé', async () => {
    const run = runWith(stateWith(), 5);
    const payloads = new FakePayloads(sealedPayload());
    const admission = new FakeAdmission(admitted(run), run);
    const { controller: candidate } = controller({ admission, payloads });

    const snapshot = await asOwner(() => candidate.getRun(RUN_ID));

    expect(payloads.refs).toEqual([{
      companyId: COMPANY_ID,
      ownerUserId: OWNER_USER_ID,
      runId: RUN_ID,
      proposalId: PROPOSAL_ID,
      fieldsDigest: FIELDS_DIGEST,
    }]);
    expect(snapshot.run).toEqual({
      runId: RUN_ID,
      kind: 'customer_contact',
      definitionVersion: 1,
      status: 'waiting_user',
      revision: 5,
      nextWakeAt: null,
      terminalAt: null,
    });
    expect(snapshot.presentation).toEqual({
      schema: 'bob.jarvis-run.customer-contact-presentation',
      version: 1,
      phase: 'awaiting_confirmation',
      intent: 'create',
      targetCustomerId: null,
      proposal: {
        proposalId: PROPOSAL_ID,
        proposalHash: PROPOSAL_HASH,
        fieldsDigest: FIELDS_DIGEST,
        fields: [
          { field: 'display_name', label: 'Nom', before: null, after: 'Dupont Toiture', sensitiveField: null },
          { field: 'email', label: 'E-mail', before: null, after: 'contact@dupont.fr', sensitiveField: 'recipient' },
          { field: 'address_line', label: 'Adresse', before: null, after: '12 rue des Lilas', sensitiveField: 'address' },
          { field: 'postal_code', label: 'Code postal', before: null, after: '69003', sensitiveField: 'address' },
          { field: 'city', label: 'Ville', before: null, after: 'Lyon', sensitiveField: 'address' },
          { field: 'billing_channel', label: 'Facturation', before: null, after: 'Par e-mail', sensitiveField: 'billing_channel' },
          { field: 'recipient_name', label: 'Destinataire', before: null, after: 'Jean Dupont', sensitiveField: 'recipient' },
        ],
      },
      confirmation: {
        confirmationId: CONFIRMATION_ID,
        status: 'issued',
        expiresAt: '2026-08-19T10:04:00.000Z',
        presentedAt: null,
      },
    });
  });

  it('digest divergent : la charge est ABSENTE, donc la présentation aussi (fail-closed)', async () => {
    const run = runWith(stateWith(), 5);
    // Le magasin revérifie `fieldsDigest` et rend `null` sur divergence : l'écran ne confirme rien.
    const payloads = new FakePayloads(null);
    const admission = new FakeAdmission(admitted(run), run);
    const { controller: candidate } = controller({ admission, payloads });

    const snapshot = await asOwner(() => candidate.getRun(RUN_ID));
    const receipt = await asOwner(() => candidate.submitCommand(RUN_ID, submitBody()));

    expect(snapshot.presentation).toBeNull();
    expect(receipt.presentation).toBeNull();
    expect(receipt.outcome).toBe('admitted');
  });

  it('sans magasin PII lié, une proposition ne se rend jamais', async () => {
    const run = runWith(stateWith(), 5);
    const admission = new FakeAdmission(admitted(run), run);
    const { controller: candidate } = controller({ admission, payloads: null });

    expect((await asOwner(() => candidate.getRun(RUN_ID))).presentation).toBeNull();
  });

  it('sans proposition, la présentation existe mais n’offre AUCUN geste', async () => {
    const state = stateWith({ phase: 'preparing_proposal', proposal: null, confirmation: null });
    const run = runWith(state, 3);
    const admission = new FakeAdmission(admitted(run), run);
    const { controller: candidate } = controller({ admission, payloads: new FakePayloads(sealedPayload()) });

    const snapshot = await asOwner(() => candidate.getRun(RUN_ID));

    expect(snapshot.presentation).toMatchObject({ phase: 'preparing_proposal', proposal: null, confirmation: null });
  });

  it('state illisible ou run absent : présentation nulle, 404 franc', async () => {
    const corrupted = runWith({ schema: 'autre-chose' }, 2);
    const { controller: withCorrupted } = controller({
      admission: new FakeAdmission(admitted(corrupted), corrupted),
    });
    expect((await asOwner(() => withCorrupted.getRun(RUN_ID))).presentation).toBeNull();

    const { controller: withoutRun } = controller({
      admission: new FakeAdmission(admitted(runWith(null)), null),
    });
    const error = await caught(() => asOwner(() => withoutRun.getRun(RUN_ID)));
    expect(error.getStatus()).toBe(404);
  });

  it('refuse une valeur non présentable — jamais un champ tronqué à l’écran', () => {
    // Un caractere de controle dans une valeur presentee : la presentation entiere disparait.
    expect(presentCustomerContactFields({ ...FIELDS, city: 'Lyon\u0007' })).toBeNull();
    expect(presentCustomerContactFields({ ...FIELDS, city: '   ' })).toBeNull();
    expect(presentCustomerContactFields({
      displayName: null,
      legalName: null,
      email: null,
      phone: null,
      addressLine: null,
      postalCode: null,
      city: null,
      vatNumber: null,
      billingChannel: null,
      recipientName: null,
    })).toBeNull();
  });
});

describe('bornes de route', () => {
  it('chiffre le débit PAR route (POST 10/10 s, GET 30/10 s)', () => {
    const post = JarvisRunController.prototype.submitCommand;
    const get = JarvisRunController.prototype.getRun;

    expect(Reflect.getMetadata('THROTTLER:LIMITdefault', post)).toBe(10);
    expect(Reflect.getMetadata('THROTTLER:TTLdefault', post)).toBe(10_000);
    expect(Reflect.getMetadata('THROTTLER:LIMITdefault', get)).toBe(30);
    expect(Reflect.getMetadata('THROTTLER:TTLdefault', get)).toBe(10_000);
  });
});
