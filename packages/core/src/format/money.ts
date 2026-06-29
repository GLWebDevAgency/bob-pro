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
