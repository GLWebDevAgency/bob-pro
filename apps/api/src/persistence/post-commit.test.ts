import { describe, expect, it, vi } from 'vitest';
import {
  deferUntilTenantCommit,
  runWithTenantPostCommitBoundary,
  scheduleAfterTenantCommit,
} from './post-commit';

describe('frontière post-COMMIT tenant', () => {
  it('libère les tâches uniquement après la transaction réussie', async () => {
    const events: string[] = [];
    const result = await runWithTenantPostCommitBoundary(async () => {
      events.push('transaction');
      expect(deferUntilTenantCommit(() => events.push('projection'))).toBe('deferred');
      events.push('before-commit');
      return 'committed';
    }, vi.fn());

    expect(result).toBe('committed');
    expect(events).toEqual(['transaction', 'before-commit', 'projection']);
  });

  it('abandonne les tâches après rollback et ferme les continuations héritées', async () => {
    const task = vi.fn();
    let resolveLate!: () => void;
    const lateAttempt = new Promise<void>((resolve) => { resolveLate = resolve; });
    let disposition: ReturnType<typeof deferUntilTenantCommit> | undefined;

    await expect(runWithTenantPostCommitBoundary(async () => {
      expect(deferUntilTenantCommit(task)).toBe('deferred');
      setImmediate(() => {
        disposition = deferUntilTenantCommit(task);
        resolveLate();
      });
      throw new Error('rollback');
    }, vi.fn())).rejects.toThrow('rollback');
    await lateAttempt;

    expect(task).not.toHaveBeenCalled();
    expect(disposition).toBe('closed');
  });

  it('rattache une frontière imbriquée au commit extérieur', async () => {
    const events: string[] = [];
    await runWithTenantPostCommitBoundary(async () => {
      await runWithTenantPostCommitBoundary(async () => {
        expect(deferUntilTenantCommit(() => events.push('nested'))).toBe('deferred');
        events.push('inside');
      }, vi.fn());
      events.push('outer-before-commit');
    }, vi.fn());
    expect(events).toEqual(['inside', 'outer-before-commit', 'nested']);
  });

  it('isole une tâche en panne et poursuit les suivantes', async () => {
    const onTaskError = vi.fn();
    const second = vi.fn();
    await expect(runWithTenantPostCommitBoundary(async () => {
      deferUntilTenantCommit(() => { throw new Error('projection down'); });
      deferUntilTenantCommit(second);
      return 'ok';
    }, onTaskError)).resolves.toBe('ok');
    expect(onTaskError).toHaveBeenCalledOnce();
    expect(second).toHaveBeenCalledOnce();
  });

  it('exécute immédiatement hors transaction et refuse une continuation post-flush', async () => {
    const immediate = vi.fn();
    expect(scheduleAfterTenantCommit(immediate)).toBe('absent');
    expect(immediate).toHaveBeenCalledOnce();

    const late = vi.fn();
    let resolveLate!: () => void;
    const lateAttempt = new Promise<void>((resolve) => { resolveLate = resolve; });
    let disposition: ReturnType<typeof scheduleAfterTenantCommit> | undefined;
    await runWithTenantPostCommitBoundary(async () => {
      setImmediate(() => {
        disposition = scheduleAfterTenantCommit(late);
        resolveLate();
      });
      return 'committed';
    }, vi.fn());
    await lateAttempt;
    expect(disposition).toBe('closed');
    expect(late).not.toHaveBeenCalled();
  });

  it('isole hors frontière une panne survenue après le commit acquis', () => {
    const cause = new Error('audit down');
    const onTaskError = vi.fn();
    expect(() => scheduleAfterTenantCommit(() => { throw cause; }, onTaskError)).not.toThrow();
    expect(onTaskError).toHaveBeenCalledExactlyOnceWith(cause);

    expect(() => scheduleAfterTenantCommit(
      () => { throw cause; },
      () => { throw new Error('diagnostic down'); },
    )).not.toThrow();
  });
});
