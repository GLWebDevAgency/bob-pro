import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_MISTRAL_CONVERSATION_BOOTSTRAP_TICKET_POLICY,
  DisabledMistralConversationBootstrapTicketAuthority,
  hashMistralConversationBootstrapTicket,
  isMistralConversationBootstrapTicket,
  secureMistralConversationBootstrapTicketEntropy,
  validateMistralConversationBootstrapTicketPolicy,
} from './mistral-conversation-bootstrap-ticket';

describe('Bob Live Mistral v2 — ticket de bootstrap initial', () => {
  it('émet exactement b2_ + 256 bits base64url canoniques', () => {
    const ticket = secureMistralConversationBootstrapTicketEntropy.ticket();
    expect(ticket).toMatch(/^b2_[A-Za-z0-9_-]{43}$/u);
    expect(isMistralConversationBootstrapTicket(ticket)).toBe(true);
    expect(Buffer.from(ticket.slice(3), 'base64url')).toHaveLength(32);
    expect(isMistralConversationBootstrapTicket(ticket.slice(0, -1))).toBe(false);
    expect(isMistralConversationBootstrapTicket(`${ticket}=`)).toBe(false);
    expect(isMistralConversationBootstrapTicket(`r2_${ticket.slice(3)}`)).toBe(false);
    expect(isMistralConversationBootstrapTicket(ticket.toUpperCase())).toBe(false);
  });

  it('sépare le hash des registres historiques et ne conserve jamais le ticket brut', () => {
    const ticket = `b2_${'A'.repeat(43)}`;
    const plain = createHash('sha256').update(ticket, 'utf8').digest('hex');
    const domainSeparated = hashMistralConversationBootstrapTicket(ticket);
    expect(domainSeparated).toMatch(/^[a-f0-9]{64}$/u);
    expect(domainSeparated).not.toBe(plain);
    expect(hashMistralConversationBootstrapTicket(ticket)).toBe(domainSeparated);
    expect(domainSeparated).not.toContain(ticket);
  });

  it('borne strictement TTL, quotas, rétention et budget PCM', () => {
    expect(() => validateMistralConversationBootstrapTicketPolicy(
      DEFAULT_MISTRAL_CONVERSATION_BOOTSTRAP_TICKET_POLICY,
    )).not.toThrow();
    const invalid = [
      { ticketTtlSeconds: 121 },
      { ticketTtlSeconds: 4 },
      { retentionSeconds: 3_599 },
      { retentionSeconds: 604_801 },
      { maxOutstandingPerSubject: 26 },
      { maxIssuesPerTenantHour: 24 },
      { maxIssuesPerSubjectHour: 2 },
      { maxMissionAudioBytes: 319 },
      { maxMissionAudioBytes: 321 },
      { maxMissionAudioBytes: 28_800_320 },
    ];
    for (const override of invalid) {
      expect(() => validateMistralConversationBootstrapTicketPolicy({
        ...DEFAULT_MISTRAL_CONVERSATION_BOOTSTRAP_TICKET_POLICY,
        ...override,
      })).toThrow('Invalid Mistral conversation bootstrap ticket policy.');
    }
  });

  it('reste fail-closed sans autorité PostgreSQL', async () => {
    const disabled = new DisabledMistralConversationBootstrapTicketAuthority();
    await expect(disabled.issue()).resolves.toEqual({ status: 'unavailable' });
    await expect(disabled.redeemAndOpenInitial()).resolves.toEqual({ status: 'unavailable' });
  });
});
