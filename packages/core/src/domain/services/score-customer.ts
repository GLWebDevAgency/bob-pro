export function scoreCustomer(m: { avgDelayDays: number; outstanding: number; paidOnTimeRatio: number }): number {
  const delayPenalty = Math.min(50, m.avgDelayDays * 1.2);
  const outstandingPenalty = Math.min(20, m.outstanding / 50000); // 1 pt / 500 EUR, plafond 20
  const punctualityBonus = m.paidOnTimeRatio * 30; // 0..30
  const raw = 70 + punctualityBonus - delayPenalty - outstandingPenalty;
  return Math.max(0, Math.min(100, Math.round(raw)));
}
