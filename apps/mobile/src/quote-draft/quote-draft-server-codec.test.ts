import { describe, expect, it } from 'vitest';
import type { QuoteDraftSlotView } from '@bob/api-client';
import { createQuoteDraft, type QuoteDraftState } from './quote-draft-model';
import {
  decodeQuoteDraftServerSlot,
  encodeQuoteDraftServerPayload,
  QuoteDraftServerCodecError,
} from './quote-draft-server-codec';

function state(): QuoteDraftState {
  return {
    ...createQuoteDraft('session-quote-1'),
    revision: 7,
    flow: {
      step: 'signature',
      draft: {
        customerId: 'customer-1',
        lines: [{
          label: 'Main-d’œuvre plomberie',
          category: 'labor',
          qty: 2,
          unitPriceHT: 5_500,
          vatRate: 10,
          unit: 'heure',
        }],
        tvaContext: { housingOlderThan2y: true },
        vatRate: 10,
        depositPct: 30,
        signMode: 'onsite',
        signerName: 'Signature manuscrite éphémère',
        urgentRepairRequested: false,
      },
    },
    customer: { id: 'customer-1', name: 'Camping Les Pins' },
    lineMetadata: [{
      id: 'line-1',
      interaction: 'voice',
      catalogue: { id: 'catalogue-1', source: 'perso', indicative: false },
    }],
    lineForm: { label: '  Filtre   neuf  ', quantity: ' 1 ', unitPrice: ' 25 ', category: 'supply' },
    stagingRevision: 3,
    saved: null,
    completedArtifactIds: ['old-artifact'],
    proposal: {
      id: 'proposal-secret',
      source: 'bob_voice',
      title: 'Proposition éphémère',
      explanation: null,
      commands: [],
      baseRevision: 7,
      createdAt: 1,
      expiresAt: 2,
      diff: [],
      spokenPrompt: 'Confirmer ?',
    },
    lastProposalDecision: null,
    mission: {
      status: 'active',
      id: 'mission-secret',
      mode: 'guided_voice',
      startedFrom: '/devis/new',
      startedAt: 1,
    },
  };
}

function slot(payload = encodeQuoteDraftServerPayload(state())): QuoteDraftSlotView {
  return {
    revision: 4,
    payloadVersion: 1,
    payload,
    createdAt: '2026-07-17T08:00:00.000Z',
    updatedAt: '2026-07-17T09:10:11.000Z',
  };
}

describe('codec serveur du brouillon de devis', () => {
  it('encode uniquement la saisie restaurable, sans identité ni autorité éphémère', () => {
    const payload = encodeQuoteDraftServerPayload(state());
    const serialized = JSON.stringify(payload);

    expect(payload.draft.lineForm).toEqual({
      label: 'Filtre neuf',
      quantity: '1',
      unitPrice: '25',
      category: 'supply',
    });
    expect(serialized).not.toContain('proposal-secret');
    expect(serialized).not.toContain('mission-secret');
    expect(serialized).not.toContain('Signature manuscrite');
    expect(serialized).not.toMatch(/companyId|ownerUserId|userId|identity/u);
  });

  it('réhydrate le V1 en état V2 sûr et horodate la version réellement commitée', () => {
    const hydrated = decodeQuoteDraftServerSlot(slot());

    expect(hydrated.flow.draft.signerName).toBeNull();
    expect(hydrated.proposal).toBeNull();
    expect(hydrated.lastProposalDecision).toBeNull();
    expect(hydrated.mission).toEqual({ status: 'idle' });
    expect(hydrated.completedArtifactIds).toEqual([]);
    expect(hydrated.saved).toEqual({
      contentRevision: 7,
      stagingRevision: 3,
      at: Date.parse('2026-07-17T09:10:11.000Z'),
    });
    expect(encodeQuoteDraftServerPayload(hydrated)).toEqual(slot().payload);
  });

  it('refuse un récap, une identité client incohérente et un timestamp serveur invalide', () => {
    expect(() => encodeQuoteDraftServerPayload({
      ...state(),
      flow: { ...state().flow, step: 'recap' },
    })).toThrowError(QuoteDraftServerCodecError);
    expect(() => encodeQuoteDraftServerPayload({
      ...state(),
      customer: { id: 'other-customer', name: 'Autre' },
    })).toThrowError(QuoteDraftServerCodecError);
    expect(() => decodeQuoteDraftServerSlot({ ...slot(), updatedAt: 'not-a-date' }))
      .toThrowError(QuoteDraftServerCodecError);
  });
});
