import { extractHttpsLinks } from './links';

const MAILOSAUR_API_BASE_URL = 'https://mailosaur.com/api';

interface MailosaurMessageSummary {
  readonly id: string;
}

function summaries(payload: unknown): readonly MailosaurMessageSummary[] {
  if (typeof payload !== 'object' || payload === null) return [];
  const items = (payload as Record<string, unknown>).items;
  if (!Array.isArray(items)) return [];
  return items.flatMap((item) => {
    if (typeof item !== 'object' || item === null) return [];
    const id = (item as Record<string, unknown>).id;
    return typeof id === 'string' && id.length <= 160 ? [{ id }] : [];
  });
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export class MailosaurInbox {
  private readonly authorization: string;

  constructor(
    private readonly serverId: string,
    apiKey: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {
    this.authorization = `Basic ${Buffer.from(`api:${apiKey}`, 'utf8').toString('base64')}`;
  }

  async waitForLink(input: {
    readonly sentTo: string;
    readonly receivedAfter: Date;
    readonly accepts: (link: URL) => boolean;
    readonly timeoutMs?: number;
  }): Promise<URL> {
    const timeoutMs = input.timeoutMs ?? 120_000;
    const deadline = Date.now() + timeoutMs;
    const inspected = new Set<string>();
    while (Date.now() < deadline) {
      const query = new URLSearchParams({
        server: this.serverId,
        receivedAfter: input.receivedAfter.toISOString(),
      });
      const response = await this.fetchImpl(`${MAILOSAUR_API_BASE_URL}/messages/search?${query}`, {
        method: 'POST',
        headers: {
          Accept: 'application/json',
          Authorization: this.authorization,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ sentTo: input.sentTo }),
        signal: AbortSignal.timeout(10_000),
      });
      if (response.status === 401 || response.status === 403) {
        throw new Error('Cabinet staging mailbox authentication failed.');
      }
      if (response.ok) {
        for (const summary of summaries(await response.json())) {
          if (inspected.has(summary.id)) continue;
          inspected.add(summary.id);
          const messageResponse = await this.fetchImpl(
            `${MAILOSAUR_API_BASE_URL}/messages/${encodeURIComponent(summary.id)}`,
            {
              headers: { Accept: 'application/json', Authorization: this.authorization },
              signal: AbortSignal.timeout(10_000),
            },
          );
          if (!messageResponse.ok) continue;
          const message: unknown = await messageResponse.json();
          const link = extractHttpsLinks(message).find(input.accepts);
          if (link !== undefined) return link;
        }
      } else if (response.status < 500 && response.status !== 429) {
        throw new Error('Cabinet staging mailbox search failed.');
      }
      await delay(2_000);
    }
    throw new Error('Cabinet staging mailbox did not receive the expected link in time.');
  }
}
