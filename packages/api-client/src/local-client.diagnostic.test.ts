import { describe, expect, it, vi } from 'vitest';
import { Payment, runDiagnostic } from '@bob/core';
import { LocalBobClient } from './local-client';

/**
 * Année MÉTIER Paris du diagnostic DÉMO (jumeau local de backend.service.getDiagnostic et de
 * DiagnosticAssessmentService — bug de la nuit du Nouvel An, fenêtre 23:00–00:00 UTC le 31/12) :
 * la borne (asOf = parisDateOnly(clock.now())) ET le jour des encaissements (businessDayOf)
 * vivent sur le même calendrier. La société de démo est en 'reel_simpl' : l'item 293 B n'existe
 * pas dans le résultat public, donc `annualEncaissedCents` n'y est PAS observable —
 * l'observation honnête est la FRONTIÈRE `runDiagnostic` (@bob/core), espionnée en CALL-THROUGH
 * (le vrai moteur s'exécute, rien n'est fabriqué), dans un fichier dédié pour ne pas contaminer
 * le graphe de modules de local-client.test.ts.
 *
 * Horloge GELÉE par injection (ClockPort inline). Les encaissements sont posés DIRECTEMENT dans
 * le dépôt in-memory du client (même geste que le seed de persistence des tests serveur) : le
 * seed de démo n'en produit AUCUN sous une horloge injectée (ses flows historisés via
 * clockDaysAgo(Date.now()) violent la chronologie de numérotation et s'interrompent — écart démo
 * documenté, local-client.ts). La prémisse est assertée : le dépôt contient EXACTEMENT les
 * paiements du test, jamais un total tautologique.
 */
vi.mock('@bob/core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@bob/core')>();
  return { ...actual, runDiagnostic: vi.fn(actual.runDiagnostic) };
});

function paymentAt(companyId: string, receivedAt: string, amount: number): Payment {
  const value = Payment.record({
    id: `pay-${receivedAt}-${amount}`,
    companyId,
    invoiceId: 'inv-jour-metier',
    amount,
    method: 'transfer',
    receivedAt,
  });
  if (!value.ok) throw new Error('fixture: paiement invalide');
  return value.value;
}

/** Client démo à horloge gelée + encaissements datés posés au dépôt, puis entrée runDiagnostic lue. */
async function capturedDiagnosticInput(
  frozenNow: string,
  payments: readonly { receivedAt: string; amount: number }[],
) {
  const clock = { now: () => frozenNow, today: () => frozenNow.slice(0, 10) };
  const client = new LocalBobClient({ clock });
  const raw = client as unknown as {
    payments: { save(p: Payment): Promise<void> };
    companyId: string;
  };
  await client.listPayments(); // barrière : attend le seed AVANT de poser les paiements du test
  for (const p of payments) await raw.payments.save(paymentAt(raw.companyId, p.receivedAt, p.amount));
  const listed = await client.listPayments();
  expect(listed.ok).toBe(true);
  if (!listed.ok) throw new Error('listPayments KO');
  // Prémisse discriminante : le dépôt contient EXACTEMENT les paiements du test (le seed démo
  // n'en ajoute aucun sous horloge injectée) — sinon les littéraux ci-dessous ne prouvent rien.
  expect(listed.value).toHaveLength(payments.length);
  const r = await client.getDiagnostic();
  expect(r.ok).toBe(true);
  const input = vi.mocked(runDiagnostic).mock.calls.at(-1)?.[0];
  if (input === undefined) throw new Error('runDiagnostic non appelé');
  vi.mocked(runDiagnostic).mockClear();
  return input;
}

describe('LocalBobClient.getDiagnostic — année MÉTIER Paris des encaissements (293 B, Nouvel An)', () => {
  it("encaissé le 31/12 23:30 UTC = 1er janvier 00:30 Paris (CET +1) : asOf 2027-01-01 et 40 000 € comptés en 2027", async () => {
    // Horloge gelée à 2026-12-31T23:30Z : asOf = parisDateOnly(now) = 2027-01-01 → année '2027'
    // (la borne au jour UTC de l'appareil aurait dit 2026-12-31 → année '2026'). Le paiement du
    // même instant a pour jour métier 2027-01-01 → année '2027' → compté : 4 000 000 c. Le
    // contrôle de juin 2026 (777 777 c) reste hors de l'année surveillée — jamais un « total du
    // dépôt » tautologique. La troncature UTC (année '2026' ≠ '2027') aurait rendu 0.
    const input = await capturedDiagnosticInput('2026-12-31T23:30:00.000Z', [
      { receivedAt: '2026-12-31T23:30:00.000Z', amount: 4_000_000 },
      { receivedAt: '2026-06-15T10:00:00.000Z', amount: 777_777 },
    ]);
    expect(input.asOf).toBe('2027-01-01');
    expect(input.annualEncaissedCents).toBe(4_000_000);
  });

  it("TÉMOIN DST : encaissé le 31/12 22:30 UTC = 23:30 Paris (CET +1, pas +2) : asOf 2026-12-31, compté en 2026", async () => {
    // 22:30Z + 1 h = 23:30 le 31/12 : asOf = 2026-12-31 → année '2026', et le jour métier du
    // paiement est ENCORE 2026-12-31 → compté (4 000 000 c ; le contrôle 2025 reste dehors). Un
    // calcul DST-naïf à offset d'été figé (+2 h toute l'année) projetterait le paiement au
    // 01/01/2027 (année '2027' ≠ '2026') → 0. Le cas 23:30Z ci-dessus ne discrimine pas (+1 et
    // +2 donnent tous deux le 01/01) : ce littéral-ci est le témoin qui tue ce mutant.
    const input = await capturedDiagnosticInput('2026-12-31T22:30:00.000Z', [
      { receivedAt: '2026-12-31T22:30:00.000Z', amount: 4_000_000 },
      { receivedAt: '2025-06-15T10:00:00.000Z', amount: 777_777 },
    ]);
    expect(input.asOf).toBe('2026-12-31');
    expect(input.annualEncaissedCents).toBe(4_000_000);
  });

  it('non-régression pleine journée : encaissé le 10/06 09:00 UTC = 11:00 Paris → asOf 2026-06-15, compté en 2026', async () => {
    // Loin de minuit, année UTC et année Paris coïncident — le correctif ne change rien.
    const input = await capturedDiagnosticInput('2026-06-15T10:00:00.000Z', [
      { receivedAt: '2026-06-10T09:00:00.000Z', amount: 4_000_000 },
      { receivedAt: '2025-12-31T10:00:00.000Z', amount: 777_777 },
    ]);
    expect(input.asOf).toBe('2026-06-15');
    expect(input.annualEncaissedCents).toBe(4_000_000);
  });
});
