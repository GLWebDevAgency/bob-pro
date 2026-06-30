import { describe, it, expect } from 'vitest';
import { EinvoiceTransmission } from './einvoice-transmission';

const AT = '2026-06-01T00:00:00.000Z';

describe('EinvoiceTransmission', () => {
  it('cycle issued->transmitted->received->accepted->paid', () => {
    const r = EinvoiceTransmission.open('t1', 'i1', 'pa');
    if (!r.ok) throw new Error('open');
    const t = r.value;
    expect(t.status).toBe('issued');
    expect(t.transmit(AT).ok).toBe(true);
    expect(t.acknowledgeReceived(AT).ok).toBe(true);
    expect(t.accept(AT).ok).toBe(true);
    expect(t.markPaidOnPlatform(AT).ok).toBe(true);
    expect(t.status).toBe('paid');
  });
  it('refuse une transition illegale (accept avant received)', () => {
    const r = EinvoiceTransmission.open('t1', 'i1', 'pa');
    if (!r.ok) throw new Error('open');
    expect(r.value.accept(AT).ok).toBe(false);
  });
});
