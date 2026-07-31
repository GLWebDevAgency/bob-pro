import { describe, expect, it } from 'vitest';
import type { QuoteScreenMissionBindingState } from './quote-screen-mission-coordinator';
import {
  QuoteCustomerListRefreshCoordinator,
  quoteWizardCanResumeParkedDraft,
  quoteWizardGlobalBobHidden,
  quoteWizardInteractionEnabled,
  quoteWizardLineSurfaceMode,
  quoteWizardNavigationLocked,
} from './quote-wizard-interaction';

describe('quoteWizardInteractionEnabled — verrou du writer complet', () => {
  const phases = [
    'detecting',
    'waiting_context',
    'hydrating',
    'acknowledging',
    'refreshing',
    'waiting_recovery',
    'ready',
    'resume_required',
    'handoff_required',
    'handing_off',
    'handoff_error',
    'handoff',
    'manual',
    'blocked',
    'error',
  ] as const satisfies readonly QuoteScreenMissionBindingState['phase'][];

  it.each(phases)('n’ouvre le writer que dans une phase autoritaire (%s)', (missionPhase) => {
    const expected = missionPhase === 'ready'
      || missionPhase === 'handoff'
      || missionPhase === 'manual';
    expect(quoteWizardInteractionEnabled({
      billingDefaultsReady: true,
      missionPhase,
    })).toBe(expected);
    expect(quoteWizardGlobalBobHidden(missionPhase)).toBe(!expected);
  });

  it.each([
    ['ready', false],
    ['handoff', false],
    ['manual', false],
  ] as const)(
    'attend toujours les réglages même si la mission est %s',
    (missionPhase, expected) => {
      expect(quoteWizardInteractionEnabled({
        billingDefaultsReady: false,
        missionPhase,
      })).toBe(expected);
    },
  );

  it('referme le writer lorsqu’une mission ready repart en refreshing', () => {
    expect(quoteWizardInteractionEnabled({
      billingDefaultsReady: true,
      missionPhase: 'ready',
    })).toBe(true);
    expect(quoteWizardInteractionEnabled({
      billingDefaultsReady: true,
      missionPhase: 'refreshing',
    })).toBe(false);
  });
});

describe('quoteWizardCanResumeParkedDraft — autorité unique du brouillon', () => {
  const phases = [
    'detecting',
    'waiting_context',
    'hydrating',
    'acknowledging',
    'refreshing',
    'waiting_recovery',
    'ready',
    'resume_required',
    'handoff_required',
    'handing_off',
    'handoff_error',
    'handoff',
    'manual',
    'blocked',
    'error',
  ] as const satisfies readonly QuoteScreenMissionBindingState['phase'][];

  it.each(phases)('n’autorise la reprise locale qu’en mode manuel (%s)', (phase) => {
    expect(quoteWizardCanResumeParkedDraft(phase)).toBe(phase === 'manual');
  });
});

describe('quoteWizardLineSurfaceMode — un seul writer de lignes', () => {
  const v1Ready = {
    phase: 'ready',
    protocolVersion: 1,
  } as QuoteScreenMissionBindingState;
  const v2Ready = {
    phase: 'ready',
    protocolVersion: 2,
  } as QuoteScreenMissionBindingState;

  it('rend uniquement la surface mission pour une mission V2 prête', () => {
    expect(quoteWizardLineSurfaceMode({
      isLineStep: true,
      missionState: v2Ready,
    })).toBe('agent_v2');
  });

  it('ne rend jamais le writer legacy durant la fenêtre ready V1', () => {
    expect(quoteWizardLineSurfaceMode({
      isLineStep: true,
      missionState: v1Ready,
    })).toBe('hidden');
  });

  it.each(['handoff', 'manual'] as const)(
    'rend le writer legacy seulement après autorité locale (%s)',
    (phase) => {
      expect(quoteWizardLineSurfaceMode({
        isLineStep: true,
        missionState: { phase } as QuoteScreenMissionBindingState,
      })).toBe('legacy');
    },
  );

  it('ne rend aucune surface de lignes sur une autre étape', () => {
    expect(quoteWizardLineSurfaceMode({
      isLineStep: false,
      missionState: v2Ready,
    })).toBe('hidden');
  });
});

describe('quoteWizardNavigationLocked — propriété de la transition', () => {
  it('verrouille toute navigation pendant la passation', () => {
    expect(quoteWizardNavigationLocked({
      missionPhase: 'handing_off',
      missionResumePending: false,
    })).toBe(true);
  });

  it('verrouille toute navigation pendant une reprise, quelle que soit la phase rendue', () => {
    expect(quoteWizardNavigationLocked({
      missionPhase: 'resume_required',
      missionResumePending: true,
    })).toBe(true);
  });

  it('laisse sortir hors transition possédée', () => {
    expect(quoteWizardNavigationLocked({
      missionPhase: 'resume_required',
      missionResumePending: false,
    })).toBe(false);
    expect(quoteWizardNavigationLocked({
      missionPhase: 'ready',
      missionResumePending: false,
    })).toBe(false);
  });
});

describe('QuoteCustomerListRefreshCoordinator — refetch honnête single-flight', () => {
  it('partage un seul vol et une seule paire de transitions pending', async () => {
    const coordinator = new QuoteCustomerListRefreshCoordinator();
    const pending: boolean[] = [];
    let resolveOperation!: (value: boolean) => void;
    let calls = 0;
    const operation = () => {
      calls += 1;
      return new Promise<boolean>((resolve) => {
        resolveOperation = resolve;
      });
    };

    const first = coordinator.refresh(operation, (value) => pending.push(value));
    const second = coordinator.refresh(operation, (value) => pending.push(value));

    expect(second).toBe(first);
    expect(calls).toBe(0);
    expect(pending).toEqual([true]);

    await Promise.resolve();
    expect(calls).toBe(1);
    resolveOperation(true);

    await expect(first).resolves.toBe(true);
    expect(pending).toEqual([true, false]);
  });

  it('transforme une panne en false puis autorise un nouveau vol', async () => {
    const coordinator = new QuoteCustomerListRefreshCoordinator();
    const pending: boolean[] = [];
    let calls = 0;

    await expect(coordinator.refresh(async () => {
      calls += 1;
      throw new Error('offline');
    }, (value) => pending.push(value))).resolves.toBe(false);

    await expect(coordinator.refresh(async () => {
      calls += 1;
      return true;
    }, (value) => pending.push(value))).resolves.toBe(true);

    expect(calls).toBe(2);
    expect(pending).toEqual([true, false, true, false]);
  });
});
