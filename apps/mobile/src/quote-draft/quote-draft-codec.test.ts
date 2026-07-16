import { describe, expect, it } from 'vitest';
import type { LineInput } from '@bob/core';
import {
  addLine,
  applyQuoteDraftCommand,
  completeQuoteDraft,
  createQuoteDraft,
  proposeQuoteDraft,
  selectCustomer,
  startQuoteDraftMission,
  type QuoteDraftState,
} from './quote-draft-model';
import {
  decodeQuoteDraftSnapshot,
  encodeQuoteDraftSnapshot,
  QuoteDraftSnapshotCodecError,
  type QuoteDraftStorageIdentity,
} from './quote-draft-codec';

const IDENTITY: QuoteDraftStorageIdentity = {
  mode: 'authenticated',
  userId: 'user-123',
  companyId: 'company-456',
};
const CUSTOMER = { id: 'customer-1', name: 'Camping Les Pins' } as const;
const LINE: LineInput = {
  label: 'Pose chauffe-eau',
  category: 'labor',
  qty: 2,
  unit: 'h',
  unitPriceHT: 5_500,
  vatRate: 10,
};

function value(result: ReturnType<typeof selectCustomer>): QuoteDraftState {
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
}

function populatedDraft(): QuoteDraftState {
  let state = value(selectCustomer(createQuoteDraft('session-1'), CUSTOMER));
  state = value(applyQuoteDraftCommand(state, { type: 'next_step' }));
  state = value(
    addLine(state, {
      lineId: 'line-1',
      line: LINE,
      interaction: 'manual',
    }),
  );
  state = value(applyQuoteDraftCommand(state, { type: 'next_step' }));
  state = value(applyQuoteDraftCommand(state, { type: 'next_step' }));
  return state;
}

function mutateSnapshot(
  serialized: string,
  mutation: (snapshot: Record<string, unknown>) => void,
): string {
  const snapshot = JSON.parse(serialized) as Record<string, unknown>;
  mutation(snapshot);
  return JSON.stringify(snapshot);
}

describe('quote draft strict snapshot codec', () => {
  it('ne sérialise ni proposition Bob, ni mission, ni signature, ni fence de pièce', () => {
    const completed = completeQuoteDraft(populatedDraft(), {
      artifactId: 'invoice-old',
      newSessionId: 'session-2',
    }).state;
    let state = value(selectCustomer(completed, CUSTOMER));
    state = value(applyQuoteDraftCommand(state, { type: 'next_step' }));
    state = value(addLine(state, { lineId: 'line-2', line: LINE, interaction: 'voice' }));
    state = value(applyQuoteDraftCommand(state, { type: 'next_step' }));
    state = value(applyQuoteDraftCommand(state, { type: 'next_step' }));
    state = value(
      applyQuoteDraftCommand(state, { type: 'set_signer_name', signerName: 'Jean Dupont' }),
    );
    state = value(
      startQuoteDraftMission(state, {
        id: 'mission-1',
        mode: 'guided_voice',
        startedFrom: '/devis/new',
        startedAt: 10,
      }),
    );
    const proposed = proposeQuoteDraft(state, {
      id: 'proposal-1',
      source: 'bob_voice',
      commands: [{ type: 'previous_step' }],
      createdAt: 20,
      expiresAt: 1_000,
    });
    state = value(proposed);

    const encoded = encodeQuoteDraftSnapshot(state, IDENTITY, 100);
    const raw = JSON.parse(encoded.serialized) as Record<string, unknown>;
    const rawText = encoded.serialized;
    expect(rawText).not.toContain('proposal-1');
    expect(rawText).not.toContain('mission-1');
    expect(rawText).not.toContain('invoice-old');
    expect(rawText).not.toContain('Jean Dupont');
    expect(raw).not.toHaveProperty('proposal');
    expect(encoded.state.completedArtifactIds).toEqual(['invoice-old']);

    const restored = decodeQuoteDraftSnapshot(encoded.serialized, IDENTITY);
    expect(restored.flow.step).toBe('signature');
    expect(restored.flow.draft.signerName).toBeNull();
    expect(restored.proposal).toBeNull();
    expect(restored.mission).toEqual({ status: 'idle' });
    expect(restored.completedArtifactIds).toEqual([]);
    expect(restored.saved).toEqual({
      contentRevision: restored.revision,
      stagingRevision: restored.stagingRevision,
      at: 100,
    });
  });

  it('recule acompte vers signature pour exiger une nouvelle preuve graphique', () => {
    let state = populatedDraft();
    state = value(
      applyQuoteDraftCommand(state, { type: 'set_signer_name', signerName: 'Jean Dupont' }),
    );
    state = value(applyQuoteDraftCommand(state, { type: 'next_step' }));
    expect(state.flow.step).toBe('acompte');

    const encoded = encodeQuoteDraftSnapshot(state, IDENTITY, 200);
    expect(encoded.state.flow.step).toBe('signature');
    expect(decodeQuoteDraftSnapshot(encoded.serialized, IDENTITY).flow.step).toBe('signature');
  });

  it('refuse génération entamée, identité différente et version inconnue', () => {
    let state = populatedDraft();
    state = value(
      applyQuoteDraftCommand(state, { type: 'set_signer_name', signerName: 'Jean Dupont' }),
    );
    state = value(applyQuoteDraftCommand(state, { type: 'next_step' }));
    state = value(applyQuoteDraftCommand(state, { type: 'next_step' }));
    expect(() => encodeQuoteDraftSnapshot(state, IDENTITY, 200)).toThrowError(
      expect.objectContaining({ code: 'unsafe_state' }),
    );

    const encoded = encodeQuoteDraftSnapshot(populatedDraft(), IDENTITY, 100).serialized;
    expect(() =>
      decodeQuoteDraftSnapshot(encoded, { ...IDENTITY, companyId: 'company-other' }),
    ).toThrowError(expect.objectContaining({ code: 'identity_mismatch' }));
    const future = mutateSnapshot(encoded, (snapshot) => {
      snapshot['version'] = 99;
    });
    expect(() => decodeQuoteDraftSnapshot(future, IDENTITY)).toThrowError(
      expect.objectContaining({ code: 'unsupported_version' }),
    );
  });

  it('échoue fermé sur JSON, propriétés en trop, incohérences et preuve injectée', () => {
    const encoded = encodeQuoteDraftSnapshot(populatedDraft(), IDENTITY, 100).serialized;
    expect(() => decodeQuoteDraftSnapshot('{broken', IDENTITY)).toThrowError(
      expect.objectContaining({ code: 'invalid_json' }),
    );
    const extra = mutateSnapshot(encoded, (snapshot) => {
      snapshot['unexpected'] = true;
    });
    expect(() => decodeQuoteDraftSnapshot(extra, IDENTITY)).toThrowError(
      QuoteDraftSnapshotCodecError,
    );

    const mismatchedMetadata = mutateSnapshot(encoded, (snapshot) => {
      const draft = snapshot['draft'] as Record<string, unknown>;
      draft['lineMetadata'] = [];
    });
    expect(() => decodeQuoteDraftSnapshot(mismatchedMetadata, IDENTITY)).toThrowError(
      expect.objectContaining({ code: 'invalid_snapshot' }),
    );

    const injectedSigner = mutateSnapshot(encoded, (snapshot) => {
      const draft = snapshot['draft'] as Record<string, unknown>;
      const flow = draft['flow'] as Record<string, unknown>;
      (flow['draft'] as Record<string, unknown>)['signerName'] = 'Preuve inventée';
    });
    expect(() => decodeQuoteDraftSnapshot(injectedSigner, IDENTITY)).toThrowError(
      expect.objectContaining({ code: 'invalid_snapshot' }),
    );

    const staleSavedMarker = mutateSnapshot(encoded, (snapshot) => {
      const draft = snapshot['draft'] as Record<string, unknown>;
      (draft['saved'] as Record<string, unknown>)['contentRevision'] = -1;
    });
    expect(() => decodeQuoteDraftSnapshot(staleSavedMarker, IDENTITY)).toThrowError(
      expect.objectContaining({ code: 'invalid_snapshot' }),
    );
  });
});
