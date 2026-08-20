import { HttpException } from '@nestjs/common';
import {
  appUnavailable,
  computeCustomerContactFieldsDigest,
  computeCustomerContactSensitiveDigest,
  err,
  type CustomerContactProposedFieldsV1,
  type JarvisAdmissionOwner,
  type JarvisAdmissionResult,
  type JarvisAdmissionUnitOfWorkPort,
  type JarvisProposalPayloadRef,
  type JarvisProposalPayloadStorePort,
  type JarvisProposalPayloadV1,
  type JarvisRunEnvelope,
  type JarvisStatelessReadResult,
  type JarvisStatelessReadView,
  type JarvisUserAdmissionEnvelope,
} from '@bob/core';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { AppLogger, requestContext } from '../observability/logger';
import { agentMissionPrincipalBindingHash } from '../voice/realtime/realtime-agent-mission-admission';

import {
  DurableJarvisTapAuthority,
  JARVIS_UNVERIFIED_TARGET_REVISION,
  JarvisRunController,
  computeJarvisTapCanonicalInputDigest,
  deriveJarvisScreenRunId,
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
const DUPLICATE_CUSTOMER_A = '27000000-0000-4000-8000-000000000001';
const DUPLICATE_CUSTOMER_B = '27000000-0000-4000-8000-000000000002';
const DUPLICATE_REVIEW_ID = '28000000-0000-4000-8000-000000000001';
const DUPLICATE_CHOICE_A = '29000000-0000-4000-8000-000000000001';
const DUPLICATE_CHOICE_B = '29000000-0000-4000-8000-000000000002';
const WAKE_ID = '23000000-0000-4000-8000-000000000001';
const PROPOSAL_HASH = 'd'.repeat(64);
/** Sceau de la cible RELUE (§9.1) — distinct du digest des champs proposés, par construction. */
const TARGET_SENSITIVE_DIGEST = 'e'.repeat(64);
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
      // Sceau de cible §9.1 : les deux moitiés vont ensemble — une création n'a pas de cible.
      targetSensitiveDigest: null,
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

function duplicateReviewState(): unknown {
  return stateWith({
    phase: 'awaiting_duplicate_review',
    duplicateReview: {
      reviewId: DUPLICATE_REVIEW_ID,
      candidates: [
        {
          choiceId: DUPLICATE_CHOICE_A,
          customerId: DUPLICATE_CUSTOMER_A,
          matchDigest: 'a'.repeat(64),
        },
        {
          choiceId: DUPLICATE_CHOICE_B,
          customerId: DUPLICATE_CUSTOMER_B,
          matchDigest: 'b'.repeat(64),
        },
      ],
      candidateSetHash: 'c'.repeat(64),
    },
    proposal: null,
    confirmation: null,
  });
}

type StatefulJarvisRunEnvelope = Extract<
  JarvisRunEnvelope,
  { readonly stateVersion: number }
>;

function runWith(state: unknown, revision = 4): StatefulJarvisRunEnvelope {
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

function terminalRunWith(state: unknown, revision = 4): JarvisRunEnvelope {
  return {
    ...runWith(state, revision),
    status: 'completed',
    terminalAt: READ_AT,
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
    /**
     * `null` = adaptateur SANS annuaire (la vue stateless n'expose alors que `runById`, exactement
     * comme la persistance d'aujourd'hui) ; un objet = annuaire lié rendant ce run courant.
     */
    private readonly directory: { readonly currentRun: JarvisRunEnvelope | null } | null = null,
    private readonly extraView: Partial<JarvisStatelessReadView> = {},
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
    read: (view: JarvisStatelessReadView) => Promise<T>,
  ): Promise<JarvisStatelessReadResult<T>> {
    this.reads.push(owner);
    const directory = this.directory;
    const baseView: JarvisStatelessReadView =
      directory === null
        ? { runById: () => Promise.resolve(this.run) }
        : {
            runById: () => Promise.resolve(this.run),
            currentRun: () => Promise.resolve(directory.currentRun),
          };
    const view: JarvisStatelessReadView = { ...baseView, ...this.extraView };
    return { status: 'executed', value: await read(view), readAt: READ_AT };
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

/** Corps EXACT de l'ouverture depuis l'écran : le commandId mémoïsé et la cible, rien d'autre. */
function openBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    commandId: COMMAND_ID,
    intent: { mode: 'update', target: { customerId: TARGET_CUSTOMER_ID } },
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

const UNAVAILABLE_TAP_AUTHORITY: JarvisTapAuthority = {
  prepare: () => err(appUnavailable('jarvis_tap_authority')),
};

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

  it('une autorité tap indisponible : les QUATRE routes rendent 503 sans toucher à l’admission', async () => {
    const admission = new FakeAdmission(admitted(runWith(null)), runWith(null), {
      currentRun: runWith(null),
    });
    const { controller: candidate } = controller({
      admission,
      authority: UNAVAILABLE_TAP_AUTHORITY,
    });

    const post = await caught(() => asOwner(() => candidate.submitCommand(RUN_ID, submitBody())));
    const open = await caught(() => asOwner(() => candidate.openRun(openBody())));
    const current = await caught(() => asOwner(() => candidate.getCurrentRun()));
    const get = await caught(() => asOwner(() => candidate.getRun(RUN_ID)));

    for (const refusal of [post, open, current, get]) {
      expect(refusal.getStatus()).toBe(503);
      expect(refusal.getResponse()).toEqual({
        ok: false,
        error: { kind: 'unavailable', service: 'jarvis_tap_authority' },
      });
    }
    expect(admission.envelopes).toHaveLength(0);
    expect(admission.reads).toHaveLength(0);
  });

  it('garde l’autorité d’authentification active sous fermeture — le gate vit dans l’admission', () => {
    const original = process.env.BOB_JARVIS_ADMISSION_ENABLED;
    try {
      const factory = (jarvisTapAuthorityProvider as { useFactory: () => JarvisTapAuthority })
        .useFactory;
      delete process.env.BOB_JARVIS_ADMISSION_ENABLED;
      expect(factory()).toBeInstanceOf(DurableJarvisTapAuthority);
      process.env.BOB_JARVIS_ADMISSION_ENABLED = 'true';
      expect(factory()).toBeInstanceOf(DurableJarvisTapAuthority);
      process.env.BOB_JARVIS_ADMISSION_ENABLED = 'TRUE';
      expect(factory()).toBeInstanceOf(DurableJarvisTapAuthority);
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
    ['action vide', submitBody({ actionId: '' }), 'actionId'],
    ['action non canonique', submitBody({ actionId: 'Devis_Creer' }), 'actionId'],
    ['action trop longue', submitBody({ actionId: `a-${'b'.repeat(100)}` }), 'actionId'],
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
    [
      'adoption hostile d’un doublon',
      submitBody({
        command: {
          type: 'choose_duplicate_resolution',
          reviewId: DUPLICATE_REVIEW_ID,
          decision: { kind: 'adopt_existing', choiceId: DUPLICATE_CHOICE_A },
        },
      }),
      'command.decision.kind',
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
    expect(parseJarvisSubmitCommandBody(submitBody({
      command: {
        type: 'choose_duplicate_resolution',
        reviewId: DUPLICATE_REVIEW_ID,
        decision: { kind: 'use_existing', choiceId: DUPLICATE_CHOICE_A },
      },
    })).command).toEqual({
      type: 'choose_duplicate_resolution',
      reviewId: DUPLICATE_REVIEW_ID,
      decision: { kind: 'use_existing', choiceId: DUPLICATE_CHOICE_A },
    });
    expect(parseJarvisSubmitCommandBody(submitBody({
      command: {
        type: 'choose_duplicate_resolution',
        reviewId: DUPLICATE_REVIEW_ID,
        decision: { kind: 'continue_create' },
      },
    })).command).toEqual({
      type: 'choose_duplicate_resolution',
      reviewId: DUPLICATE_REVIEW_ID,
      decision: { kind: 'continue_create' },
    });
  });

  it('laisse replay et drain atteindre l’admission même après retrait de l’allowlist technique', () => {
    const parsed = parseJarvisSubmitCommandBody(submitBody({
      actionId: 'devis-creer',
      command: { type: 'cancel_run', reason: 'manual_handoff' },
    }));

    expect(parsed.actionId).toBe('devis-creer');
    expect(parsed.command).toEqual({ type: 'cancel_run', reason: 'manual_handoff' });
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

  it('transmet le choix tactile de doublon clé par clé jusqu’à l’admission', async () => {
    const admission = new FakeAdmission(admitted(runWith(duplicateReviewState(), 3)));
    const { controller: candidate } = controller({ admission });

    await asOwner(() => candidate.submitCommand(RUN_ID, submitBody({
      expectedRevision: 2,
      command: {
        type: 'choose_duplicate_resolution',
        reviewId: DUPLICATE_REVIEW_ID,
        decision: { kind: 'use_existing', choiceId: DUPLICATE_CHOICE_A },
      },
    })));

    expect(admission.envelopes).toHaveLength(1);
    expect(admission.envelopes[0]?.command).toEqual({
      type: 'choose_duplicate_resolution',
      reviewId: DUPLICATE_REVIEW_ID,
      decision: { kind: 'use_existing', choiceId: DUPLICATE_CHOICE_A },
    });
  });

  it('transmet le confirm TEL QUEL — trois clés, jamais une cible que le client certifierait', async () => {
    const admission = new FakeAdmission(admitted(runWith(stateWith(), 5)), runWith(stateWith()));
    const { controller: candidate } = controller({ admission });

    await asOwner(() => candidate.submitCommand(RUN_ID, submitBody({
      command: { type: 'confirm', confirmationId: CONFIRMATION_ID, proposalHash: PROPOSAL_HASH },
    })));

    // U1-e §2 : le controller n'AJOUTE plus `revalidatedTargetRevision`/`revalidatedSensitiveDigest`.
    // Les fabriquer ici serait deux fois faux (auto-certification + lecture hors transaction) ;
    // l'admission relit la cible sous verrou. Le canal ne lit donc même plus le run pour ça.
    expect(admission.envelopes[0]?.command).toEqual({
      type: 'confirm',
      confirmationId: CONFIRMATION_ID,
      proposalHash: PROPOSAL_HASH,
    });
    // Et il ne relit plus le run AVANT de soumettre : cette lecture-là n'existait que pour
    // distinguer création et modification — la transaction le fait maintenant, sous verrou.
    expect(admission.reads).toHaveLength(0);
  });

  it('la confirmation d’une MODIFICATION atteint l’admission : plus de refus 503 de canal', async () => {
    const updateState = stateWith({
      intent: { mode: 'update', target: { customerId: TARGET_CUSTOMER_ID, revision: 2 } },
      proposal: {
        proposalId: PROPOSAL_ID,
        proposalCommandId: PROPOSAL_COMMAND_ID,
        fieldsDigest: FIELDS_DIGEST,
        sensitiveDigest: SENSITIVE_DIGEST,
        targetRevision: 2,
        targetSensitiveDigest: TARGET_SENSITIVE_DIGEST,
        proposalHash: PROPOSAL_HASH,
      },
    });
    const admission = new FakeAdmission(admitted(runWith(updateState)), runWith(updateState));
    const { controller: candidate } = controller({ admission });

    await asOwner(() => candidate.submitCommand(RUN_ID, submitBody({
      actionId: 'client-modifier',
      command: { type: 'confirm', confirmationId: CONFIRMATION_ID, proposalHash: PROPOSAL_HASH },
    })));

    // Le canal ne s'oppose plus à la modification : c'est la TRANSACTION qui relit la cible et
    // décide (consumed ou invalidated §9.1). Le corps transmis reste celui du wire, à l'octet.
    expect(admission.envelopes).toHaveLength(1);
    expect(admission.envelopes[0]?.actionId).toBe('client-modifier');
    expect(admission.envelopes[0]?.command).toEqual({
      type: 'confirm',
      confirmationId: CONFIRMATION_ID,
      proposalHash: PROPOSAL_HASH,
    });
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
    [{ status: 'action_refused', reason: 'action_not_released' }, 403],
    [{ status: 'action_refused', reason: 'action_binding_mismatch' }, 403],
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
      targetLabel: null,
      // U1-h — la projection est TOTALE : un run sans revue ni fin les porte a `null`,
      // jamais absentes. Le decodeur client refuse a la forme sur cle manquante.
      duplicateReview: null,
      completion: null,
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

  it('projette la revue scellée sans exposer les customerId et conserve un rang irrésolu', async () => {
    const run = runWith(duplicateReviewState(), 2);
    const admission = new FakeAdmission(admitted(run), run, null, {
      customerLabels: (customerIds) => {
        expect(customerIds).toEqual([DUPLICATE_CUSTOMER_A, DUPLICATE_CUSTOMER_B]);
        // Le second client a disparu entre la recherche et la lecture : son rang reste présent.
        return Promise.resolve([
          { customerId: DUPLICATE_CUSTOMER_A, canonicalName: 'Dupont\u00a0 Plomberie' },
        ]);
      },
    });
    const { controller: candidate } = controller({ admission });

    const snapshot = await asOwner(() => candidate.getRun(RUN_ID));

    expect(snapshot.presentation?.duplicateReview).toEqual({
      reviewId: DUPLICATE_REVIEW_ID,
      choices: [
        { ordinal: 1, choiceId: DUPLICATE_CHOICE_A, label: 'Dupont Plomberie' },
        { ordinal: 2, choiceId: DUPLICATE_CHOICE_B, label: null },
      ],
    });
    const wire = JSON.stringify(snapshot.presentation);
    expect(wire).not.toContain(DUPLICATE_CUSTOMER_A);
    expect(wire).not.toContain(DUPLICATE_CUSTOMER_B);
  });

  it.each([
    ['port absent', {}],
    [
      'port en panne',
      { customerLabels: () => Promise.reject(new Error('annuaire indisponible')) },
    ],
  ] as const)('%s : masque la revue entière et journalise le refus fail-closed', async (_label, extraView) => {
    const run = runWith(duplicateReviewState(), 2);
    const admission = new FakeAdmission(admitted(run), run, null, extraView);
    const { controller: candidate, logger } = controller({ admission });

    const snapshot = await asOwner(() => candidate.getRun(RUN_ID));

    expect(snapshot.presentation).toMatchObject({
      phase: 'awaiting_duplicate_review',
      duplicateReview: null,
      proposal: null,
      confirmation: null,
    });
    expect(logger.audit).toHaveBeenCalledWith(
      'jarvis.presentation.duplicate_labels_unavailable',
      expect.objectContaining({ companyId: COMPANY_ID }),
    );
  });

  it('nomme séparément la fiche existante retenue et l’écriture réellement acquittée', async () => {
    const selected = terminalRunWith(stateWith({
      phase: 'completed',
      duplicateReview: (duplicateReviewState() as Record<string, unknown>).duplicateReview,
      proposal: null,
      confirmation: null,
      resolvedExistingCustomerId: DUPLICATE_CUSTOMER_A,
    }), 3);
    const selectedAdmission = new FakeAdmission(admitted(selected), selected, null, {
      customerLabels: () => Promise.resolve([
        { customerId: DUPLICATE_CUSTOMER_A, canonicalName: 'Dupont Plomberie' },
        { customerId: DUPLICATE_CUSTOMER_B, canonicalName: 'Durand Couverture' },
      ]),
    });
    const { controller: selectedController } = controller({ admission: selectedAdmission });

    expect((await asOwner(() => selectedController.getRun(RUN_ID))).presentation?.completion)
      .toEqual({ kind: 'existing_selected', label: 'Dupont Plomberie' });

    const recorded = terminalRunWith(stateWith({
      phase: 'completed',
      receipt: {
        effectId: EFFECT_ID,
        customerId: DUPLICATE_CUSTOMER_A,
        customerRevision: 1,
        recordedAt: READ_AT,
      },
    }), 7);
    const recordedAdmission = new FakeAdmission(admitted(recorded), recorded);
    const { controller: recordedController } = controller({
      admission: recordedAdmission,
      payloads: new FakePayloads(sealedPayload()),
    });

    expect((await asOwner(() => recordedController.getRun(RUN_ID))).presentation?.completion)
      .toEqual({ kind: 'recorded' });
  });

  it.each([
    [
      'reçu hors phase completed',
      runWith(stateWith({
        receipt: {
          effectId: EFFECT_ID,
          customerId: DUPLICATE_CUSTOMER_A,
          customerRevision: 1,
          recordedAt: READ_AT,
        },
      }), 6),
    ],
    [
      'fiche existante retenue depuis une intention update',
      terminalRunWith(stateWith({
        phase: 'completed',
        intent: { mode: 'update', target: { customerId: TARGET_CUSTOMER_ID, revision: 2 } },
        proposal: null,
        confirmation: null,
        resolvedExistingCustomerId: DUPLICATE_CUSTOMER_A,
      }), 6),
    ],
    [
      'reçu et fiche retenue simultanés',
      terminalRunWith(stateWith({
        phase: 'completed',
        receipt: {
          effectId: EFFECT_ID,
          customerId: DUPLICATE_CUSTOMER_A,
          customerRevision: 1,
          recordedAt: READ_AT,
        },
        resolvedExistingCustomerId: DUPLICATE_CUSTOMER_A,
      }), 7),
    ],
    [
      'revue de doublons greffée sur une intention update',
      runWith(stateWith({
        // `preparing_proposal` laisse volontairement passer cette forme au parseur de state :
        // le test mord donc sur la garde du projecteur, pas sur une garde de phase antérieure.
        phase: 'preparing_proposal',
        intent: { mode: 'update', target: { customerId: TARGET_CUSTOMER_ID, revision: 2 } },
        duplicateReview: (duplicateReviewState() as Record<string, unknown>).duplicateReview,
        proposal: null,
        confirmation: null,
      }), 5),
    ],
  ] as const)('%s : la projection serveur échoue fermée', async (_label, run) => {
    const admission = new FakeAdmission(admitted(run), run);
    const { controller: candidate } = controller({
      admission,
      payloads: new FakePayloads(sealedPayload()),
    });

    expect((await asOwner(() => candidate.getRun(RUN_ID))).presentation).toBeNull();
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

describe('ouverture depuis l’écran (U1-e §1) — POST /jarvis/runs', () => {
  const refusals: readonly (readonly [string, Record<string, unknown>, string])[] = [
    ['clé inconnue', { ...openBody(), kind: 'customer_contact' }, 'kind'],
    ['identité serveur refusée', { ...openBody(), runId: RUN_ID }, 'runId'],
    ['révision de seed imposée', { ...openBody(), expectedRevision: 0 }, 'expectedRevision'],
    ['commandId manquant', { intent: openBody().intent }, 'commandId'],
    [
      'commandId v8 (contrat user = v4)',
      openBody({ commandId: '40000000-0000-8000-8000-000000000001' }),
      'commandId',
    ],
    // L'écran n'ouvre QUE des modifications : une création naît de la voix ou du formulaire.
    ['ouverture d’une création', openBody({ intent: { mode: 'create' } }), 'intent'],
    [
      'révision de cible affirmée par le client',
      openBody({
        intent: { mode: 'update', target: { customerId: TARGET_CUSTOMER_ID, revision: 2 } },
      }),
      'revision',
    ],
    [
      'cible non canonique',
      openBody({ intent: { mode: 'update', target: { customerId: 'client-1' } } }),
      'customerId',
    ],
    ['cible absente', openBody({ intent: { mode: 'update' } }), 'target'],
  ];

  it.each(refusals)('refuse %s en 422 sans rien exécuter', async (_label, body, field) => {
    const admission = new FakeAdmission(admitted(runWith(null)));
    const { controller: candidate } = controller({ admission });

    const error = await caught(() => asOwner(() => candidate.openRun(body)));

    expect(error.getStatus()).toBe(422);
    expect(JSON.stringify(error.getResponse())).toContain(field);
    expect(admission.envelopes).toHaveLength(0);
  });

  it('stampe SERVEUR tout ce que le client ne peut pas prouver', async () => {
    const admission = new FakeAdmission(admitted(runWith(null, 1)));
    const { controller: candidate } = controller({ admission });

    const receipt = await asOwner(() => candidate.openRun(openBody()));

    const envelope = admission.envelopes[0];
    const runId = deriveJarvisScreenRunId(
      { companyId: COMPANY_ID, ownerUserId: OWNER_USER_ID },
      COMMAND_ID,
    );
    expect(envelope).toMatchObject({
      companyId: COMPANY_ID,
      ownerUserId: OWNER_USER_ID,
      kind: 'customer_contact',
      definitionVersion: 1,
      runId,
      commandId: COMMAND_ID,
      // 0 = SEMER : la seule route qui l'écrit. Le canal de commandes le refuse toujours (422).
      expectedRevision: 0,
      actionId: 'client-modifier',
      actionVersion: 1,
      authority: {
        source: 'authenticated_principal',
        principalBindingHash: agentMissionPrincipalBindingHash(COMPANY_ID, OWNER_USER_ID),
      },
    });
    expect(envelope?.occurredAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u);
    expect(envelope?.canonicalInputDigest).toBe(
      computeJarvisTapCanonicalInputDigest({
        runId,
        commandId: COMMAND_ID,
        command: {
          type: 'start_run',
          intent: {
            mode: 'update',
            target: {
              customerId: TARGET_CUSTOMER_ID,
              revision: JARVIS_UNVERIFIED_TARGET_REVISION,
            },
          },
        },
      }),
    );
    expect(receipt.outcome).toBe('admitted');
  });

  it('dérive l’identité du run du commandId mémoïsé : deux essais visent le MÊME run', async () => {
    const admission = new FakeAdmission(admitted(runWith(null, 1)));
    const { controller: candidate } = controller({ admission });
    const otherCommandId = '30000000-0000-4000-8000-000000000002';

    await asOwner(() => candidate.openRun(openBody()));
    await asOwner(() => candidate.openRun(openBody()));
    await asOwner(() => candidate.openRun(openBody({ commandId: otherCommandId })));

    // L'ouverture soumet DEUX enveloppes (semis puis resolution de cible serveur, §8) :
    // on compare les SEMIS entre eux, jamais un semis a une resolution.
    const seeds = admission.envelopes.filter(
      (envelope) => (envelope.command as { type?: string } | null)?.type === 'start_run',
    );
    const [first, second, third] = seeds;
    // Reçu perdu, réseau coupé, écran remonté : le rejeu retombe sur le même run (zéro write §5.2).
    expect(second?.runId).toBe(first?.runId);
    expect(second?.canonicalInputDigest).toBe(first?.canonicalInputDigest);
    // Un autre geste est un autre run : la dérivation n'est pas une constante déguisée.
    expect(third?.runId).not.toBe(first?.runId);
    expect(first?.runId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u,
    );
  });

  it('sème avec une révision de cible NON OPPOSABLE — jamais une preuve fabriquée', async () => {
    const admission = new FakeAdmission(admitted(runWith(null, 1)));
    const { controller: candidate } = controller({ admission });

    await asOwner(() => candidate.openRun(openBody()));

    // Le controller ne relit pas la fiche (une lecture hors transaction serait un TOCTOU) : il
    // sème la révision minimale du domaine, que `record_customer_resolution` remplace par la
    // révision RELUE avant que `stage_proposal` ne puisse sceller quoi que ce soit.
    expect(admission.envelopes[0]?.command).toEqual({
      type: 'start_run',
      intent: {
        mode: 'update',
        target: { customerId: TARGET_CUSTOMER_ID, revision: JARVIS_UNVERIFIED_TARGET_REVISION },
      },
    });
    expect(JARVIS_UNVERIFIED_TARGET_REVISION).toBe(1);
  });

  it('rend le reçu ORIGINAL sur rejeu, et projette les refus par le mapping fermé', async () => {
    const replayed = new FakeAdmission({
      status: 'replayed',
      postimage: runWith(null, 1),
      eventSequence: 1,
      signalRestamped: false,
    });
    const { controller: replaying } = controller({ admission: replayed });
    expect((await asOwner(() => replaying.openRun(openBody()))).outcome).toBe('replayed');

    // Un run existe déjà à cette identité : `expectedRevision: 0` ne peut plus le semer.
    const stale = new FakeAdmission({ status: 'stale_revision', actualRevision: 3 });
    const { controller: refusing, logger } = controller({ admission: stale });
    const error = await caught(() => asOwner(() => refusing.openRun(openBody())));

    expect(error.getStatus()).toBe(409);
    expect(error.getResponse()).toEqual({
      ok: false,
      error: { kind: 'conflict', entity: 'jarvis_run', reason: 'stale_revision' },
    });
    expect(logger.audit).toHaveBeenCalledWith(
      'jarvis.tap.refused',
      expect.objectContaining({
        status: 'stale_revision',
        commandType: 'start_run',
      }),
    );
  });
});

describe('découverte (U1-e §1) — GET /jarvis/runs/current', () => {
  it('rend le run non terminal de l’owner et sa présentation recomposée', async () => {
    const run = runWith(stateWith(), 5);
    const admission = new FakeAdmission(admitted(run), null, { currentRun: run });
    const { controller: candidate } = controller({
      admission,
      payloads: new FakePayloads(sealedPayload()),
    });

    const current = await asOwner(() => candidate.getCurrentRun());

    // Owner-scopée : la lecture porte l'identité dérivée du bearer, jamais un paramètre client.
    expect(admission.reads).toEqual([{ companyId: COMPANY_ID, ownerUserId: OWNER_USER_ID }]);
    expect(current.run).toEqual({
      runId: RUN_ID,
      kind: 'customer_contact',
      definitionVersion: 1,
      status: 'waiting_user',
      revision: 5,
      nextWakeAt: null,
      terminalAt: null,
    });
    expect(current.presentation).toMatchObject({
      phase: 'awaiting_confirmation',
      intent: 'create',
      proposal: { proposalId: PROPOSAL_ID, fieldsDigest: FIELDS_DIGEST },
    });
  });

  it('aucun run : les DEUX champs sont nuls — jamais une carte orpheline', async () => {
    const admission = new FakeAdmission(admitted(runWith(null)), null, { currentRun: null });
    const { controller: candidate } = controller({
      admission,
      payloads: new FakePayloads(sealedPayload()),
    });

    expect(await asOwner(() => candidate.getCurrentRun())).toEqual({
      run: null,
      presentation: null,
    });
  });

  it('un run TERMINAL n’est jamais courant : rien à reprendre à l’écran', async () => {
    const terminal: JarvisRunEnvelope = {
      kind: 'customer_contact',
      runId: RUN_ID,
      companyId: COMPANY_ID,
      createdBy: OWNER_USER_ID,
      definitionVersion: 1,
      status: 'completed',
      revision: 9,
      stateVersion: 1,
      state: stateWith({ phase: 'completed' }),
      nextWakeAt: null,
      terminalAt: '2026-08-19T10:03:00.000Z',
    };
    const admission = new FakeAdmission(admitted(terminal), null, { currentRun: terminal });
    const { controller: candidate } = controller({
      admission,
      payloads: new FakePayloads(sealedPayload()),
    });

    expect(await asOwner(() => candidate.getCurrentRun())).toEqual({
      run: null,
      presentation: null,
    });
  });

  it('digest divergent : le run sort, la présentation reste ABSENTE (fail-closed G4)', async () => {
    const run = runWith(stateWith(), 5);
    const admission = new FakeAdmission(admitted(run), null, { currentRun: run });
    // Le magasin revérifie `fieldsDigest` et rend `null` sur divergence.
    const { controller: candidate } = controller({ admission, payloads: new FakePayloads(null) });

    const current = await asOwner(() => candidate.getCurrentRun());

    expect(current.run).toMatchObject({ runId: RUN_ID });
    expect(current.presentation).toBeNull();
  });

  it('la branche devis ne sort JAMAIS par ce canal (§17.1)', async () => {
    // Enveloppe legacy `quote_creation` : le writer N-1 garde ses routes, la carte ne la voit pas.
    const legacy = {
      kind: 'quote_creation',
      runId: RUN_ID,
      companyId: COMPANY_ID,
      createdBy: OWNER_USER_ID,
      definitionVersion: 2,
      status: 'waiting_user',
      revision: 3,
      snapshot: {},
    } as unknown as JarvisRunEnvelope;
    const admission = new FakeAdmission(admitted(legacy), null, { currentRun: legacy });
    const { controller: candidate } = controller({ admission });

    expect(await asOwner(() => candidate.getCurrentRun())).toEqual({
      run: null,
      presentation: null,
    });
  });

  it('annuaire ABSENT : 503 nommé, jamais un « aucun run » non vérifié', async () => {
    // Adaptateur sans annuaire : la vue stateless n'expose que `runById` (état d'aujourd'hui).
    const admission = new FakeAdmission(admitted(runWith(null)), runWith(stateWith()));
    const { controller: candidate } = controller({ admission });

    const error = await caught(() => asOwner(() => candidate.getCurrentRun()));

    expect(error.getStatus()).toBe(503);
    expect(error.getResponse()).toEqual({
      ok: false,
      error: { kind: 'unavailable', service: 'jarvis_current_run_directory' },
    });
  });

  it('sans adapter d’admission lié, la découverte refuse en 503 — jamais un 500 muet', async () => {
    const { controller: candidate } = controller({ admission: null });
    const error = await caught(() => asOwner(() => candidate.getCurrentRun()));
    expect(error.getStatus()).toBe(503);
    expect(error.getResponse()).toEqual({
      ok: false,
      error: { kind: 'unavailable', service: 'jarvis_admission' },
    });
  });
});

describe('bornes de route', () => {
  it('chiffre le débit PAR route (POST 10/10 s, GET 30/10 s)', () => {
    const post = JarvisRunController.prototype.submitCommand;
    const open = JarvisRunController.prototype.openRun;
    const current = JarvisRunController.prototype.getCurrentRun;
    const get = JarvisRunController.prototype.getRun;

    expect(Reflect.getMetadata('THROTTLER:LIMITdefault', post)).toBe(10);
    expect(Reflect.getMetadata('THROTTLER:TTLdefault', post)).toBe(10_000);
    expect(Reflect.getMetadata('THROTTLER:LIMITdefault', open)).toBe(10);
    expect(Reflect.getMetadata('THROTTLER:TTLdefault', open)).toBe(10_000);
    expect(Reflect.getMetadata('THROTTLER:LIMITdefault', current)).toBe(30);
    expect(Reflect.getMetadata('THROTTLER:TTLdefault', current)).toBe(10_000);
    expect(Reflect.getMetadata('THROTTLER:LIMITdefault', get)).toBe(30);
    expect(Reflect.getMetadata('THROTTLER:TTLdefault', get)).toBe(10_000);
  });

  it('déclare `runs/current` AVANT `runs/:runId` — Nest apparie dans l’ordre du prototype', () => {
    const methods = Object.getOwnPropertyNames(JarvisRunController.prototype);
    const current = methods.indexOf('getCurrentRun');
    const byId = methods.indexOf('getRun');

    expect(current).toBeGreaterThan(-1);
    expect(byId).toBeGreaterThan(-1);
    // Inverser ces deux déclarations ferait capturer le littéral « current » comme identifiant de
    // run : la découverte répondrait 404 (« current » n'est pas un UUID canonique).
    expect(current).toBeLessThan(byId);
  });
});
