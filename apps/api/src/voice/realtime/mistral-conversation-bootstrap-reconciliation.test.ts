import { describe, expect, it } from 'vitest';
import { hashMistralConversationResumeTicket } from './mistral-conversation-resume-ticket';
import {
  MISTRAL_CONVERSATION_BOOTSTRAP_RECONCILIATION_MAX_ATTEMPTS,
  MISTRAL_CONVERSATION_BOOTSTRAP_RECONCILIATION_RESULT,
  areMistralConversationBootstrapReconciliationTicketHashesEqual,
  deriveMistralConversationBootstrapReconciliationCapability,
  isMistralConversationBootstrapReconciliationAttempt,
  snapshotMistralConversationBootstrapReconciliationCapability,
  type MistralConversationBootstrapReconciliationDerivationInput,
} from './mistral-conversation-bootstrap-reconciliation';

const SECRET = Buffer.from('0123456789abcdef0123456789abcdef', 'utf8');
const INPUT: MistralConversationBootstrapReconciliationDerivationInput = {
  secret: SECRET,
  keyVersion: 7,
  companyId: 'company-reconciliation-a',
  subjectHash: 'a'.repeat(64),
  initialBootstrapId: '11111111-1111-4111-8111-111111111111',
  sessionHandle: '22222222-2222-4222-8222-222222222222',
  attempt: 1,
};

describe('Bob Live Mistral v2 — réconciliation du bootstrap initial', () => {
  it('expose les trois issues fermées et borne les tentatives à 1..8', () => {
    expect(MISTRAL_CONVERSATION_BOOTSTRAP_RECONCILIATION_RESULT).toEqual({
      retryInitial: 'retry_initial',
      issued: 'issued',
      attemptConsumed: 'attempt_consumed',
    });
    expect(MISTRAL_CONVERSATION_BOOTSTRAP_RECONCILIATION_MAX_ATTEMPTS).toBe(8);
    expect(isMistralConversationBootstrapReconciliationAttempt(1)).toBe(true);
    expect(isMistralConversationBootstrapReconciliationAttempt(8)).toBe(true);
    for (const invalid of [0, -0, -1, 9, 1.5, Number.NaN, Number.POSITIVE_INFINITY, '1', null]) {
      expect(isMistralConversationBootstrapReconciliationAttempt(invalid)).toBe(false);
      expect(() => deriveMistralConversationBootstrapReconciliationCapability({
        ...INPUT,
        attempt: invalid as number,
      })).toThrow('Invalid Mistral conversation bootstrap reconciliation input.');
    }
  });

  it('dérive une capacité stable, canonique et liée au hash resume existant', () => {
    const before = Buffer.from(SECRET);
    const first = deriveMistralConversationBootstrapReconciliationCapability(INPUT);
    const second = deriveMistralConversationBootstrapReconciliationCapability(INPUT);

    expect(first).toEqual(second);
    expect(first).toEqual({
      ticketId: 'afaa8aa6-7f62-4dd9-aa85-d0db68962666',
      ticket: 'r2_BTBz9CgvWV5mBliper3QbP2peJdiMN4UAiLJxGfzHBg',
      ticketHash: 'fe0cc044394072bec7607ad457dc5ee542999800918c5f8b71471ee6544c664d',
      keyVersion: 7,
      attempt: 1,
    });
    expect(first).not.toBe(second);
    expect(Object.isFrozen(first)).toBe(true);
    expect(first.ticket).toMatch(/^r2_[A-Za-z0-9_-]{43}$/u);
    expect(Buffer.from(first.ticket.slice(3), 'base64url')).toHaveLength(32);
    expect(first.ticketId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u,
    );
    expect(first.ticketHash).toBe(hashMistralConversationResumeTicket(first.ticket));
    expect(first.keyVersion).toBe(INPUT.keyVersion);
    expect(first.attempt).toBe(INPUT.attempt);
    expect(SECRET).toEqual(before);
  });

  it.each([
    ['tenant', { companyId: 'company-reconciliation-b' }],
    ['sujet', { subjectHash: 'b'.repeat(64) }],
    ['bootstrap', { initialBootstrapId: '33333333-3333-4333-8333-333333333333' }],
    ['session', { sessionHandle: '44444444-4444-4444-8444-444444444444' }],
    ['tentative', { attempt: 2 }],
    ['version de clé', { keyVersion: 8 }],
    ['secret', { secret: Buffer.from('fedcba9876543210fedcba9876543210', 'utf8') }],
  ] as const)('sépare la dérivation par %s', (_label, override) => {
    const base = deriveMistralConversationBootstrapReconciliationCapability(INPUT);
    const changed = deriveMistralConversationBootstrapReconciliationCapability({
      ...INPUT,
      ...override,
    });
    expect(changed.ticket).not.toBe(base.ticket);
    expect(changed.ticketId).not.toBe(base.ticketId);
    expect(changed.ticketHash).not.toBe(base.ticketHash);
  });

  it('ne fait persister ni ticket brut, ni matière HMAC, ni identité de dérivation', () => {
    const capability = deriveMistralConversationBootstrapReconciliationCapability(INPUT);
    const snapshot = snapshotMistralConversationBootstrapReconciliationCapability(capability);
    const exposed = JSON.stringify({ capability, snapshot });
    const secretText = Buffer.from(INPUT.secret).toString('utf8');

    expect(Object.keys(capability).sort()).toEqual([
      'attempt',
      'keyVersion',
      'ticket',
      'ticketHash',
      'ticketId',
    ]);
    expect(Object.keys(snapshot).sort()).toEqual([
      'attempt',
      'keyVersion',
      'ticketHash',
      'ticketId',
    ]);
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(snapshot).not.toHaveProperty('ticket');
    expect(snapshot).not.toHaveProperty('material');
    expect(() => snapshotMistralConversationBootstrapReconciliationCapability({
      ...capability,
      ticketHash: '0'.repeat(64),
    })).toThrow('Invalid Mistral conversation bootstrap reconciliation capability.');
    expect(snapshot.ticketHash).not.toContain(capability.ticket);
    for (const sensitive of [
      secretText,
      INPUT.companyId,
      INPUT.subjectHash,
      INPUT.initialBootstrapId,
      INPUT.sessionHandle,
    ]) {
      expect(snapshot.ticketHash).not.toContain(sensitive);
      expect(exposed).not.toContain(sensitive);
    }
  });

  it('compare les empreintes canoniques en temps constant', () => {
    const first = deriveMistralConversationBootstrapReconciliationCapability(INPUT);
    const second = deriveMistralConversationBootstrapReconciliationCapability({
      ...INPUT,
      attempt: 2,
    });
    expect(areMistralConversationBootstrapReconciliationTicketHashesEqual(
      first.ticketHash,
      first.ticketHash,
    )).toBe(true);
    expect(areMistralConversationBootstrapReconciliationTicketHashesEqual(
      first.ticketHash,
      second.ticketHash,
    )).toBe(false);
    expect(areMistralConversationBootstrapReconciliationTicketHashesEqual(
      first.ticketHash.toUpperCase(),
      first.ticketHash,
    )).toBe(false);
    expect(areMistralConversationBootstrapReconciliationTicketHashesEqual('0'.repeat(63), '')).toBe(
      false,
    );
  });
});
