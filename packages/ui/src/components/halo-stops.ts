/**
 * Convertit un littéral rgba token en couleur pleine + stopOpacity pour react-native-svg :
 * certaines versions ignorent l'alpha de stopColor, transformant un glow en aplat opaque.
 * Partagé par AppHeaderNavy et HeroMoneyCard (halos décoratifs, réf dc.html : fondu à 70 %).
 */
export function rgbaStop(token: string): { color: string; opacity: number } {
  const m = /rgba?\(([^)]+)\)/.exec(token);
  if (!m?.[1]) return { color: token, opacity: 1 };
  const parts = m[1].split(',').map((v) => Number(v.trim()));
  const [r = 0, g = 0, b = 0, a = 1] = parts;
  return { color: `rgb(${r},${g},${b})`, opacity: a };
}
