/**
 * Notice éphémère entre deux routes.
 *
 * Le token dans l'URL n'est jamais une vérité suffisante : seule une entrée émise dans ce runtime,
 * bornée dans le temps, consommable une fois et liée au client attendu autorise le feedback.
 * Une restauration de navigation après redémarrage ou un deep link forgé reste donc silencieux.
 */

const NOTICE_TTL_MS = 2 * 60 * 1_000;
const MAX_PENDING_NOTICES = 16;

interface ContractDeletedNotice {
  readonly kind: 'contract_deleted';
  readonly customerId: string;
  readonly contractId: string;
  readonly expiresAt: number;
}

export interface ConsumedContractDeletedNotice {
  readonly kind: 'contract_deleted';
  readonly contractId: string;
}

const pendingNotices = new Map<string, ContractDeletedNotice>();
let sequence = 0;

function prune(now: number): void {
  for (const [token, notice] of pendingNotices) {
    if (notice.expiresAt <= now) pendingNotices.delete(token);
  }
  while (pendingNotices.size >= MAX_PENDING_NOTICES) {
    const oldest = pendingNotices.keys().next().value as string | undefined;
    if (oldest === undefined) break;
    pendingNotices.delete(oldest);
  }
}

export function issueContractDeletedNotice(
  input: { readonly customerId: string; readonly contractId: string },
  now = Date.now(),
): string {
  if (input.customerId.length === 0 || input.contractId.length === 0) {
    throw new Error('navigation_notice_invalid_scope');
  }
  prune(now);
  sequence = (sequence + 1) % Number.MAX_SAFE_INTEGER;
  const token = `contract-deleted:${now.toString(36)}:${sequence.toString(36)}`;
  pendingNotices.set(token, {
    kind: 'contract_deleted',
    customerId: input.customerId,
    contractId: input.contractId,
    expiresAt: now + NOTICE_TTL_MS,
  });
  return token;
}

export function consumeContractDeletedNotice(
  token: string,
  expectedCustomerId: string,
  now = Date.now(),
): ConsumedContractDeletedNotice | null {
  const notice = pendingNotices.get(token);
  // Une tentative consomme toujours le token : un mauvais écran ne peut pas le rejouer ailleurs.
  pendingNotices.delete(token);
  if (
    notice === undefined
    || notice.expiresAt <= now
    || notice.customerId !== expectedCustomerId
  ) {
    return null;
  }
  return { kind: notice.kind, contractId: notice.contractId };
}
