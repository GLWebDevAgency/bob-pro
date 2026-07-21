import {
  PDFDocument,
  rgb,
  AFRelationship,
  PDFName,
  LineCapStyle,
  type Color,
  type PDFFont,
  type PDFImage,
  type PDFPage,
} from 'pdf-lib';
import fontkit from '@pdf-lib/fontkit';
import {
  formatEUR,
  type Discount,
  type PdfRendererPort,
  type InvoicePdfData,
  type InvoicePdfAccentColor,
  type QuotePdfData,
} from '@bob/core';
import { loadPdfFontBytes } from './pdf-fonts';
import { applyPdfA3bEnvelope } from './pdfa3';

export const PDF_RENDERER = Symbol('PDF_RENDERER');

// Les polices embarquées couvrent l'Unicode latin, mais `sanitize` reste le CONTRAT des tests
// d'extraction (espace fine U+202F de formatEUR, guillemets, tirets) : conservé TEL QUEL
// (échappements \u explicites, robustes aux normalisations de fichier — formatEUR insère U+202F).
// L'assouplir est un chantier séparé.
const sanitize = (s: string): string =>
  s
    .replace(/[\u00a0\u202f\u2007\u2009]/g, ' ')
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u2013\u2014]/g, '-');

const money = (cents: number): string => sanitize(formatEUR(cents));

/** B3 — libellé imprimable d'une remise (« remise 10 % » | « remise 25,00 € »). */
const discountLabel = (d: Discount): string =>
  d.type === 'percent' ? `remise ${d.value} %` : `remise ${money(d.cents)}`;

/* ────────────────────────────────────────────────────────────────────────────
 * Couleur — « Fintech chaleureuse ». Accents tenant RECALÉS sur les tokens de
 * l'app (packages/tokens) : les pastilles du sélecteur mobile (#0C2340,
 * #0E7C5A, #4338CA, #C77A12) deviennent EXACTEMENT ce qui s'imprime (WYSIWYG).
 * Le type reste fermé à 4 : le renderer est l'autorité de rendu de ces rôles.
 * ──────────────────────────────────────────────────────────────────────────── */

export interface PdfAccentRoleHex {
  /** Aplats généreux (bandeau, bloc héros) — texte ≥ 9 pt gras blanc uniquement. */
  base: string;
  /** Texte accent sur fond clair + fonds des petits textes < 12 pt (en-tête tableau, pills). */
  deep: string;
  /** Pills (remises, acompte). */
  tint12: string;
  /** Cartes RIB/assurance, chips méta. */
  tint07: string;
  /** Zébrures du tableau. */
  tint04: string;
  /** Filets structurants. */
  hairline: string;
}

export const PDF_ACCENT_HEX: Record<InvoicePdfAccentColor, PdfAccentRoleHex> = {
  navy: {
    base: '#0C2340',
    deep: '#09192E',
    tint12: '#E2E5E8',
    tint07: '#EEF0F2',
    tint04: '#F5F6F7',
    hairline: '#CACFD5',
  },
  green: {
    base: '#0E7C5A',
    deep: '#0A5941',
    tint12: '#E2EFEB',
    tint07: '#EEF6F3',
    tint04: '#F5FAF8',
    hairline: '#CAE2DB',
  },
  purple: {
    base: '#4338CA',
    deep: '#302891',
    tint12: '#E8E7F9',
    tint07: '#F2F1FB',
    tint04: '#F7F7FD',
    hairline: '#D6D3F3',
  },
  orange: {
    base: '#C77A12',
    deep: '#8F580D',
    tint12: '#F8EFE3',
    tint07: '#FBF6EE',
    tint04: '#FDFAF6',
    hairline: '#F3E2CB',
  },
};

export function hexToRgb(hex: string): Color {
  const v = hex.replace('#', '');
  return rgb(
    parseInt(v.slice(0, 2), 16) / 255,
    parseInt(v.slice(2, 4), 16) / 255,
    parseInt(v.slice(4, 6), 16) / 255,
  );
}

interface AccentRgb {
  base: Color;
  deep: Color;
  tint12: Color;
  tint07: Color;
  tint04: Color;
  hairline: Color;
}

function accentRoles(accent: InvoicePdfAccentColor): AccentRgb {
  // Fail-safe : un accent hors des 4 rôles connus (donnée corrompue, adapter futur) retombe sur
  // navy plutôt que de propager un `undefined` → TypeError → 500. Un PDF navy vaut mieux qu'un crash.
  const hexes = PDF_ACCENT_HEX[accent] ?? PDF_ACCENT_HEX.navy;
  return {
    base: hexToRgb(hexes.base),
    deep: hexToRgb(hexes.deep),
    tint12: hexToRgb(hexes.tint12),
    tint07: hexToRgb(hexes.tint07),
    tint04: hexToRgb(hexes.tint04),
    hairline: hexToRgb(hexes.hairline),
  };
}

// Neutres invariants (tokens de l'app).
const INK900 = hexToRgb('#0C2340');
const INK800 = hexToRgb('#0F2235');
const SLATE500 = hexToRgb('#5B6B7B');
const SLATE400 = hexToRgb('#8A99A8');
const LINE = hexToRgb('#E0E6EE');
const WHITE = rgb(1, 1, 1);
const CARD_BORDER = hexToRgb('#EAEEF3');
// Ambre « rectification » (warningBg/creditBorder de l'app) — le langage de l'avoir.
const AMBER_BG = hexToRgb('#FBF0DF');
const AMBER_BORDER = hexToRgb('#F0DEBE');
const AMBER_INK = hexToRgb('#8A5A12');
// Succès signature.
const SUCCESS_BG = hexToRgb('#EAF2EC');
const SUCCESS_BORDER = hexToRgb('#CFE6D6');
const SUCCESS_INK = hexToRgb('#0E7C5A');
const SUCCESS_WINDOW_BORDER = hexToRgb('#DCEDE3');
const DASH_NEUTRAL = hexToRgb('#D6DEE6');
const CUT_LINE = hexToRgb('#A9B4C0');

// Grille A4.
const PAGE_W = 595;
const PAGE_H = 842;
const MARGIN_X = 44;
const RIGHT_X = 551;
const CONTENT_W = 507;
const MIN_Y = 72;

/* ── Typographie : les polices DE L'APP, embarquées (fontkit, subset) ─────── */

interface Fonts {
  display800: PDFFont;
  display700: PDFFont;
  text700: PDFFont;
  text600: PDFFont;
  text500: PDFFont;
}

async function embedFonts(doc: PDFDocument): Promise<Fonts> {
  doc.registerFontkit(fontkit);
  const bytes = loadPdfFontBytes();
  const [display800, display700, text700, text600, text500] = await Promise.all([
    doc.embedFont(bytes.display800, { subset: true }),
    doc.embedFont(bytes.display700, { subset: true }),
    doc.embedFont(bytes.text700, { subset: true }),
    doc.embedFont(bytes.text600, { subset: true }),
    doc.embedFont(bytes.text500, { subset: true }),
  ]);
  return { display800, display700, text700, text600, text500 };
}

/* ── Helpers de dessin ────────────────────────────────────────────────────── */

const widthOf = (font: PDFFont, text: string, size: number): number =>
  font.widthOfTextAtSize(sanitize(text), size);

/**
 * Wrap par MESURE de glyphes (widthOfTextAtSize) — coupe au dernier espace,
 * césure dure des mots plus larges que la colonne. Remplace le wrap naïf au
 * nombre de caractères.
 */
function wrapMeasured(text: string, font: PDFFont, size: number, maxW: number): string[] {
  const clean = sanitize(text);
  const lines: string[] = [];
  let current = '';
  const pushWord = (word: string): void => {
    const joined = current === '' ? word : `${current} ${word}`;
    if (font.widthOfTextAtSize(joined, size) <= maxW) {
      current = joined;
      return;
    }
    if (current !== '') lines.push(current);
    if (font.widthOfTextAtSize(word, size) <= maxW) {
      current = word;
      return;
    }
    // Césure dure d'un mot plus large que la colonne.
    let chunk = '';
    for (const ch of word) {
      if (font.widthOfTextAtSize(chunk + ch, size) > maxW && chunk !== '') {
        lines.push(chunk);
        chunk = ch;
      } else {
        chunk += ch;
      }
    }
    current = chunk;
  };
  for (const word of clean.split(' ')) {
    if (word === '') continue;
    pushWord(word);
  }
  if (current !== '') lines.push(current);
  return lines.length > 0 ? lines : [''];
}

interface TextOpts {
  color?: Color;
  opacity?: number;
}

function drawRun(
  page: PDFPage,
  text: string,
  x: number,
  y: number,
  font: PDFFont,
  size: number,
  opts: TextOpts = {},
): void {
  page.drawText(sanitize(text), {
    x,
    y,
    size,
    font,
    color: opts.color ?? INK800,
    ...(opts.opacity !== undefined ? { opacity: opts.opacity } : {}),
  });
}

function drawRight(
  page: PDFPage,
  text: string,
  xRight: number,
  y: number,
  font: PDFFont,
  size: number,
  opts: TextOpts = {},
): void {
  drawRun(page, text, xRight - widthOf(font, text, size), y, font, size, opts);
}

/**
 * Eyebrows décoratifs NON légaux uniquement (EMETTEUR, CLIENT, SIGNATURE,
 * FORMULAIRE DETACHABLE) : tracking lettre à lettre. Jamais pour une string
 * légale/testée (règle absolue de test-safety).
 */
function drawTracked(
  page: PDFPage,
  text: string,
  x: number,
  y: number,
  font: PDFFont,
  size: number,
  tracking: number,
  opts: TextOpts = {},
): void {
  let cursor = x;
  for (const ch of sanitize(text)) {
    drawRun(page, ch, cursor, y, font, size, opts);
    cursor += font.widthOfTextAtSize(ch, size) + tracking;
  }
}

const DIGITS = '0123456789';

function digitCell(font: PDFFont, size: number): { cell: number; tabular: boolean } {
  const widths = DIGITS.split('').map((d) => font.widthOfTextAtSize(d, size));
  const cell = Math.max(...widths);
  const tabular = widths.every((w) => Math.abs(w - cell) < 0.01);
  return { cell, tabular };
}

/**
 * Montant aligné à droite en chiffres TABULAIRES : si la police a des chiffres
 * à chasse fixe, un seul drawText ; sinon chaque chiffre est posé sur une
 * chasse fixe (empilement vertical parfait des colonnes de totaux).
 * Réservé aux VALEURS numériques — jamais aux strings légales/testées.
 */
function drawAmountRight(
  page: PDFPage,
  text: string,
  xRight: number,
  y: number,
  font: PDFFont,
  size: number,
  opts: TextOpts = {},
): void {
  const clean = sanitize(text);
  const { cell, tabular } = digitCell(font, size);
  if (tabular) {
    drawRight(page, clean, xRight, y, font, size, opts);
    return;
  }
  let cursor = xRight;
  for (let i = clean.length - 1; i >= 0; i--) {
    const ch = clean[i]!;
    const w = font.widthOfTextAtSize(ch, size);
    if (DIGITS.includes(ch)) {
      cursor -= cell;
      drawRun(page, ch, cursor + (cell - w) / 2, y, font, size, opts);
    } else {
      cursor -= w;
      drawRun(page, ch, cursor, y, font, size, opts);
    }
  }
}

interface CornerRadii {
  tl: number;
  tr: number;
  br: number;
  bl: number;
}

function roundedRectPath(w: number, h: number, r: number | CornerRadii): string {
  const { tl, tr, br, bl } = typeof r === 'number' ? { tl: r, tr: r, br: r, bl: r } : r;
  const parts: string[] = [`M ${tl} 0`, `L ${w - tr} 0`];
  if (tr > 0) parts.push(`A ${tr} ${tr} 0 0 1 ${w} ${tr}`);
  parts.push(`L ${w} ${h - br}`);
  if (br > 0) parts.push(`A ${br} ${br} 0 0 1 ${w - br} ${h}`);
  parts.push(`L ${bl} ${h}`);
  if (bl > 0) parts.push(`A ${bl} ${bl} 0 0 1 0 ${h - bl}`);
  parts.push(`L 0 ${tl}`);
  if (tl > 0) parts.push(`A ${tl} ${tl} 0 0 1 ${tl} 0`);
  parts.push('Z');
  return parts.join(' ');
}

interface RoundedRectOpts {
  x: number;
  /** Bord SUPÉRIEUR du rectangle (drawSvgPath : l'axe y descend depuis `y`). */
  top: number;
  w: number;
  h: number;
  r: number | CornerRadii;
  color?: Color;
  opacity?: number;
  borderColor?: Color;
  borderWidth?: number;
  borderOpacity?: number;
  borderDashArray?: number[];
}

function roundedRect(page: PDFPage, opts: RoundedRectOpts): void {
  page.drawSvgPath(roundedRectPath(opts.w, opts.h, opts.r), {
    x: opts.x,
    y: opts.top,
    ...(opts.color !== undefined ? { color: opts.color } : {}),
    ...(opts.opacity !== undefined ? { opacity: opts.opacity } : {}),
    ...(opts.borderColor !== undefined ? { borderColor: opts.borderColor } : {}),
    ...(opts.borderWidth !== undefined ? { borderWidth: opts.borderWidth } : {}),
    ...(opts.borderOpacity !== undefined ? { borderOpacity: opts.borderOpacity } : {}),
    ...(opts.borderDashArray !== undefined ? { borderDashArray: opts.borderDashArray } : {}),
  });
}

/** Ombre bleutée signature de l'app (jamais grise) : même rect décalé (0, −3). */
function shadowRect(page: PDFPage, x: number, top: number, w: number, h: number, r: number): void {
  roundedRect(page, { x, top: top - 3, w, h, r, color: INK900, opacity: 0.05 });
}

interface ChipSpec {
  text: string;
  fill: Color;
  fillOpacity?: number;
  textColor: Color;
  textOpacity?: number;
}

const CHIP_H = 16;
const CHIP_PAD = 8;
const CHIP_FONT_SIZE = 7.5;

function chipWidth(font: PDFFont, text: string): number {
  return widthOf(font, text, CHIP_FONT_SIZE) + CHIP_PAD * 2;
}

/** Chip arrondie h=16 — le texte est UN SEUL drawText (strings verbatim). */
function drawChip(page: PDFPage, font: PDFFont, spec: ChipSpec, x: number, top: number): number {
  const w = chipWidth(font, spec.text);
  roundedRect(page, {
    x,
    top,
    w,
    h: CHIP_H,
    r: 8,
    color: spec.fill,
    ...(spec.fillOpacity !== undefined ? { opacity: spec.fillOpacity } : {}),
  });
  drawRun(page, spec.text, x + CHIP_PAD, top - 11, font, CHIP_FONT_SIZE, {
    color: spec.textColor,
    ...(spec.textOpacity !== undefined ? { opacity: spec.textOpacity } : {}),
  });
  return w;
}

// #1/#5 — largeur mono-ligne max d'une chip AVANT bascule en bloc : au-delà, une chip
// (adresse de chantier ≥ 130 c., long n° de bon de commande) déborderait la carte (x=551)
// puis la page (x=595). Bornée à la largeur interne de la carte (x 60 → 535).
const CHIP_MAX_W = 475;
const CHIP_LINE_H = 10;
const CHIP_BLOCK_VPAD = 5;

/** Hauteur d'une chip BLOC (texte wrappé sur N lignes) — la carte grandit avec elle. */
function blockChipHeight(lineCount: number): number {
  return CHIP_BLOCK_VPAD * 2 + lineCount * CHIP_LINE_H;
}

/**
 * Chip BLOC : même langage visuel qu'une chip, mais le texte est wrappé par MESURE sur plusieurs
 * lignes DANS la pastille (qui grandit) au lieu de déborder. Le texte n'est PAS une string légale
 * verbatim (adresse A7 / n° d'engagement) : le wrap est admis ; le préfixe reste en tête de ligne 1.
 */
function drawBlockChip(
  page: PDFPage,
  font: PDFFont,
  lines: string[],
  x: number,
  top: number,
  w: number,
  fill: Color,
  textColor: Color,
): void {
  roundedRect(page, { x, top, w, h: blockChipHeight(lines.length), r: 8, color: fill });
  let ty = top - CHIP_BLOCK_VPAD - 6.5;
  for (const line of lines) {
    drawRun(page, line, x + CHIP_PAD, ty, font, CHIP_FONT_SIZE, { color: textColor });
    ty -= CHIP_LINE_H;
  }
}

/** Adresse (JAMAIS un nom légal) réduite à `maxW` avec « … » — signale une coupe honnête. */
function ellipsizeToWidth(line: string, font: PDFFont, size: number, maxW: number): string {
  let s = line;
  while (s.length > 0 && widthOf(font, `${s}...`, size) > maxW) s = s.slice(0, -1);
  return `${s.trimEnd()}...`;
}

/** Initiales du monogramme (fallback logo) — décoratif, dérivé du nom. */
export function monogramInitials(name: string): string {
  const words = sanitize(name)
    .split(/\s+/)
    .map((w) => w.replace(/[^\p{L}\p{N}]/gu, ''))
    .filter((w) => w.length > 0);
  const first = words[0]?.charAt(0) ?? '';
  const second = words.length > 1 ? (words[1]?.charAt(0) ?? '') : (words[0]?.charAt(1) ?? '');
  const initials = `${first}${second}`.toUpperCase();
  return initials === '' ? 'B' : initials;
}

function sniffImageKind(bytes: Uint8Array): 'png' | 'jpeg' | null {
  if (bytes.length > 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) {
    return 'png';
  }
  if (bytes.length > 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'jpeg';
  return null;
}

/** Data-URL SVG du pad de signature → viewBox + paths `d` (fail-closed : null). */
export function parseSignatureSvgDataUrl(
  dataUrl: string,
): { width: number; height: number; paths: string[] } | null {
  if (!dataUrl.startsWith('data:image/svg+xml')) return null;
  const comma = dataUrl.indexOf(',');
  if (comma < 0) return null;
  let svg = dataUrl.slice(comma + 1);
  try {
    svg = decodeURIComponent(svg);
  } catch {
    // Déjà décodé — on tente tel quel.
  }
  const viewBox = /viewBox="([-\d.\s]+)"/.exec(svg);
  const dims = viewBox?.[1]?.trim().split(/\s+/).map(Number) ?? [];
  const width = dims.length === 4 ? dims[2]! : Number(/width="([\d.]+)"/.exec(svg)?.[1]);
  const height = dims.length === 4 ? dims[3]! : Number(/height="([\d.]+)"/.exec(svg)?.[1]);
  const paths = [...svg.matchAll(/\sd="([^"]+)"/g)].map((m) => m[1]!).filter((d) => d.length > 0);
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return null;
  if (paths.length === 0) return null;
  return { width, height, paths };
}

/** `2026-07-19[T…]` → `19/07/2026` (date FR de la carte signature). */
function frDate(iso: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  return m ? `${m[3]}/${m[2]}/${m[1]}` : iso;
}

function groupIban(iban: string): string {
  const compact = iban.replace(/\s+/g, '');
  return compact.replace(/(.{4})/g, '$1 ').trim();
}

/* ── Moteur de pagination : blocs mesurés avant dessin ────────────────────── */

interface Ctx {
  doc: PDFDocument;
  fonts: Fonts;
  accent: AccentRgb;
  page: PDFPage;
  y: number;
  /** Titre verbatim de la pièce (« Facture N » | « Avoir N » | « Devis N »). */
  pieceTitle: string;
  companyName: string;
  /** Ré-impression de l'en-tête de tableau après un saut de page en cours de table. */
  tableHeaderPainter: (() => void) | null;
}

/** Bandeau slim des pages de continuation et de rétractation — l'identité vivante. */
function drawSlimBanner(ctx: Ctx): void {
  const { page, accent, fonts } = ctx;
  page.drawRectangle({ x: 0, y: PAGE_H - 44, width: PAGE_W, height: 44, color: accent.base });
  page.drawRectangle({ x: 0, y: PAGE_H - 44, width: PAGE_W, height: 2, color: accent.deep });
  drawRun(page, ctx.companyName, MARGIN_X, PAGE_H - 27, fonts.text700, 9, { color: WHITE });
  drawRight(page, ctx.pieceTitle, RIGHT_X, PAGE_H - 27, fonts.text700, 9, { color: WHITE });
}

function newPage(ctx: Ctx): void {
  ctx.page = ctx.doc.addPage([PAGE_W, PAGE_H]);
  drawSlimBanner(ctx);
  ctx.y = PAGE_H - 44 - 26;
  if (ctx.tableHeaderPainter) ctx.tableHeaderPainter();
}

function ensureSpace(ctx: Ctx, h: number): void {
  if (ctx.y - h < MIN_Y) newPage(ctx);
}

/** Footer tamponné en 2e passe (le total de pages n'existe qu'à la fin). */
function stampFooters(ctx: Ctx): void {
  const pages = ctx.doc.getPages();
  const total = pages.length;
  pages.forEach((page, index) => {
    page.drawLine({
      start: { x: MARGIN_X, y: 48 },
      end: { x: RIGHT_X, y: 48 },
      thickness: 0.75,
      color: ctx.accent.hairline,
    });
    drawRun(page, `${ctx.companyName} — ${ctx.pieceTitle}`, MARGIN_X, 36, ctx.fonts.text600, 7, {
      color: SLATE400,
    });
    const tail = ` / ${total}`;
    const num = `${index + 1}`;
    const head = 'Page ';
    const tailW = widthOf(ctx.fonts.text600, tail, 7);
    const numW = widthOf(ctx.fonts.text600, num, 7);
    const headW = widthOf(ctx.fonts.text600, head, 7);
    let x = RIGHT_X - tailW - numW - headW;
    page.drawCircle({ x: x - 8, y: 38.5, size: 1.5, color: ctx.accent.base });
    drawRun(page, head, x, 36, ctx.fonts.text600, 7, { color: SLATE400 });
    x += headW;
    drawRun(page, num, x, 36, ctx.fonts.text600, 7, { color: ctx.accent.deep });
    x += numW;
    drawRun(page, tail, x, 36, ctx.fonts.text600, 7, { color: SLATE400 });
  });
}

/* ── En-tête héros page 1 : bandeau plein + logo/monogramme + chips ───────── */

interface HeroIdentity {
  companyName: string;
  companyAddress: string;
  companyRcsOrRm: string | null;
}

function drawHeroHeader(
  ctx: Ctx,
  identity: HeroIdentity,
  chips: string[],
  subtitle: string | null,
  logo: { image: PDFImage; width: number; height: number } | null,
): void {
  const { page, accent, fonts } = ctx;
  // Bandeau plein 136 pt + liseré deep + halos signature de l'app.
  page.drawRectangle({ x: 0, y: 706, width: PAGE_W, height: 136, color: accent.base });
  page.drawRectangle({ x: 0, y: 706, width: PAGE_W, height: 3, color: accent.deep });
  page.drawEllipse({ x: 556, y: 838, xScale: 110, yScale: 110, color: WHITE, opacity: 0.05 });
  page.drawEllipse({ x: 480, y: 872, xScale: 70, yScale: 70, color: WHITE, opacity: 0.04 });

  // Logo (plaque blanche) ou monogramme — jamais un trou.
  const slotTop = 820;
  if (logo) {
    const scale = Math.min(32 / logo.height, 120 / logo.width);
    const w = logo.width * scale;
    const h = logo.height * scale;
    roundedRect(page, { x: MARGIN_X, top: slotTop, w: w + 16, h: 44, r: 10, color: WHITE });
    page.drawImage(logo.image, {
      x: MARGIN_X + 8,
      y: slotTop - 44 + (44 - h) / 2,
      width: w,
      height: h,
    });
  } else {
    roundedRect(page, {
      x: MARGIN_X,
      top: slotTop,
      w: 44,
      h: 44,
      r: 12,
      color: WHITE,
      opacity: 0.14,
      borderColor: WHITE,
      borderWidth: 1,
      borderOpacity: 0.3,
    });
    const initials = monogramInitials(identity.companyName);
    const w = widthOf(fonts.display700, initials, 18);
    drawRun(page, initials, MARGIN_X + (44 - w) / 2, slotTop - 29, fonts.display700, 18, {
      color: WHITE,
    });
  }

  // Identité émetteur à droite du logo.
  const idX = MARGIN_X + 44 + 12;
  let idY = 810;
  // #2 — un nom légal n'est JAMAIS tronqué en silence : au-delà de 2 lignes à 11 pt on réduit
  // d'un cran (9.5 pt) et on laisse le bloc grandir ; jamais de slice(0,2) qui amputerait
  // « …du Sud-Ouest Aquitain » de son dernier mot.
  const nameFull = wrapMeasured(identity.companyName, fonts.text700, 11, 170);
  const nameSize = nameFull.length > 2 ? 9.5 : 11;
  const nameLines =
    nameSize === 11 ? nameFull : wrapMeasured(identity.companyName, fonts.text700, 9.5, 170);
  for (const line of nameLines) {
    drawRun(page, line, idX, idY, fonts.text700, nameSize, { color: WHITE });
    idY -= nameSize + 2;
  }
  idY -= 1;
  for (const line of wrapMeasured(identity.companyAddress, fonts.text500, 8, 170).slice(0, 2)) {
    drawRun(page, line, idX, idY, fonts.text500, 8, { color: WHITE, opacity: 0.66 });
    idY -= 10;
  }
  if (identity.companyRcsOrRm) {
    drawRun(page, identity.companyRcsOrRm, idX, idY, fonts.text500, 8, {
      color: WHITE,
      opacity: 0.66,
    });
  }

  // Identité de la pièce, alignée droite : titre verbatim (UN SEUL drawText).
  drawRight(page, ctx.pieceTitle, RIGHT_X, 792, fonts.display800, 24, { color: WHITE });

  // Chips translucides (dates) — chaque string verbatim, un draw par chip.
  let chipX = RIGHT_X;
  const widths = chips.map((text) => chipWidth(fonts.text700, text));
  chipX = RIGHT_X - widths.reduce((sum, w) => sum + w, 0) - (chips.length - 1) * 6;
  chipX = Math.max(chipX, 300);
  for (const text of chips) {
    chipX +=
      drawChip(
        page,
        fonts.text700,
        { text, fill: WHITE, fillOpacity: 0.14, textColor: WHITE },
        chipX,
        776,
      ) + 6;
  }

  // Sous-titre situation B2 (string verrouillée) — un draw.
  if (subtitle) {
    drawRight(page, subtitle, RIGHT_X, 746, fonts.text600, 8.5, { color: WHITE, opacity: 0.85 });
  }
}

/* ── Carte méta flottante — LE geste Bob (floatingBalanceCard en print) ───── */

interface MetaParty {
  eyebrow: string;
  name: string;
  address: string;
  extra?: string | null;
}

/** Colonne mesurée d'une partie (émetteur/client) — le nom légal n'est jamais amputé. */
interface MetaCol {
  nameLines: string[];
  nameSize: number;
  nameLH: number;
  addrLines: string[];
  h: number;
}

/** Rangée de chips : soit des chips inline packées, soit UNE chip bloc (texte wrappé). */
type ChipRow =
  | { kind: 'inline'; items: string[]; h: number }
  | { kind: 'block'; lines: string[]; h: number };

const MAX_ADDR_LINES = 5;

function drawMetaCard(ctx: Ctx, emitter: MetaParty, client: MetaParty, chips: string[]): void {
  const { page, fonts, accent } = ctx;
  const colW = 236;

  const measureCol = (party: MetaParty): MetaCol => {
    // #2 — un nom légal n'est JAMAIS tronqué : au-delà de 2 lignes à 10.5 pt, on réduit d'un cran
    // (9 pt) et le bloc grandit ; jamais de slice(0,2). Le nom du client n'existe nulle part ailleurs.
    const nameFull = wrapMeasured(party.name, fonts.display700, 10.5, colW);
    const nameSize = nameFull.length > 2 ? 9 : 10.5;
    const nameLines =
      nameSize === 10.5 ? nameFull : wrapMeasured(party.name, fonts.display700, 9, colW);
    const nameLH = nameSize + 2.5;
    // #5 — l'adresse (donnée A7, JAMAIS un nom légal) est BORNÉE : au-delà de MAX_ADDR_LINES, la
    // dernière ligne est coupée avec « … ». La carte ne peut plus grandir sans fin (adresse
    // domaine-valide de plusieurs milliers de caractères → y négatif, contenu invisible).
    let addrLines = wrapMeasured(party.address, fonts.text500, 8.5, colW);
    if (party.extra) addrLines = [...addrLines, ...wrapMeasured(party.extra, fonts.text500, 8.5, colW)];
    if (addrLines.length > MAX_ADDR_LINES) {
      const kept = addrLines.slice(0, MAX_ADDR_LINES);
      kept[MAX_ADDR_LINES - 1] = ellipsizeToWidth(kept[MAX_ADDR_LINES - 1] ?? '', fonts.text500, 8.5, colW);
      addrLines = kept;
    }
    return {
      nameLines,
      nameSize,
      nameLH,
      addrLines,
      h: 26 + nameLines.length * nameLH + 4 + addrLines.length * 11,
    };
  };
  const left = measureCol(emitter);
  const right = measureCol(client);

  // #1/#5 — mise en page des chips : les chips étroites (dates, période) sont packées en rangées ;
  // une chip TROP LARGE (adresse de chantier, long bon de commande) bascule en chip BLOC (texte
  // wrappé DANS la pastille, sur sa propre rangée) — elle ne déborde plus jamais la carte/page.
  const chipRows: ChipRow[] = [];
  let inline: string[] = [];
  let inlineW = 0;
  const flushInline = (): void => {
    if (inline.length > 0) {
      chipRows.push({ kind: 'inline', items: inline, h: CHIP_H });
      inline = [];
      inlineW = 0;
    }
  };
  for (const text of chips) {
    const w = chipWidth(fonts.text700, text);
    if (w > CHIP_MAX_W) {
      flushInline();
      const lines = wrapMeasured(text, fonts.text700, CHIP_FONT_SIZE, CHIP_MAX_W - CHIP_PAD * 2);
      chipRows.push({ kind: 'block', lines, h: blockChipHeight(lines.length) });
    } else if (inlineW + w > CHIP_MAX_W) {
      flushInline();
      inline.push(text);
      inlineW = w + 6;
    } else {
      inline.push(text);
      inlineW += w + 6;
    }
  }
  flushInline();

  const rowGap = 6;
  const rowsTotalH = chipRows.reduce((sum, row) => sum + row.h + rowGap, 0);
  const chipsH = chipRows.length > 0 ? rowsTotalH - rowGap + 16 : 0; // 8 pt de marge haut/bas
  const h = Math.max(122, Math.max(left.h, right.h) + chipsH + 30);
  const top = 726; // mord de 20 pt dans le bandeau (706).

  shadowRect(page, MARGIN_X, top, CONTENT_W, h, 14);
  roundedRect(page, {
    x: MARGIN_X,
    top,
    w: CONTENT_W,
    h,
    r: 14,
    color: WHITE,
    borderColor: CARD_BORDER,
    borderWidth: 1,
  });

  const paintCol = (party: MetaParty, col: MetaCol, x: number): void => {
    drawTracked(page, party.eyebrow, x, top - 20, fonts.text700, 7, 0.8, { color: SLATE400 });
    let yy = top - 36;
    for (const line of col.nameLines) {
      drawRun(page, line, x, yy, fonts.display700, col.nameSize, { color: INK900 });
      yy -= col.nameLH;
    }
    yy -= 4;
    for (const line of col.addrLines) {
      drawRun(page, line, x, yy, fonts.text500, 8.5, { color: SLATE500 });
      yy -= 11;
    }
  };
  paintCol(emitter, left, 60);
  paintCol(client, right, 312);

  // Chips méta (A7 période/chantier, B8 bon de commande) — chips inline verbatim (un draw chacune),
  // chips bloc wrappées ; peintes de haut en bas dans la zone basse de la carte.
  const bottom = top - h;
  let cy = bottom + 8 + (rowsTotalH - rowGap); // top de la 1re rangée
  for (const row of chipRows) {
    if (row.kind === 'inline') {
      let x = 60;
      for (const text of row.items) {
        x += drawChip(page, fonts.text700, { text, fill: accent.tint07, textColor: accent.deep }, x, cy) + 6;
      }
    } else {
      drawBlockChip(page, fonts.text700, row.lines, 60, cy, CHIP_MAX_W, accent.tint07, accent.deep);
    }
    cy -= row.h + rowGap;
  }

  ctx.y = bottom - 20;
}

/* ── Tableau des lignes ───────────────────────────────────────────────────── */

const COL_DESIGNATION_X = 60;
const COL_DESIGNATION_W = 236;
const COL_QTY_R = 336;
const COL_PU_R = 404;
const COL_VAT_R = 450;
const COL_TOTAL_R = 535;

type PdfLine = InvoicePdfData['lines'][number];

function drawLinesTable(ctx: Ctx, lines: PdfLine[]): void {
  const { fonts, accent } = ctx;

  const paintHeader = (): void => {
    const top = ctx.y;
    roundedRect(ctx.page, {
      x: MARGIN_X,
      top,
      w: CONTENT_W,
      h: 22,
      r: { tl: 8, tr: 8, br: 0, bl: 0 },
      color: accent.deep,
    });
    const label = (text: string, xRight: number | null): void => {
      if (xRight === null) drawRun(ctx.page, text, COL_DESIGNATION_X, top - 15, fonts.text700, 7.5, { color: WHITE });
      else drawRight(ctx.page, text, xRight, top - 15, fonts.text700, 7.5, { color: WHITE });
    };
    label('DESIGNATION', null);
    label('QTE', COL_QTY_R);
    label('PU HT', COL_PU_R);
    label('TVA', COL_VAT_R);
    label('TOTAL HT', COL_TOTAL_R);
    ctx.y = top - 22;
  };

  ctx.tableHeaderPainter = paintHeader;
  paintHeader();

  lines.forEach((line, index) => {
    const desLines = wrapMeasured(line.label, fonts.text600, 9, COL_DESIGNATION_W);
    const pill = line.discount ? discountLabel(line.discount) : null;
    const rowH = Math.max(26, 8 + desLines.length * 11 + (pill ? 15 : 0) + 7);
    ensureSpace(ctx, rowH); // une ligne (avec sa pill) est INSÉCABLE entre pages
    const top = ctx.y;
    if (index % 2 === 1) {
      ctx.page.drawRectangle({
        x: MARGIN_X,
        y: top - rowH,
        width: CONTENT_W,
        height: rowH,
        color: accent.tint04,
      });
    }
    let textY = top - 16;
    for (const chunk of desLines) {
      drawRun(ctx.page, chunk, COL_DESIGNATION_X, textY, fonts.text600, 9, { color: INK800 });
      textY -= 11;
    }
    drawRight(
      ctx.page,
      `${line.qty}${line.unit ? ` ${line.unit}` : ''}`,
      COL_QTY_R,
      top - 16,
      fonts.text600,
      9,
      { color: INK800 },
    );
    drawAmountRight(ctx.page, money(line.unitPriceHT), COL_PU_R, top - 16, fonts.text600, 9, {
      color: INK800,
    });
    drawRight(ctx.page, `${line.vatRate} %`, COL_VAT_R, top - 16, fonts.text600, 9, { color: INK800 });
    // Clean Arch — le total de ligne (HT brut) est RÉSOLU PAR LE DOMAINE (computeLineBases) et
    // transporté par le port : l'adapter imprime, il ne (re)calcule aucun arrondi métier. Le repli
    // `qty × unitPriceHT` ne sert QUE les fixtures/adapters antérieurs au champ (compat ascendante).
    const lineTotalCents = line.lineTotalCents ?? Math.round(line.qty * line.unitPriceHT);
    drawAmountRight(ctx.page, money(lineTotalCents), COL_TOTAL_R, top - 16, fonts.text600, 9, {
      color: INK800,
    });
    if (pill) {
      // B3 — remise visible sous la désignation : pill tint12, string verbatim (un draw).
      const pillTop = textY + 8 - 3;
      const pillW = widthOf(fonts.text700, pill, 7.5) + 12;
      roundedRect(ctx.page, { x: COL_DESIGNATION_X, top: pillTop, w: pillW, h: 12, r: 6, color: accent.tint12 });
      drawRun(ctx.page, pill, COL_DESIGNATION_X + 6, pillTop - 9, fonts.text700, 7.5, {
        color: accent.deep,
      });
    }
    ctx.y = top - rowH;
  });

  ctx.tableHeaderPainter = null;
  // Clôture : le filet qui ferme la zébrure — la rigueur comptable.
  ctx.page.drawLine({
    start: { x: MARGIN_X, y: ctx.y },
    end: { x: RIGHT_X, y: ctx.y },
    thickness: 1,
    color: accent.hairline,
  });
  ctx.y -= 16;
}

/* ── Totaux : le chiffre en héros + cartes RIB/assurance ──────────────────── */

interface TotalsRow {
  label: string;
  value: string;
  kind: 'muted' | 'normal' | 'discount' | 'retenue';
}

interface SideCard {
  title: string;
  lines: { text: string; strong?: boolean; muted?: boolean }[];
}

interface TotalsBlock {
  rows: TotalsRow[];
  hero: { label: string; value: string };
  heroChip?: string | null;
  cards: SideCard[];
}

/**
 * 242 nonies A annexe II CGI — ventilation TVA : une rangée base + taxe PAR TAUX dès qu'il y a
 * ≥ 2 taux (« TVA 10 % (base 1 200,00 €) : 120,00 € »), la rangée agrégée sinon (compat : les
 * pièces mono-taux gardent « TVA : … » au centime). Les montants (base NETTE après remises,
 * taxe) sont RÉSOLUS PAR LE DOMAINE (computeTotals/computeLineBases) et transportés par le port —
 * l'adapter n'agrège rien, il formate.
 */
function vatRows(
  vatByRate: { rate: number; base: number; tax: number }[] | undefined,
  aggregateVat: number,
  credited: boolean,
): TotalsRow[] {
  if (vatByRate && vatByRate.length >= 2) {
    return vatByRate.map(({ rate, base, tax }) => ({
      label: credited
        ? `TVA ${rate} % creditee (base ${money(base)}) :`
        : `TVA ${rate} % (base ${money(base)}) :`,
      value: money(tax),
      kind: 'normal' as const,
    }));
  }
  return [
    { label: credited ? 'TVA creditee :' : 'TVA :', value: money(aggregateVat), kind: 'normal' },
  ];
}

function drawTotalsBlock(ctx: Ctx, block: TotalsBlock): void {
  const { fonts, accent } = ctx;
  const rowStep = 16;
  const cardH = (card: SideCard): number => 30 + card.lines.length * 12 + 10;
  const cardsH = block.cards.reduce((sum, card) => sum + cardH(card) + 10, 0);
  const rightH = block.rows.length * rowStep + 58 + (block.heroChip ? 24 : 0);
  const blockH = Math.max(cardsH, rightH);
  ensureSpace(ctx, blockH + 4); // bloc totaux entier INSÉCABLE
  const top = ctx.y;

  // Colonne gauche — cartes RIB / assurance décennale (chacune insécable).
  let cardTop = top;
  for (const card of block.cards) {
    const h = cardH(card);
    roundedRect(ctx.page, { x: MARGIN_X, top: cardTop, w: 256, h, r: 12, color: accent.tint07 });
    ctx.page.drawRectangle({
      x: MARGIN_X + 10,
      y: cardTop - h + 10,
      width: 3,
      height: h - 20,
      color: accent.base,
    });
    drawRun(ctx.page, card.title, MARGIN_X + 22, cardTop - 17, fonts.text700, 7.5, {
      color: accent.deep,
    });
    let lineY = cardTop - 31;
    for (const line of card.lines) {
      const font = line.strong ? fonts.text600 : fonts.text500;
      drawRun(ctx.page, line.text, MARGIN_X + 22, lineY, font, line.strong ? 8.5 : 8, {
        color: line.muted ? SLATE500 : INK800,
      });
      lineY -= 12;
    }
    cardTop -= h + 10;
  }

  // Colonne droite — rangées de totaux (labels verbatim, un draw chacun).
  let rowY = top - 12;
  for (const row of block.rows) {
    const labelColor =
      row.kind === 'muted' || row.kind === 'retenue' ? SLATE500 : INK800;
    const labelFont = row.kind === 'normal' ? fonts.text600 : fonts.text500;
    const valueColor =
      row.kind === 'discount' ? accent.deep : row.kind === 'retenue' ? SLATE500 : row.kind === 'muted' ? SLATE500 : INK800;
    drawRun(ctx.page, row.label, 315, rowY, labelFont, 8.5, { color: labelColor });
    drawAmountRight(ctx.page, row.value, RIGHT_X, rowY, fonts.text600, 9, { color: valueColor });
    rowY -= rowStep;
  }

  // Rangée héros : le seul aplat de cette force sur la page.
  const heroTop = rowY - 6 + rowStep - rowStep; // = rowY - 6
  shadowRect(ctx.page, 315, heroTop, 236, 40, 10);
  roundedRect(ctx.page, { x: 315, top: heroTop, w: 236, h: 40, r: 10, color: accent.base });
  drawRun(ctx.page, block.hero.label, 331, heroTop - 25, fonts.text700, 9, { color: WHITE });
  drawAmountRight(ctx.page, block.hero.value, COL_TOTAL_R, heroTop - 26, fonts.display800, 16, {
    color: WHITE,
  });
  let rightBottom = heroTop - 40;
  if (block.heroChip) {
    const w = chipWidth(fonts.text700, block.heroChip);
    drawChip(
      ctx.page,
      fonts.text700,
      { text: block.heroChip, fill: accent.tint12, textColor: accent.deep },
      RIGHT_X - w,
      rightBottom - 8,
    );
    rightBottom -= 8 + CHIP_H;
  }

  ctx.y = Math.min(cardTop, rightBottom) - 16;
}

/* ── Signature du devis — dignité du geste ────────────────────────────────── */

function drawQuoteSignature(ctx: Ctx, data: QuotePdfData): void {
  const { fonts } = ctx;
  const x = 311;
  const w = 240;

  if (data.signedBy) {
    const parsed = data.signatureSvg ? parseSignatureSvgDataUrl(data.signatureSvg) : null;
    const h = parsed ? 96 : 56;
    ensureSpace(ctx, h + 10);
    const top = ctx.y;
    roundedRect(ctx.page, {
      x,
      top,
      w,
      h,
      r: 12,
      color: SUCCESS_BG,
      borderColor: SUCCESS_BORDER,
      borderWidth: 1,
    });
    // Pastille + coche vectorielle (jamais un glyphe).
    const dotCy = top - 18;
    ctx.page.drawCircle({ x: x + 20, y: dotCy, size: 7, color: SUCCESS_INK });
    ctx.page.drawSvgPath('M 3.6 7.4 L 6.4 10.2 L 11.4 4.2', {
      x: x + 13,
      y: dotCy + 7,
      borderColor: WHITE,
      borderWidth: 1.6,
      borderLineCap: LineCapStyle.Round,
    });
    // « Signe par {nom} » : string verbatim, UN SEUL drawText ; la date est un run séparé.
    const label = `Signe par ${data.signedBy}`;
    drawRun(ctx.page, label, x + 34, top - 21, fonts.text700, 8.5, { color: SUCCESS_INK });
    if (data.signedAt) {
      const labelW = widthOf(fonts.text700, label, 8.5);
      drawRun(ctx.page, ` le ${frDate(data.signedAt)}`, x + 34 + labelW, top - 21, fonts.text500, 8.5, {
        color: SLATE500,
      });
    }
    if (parsed) {
      // Fenêtre blanche interne + tracé vectoriel à l'échelle — encre ink900 (jamais accent).
      const winTop = top - 34;
      roundedRect(ctx.page, {
        x: x + 16,
        top: winTop,
        w: 208,
        h: 40,
        r: 8,
        color: WHITE,
        borderColor: SUCCESS_WINDOW_BORDER,
        borderWidth: 1,
      });
      const scale = Math.min(196 / parsed.width, 32 / parsed.height);
      const drawnW = parsed.width * scale;
      const drawnH = parsed.height * scale;
      const originX = x + 16 + (208 - drawnW) / 2;
      const originTop = winTop - (40 - drawnH) / 2;
      for (const d of parsed.paths) {
        ctx.page.drawSvgPath(d, {
          x: originX,
          y: originTop,
          scale,
          borderColor: INK900,
          borderWidth: 1.6,
          borderLineCap: LineCapStyle.Round,
        });
      }
    }
    ctx.y = top - h - 12;
    return;
  }

  // Non signé : cadre de seing pointillé, digne et honnête.
  const h = 72;
  ensureSpace(ctx, h + 10);
  const top = ctx.y;
  roundedRect(ctx.page, {
    x,
    top,
    w,
    h,
    r: 12,
    borderColor: DASH_NEUTRAL,
    borderWidth: 1,
    borderDashArray: [3, 3],
  });
  drawTracked(ctx.page, 'SIGNATURE', x + 16, top - 18, fonts.text700, 7, 0.8, { color: SLATE400 });
  ctx.page.drawLine({
    start: { x: x + 16, y: top - 48 },
    end: { x: x + w - 16, y: top - 48 },
    thickness: 0.75,
    color: LINE,
  });
  drawRun(ctx.page, 'Date et signature du client', x + 16, top - 62, fonts.text500, 7.5, {
    color: SLATE400,
  });
  ctx.y = top - h - 12;
}

/* ── Mentions légales — la loi n'est pas de la déco (jamais d'accent) ─────── */

function drawMentions(ctx: Ctx, mentions: string[]): void {
  if (mentions.length === 0) return;
  const { fonts } = ctx;
  ensureSpace(ctx, 40);
  ctx.page.drawLine({
    start: { x: MARGIN_X, y: ctx.y },
    end: { x: RIGHT_X, y: ctx.y },
    thickness: 0.75,
    color: LINE,
  });
  drawRun(ctx.page, 'Mentions legales', MARGIN_X, ctx.y - 14, fonts.text700, 7.5, {
    color: SLATE500,
  });
  ctx.y -= 26;
  for (const mention of mentions) {
    // Chaque mention : verbatim, intégrale, sécable ENTRE mentions, jamais au milieu.
    const chunks = wrapMeasured(mention, fonts.text500, 6.8, CONTENT_W);
    const blockH = chunks.length * 9.6 + 3;
    ensureSpace(ctx, blockH);
    for (const chunk of chunks) {
      drawRun(ctx.page, chunk, MARGIN_X, ctx.y - 8, fonts.text500, 6.8, { color: SLATE500 });
      ctx.y -= 9.6;
    }
    ctx.y -= 3;
  }
}

/* ── Rétractation A3 : identité en tête, sobriété réglementaire au corps ──── */

function drawRetractationPages(ctx: Ctx, retractation: { noticeLines: string[]; formLines: string[] }): void {
  const { fonts } = ctx;

  // Page(s) d'avis — annexe R221-3 c. conso.
  ctx.tableHeaderPainter = null;
  newPage(ctx);
  const [noticeTitle, ...noticeBody] = retractation.noticeLines;
  if (noticeTitle) {
    drawRun(ctx.page, noticeTitle, MARGIN_X, ctx.y - 12, fonts.text700, 13, { color: INK900 });
    ctx.y -= 34;
  }
  for (const line of noticeBody) {
    // « Effets de rétractation » : intertitre du modèle réglementaire — égalité stricte sur la
    // string BRUTE, un seul drawText, jamais uppercasé.
    if (line === 'Effets de rétractation') {
      ensureSpace(ctx, 26);
      ctx.y -= 6;
      drawRun(ctx.page, line, MARGIN_X, ctx.y - 10, fonts.text700, 9.5, { color: INK900 });
      ctx.y -= 22;
      continue;
    }
    const chunks = wrapMeasured(line, fonts.text500, 8.5, CONTENT_W);
    for (const chunk of chunks) {
      ensureSpace(ctx, 14);
      drawRun(ctx.page, chunk, MARGIN_X, ctx.y - 9, fonts.text500, 8.5, { color: INK800 });
      ctx.y -= 12.5;
    }
    ctx.y -= 3;
  }

  // Page dédiée du FORMULAIRE détachable — annexe R221-1 (photocopiable proprement).
  newPage(ctx);
  ctx.page.drawLine({
    start: { x: 0, y: ctx.y - 4 },
    end: { x: PAGE_W, y: ctx.y - 4 },
    thickness: 1,
    color: CUT_LINE,
    dashArray: [4, 3],
  });
  drawTracked(ctx.page, 'FORMULAIRE DETACHABLE', MARGIN_X, ctx.y - 18, fonts.text700, 7, 0.8, {
    color: SLATE400,
  });
  ctx.y -= 30;

  const [formTitle, ...formBody] = retractation.formLines;
  const innerW = CONTENT_W - 32;
  // Mesure du bloc AVANT dessin (le cadre englobe tout le formulaire).
  let contentH = formTitle ? 26 : 8;
  const measured: { chunks: string[]; rule: boolean }[] = [];
  for (const line of formBody) {
    const chunks = wrapMeasured(line, fonts.text500, 8.5, innerW);
    const rule = /:\s*$/.test(line);
    measured.push({ chunks, rule });
    contentH += chunks.length * 12 + (rule ? 10 : 0) + 4;
  }
  const boxH = Math.min(contentH + 18, ctx.y - MIN_Y);
  const boxTop = ctx.y;
  roundedRect(ctx.page, {
    x: MARGIN_X,
    top: boxTop,
    w: CONTENT_W,
    h: boxH,
    r: 12,
    color: WHITE,
    borderColor: DASH_NEUTRAL,
    borderWidth: 1,
    borderDashArray: [3, 3],
  });
  let yy = boxTop - 22;
  // #8 — plancher de dessin : la boucle s'ARRÊTE proprement au bas du cadre (borné à la page par
  // boxH = min(contenu, ctx.y − MIN_Y)) au lieu de dessiner sous le cadre puis à y négatif. Les
  // formLines réglementaires (modèle R221-1) tiennent toujours ; le plancher est un fail-safe.
  const boxFloor = boxTop - boxH + 10;
  if (formTitle) {
    drawRun(ctx.page, formTitle, MARGIN_X + 16, yy, fonts.text700, 11, { color: INK900 });
    yy -= 22;
  }
  let stop = false;
  for (const { chunks, rule } of measured) {
    if (stop) break;
    for (const chunk of chunks) {
      if (yy < boxFloor) {
        stop = true;
        break;
      }
      drawRun(ctx.page, chunk, MARGIN_X + 16, yy, fonts.text500, 8.5, { color: INK800 });
      yy -= 12;
    }
    if (stop) break;
    if (rule) {
      // Ligne à compléter : filet neutre après les libellés se terminant par « : ».
      ctx.page.drawLine({
        start: { x: MARGIN_X + 16, y: yy + 2 },
        end: { x: MARGIN_X + CONTENT_W - 16, y: yy + 2 },
        thickness: 0.75,
        color: LINE,
      });
      yy -= 10;
    }
    yy -= 4;
  }
  ctx.y = boxTop - boxH - 12;
}

/* ── Renderer ─────────────────────────────────────────────────────────────── */

/**
 * Paquet XMP déclarant le fichier comme Factur-X (profil EN16931) — reconnaissance par les
 * plateformes e-invoicing. L'enveloppe PDF/A-3b est appliquée avant la sauvegarde par
 * `applyPdfA3bEnvelope` (polices embarquées, profil sRGB officiel, OutputIntent, trailer ID et
 * groupe de transparence par page) : aucun post-traitement ou binaire système n'est requis.
 */
function facturXXmp(): string {
  return `<?xpacket begin="" id="W5M0MpCehiHzreSzNTczkc9d"?>
<x:xmpmeta xmlns:x="adobe:ns:meta/">
 <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
  <rdf:Description rdf:about="" xmlns:pdfaid="http://www.aiim.org/pdfa/ns/id/">
   <pdfaid:part>3</pdfaid:part>
   <pdfaid:conformance>B</pdfaid:conformance>
  </rdf:Description>
  <rdf:Description rdf:about="" xmlns:fx="urn:factur-x:pdfa:CrossIndustryDocument:invoice:1p0#">
   <fx:DocumentType>INVOICE</fx:DocumentType>
   <fx:DocumentFileName>factur-x.xml</fx:DocumentFileName>
   <fx:Version>1.0</fx:Version>
   <fx:ConformanceLevel>EN 16931</fx:ConformanceLevel>
  </rdf:Description>
  <rdf:Description rdf:about="" xmlns:pdfaExtension="http://www.aiim.org/pdfa/ns/extension/" xmlns:pdfaSchema="http://www.aiim.org/pdfa/ns/schema#" xmlns:pdfaProperty="http://www.aiim.org/pdfa/ns/property#">
   <pdfaExtension:schemas>
    <rdf:Bag>
     <rdf:li rdf:parseType="Resource">
      <pdfaSchema:schema>Factur-X PDFA Extension Schema</pdfaSchema:schema>
      <pdfaSchema:namespaceURI>urn:factur-x:pdfa:CrossIndustryDocument:invoice:1p0#</pdfaSchema:namespaceURI>
      <pdfaSchema:prefix>fx</pdfaSchema:prefix>
      <pdfaSchema:property>
       <rdf:Seq>
        <rdf:li rdf:parseType="Resource"><pdfaProperty:name>DocumentFileName</pdfaProperty:name><pdfaProperty:valueType>Text</pdfaProperty:valueType><pdfaProperty:category>external</pdfaProperty:category><pdfaProperty:description>Name of the embedded XML invoice file</pdfaProperty:description></rdf:li>
        <rdf:li rdf:parseType="Resource"><pdfaProperty:name>DocumentType</pdfaProperty:name><pdfaProperty:valueType>Text</pdfaProperty:valueType><pdfaProperty:category>external</pdfaProperty:category><pdfaProperty:description>INVOICE</pdfaProperty:description></rdf:li>
        <rdf:li rdf:parseType="Resource"><pdfaProperty:name>Version</pdfaProperty:name><pdfaProperty:valueType>Text</pdfaProperty:valueType><pdfaProperty:category>external</pdfaProperty:category><pdfaProperty:description>The actual version of the Factur-X data</pdfaProperty:description></rdf:li>
        <rdf:li rdf:parseType="Resource"><pdfaProperty:name>ConformanceLevel</pdfaProperty:name><pdfaProperty:valueType>Text</pdfaProperty:valueType><pdfaProperty:category>external</pdfaProperty:category><pdfaProperty:description>The conformance level of the Factur-X data</pdfaProperty:description></rdf:li>
       </rdf:Seq>
      </pdfaSchema:property>
     </rdf:li>
    </rdf:Bag>
   </pdfaExtension:schemas>
  </rdf:Description>
 </rdf:RDF>
</x:xmpmeta>
<?xpacket end="w"?>`;
}

async function embedLogo(
  doc: PDFDocument,
  logoBytes: Uint8Array | null | undefined,
): Promise<{ image: PDFImage; width: number; height: number } | null> {
  if (!logoBytes || logoBytes.length === 0) return null;
  const kind = sniffImageKind(logoBytes);
  if (kind === null) return null; // fail-safe : le monogramme prend le relais, jamais un trou
  try {
    const image = kind === 'png' ? await doc.embedPng(logoBytes) : await doc.embedJpg(logoBytes);
    return { image, width: image.width, height: image.height };
  } catch {
    return null;
  }
}

export class PdfRenderer implements PdfRendererPort {
  async renderInvoice(data: InvoicePdfData, facturX?: { xml: string }): Promise<Uint8Array> {
    const doc = await PDFDocument.create();
    const fonts = await embedFonts(doc);
    const accent = accentRoles(data.billingPresentation.accentColor);
    const logo = await embedLogo(doc, data.logoBytes);

    // A5 — une pièce rectificative s'intitule « Avoir », jamais « Facture » : le titre suit
    // data.kind (le domaine ne fabrique que des avoirs TOTAUX, Invoice.creditNoteFor).
    const isCreditNote = data.kind === 'credit_note';
    const pieceLabel = isCreditNote
      ? 'Avoir'
      : data.kind === 'deposit'
        ? 'Facture d’acompte'
        : 'Facture';
    const pieceTitle = `${pieceLabel} ${data.number}`;

    const ctx: Ctx = {
      doc,
      fonts,
      accent,
      page: doc.addPage([PAGE_W, PAGE_H]),
      y: PAGE_H,
      pieceTitle,
      companyName: data.companyName,
      tableHeaderPainter: null,
    };

    const chips: string[] = [];
    if (data.issuedAt) chips.push(`Emise le ${data.issuedAt}`);
    // A5 — pas d'« échéance » sur un avoir : rien n'est dû par le client sur cette pièce.
    if (data.dueAt && !isCreditNote) chips.push(`Echeance : ${data.dueAt}`);
    // B2 — situation de travaux : sous-titre « Situation n°N — avancement X % » (l'avancement
    // n'est imprimé que s'il a pu être dérivé du devis parent — jamais inventé).
    const subtitle = data.situation
      ? data.situation.advancementPct === null
        ? `Situation n°${data.situation.order}`
        : `Situation n°${data.situation.order} — avancement ${data.situation.advancementPct} % du marché`
      : null;

    drawHeroHeader(
      ctx,
      {
        companyName: data.companyName,
        companyAddress: data.companyAddress,
        companyRcsOrRm: data.companyRcsOrRm,
      },
      chips,
      subtitle,
      logo,
    );

    // Chips méta de la carte flottante — A7 (période, chantier) + B8 (bon de commande).
    const metaChips: string[] = [];
    if (data.servicePeriod) {
      metaChips.push(
        data.servicePeriod.end === null
          ? `Prestation realisee le ${data.servicePeriod.start}`
          : `Prestation du ${data.servicePeriod.start} au ${data.servicePeriod.end}`,
      );
    }
    if (data.deliveryAddress) {
      metaChips.push(`Adresse de chantier / livraison : ${data.deliveryAddress}`);
    }
    if (data.purchaseOrder) {
      const receivedAt = data.purchaseOrder.receivedAt
        ? ` du ${data.purchaseOrder.receivedAt.slice(0, 10)}`
        : '';
      metaChips.push(`Bon de commande n° ${data.purchaseOrder.number}${receivedAt}`);
    }

    drawMetaCard(
      ctx,
      {
        eyebrow: 'EMETTEUR',
        name: data.companyName,
        address: data.companyAddress,
        extra: data.companyRcsOrRm,
      },
      { eyebrow: 'CLIENT', name: data.customerName, address: data.customerAddress },
      metaChips,
    );

    if (isCreditNote && data.creditNoteSource) {
      // A5 — référence OBLIGATOIRE à la facture initiale sur la pièce rectificative
      // (art. 242 nonies A, I de l'annexe II au CGI) ; c'est aussi la condition de récupération
      // de la TVA par l'émetteur (art. 272, 1 du CGI). L'avoir du domaine étant total, la
      // formulation est « annule totalement » — jamais « remplace » : rien n'est réémis.
      // Banneau AMBRE (langage « rectification » de l'app) — string verbatim, un seul draw.
      ensureSpace(ctx, 36);
      const top = ctx.y;
      roundedRect(ctx.page, {
        x: MARGIN_X,
        top,
        w: CONTENT_W,
        h: 24,
        r: 10,
        color: AMBER_BG,
        borderColor: AMBER_BORDER,
        borderWidth: 1,
      });
      drawRun(
        ctx.page,
        `Annule totalement la facture n° ${data.creditNoteSource.number} du ${data.creditNoteSource.issuedAt}`,
        60,
        top - 16,
        fonts.text600,
        8.5,
        { color: AMBER_INK },
      );
      ctx.y = top - 24 - 14;
    }

    drawLinesTable(ctx, data.lines);

    // B3 — récapitulatif des remises quand elles existent : HT brut, total remisé, HT net —
    // le total HT imprimé reste le NET (assiette réelle de la TVA), jamais réécrit.
    const hasDiscountRecap =
      data.totals.grossHt !== undefined && data.totals.discountCents !== undefined;
    const rows: TotalsRow[] = [];
    if (hasDiscountRecap && !isCreditNote) {
      rows.push({ label: 'Total HT brut :', value: money(data.totals.grossHt!), kind: 'muted' });
      rows.push({
        label: 'Rabais, remises et ristournes :',
        value: `-${money(data.totals.discountCents!)}`,
        kind: 'discount',
      });
    }
    let hero: TotalsBlock['hero'];
    if (isCreditNote) {
      // A5 — formulation CRÉDITRICE : le domaine fige des montants POSITIFS (miroir exact de la
      // facture annulée, Invoice.creditNoteFor) ; le PDF les présente comme un crédit au client,
      // jamais comme un « net à payer » — lisibilité juridique de la pièce rectificative.
      rows.push({ label: 'Total HT credite :', value: money(data.totals.ht), kind: 'normal' });
      rows.push(...vatRows(data.totals.vatByRate, data.totals.vat, true));
      rows.push({ label: 'Total TTC credite :', value: money(data.totals.ttc), kind: 'normal' });
      hero = { label: 'Net a crediter au client', value: money(data.totals.netToPay) };
    } else {
      rows.push({
        label: `Total HT${hasDiscountRecap ? ' net' : ''} :`,
        value: money(data.totals.ht),
        kind: 'normal',
      });
      rows.push(...vatRows(data.totals.vatByRate, data.totals.vat, false));
      rows.push({ label: 'Total TTC :', value: money(data.totals.ttc), kind: 'normal' });
      // 242 nonies A — RÉCONCILIATION : ce qui a déjà été facturé sur le marché (situations puis
      // acompte) est DÉDUIT avant le net à payer, chacun sur sa rangée. situationDeductionCents
      // (part des situations) ≤ depositDeductionCents (total déjà facturé) : la part acompte est le
      // reste. Mécanique neutre — label ET valeur en gris, jamais d'accent.
      const alreadyBilled = data.totals.depositDeductionCents ?? 0;
      if (alreadyBilled > 0) {
        const situationPart = data.totals.situationDeductionCents ?? 0;
        const depositPart = alreadyBilled - situationPart;
        if (situationPart > 0)
          rows.push({
            label: 'Situations deja facturees (deduit) :',
            value: `-${money(situationPart)}`,
            kind: 'retenue',
          });
        if (depositPart > 0)
          rows.push({
            label: 'Acompte deja facture (deduit) :',
            value: `-${money(depositPart)}`,
            kind: 'retenue',
          });
      }
      // B5 — ligne DÉDIÉE de la retenue de garantie (loi 71-584) : déduite du net à payer,
      // jamais de la TVA ; mécanique légale — label ET valeur en neutre, jamais d'accent.
      if (data.totals.retenueGarantieCents !== undefined) {
        const pct = data.retenueGarantiePct != null ? ` (${data.retenueGarantiePct} %)` : '';
        rows.push({
          label: `Retenue de garantie${pct} :`,
          value: `-${money(data.totals.retenueGarantieCents)}`,
          kind: 'retenue',
        });
      }
      hero = { label: 'Net a payer', value: money(data.totals.netToPay) };
    }

    const cards: SideCard[] = [];
    if (data.billingPresentation.rib) {
      cards.push({
        title: 'Coordonnees de paiement',
        lines: [
          { text: `IBAN : ${groupIban(data.billingPresentation.rib.iban)}`, strong: true },
          ...(data.billingPresentation.rib.bic
            ? [{ text: `BIC : ${data.billingPresentation.rib.bic}` }]
            : []),
        ],
      });
    }
    if (data.billingPresentation.insurance) {
      const insurance = data.billingPresentation.insurance;
      cards.push({
        title: 'Assurance professionnelle',
        lines: [
          { text: `${insurance.insurer} - police ${insurance.policyNo}`, strong: true },
          ...wrapMeasured(insurance.coverage, fonts.text500, 8, 220).map((text) => ({ text })),
          { text: `Valable jusqu'au ${insurance.expiresAt}`, muted: true },
        ],
      });
    }

    drawTotalsBlock(ctx, { rows, hero, cards });
    drawMentions(ctx, data.mentions);
    stampFooters(ctx);

    if (facturX) {
      // Pièce jointe associée : le profil EN16931 impose la relation Alternative
      // (Data est réservé aux profils MINIMUM/BASIC-WL).
      const xmlBytes = new TextEncoder().encode(facturX.xml);
      const now = new Date();
      await doc.attach(xmlBytes, 'factur-x.xml', {
        mimeType: 'application/xml',
        description: 'Facture electronique Factur-X (CII)',
        afRelationship: AFRelationship.Alternative,
        creationDate: now,
        modificationDate: now,
      });
      const metaStream = doc.context.stream(facturXXmp(), { Type: 'Metadata', Subtype: 'XML' });
      doc.catalog.set(PDFName.of('Metadata'), doc.context.register(metaStream));
      applyPdfA3bEnvelope(doc, {
        facturXXml: facturX.xml,
        title: pieceTitle,
        createdAt: now,
      });
    }

    return doc.save();
  }

  /** Devis — même signature visuelle que la facture, SANS RIB/assurance/Factur-X (pas une pièce
   *  comptable probante). L'accent tenant arrive par `data.accentColor` (mêmes billing settings
   *  que la facture) ; absent → navy (compat adapters existants). Le devis signé est servi depuis
   *  l'archive A8 : un changement de couleur ne re-rend JAMAIS un contrat. */
  async renderQuote(data: QuotePdfData): Promise<Uint8Array> {
    const doc = await PDFDocument.create();
    const fonts = await embedFonts(doc);
    const accent = accentRoles(data.accentColor ?? 'navy');
    const logo = await embedLogo(doc, data.logoBytes);
    const pieceTitle = `Devis ${data.number}`;

    const ctx: Ctx = {
      doc,
      fonts,
      accent,
      page: doc.addPage([PAGE_W, PAGE_H]),
      y: PAGE_H,
      pieceTitle,
      companyName: data.companyName,
      tableHeaderPainter: null,
    };

    const chips: string[] = [];
    if (data.validUntil) chips.push(`Valable jusqu'au ${data.validUntil}`);

    drawHeroHeader(
      ctx,
      {
        companyName: data.companyName,
        companyAddress: data.companyAddress,
        companyRcsOrRm: data.companyRcsOrRm,
      },
      chips,
      null,
      logo,
    );

    drawMetaCard(
      ctx,
      {
        eyebrow: 'EMETTEUR',
        name: data.companyName,
        address: data.companyAddress,
        extra: data.companyRcsOrRm,
      },
      { eyebrow: 'CLIENT', name: data.customerName, address: data.customerAddress },
      [],
    );

    drawLinesTable(ctx, data.lines);

    // B3 — récapitulatif des remises quand elles existent (HT brut, total remisé, HT net).
    const quoteHasDiscountRecap =
      data.totals.grossHt !== undefined && data.totals.discountCents !== undefined;
    const rows: TotalsRow[] = [];
    if (quoteHasDiscountRecap) {
      rows.push({ label: 'Total HT brut :', value: money(data.totals.grossHt!), kind: 'muted' });
      rows.push({
        label: 'Rabais, remises et ristournes :',
        value: `-${money(data.totals.discountCents!)}`,
        kind: 'discount',
      });
    }
    rows.push({
      label: `Total HT${quoteHasDiscountRecap ? ' net' : ''} :`,
      value: money(data.totals.ht),
      kind: 'normal',
    });
    rows.push(...vatRows(data.totals.vatByRate, data.totals.vat, false));

    drawTotalsBlock(ctx, {
      rows,
      hero: { label: 'Total TTC', value: money(data.totals.ttc) },
      heroChip:
        data.depositPct !== null
          ? `Acompte a la signature (${data.depositPct} %) : ${money(data.totals.netToPay)}`
          : null,
      cards: [],
    });

    drawQuoteSignature(ctx, data);

    // A1 — bloc mentions légales du devis : MÊME pattern que la facture (buildMentions 'quote').
    drawMentions(ctx, data.mentions);

    // A3 — devis B2C : avis d'information rétractation (annexe R221-3) + FORMULAIRE DÉTACHABLE
    // (annexe R221-1) sur pages dédiées. Textes réglementaires servis par l'appelant
    // (@bob/core retractation.ts), jamais réécrits ici.
    if (data.retractation) {
      drawRetractationPages(ctx, data.retractation);
    }

    stampFooters(ctx);
    return doc.save();
  }
}
