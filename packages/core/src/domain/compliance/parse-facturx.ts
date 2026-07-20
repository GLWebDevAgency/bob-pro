import {
  FACTURX_BASIC_PROFILE,
  type FacturXInvoiceData,
  type FacturXLine,
  type FacturXParty,
  type FacturXVatBreakdown,
  type VatCategory,
} from './facturx';
import { ok, err, type DomainResult } from '../../shared-kernel/result';

/**
 * parse-facturx — INVERSE exact de `buildFacturXBasicXml` (facturx.ts).
 *
 * Lit un XML CII / Factur-X profil BASIC (EN 16931) et reconstruit la
 * `FacturXInvoiceData` telle que, repassée dans `buildFacturXBasicXml`, elle
 * redonne le même document. Module PUR (aucune dépendance infra) : exporté par
 * l'index depuis C-EXP6b — il alimente le contrôle de réception e-facture
 * (importFacturXExpense) et la décision AFNOR entrante (einvoice-inbound).
 *
 * STRATÉGIE DE PARSING — descente récursive maison (zéro dépendance).
 * @bob/core est un package de domaine pur, sans parseur XML embarqué
 * (pas de DOMParser Node, pas de fast-xml-parser/xmldom). Plutôt qu'un
 * enchaînement de regex fragiles (le document comporte des balises homonymes
 * — `ram:Name` en ligne et en partie, `ram:ApplicableTradeTax` en ligne et en
 * en-tête — que des regex non ancrées confondraient), on construit un petit
 * arbre XML générique puis on navigue par chemin de balises. C'est robuste aux
 * espaces / retours de ligne, à l'ordre des éléments et aux balises optionnelles,
 * et cela reste entièrement typé (zéro `any`).
 *
 * Toute erreur (XML malformé, balise obligatoire absente, profil non BASIC,
 * montant non numérique, date invalide) → `err` typé, JAMAIS un objet à moitié
 * rempli ni un throw non capturé. Le seul code disponible dans `DomainError` du
 * repo est `VALIDATION` ; on le rend explicite via `field` (jeton BT/BG ou
 * `xml`/`profile`) et un `message` humain.
 *
 * LIMITE ASSUMÉE (documentée) : les préfixes de namespace sont traités
 * littéralement (`rsm:` / `ram:` / `udt:`, tels qu'émis par le générateur). La
 * résolution par URI de namespace (préfixes alternatifs) et les profils
 * supérieurs (EN 16931, EXTENDED) relèvent de v2 — hors périmètre C-EXP6a.
 */

// ——————————————————————————————————————————————————————————————
// Mini-arbre XML (descente récursive maison)
// ——————————————————————————————————————————————————————————————

interface XmlNode {
  readonly name: string;
  readonly attrs: Record<string, string>;
  readonly children: XmlNode[];
  text: string; // texte direct concaténé, déjà déséchappé
}

/** Erreur de bas niveau : XML syntaxiquement invalide. */
class XmlSyntaxError extends Error {}

/** Erreur métier : élément/valeur attendu absent ou invalide, porte un jeton BT/BG. */
class FieldError extends Error {
  constructor(
    public readonly field: string,
    message: string,
  ) {
    super(message);
  }
}

/** Déséchappe les entités XML. `&amp;` traité EN DERNIER (inverse exact de xmlEscape). */
function unescapeXml(s: string): string {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_m, d: string) => String.fromCodePoint(Number(d)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_m, h: string) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&amp;/g, '&');
}

function parseAttrs(raw: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  const re = /([\w:.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(raw)) !== null) {
    const key = m[1];
    const value = m[2] ?? m[3] ?? '';
    if (key !== undefined) attrs[key] = unescapeXml(value);
  }
  return attrs;
}

/**
 * Construit l'arbre d'un document XML bien formé. Ignore prologue, commentaires,
 * DOCTYPE ; gère les sections CDATA et les balises auto-fermantes. Lève
 * `XmlSyntaxError` si les balises ne sont pas équilibrées ou le document tronqué.
 */
function parseXmlTree(input: string): XmlNode {
  const root: XmlNode = { name: '#document', attrs: {}, children: [], text: '' };
  const stack: XmlNode[] = [root];
  const top = (): XmlNode => {
    const node = stack[stack.length - 1];
    if (node === undefined) throw new XmlSyntaxError('pile de balises vide');
    return node;
  };

  let pos = 0;
  const len = input.length;
  while (pos < len) {
    const lt = input.indexOf('<', pos);
    if (lt === -1) break; // reste = texte final (ignoré s'il n'est que blancs)

    if (lt > pos) {
      const chunk = input.slice(pos, lt);
      if (chunk.trim().length > 0) top().text += unescapeXml(chunk);
    }

    if (input.startsWith('<?', lt)) {
      const end = input.indexOf('?>', lt + 2);
      if (end === -1) throw new XmlSyntaxError('instruction de traitement non terminée');
      pos = end + 2;
      continue;
    }
    if (input.startsWith('<!--', lt)) {
      const end = input.indexOf('-->', lt + 4);
      if (end === -1) throw new XmlSyntaxError('commentaire non terminé');
      pos = end + 3;
      continue;
    }
    if (input.startsWith('<![CDATA[', lt)) {
      const end = input.indexOf(']]>', lt + 9);
      if (end === -1) throw new XmlSyntaxError('section CDATA non terminée');
      top().text += input.slice(lt + 9, end);
      pos = end + 3;
      continue;
    }
    if (input.startsWith('<!', lt)) {
      const end = input.indexOf('>', lt + 2);
      if (end === -1) throw new XmlSyntaxError('déclaration non terminée');
      pos = end + 1;
      continue;
    }

    const gt = input.indexOf('>', lt + 1);
    if (gt === -1) throw new XmlSyntaxError('balise non terminée');
    const inner = input.slice(lt + 1, gt);
    pos = gt + 1;

    if (inner.startsWith('/')) {
      const name = inner.slice(1).trim();
      const current = top();
      if (current.name !== name) {
        throw new XmlSyntaxError(`balise fermante inattendue </${name}> (ouverte : ${current.name})`);
      }
      stack.pop();
      continue;
    }

    const selfClosing = inner.endsWith('/');
    const body = (selfClosing ? inner.slice(0, -1) : inner).trim();
    const nameMatch = /^([\w:.-]+)([\s\S]*)$/.exec(body);
    if (nameMatch === null || nameMatch[1] === undefined) {
      throw new XmlSyntaxError(`nom de balise invalide : "${body}"`);
    }
    const node: XmlNode = {
      name: nameMatch[1],
      attrs: parseAttrs(nameMatch[2] ?? ''),
      children: [],
      text: '',
    };
    top().children.push(node);
    if (!selfClosing) stack.push(node);
  }

  if (stack.length !== 1) throw new XmlSyntaxError('balises non équilibrées (document tronqué)');
  const documentElement = root.children[0];
  if (documentElement === undefined || root.children.length !== 1) {
    throw new XmlSyntaxError('document sans élément racine unique');
  }
  return documentElement;
}

// ——————————————————————————————————————————————————————————————
// Navigation par chemin
// ——————————————————————————————————————————————————————————————

const childrenNamed = (node: XmlNode, name: string): XmlNode[] => node.children.filter((c) => c.name === name);

/** Descend le long d'un chemin de balises (première occurrence à chaque niveau). */
function descend(node: XmlNode, path: readonly string[]): XmlNode | undefined {
  let current: XmlNode | undefined = node;
  for (const segment of path) {
    if (current === undefined) return undefined;
    current = current.children.find((c) => c.name === segment);
  }
  return current;
}

function requireNode(node: XmlNode, path: readonly string[], field: string): XmlNode {
  const found = descend(node, path);
  if (found === undefined) throw new FieldError(field, `élément obligatoire absent : ${path.join(' > ')}`);
  return found;
}

function requireText(node: XmlNode, path: readonly string[], field: string): string {
  const value = requireNode(node, path, field).text.trim();
  if (value.length === 0) throw new FieldError(field, `valeur obligatoire vide : ${path.join(' > ')}`);
  return value;
}

function optionalText(node: XmlNode, path: readonly string[]): string | undefined {
  const found = descend(node, path);
  if (found === undefined) return undefined;
  const value = found.text.trim();
  return value.length === 0 ? undefined : value;
}

// ——————————————————————————————————————————————————————————————
// Conversions typées (inverses de eur / pct / qtyStr / dateCII)
// ——————————————————————————————————————————————————————————————

const NUMERIC = /^-?\d+(?:\.\d+)?$/;

/** "180.00" -> 18000. Inverse de `eur` (arrondi au centime, robuste au flottant). */
function toCents(raw: string, field: string): number {
  const s = raw.trim();
  if (!NUMERIC.test(s)) throw new FieldError(field, `montant non numérique : "${raw}"`);
  const cents = Math.round(Number(s) * 100);
  if (!Number.isFinite(cents)) throw new FieldError(field, `montant hors limites : "${raw}"`);
  return cents;
}

/** "20.00" -> 20, "1.5" -> 1.5. Inverse de `pct` / `qtyStr`. */
function toDecimal(raw: string, field: string): number {
  const s = raw.trim();
  if (!NUMERIC.test(s)) throw new FieldError(field, `nombre non numérique : "${raw}"`);
  return Number(s);
}

/** Lit un `udt:DateTimeString` format 102 (AAAAMMJJ) -> "AAAA-MM-JJ". Inverse de `dateCII`. */
function toIsoDate(dateTimeParent: XmlNode, field: string): string {
  const dt = descend(dateTimeParent, ['udt:DateTimeString']);
  if (dt === undefined) throw new FieldError(field, 'udt:DateTimeString absent');
  const format = dt.attrs['format'];
  if (format !== undefined && format !== '102') throw new FieldError(field, `format de date non géré : ${format}`);
  const raw = dt.text.trim();
  if (!/^\d{8}$/.test(raw)) throw new FieldError(field, `date format 102 invalide : "${raw}"`);
  const year = raw.slice(0, 4);
  const month = raw.slice(4, 6);
  const day = raw.slice(6, 8);
  const iso = `${year}-${month}-${day}`;
  const parsed = new Date(`${iso}T00:00:00Z`);
  const valid =
    !Number.isNaN(parsed.getTime()) &&
    parsed.getUTCFullYear() === Number(year) &&
    parsed.getUTCMonth() + 1 === Number(month) &&
    parsed.getUTCDate() === Number(day);
  if (!valid) throw new FieldError(field, `date invalide : "${raw}"`);
  return iso;
}

function toVatCategory(raw: string, field: string): VatCategory {
  if (raw === 'S' || raw === 'E' || raw === 'Z' || raw === 'AE') return raw;
  throw new FieldError(field, `catégorie de TVA non gérée : "${raw}" (attendu S/E/Z/AE)`);
}

// ——————————————————————————————————————————————————————————————
// Mapping CII -> FacturXInvoiceData
// ——————————————————————————————————————————————————————————————

function parseParty(party: XmlNode, field: string): FacturXParty {
  const address = requireNode(party, ['ram:PostalTradeAddress'], `${field}.address`);
  const legalId = optionalText(party, ['ram:SpecifiedLegalOrganization', 'ram:ID']); // BT-30 (schemeID 0002)
  const vatId = optionalText(party, ['ram:SpecifiedTaxRegistration', 'ram:ID']); // BT-31 (schemeID VA)
  return {
    name: requireText(party, ['ram:Name'], `${field}.name`),
    ...(legalId !== undefined ? { legalId } : {}),
    ...(vatId !== undefined ? { vatId } : {}),
    address: {
      line1: requireText(address, ['ram:LineOne'], `${field}.address.line1`),
      postcode: requireText(address, ['ram:PostcodeCode'], `${field}.address.postcode`),
      city: requireText(address, ['ram:CityName'], `${field}.address.city`),
      countryCode: requireText(address, ['ram:CountryID'], `${field}.address.countryCode`),
    },
  };
}

function parseLine(item: XmlNode, position: number): FacturXLine {
  const f = `BG-25[${position}]`;
  const quantity = requireNode(item, ['ram:SpecifiedLineTradeDelivery', 'ram:BilledQuantity'], `${f}.qty`);
  const unitCode = quantity.attrs['unitCode'];
  if (unitCode === undefined || unitCode.length === 0) {
    throw new FieldError(`${f}.unitCode`, 'attribut unitCode absent sur ram:BilledQuantity');
  }
  const settlement = requireNode(item, ['ram:SpecifiedLineTradeSettlement'], `${f}.settlement`);
  const tax = requireNode(settlement, ['ram:ApplicableTradeTax'], `${f}.tax`);
  return {
    id: requireText(item, ['ram:AssociatedDocumentLineDocument', 'ram:LineID'], `${f}.id`),
    name: requireText(item, ['ram:SpecifiedTradeProduct', 'ram:Name'], `${f}.name`),
    qty: toDecimal(quantity.text.trim(), `${f}.qty`),
    unitCode,
    unitPriceHTCents: toCents(
      requireText(item, ['ram:SpecifiedLineTradeAgreement', 'ram:NetPriceProductTradePrice', 'ram:ChargeAmount'], `${f}.unitPrice`),
      `${f}.unitPrice`,
    ),
    netAmountCents: toCents(
      requireText(settlement, ['ram:SpecifiedTradeSettlementLineMonetarySummation', 'ram:LineTotalAmount'], `${f}.netAmount`),
      `${f}.netAmount`,
    ),
    vatCategory: toVatCategory(requireText(tax, ['ram:CategoryCode'], `${f}.vatCategory`), `${f}.vatCategory`),
    vatRatePct: toDecimal(requireText(tax, ['ram:RateApplicablePercent'], `${f}.vatRatePct`), `${f}.vatRatePct`),
  };
}

function parseVatBreakdown(tax: XmlNode, position: number): FacturXVatBreakdown {
  const f = `BG-23[${position}]`;
  const exemptionReason = optionalText(tax, ['ram:ExemptionReason']);
  return {
    category: toVatCategory(requireText(tax, ['ram:CategoryCode'], `${f}.category`), `${f}.category`),
    ratePct: toDecimal(requireText(tax, ['ram:RateApplicablePercent'], `${f}.ratePct`), `${f}.ratePct`),
    basisCents: toCents(requireText(tax, ['ram:BasisAmount'], `${f}.basis`), `${f}.basis`),
    vatCents: toCents(requireText(tax, ['ram:CalculatedAmount'], `${f}.vat`), `${f}.vat`),
    ...(exemptionReason !== undefined ? { exemptionReason } : {}),
  };
}

function mapInvoice(root: XmlNode): FacturXInvoiceData {
  // Profil : BASIC uniquement (BT-24).
  const profile = optionalText(root, [
    'rsm:ExchangedDocumentContext',
    'ram:GuidelineSpecifiedDocumentContextParameter',
    'ram:ID',
  ]);
  if (profile !== FACTURX_BASIC_PROFILE) {
    throw new FieldError('profile', `profil non géré (BASIC attendu) : ${profile ?? '(absent)'}`);
  }

  // En-tête du document.
  const doc = requireNode(root, ['rsm:ExchangedDocument'], 'ExchangedDocument');
  const number = requireText(doc, ['ram:ID'], 'BT-1');
  const typeCode = requireText(doc, ['ram:TypeCode'], 'BT-3');
  const issueDate = toIsoDate(requireNode(doc, ['ram:IssueDateTime'], 'BT-2'), 'BT-2');

  const tx = requireNode(root, ['rsm:SupplyChainTradeTransaction'], 'SupplyChainTradeTransaction');

  // Lignes (BG-25).
  const lineNodes = childrenNamed(tx, 'ram:IncludedSupplyChainTradeLineItem');
  if (lineNodes.length === 0) throw new FieldError('BG-25', 'aucune ligne de facture');
  const lines = lineNodes.map((n, i) => parseLine(n, i + 1));

  // Vendeur (BG-4) / acheteur (BG-7).
  const agreement = requireNode(tx, ['ram:ApplicableHeaderTradeAgreement'], 'BG-4/BG-7');
  const buyerReference = optionalText(agreement, ['ram:BuyerReference']); // BT-10
  const seller = parseParty(requireNode(agreement, ['ram:SellerTradeParty'], 'BG-4'), 'BG-4');
  const buyer = parseParty(requireNode(agreement, ['ram:BuyerTradeParty'], 'BG-7'), 'BG-7');

  // Règlement.
  const settlement = requireNode(tx, ['ram:ApplicableHeaderTradeSettlement'], 'settlement');
  const currency = requireText(settlement, ['ram:InvoiceCurrencyCode'], 'BT-5');

  const vatNodes = childrenNamed(settlement, 'ram:ApplicableTradeTax');
  if (vatNodes.length === 0) throw new FieldError('BG-23', 'aucune ventilation de TVA');
  const vatBreakdown = vatNodes.map((n, i) => parseVatBreakdown(n, i + 1));

  const dueDateParent = descend(settlement, ['ram:SpecifiedTradePaymentTerms', 'ram:DueDateDateTime']);
  const dueDate = dueDateParent !== undefined ? toIsoDate(dueDateParent, 'BT-9') : undefined;

  // Totaux (BG-22).
  const sum = requireNode(settlement, ['ram:SpecifiedTradeSettlementHeaderMonetarySummation'], 'BG-22');
  const prepaidText = optionalText(sum, ['ram:TotalPrepaidAmount']); // BT-113 (omis par le générateur si 0)

  return {
    number,
    typeCode,
    issueDate,
    ...(dueDate !== undefined ? { dueDate } : {}),
    currency,
    ...(buyerReference !== undefined ? { buyerReference } : {}),
    seller,
    buyer,
    lines,
    vatBreakdown,
    lineTotalHTCents: toCents(requireText(sum, ['ram:LineTotalAmount'], 'BT-106'), 'BT-106'),
    taxBasisTotalCents: toCents(requireText(sum, ['ram:TaxBasisTotalAmount'], 'BT-109'), 'BT-109'),
    taxTotalCents: toCents(requireText(sum, ['ram:TaxTotalAmount'], 'BT-110'), 'BT-110'),
    grandTotalCents: toCents(requireText(sum, ['ram:GrandTotalAmount'], 'BT-112'), 'BT-112'),
    prepaidCents: prepaidText !== undefined ? toCents(prepaidText, 'BT-113') : 0,
    duePayableCents: toCents(requireText(sum, ['ram:DuePayableAmount'], 'BT-115'), 'BT-115'),
  };
}

/**
 * Parse un XML CII / Factur-X profil BASIC en `FacturXInvoiceData`.
 * Renvoie `err({ code: 'VALIDATION', field, message })` en cas d'échec (XML
 * vide/malformé, profil non BASIC, balise obligatoire absente, montant/date
 * invalide). Jamais de throw non capturé, jamais d'objet partiel.
 */
export function parseFacturXBasic(xml: string): DomainResult<FacturXInvoiceData> {
  if (typeof xml !== 'string' || xml.trim().length === 0) {
    return err({ code: 'VALIDATION', field: 'xml', message: 'XML vide' });
  }
  try {
    const root = parseXmlTree(xml);
    if (root.name !== 'rsm:CrossIndustryInvoice') {
      return err({
        code: 'VALIDATION',
        field: 'profile',
        message: `racine attendue rsm:CrossIndustryInvoice, obtenu ${root.name}`,
      });
    }
    return ok(mapInvoice(root));
  } catch (e) {
    if (e instanceof FieldError) return err({ code: 'VALIDATION', field: e.field, message: e.message });
    if (e instanceof XmlSyntaxError) return err({ code: 'VALIDATION', field: 'xml', message: `XML malformé : ${e.message}` });
    const message = e instanceof Error ? e.message : String(e);
    return err({ code: 'VALIDATION', field: 'xml', message: `échec de parsing : ${message}` });
  }
}
