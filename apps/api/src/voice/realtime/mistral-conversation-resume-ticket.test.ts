import { MISTRAL_CONVERSATION_PROTOCOL } from '@bob/ai';
import { describe, expect, it, vi } from 'vitest';
import type { PrismaService } from '../../persistence/prisma/prisma.service';
import type { PrismaMistralConversationDurableAuthority } from './mistral-conversation-authority.prisma';
import { PrismaMistralConversationResumeAuthority } from './mistral-conversation-resume-ticket.prisma';
import {
  DEFAULT_MISTRAL_CONVERSATION_RESUME_TICKET_POLICY,
  DisabledMistralConversationResumeAuthority,
  isMistralConversationConnectionLeaseToken,
  isMistralConversationReplayConnectionId,
  isMistralConversationResumeIssueInput,
  isMistralConversationResumeTicket,
  isMistralConversationTerminalReceipt,
  secureMistralConversationResumeTicketEntropy,
  validateMistralConversationResumeTicketPolicy,
  type MistralConversationResumeTicketIssueInput,
} from './mistral-conversation-resume-ticket';

const ISSUE_INPUT: MistralConversationResumeTicketIssueInput = {
  companyId: 'company-1',
  subjectHash: 'a'.repeat(64),
  subjectKeyVersion: 1,
  sessionHandle: 'session_handle_1234567890abcdef',
  clientAcceptedMissionConnectionEpoch: 1,
  resumeNextServerSequence: 0,
  signal: new AbortController().signal,
};

describe('Mistral conversation resume tickets — contrat fail-closed', () => {
  it('génère des capacités 256 bits séparées et reconnaît leurs formats exacts', () => {
    const tickets = new Set<string>();
    const ownerTokens = new Set<string>();
    const acknowledgementTokens = new Set<string>();
    const connectionIds = new Set<string>();

    for (let index = 0; index < 32; index += 1) {
      const ticket = secureMistralConversationResumeTicketEntropy.ticket();
      const owner = secureMistralConversationResumeTicketEntropy.ownerLeaseToken();
      const acknowledgement = secureMistralConversationResumeTicketEntropy
        .terminalAcknowledgementToken();
      const connectionId = secureMistralConversationResumeTicketEntropy.replayConnectionId();
      expect(isMistralConversationResumeTicket(ticket)).toBe(true);
      expect(isMistralConversationConnectionLeaseToken(owner)).toBe(true);
      expect(isMistralConversationConnectionLeaseToken(acknowledgement)).toBe(true);
      expect(isMistralConversationReplayConnectionId(connectionId)).toBe(true);
      tickets.add(ticket);
      ownerTokens.add(owner);
      acknowledgementTokens.add(acknowledgement);
      connectionIds.add(connectionId);
    }

    expect(tickets.size).toBe(32);
    expect(ownerTokens.size).toBe(32);
    expect(acknowledgementTokens.size).toBe(32);
    expect(connectionIds.size).toBe(32);
    expect(isMistralConversationResumeTicket(`r2_${'A'.repeat(42)}`)).toBe(false);
    expect(isMistralConversationResumeTicket(`r1_${'A'.repeat(43)}`)).toBe(false);
  });

  it('borne les TTL, le quota et maintient le takeover live désactivé par défaut', () => {
    expect(DEFAULT_MISTRAL_CONVERSATION_RESUME_TICKET_POLICY).toEqual({
      ticketTtlSeconds: 30,
      terminalAcknowledgementTtlSeconds: 20,
      maxOutstandingTicketsPerMission: 3,
      liveTakeoverEnabled: false,
    });
    expect(() => validateMistralConversationResumeTicketPolicy(
      DEFAULT_MISTRAL_CONVERSATION_RESUME_TICKET_POLICY,
    )).not.toThrow();
    expect(() => validateMistralConversationResumeTicketPolicy({
      ...DEFAULT_MISTRAL_CONVERSATION_RESUME_TICKET_POLICY,
      ticketTtlSeconds: 121,
    })).toThrow(/Invalid Mistral conversation resume ticket policy/u);
    expect(() => validateMistralConversationResumeTicketPolicy({
      ...DEFAULT_MISTRAL_CONVERSATION_RESUME_TICKET_POLICY,
      terminalAcknowledgementTtlSeconds: 31,
    })).toThrow(/Invalid Mistral conversation resume ticket policy/u);
    expect(() => validateMistralConversationResumeTicketPolicy({
      ...DEFAULT_MISTRAL_CONVERSATION_RESUME_TICKET_POLICY,
      terminalAcknowledgementTtlSeconds: 5,
    })).toThrow(/Invalid Mistral conversation resume ticket policy/u);
    expect(() => validateMistralConversationResumeTicketPolicy({
      ...DEFAULT_MISTRAL_CONVERSATION_RESUME_TICKET_POLICY,
      maxOutstandingTicketsPerMission: 11,
    })).toThrow(/Invalid Mistral conversation resume ticket policy/u);
  });

  it('rejette toute identité, epoch ou curseur non canonique avant la persistance', () => {
    expect(isMistralConversationResumeIssueInput(ISSUE_INPUT)).toBe(true);
    expect(isMistralConversationResumeIssueInput({
      ...ISSUE_INPUT,
      subjectHash: 'A'.repeat(64),
    })).toBe(false);
    expect(isMistralConversationResumeIssueInput({
      ...ISSUE_INPUT,
      clientAcceptedMissionConnectionEpoch: -0,
    })).toBe(false);
    expect(isMistralConversationResumeIssueInput({
      ...ISSUE_INPUT,
      resumeNextServerSequence: -0,
    })).toBe(false);
    expect(isMistralConversationResumeIssueInput({
      ...ISSUE_INPUT,
      resumeNextServerSequence: 0x1_0000_0001,
    })).toBe(false);
    expect(isMistralConversationResumeIssueInput({
      ...ISSUE_INPUT,
      historicalSubjectBindings: [{
        subjectHash: 'b'.repeat(64),
        subjectKeyVersion: 2,
      }],
    })).toBe(true);
    expect(isMistralConversationResumeIssueInput({
      ...ISSUE_INPUT,
      historicalSubjectBindings: [{
        subjectHash: 'b'.repeat(64),
        subjectKeyVersion: ISSUE_INPUT.subjectKeyVersion,
      }],
    })).toBe(false);
    expect(isMistralConversationResumeIssueInput({
      ...ISSUE_INPUT,
      historicalSubjectBindings: [{
        subjectHash: ISSUE_INPUT.subjectHash,
        subjectKeyVersion: 2,
      }],
    })).toBe(false);
  });

  it('valide strictement la projection publique du reçu terminal', () => {
    const receipt = {
      companyId: 'company-1',
      sessionHandle: ISSUE_INPUT.sessionHandle,
      protocol: MISTRAL_CONVERSATION_PROTOCOL,
      missionConnectionEpoch: 4,
      nextServerSequence: 12,
      reason: 'user' as const,
      closedAt: '2026-07-19T12:00:00.000Z',
    };
    expect(isMistralConversationTerminalReceipt(receipt)).toBe(true);
    expect(isMistralConversationTerminalReceipt({
      ...receipt,
      nextServerSequence: 2,
    })).toBe(false);
    expect(isMistralConversationTerminalReceipt({
      ...receipt,
      missionConnectionEpoch: -0,
    })).toBe(false);
    expect(isMistralConversationTerminalReceipt({
      ...receipt,
      closedAt: '2026-07-19T12:00:00Z',
    })).toBe(false);
    expect(isMistralConversationTerminalReceipt({
      ...receipt,
      reason: 'invented' as 'user',
    })).toBe(false);
  });

  it('échoue fermé quand l’autorité est désactivée', async () => {
    const disabled = new DisabledMistralConversationResumeAuthority();
    await expect(disabled.issue()).resolves.toEqual({ status: 'unavailable' });
    await expect(disabled.reconcileInitialBootstrap()).resolves.toEqual({ status: 'unavailable' });
    await expect(disabled.redeemAndOpen()).resolves.toEqual({ status: 'unavailable' });
  });

  it('retrouve après purge uniquement le reçu terminal owner-bound et monotone', async () => {
    const receiptRow = {
      companyId: ISSUE_INPUT.companyId,
      sessionHandle: ISSUE_INPUT.sessionHandle,
      subjectHash: ISSUE_INPUT.subjectHash,
      subjectKeyVersion: ISSUE_INPUT.subjectKeyVersion,
      protocol: MISTRAL_CONVERSATION_PROTOCOL,
      missionConnectionEpoch: 4,
      nextServerSequence: 12n,
      terminalReason: 'user',
      closedAt: new Date('2026-07-19T12:00:00.000Z'),
    };
    const issue = async (
      overrides: Partial<MistralConversationResumeTicketIssueInput> = {},
      row: typeof receiptRow = receiptRow,
    ) => {
      const tx = {
        $executeRaw: vi.fn(async () => 0),
        $queryRaw: vi.fn()
          .mockResolvedValueOnce([])
          .mockResolvedValueOnce([row]),
      };
      const prisma = {
        inTransaction: vi.fn(() => false),
        withTenant: vi.fn(async (_companyId: string, work: (client: unknown) => unknown) =>
          work(tx)),
      } as unknown as PrismaService;
      const authority = new PrismaMistralConversationResumeAuthority(
        prisma,
        {} as PrismaMistralConversationDurableAuthority,
      );
      return authority.issue({ ...ISSUE_INPUT, ...overrides });
    };

    await expect(issue({
      clientAcceptedMissionConnectionEpoch: 2,
      resumeNextServerSequence: 8,
    })).resolves.toEqual({
      status: 'terminal_complete',
      receipt: {
        companyId: ISSUE_INPUT.companyId,
        sessionHandle: ISSUE_INPUT.sessionHandle,
        protocol: MISTRAL_CONVERSATION_PROTOCOL,
        missionConnectionEpoch: 4,
        nextServerSequence: 12,
        reason: 'user',
        closedAt: '2026-07-19T12:00:00.000Z',
      },
    });
    await expect(issue({ subjectHash: 'b'.repeat(64) })).resolves.toEqual({
      status: 'forbidden',
    });
    await expect(issue({
      subjectHash: 'b'.repeat(64),
      subjectKeyVersion: 2,
      historicalSubjectBindings: [{
        subjectHash: ISSUE_INPUT.subjectHash,
        subjectKeyVersion: ISSUE_INPUT.subjectKeyVersion,
      }],
    })).resolves.toMatchObject({ status: 'terminal_complete' });
    await expect(issue({
      subjectHash: 'b'.repeat(64),
      subjectKeyVersion: 2,
      historicalSubjectBindings: [{
        subjectHash: ISSUE_INPUT.subjectHash,
        subjectKeyVersion: 3,
      }],
    })).resolves.toEqual({ status: 'forbidden' });
    await expect(issue({ clientAcceptedMissionConnectionEpoch: 5 })).resolves.toEqual({
      status: 'stale_epoch',
    });
    await expect(issue({ resumeNextServerSequence: 13 })).resolves.toEqual({
      status: 'invalid_cursor',
    });
    await expect(issue({
      clientAcceptedMissionConnectionEpoch: 3,
      resumeNextServerSequence: 12,
    })).resolves.toEqual({ status: 'unavailable' });
    await expect(issue({}, { ...receiptRow, terminalReason: 'invented' })).resolves.toEqual({
      status: 'unavailable',
    });
  });

  it('refuse une transaction ambiante et un scope absent sans aucune I/O SQL', async () => {
    const withTenant = vi.fn();
    const prisma = {
      inTransaction: vi.fn(() => true),
      withTenant,
    } as unknown as PrismaService;
    const authority = new PrismaMistralConversationResumeAuthority(
      prisma,
      {} as PrismaMistralConversationDurableAuthority,
    );
    const valid = {
      companyId: ISSUE_INPUT.companyId,
      ticket: `r2_${'A'.repeat(43)}`,
      protocol: MISTRAL_CONVERSATION_PROTOCOL,
      expectedScope: 'terminal_replay' as const,
      resumeNextServerSequence: 0,
      maxReplayEvents: 256,
      maxReplayBytes: 256 * 1024,
      signal: ISSUE_INPUT.signal,
    };

    await expect(authority.redeemAndOpen(valid)).resolves.toEqual({ status: 'unavailable' });
    await expect(authority.redeemAndOpen({
      ...valid,
      expectedScope: undefined,
    } as unknown as Parameters<typeof authority.redeemAndOpen>[0])).resolves.toEqual({
      status: 'invalid',
    });
    expect(withTenant).not.toHaveBeenCalled();
  });
});
