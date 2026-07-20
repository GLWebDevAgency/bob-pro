const NBSP_FINE = String.fromCharCode(0x202f); // espace fine insecable U+202F
const EUR = String.fromCharCode(0x20ac); // signe euro U+20AC

/** Formate des centimes (int) en EUR fr-FR : "1<NBSP>628,00<NBSP>EUR" (separateurs = U+202F). */
export function formatEUR(cents: number): string {
  const negative = cents < 0;
  const abs = Math.abs(cents);
  const euros = Math.trunc(abs / 100);
  const dec = String(abs % 100).padStart(2, '0');
  const intStr = String(euros).replace(/\B(?=(\d{3})+(?!\d))/g, NBSP_FINE);
  return `${negative ? '-' : ''}${intStr},${dec}${NBSP_FINE}${EUR}`;
}

/**
 * Formate des centimes en EUR fr-FR arrondi à l'euro : "4<NBSP>950<NBSP>EUR".
 * Pour les AGRÉGATS (briefing, tuiles KPI, héros tréso) — le proto n'affiche jamais
 * les centimes sur ces surfaces. Les documents (devis, factures) gardent formatEUR.
 */
export function formatEURWhole(cents: number): string {
  const negative = cents < 0;
  const euros = Math.round(Math.abs(cents) / 100);
  const intStr = String(euros).replace(/\B(?=(\d{3})+(?!\d))/g, NBSP_FINE);
  return `${negative && euros !== 0 ? '-' : ''}${intStr}${NBSP_FINE}${EUR}`;
}
