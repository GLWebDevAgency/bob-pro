import { describe, expect, it, vi } from 'vitest';
import { ProcessAudioSessionCoordinator } from './process-audio-session';

describe('ProcessAudioSessionCoordinator', () => {
  it('interdit deux propriétaires simultanés et fence les releases tardives', async () => {
    const coordinator = new ProcessAudioSessionCoordinator();
    const first = await coordinator.acquire({ owner: 'legacy', mode: 'legacy_input' });
    expect(first.ok).toBe(true);
    if (!first.ok) throw new Error('lease attendu');

    await expect(coordinator.acquire({ owner: 'other', mode: 'legacy_output' })).resolves.toEqual({
      ok: false,
      reason: 'audio_busy',
    });
    expect(coordinator.release(first.lease)).toBe(true);

    const second = await coordinator.acquire({ owner: 'live', mode: 'realtime' });
    expect(second.ok).toBe(true);
    if (!second.ok) throw new Error('lease attendu');
    expect(coordinator.release(first.lease)).toBe(false);
    expect(coordinator.isCurrent(second.lease)).toBe(true);
  });

  it('autorise realtime à préempter un moteur legacy seulement après libération réelle', async () => {
    const coordinator = new ProcessAudioSessionCoordinator();
    let legacyLease: Awaited<ReturnType<typeof coordinator.acquire>> | null = null;
    legacyLease = await coordinator.acquire({
      owner: 'tts',
      mode: 'legacy_output',
      onPreempt: () => {
        if (legacyLease?.ok) coordinator.release(legacyLease.lease);
      },
    });

    const live = await coordinator.acquire({
      owner: 'bob-live',
      mode: 'realtime',
      preemptLegacy: true,
    });

    expect(live.ok).toBe(true);
    expect(coordinator.snapshot().active).toMatchObject({ mode: 'realtime', owner: 'bob-live' });
  });

  it('échoue fermé si le callback de préemption ne libère pas son lease', async () => {
    const coordinator = new ProcessAudioSessionCoordinator();
    await coordinator.acquire({ owner: 'stuck', mode: 'legacy_input', onPreempt: () => undefined });

    await expect(coordinator.acquire({
      owner: 'live',
      mode: 'realtime',
      preemptLegacy: true,
    })).resolves.toEqual({ ok: false, reason: 'preempt_failed' });
    expect(coordinator.snapshot().active).toMatchObject({ owner: 'stuck' });
  });

  it('borne la préemption et ne force jamais une ressource native inconnue', async () => {
    vi.useFakeTimers();
    try {
      const coordinator = new ProcessAudioSessionCoordinator(100);
      await coordinator.acquire({
        owner: 'stuck',
        mode: 'legacy_input',
        onPreempt: () => new Promise(() => undefined),
      });
      const live = coordinator.acquire({ owner: 'live', mode: 'realtime', preemptLegacy: true });
      await vi.advanceTimersByTimeAsync(100);
      await expect(live).resolves.toEqual({ ok: false, reason: 'preempt_timeout' });
      expect(coordinator.snapshot().active).toMatchObject({ owner: 'stuck' });
    } finally {
      vi.useRealTimers();
    }
  });

  it('partage le fence permission Android entre tous les moteurs', async () => {
    const coordinator = new ProcessAudioSessionCoordinator();
    let releasePermission!: () => void;
    const request = coordinator.withPermissionRequest(
      () => new Promise<void>((resolve) => { releasePermission = resolve; }),
    );
    expect(coordinator.permissionRequestInFlight()).toBe(true);
    let settled = false;
    const waiting = coordinator.waitForPermissionRequests().then(() => { settled = true; });
    await Promise.resolve();
    expect(settled).toBe(false);
    releasePermission();
    await request;
    await waiting;
    expect(coordinator.permissionRequestInFlight()).toBe(false);
    expect(settled).toBe(true);
  });
});
