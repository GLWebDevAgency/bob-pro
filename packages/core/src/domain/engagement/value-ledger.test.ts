import { describe, expect, it } from 'vitest';
import { buildValueDigest, DIGEST_MIN_DOCUMENTS, type ValueEvent } from './value-ledger';

const WEEK = { periodStart: '2026-07-06T00:00:00.000Z', periodEnd: '2026-07-13T00:00:00.000Z' };
const at = '2026-07-08T10:00:00.000Z';

describe('buildValueDigest — la réciprocité honnête (jamais un chiffre inventé, jamais du bruit)', () => {
  it('semaine riche : faits agrégés, accroche ARGENT recouvré prioritaire', () => {
    const events: ValueEvent[] = [
      { kind: 'payment_collected', at, amountCents: 120_000 },
      { kind: 'overdue_recovered', at, amountCents: 41_500 },
      { kind: 'document_created', at, viaVoice: true },
      { kind: 'document_created', at },
      { kind: 'relance_sent', at },
      { kind: 'voice_action_completed', at },
    ];
    const digest = buildValueDigest({ ...WEEK, events })!;
    expect(digest.collectedCents).toBe(161_500); // le recouvré EST un encaissement
    expect(digest.recoveredCents).toBe(41_500);
    expect(digest.documentsCreated).toBe(2);
    expect(digest.documentsViaVoice).toBe(1);
    expect(digest.relancesSent).toBe(1);
    expect(digest.estimatedMinutesSaved).toBe(18 + 18 + 12 + 4); // table par défaut
    expect(digest.highlight).toEqual({ kind: 'money', amountCents: 41_500, recovered: true });
  });

  it('argent encaissé sans recouvrement → accroche money non-recovered', () => {
    const digest = buildValueDigest({
      ...WEEK,
      events: [{ kind: 'payment_collected', at, amountCents: 50_000 }],
    })!;
    expect(digest.highlight).toEqual({ kind: 'money', amountCents: 50_000, recovered: false });
  });

  it('pas d’argent mais du temps significatif → accroche TEMPS (annoncée comme estimation)', () => {
    const digest = buildValueDigest({
      ...WEEK,
      events: [
        { kind: 'document_created', at },
        { kind: 'document_created', at },
      ],
    })!;
    expect(digest.highlight).toEqual({ kind: 'time', minutes: 36 });
  });

  it('SEMAINE VIDE OU INSIGNIFIANTE → null : une notification sans valeur n’existe pas', () => {
    expect(buildValueDigest({ ...WEEK, events: [] })).toBeNull();
    expect(
      buildValueDigest({ ...WEEK, events: [{ kind: 'voice_action_completed', at }] }),
    ).toBeNull(); // 4 minutes estimées < seuil : du bruit, pas de la valeur
  });

  it('volume seul (≥3 documents, table de minutes vide) → accroche VOLUME', () => {
    const events: ValueEvent[] = Array.from({ length: DIGEST_MIN_DOCUMENTS }, () => ({
      kind: 'document_created' as const,
      at,
    }));
    const digest = buildValueDigest({ ...WEEK, events, minutes: {} })!;
    expect(digest.highlight).toEqual({ kind: 'volume', documents: 3 });
  });

  it('les événements HORS période sont ignorés (borne fin exclusive — jamais comptés deux fois)', () => {
    const digest = buildValueDigest({
      ...WEEK,
      events: [
        { kind: 'payment_collected', at: '2026-07-05T23:59:59.000Z', amountCents: 10_000 },
        { kind: 'payment_collected', at: WEEK.periodEnd, amountCents: 20_000 },
        { kind: 'payment_collected', at, amountCents: 5_000 },
      ],
    })!;
    expect(digest.collectedCents).toBe(5_000);
  });

  it('montants négatifs/NaN ignorés — un fait de valeur ne recule jamais', () => {
    expect(
      buildValueDigest({
        ...WEEK,
        events: [{ kind: 'payment_collected', at, amountCents: -500 }],
      }),
    ).toBeNull();
  });

  it('la table de minutes est une ENTRÉE : calibrage différent → estimation différente', () => {
    const digest = buildValueDigest({
      ...WEEK,
      events: [{ kind: 'document_created', at }],
      minutes: { document_created: 45 },
    });
    expect(digest?.estimatedMinutesSaved).toBe(45);
  });
});
