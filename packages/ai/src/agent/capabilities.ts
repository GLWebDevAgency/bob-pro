import { type Result, type AppError } from '@bob/core';

/**
 * Capacités de Bob — implémentées par l'app via BobClient + le domaine (= use cases).
 * Chaque capacité a un équivalent manuel dans l'UI : la parité IA/non-IA est structurelle.
 */
export interface BobCapabilities {
  computePayout(): Promise<Result<{ payoutCents: number; availableCents: number }, AppError>>;
  draftRelance(): Promise<Result<{ subject: string; body: string }, AppError>>;
}
