import {
  FACTURX_BASIC_PROFILE,
  FACTURX_EN16931_PROFILE,
  type FacturXInvoiceData,
  type FacturXBillingMode,
  type FacturXLine,
  type FacturXParty,
  type FacturXVatBreakdown,
  type VatCategory,
} from './facturx';
import { ok, err, type DomainResult } from '../../shared-kernel/result';
import { isFrenchBillingMode } from './french-billing-mode';

/**
 * parse-facturx — lecture sûre des profils Factur-X EN16931 et BASIC historique.
 *
 * Lit un XML CII / Factur-X profil EN16931 (émissions courantes) ou BASIC
 * (imports historiques) et reconstruit la
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
 * Toute erreur (XML malformé, balise obligatoire absente, profil non supporté,
 * montant non numérique, date invalide) → `err` typé, JAMAIS un objet à moitié
 * rempli ni un throw non capturé. Le seul code disponible dans `DomainError` du
 * repo est `VALIDATION` ; on le rend explicite via `field` (jeton BT/BG ou
 * `xml`/`profile`) et un `message` humain.
 *
 * Les noms sont résolus par URI de namespace (expanded names), jamais par le préfixe
 * choisi par l'émetteur. Les contextes `xmlns` sont hérités selon XML Namespaces :
 * `rsm`/`ram`/`udt`/`qdt`, des alias ou un namespace par défaut sont donc équivalents.
 * Toute DTD/déclaration d'entité est refusée : ce parseur n'effectue aucune résolution
 * externe et n'accepte que les cinq entités XML prédéfinies et les références numériques.
 */

// ——————————————————————————————————————————————————————————————
// Mini-arbre XML (descente récursive maison)
// ——————————————————————————————————————————————————————————————

interface XmlNode {
  /** QName original, conservé uniquement pour contrôler la fermeture syntaxique. */
  readonly name: string;
  /** Nom développé `{namespaceUri}localName`, utilisé pour toute navigation métier. */
  readonly localName: string;
  readonly namespaceUri: string | null;
  readonly attrs: Record<string, string>;
  readonly children: XmlNode[];
  text: string; // texte direct concaténé, déjà déséchappé
}

type NamespaceContext = Readonly<Record<string, string>>;

interface OpenXmlNode {
  readonly node: XmlNode;
  readonly namespaces: NamespaceContext;
}

const XML_NAMESPACE_URI = 'http://www.w3.org/XML/1998/namespace';
const CII_NAMESPACE_URI = 'urn:un:unece:uncefact:data:standard:CrossIndustryInvoice:100';
const RAM_NAMESPACE_URI =
  'urn:un:unece:uncefact:data:standard:ReusableAggregateBusinessInformationEntity:100';
const UDT_NAMESPACE_URI = 'urn:un:unece:uncefact:data:standard:UnqualifiedDataType:100';
const QDT_NAMESPACE_URI = 'urn:un:unece:uncefact:data:standard:QualifiedDataType:100';

const CANONICAL_NAMESPACE_URIS: Readonly<Record<string, string>> = {
  rsm: CII_NAMESPACE_URI,
  ram: RAM_NAMESPACE_URI,
  udt: UDT_NAMESPACE_URI,
  qdt: QDT_NAMESPACE_URI,
};

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

/**
 * Déséchappe uniquement les entités XML intrinsèques. Une entité nommée inconnue ne
 * peut exister qu'avec une DTD, interdite ici : on la refuse au lieu de la laisser traverser.
 */
function unescapeXml(s: string): string {
  let output = '';
  let cursor = 0;
  const entity = /&([^;\s<&]+);/g;
  let match: RegExpExecArray | null;
  while ((match = entity.exec(s)) !== null) {
    const before = s.slice(cursor, match.index);
    if (before.includes('&')) throw new XmlSyntaxError('référence d’entité XML malformée');
    output += before;
    const token = match[1];
    if (token === undefined) throw new XmlSyntaxError('entité XML vide');
    if (token === 'lt') output += '<';
    else if (token === 'gt') output += '>';
    else if (token === 'quot') output += '"';
    else if (token === 'apos') output += "'";
    else if (token === 'amp') output += '&';
    else {
      const decimal = /^#(\d+)$/.exec(token);
      const hexadecimal = /^#x([0-9a-fA-F]+)$/.exec(token);
      const codePoint =
        decimal?.[1] !== undefined
          ? Number(decimal[1])
          : hexadecimal?.[1] !== undefined
            ? Number.parseInt(hexadecimal[1], 16)
            : null;
      if (
        codePoint === null ||
        !Number.isSafeInteger(codePoint) ||
        codePoint < 0 ||
        codePoint > 0x10ffff ||
        (codePoint >= 0xd800 && codePoint <= 0xdfff)
      ) {
        throw new XmlSyntaxError(`entité XML non autorisée : &${token};`);
      }
      output += String.fromCodePoint(codePoint);
    }
    cursor = match.index + match[0].length;
  }
  const tail = s.slice(cursor);
  if (tail.includes('&')) throw new XmlSyntaxError('référence d’entité XML malformée');
  return output + tail;
}

function parseAttrs(raw: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  const re = /\s+([\w:.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/gy;
  let cursor = 0;
  let m: RegExpExecArray | null;
  while (cursor < raw.length) {
    re.lastIndex = cursor;
    m = re.exec(raw);
    if (m === null) {
      if (raw.slice(cursor).trim().length === 0) break;
      throw new XmlSyntaxError(`attribut XML invalide : "${raw.slice(cursor).trim()}"`);
    }
    const key = m[1];
    const value = m[2] ?? m[3] ?? '';
    if (key === undefined) throw new XmlSyntaxError('nom d’attribut XML absent');
    if (Object.prototype.hasOwnProperty.call(attrs, key)) {
      throw new XmlSyntaxError(`attribut XML dupliqué : ${key}`);
    }
    attrs[key] = unescapeXml(value);
    cursor = re.lastIndex;
  }
  return attrs;
}

function splitQualifiedName(name: string): { prefix: string; localName: string } {
  const parts = name.split(':');
  if (parts.length > 2 || parts.some((part) => part.length === 0)) {
    throw new XmlSyntaxError(`nom XML qualifié invalide : ${name}`);
  }
  return parts.length === 2
    ? { prefix: parts[0]!, localName: parts[1]! }
    : { prefix: '', localName: parts[0]! };
}

function namespacesForElement(parent: NamespaceContext, attrs: Readonly<Record<string, string>>): NamespaceContext {
  const namespaces: Record<string, string> = { ...parent };
  for (const [name, uri] of Object.entries(attrs)) {
    if (name === 'xmlns') {
      if (uri.length === 0) delete namespaces[''];
      else namespaces[''] = uri;
      continue;
    }
    if (!name.startsWith('xmlns:')) continue;
    const prefix = name.slice('xmlns:'.length);
    if (!prefix || prefix === 'xmlns' || uri.length === 0) {
      throw new XmlSyntaxError(`déclaration de namespace invalide : ${name}`);
    }
    if (prefix === 'xml' && uri !== XML_NAMESPACE_URI) {
      throw new XmlSyntaxError('le préfixe xml ne peut pas être redéfini');
    }
    namespaces[prefix] = uri;
  }
  return namespaces;
}

function expandedElementName(
  qualifiedName: string,
  namespaces: NamespaceContext,
): { localName: string; namespaceUri: string | null } {
  const { prefix, localName } = splitQualifiedName(qualifiedName);
  if (prefix === 'xmlns') throw new XmlSyntaxError('le préfixe xmlns est réservé');
  if (prefix === 'xml') return { localName, namespaceUri: XML_NAMESPACE_URI };
  const namespaceUri = namespaces[prefix];
  if (prefix.length > 0 && namespaceUri === undefined) {
    throw new XmlSyntaxError(`préfixe de namespace non déclaré : ${prefix}`);
  }
  return { localName, namespaceUri: namespaceUri ?? null };
}

/** Trouve `>` hors guillemets afin qu'un attribut contenant ce caractère reste valide. */
function findTagEnd(input: string, from: number): number {
  let quote: '"' | "'" | null = null;
  for (let index = from; index < input.length; index += 1) {
    const char = input[index];
    if (quote !== null) {
      if (char === quote) quote = null;
      continue;
    }
    if (char === '"' || char === "'") quote = char;
    else if (char === '>') return index;
  }
  return -1;
}

/**
 * Construit l'arbre d'un document XML bien formé. Ignore prologue et commentaires,
 * refuse DTD/ENTITY, gère les sections CDATA et les balises auto-fermantes. Lève
 * `XmlSyntaxError` si les balises ne sont pas équilibrées ou le document tronqué.
 */
function parseXmlTree(input: string): XmlNode {
  const root: XmlNode = {
    name: '#document',
    localName: '#document',
    namespaceUri: null,
    attrs: {},
    children: [],
    text: '',
  };
  const stack: OpenXmlNode[] = [
    { node: root, namespaces: { xml: XML_NAMESPACE_URI } },
  ];
  const top = (): OpenXmlNode => {
    const opened = stack[stack.length - 1];
    if (opened === undefined) throw new XmlSyntaxError('pile de balises vide');
    return opened;
  };

  let pos = 0;
  const len = input.length;
  while (pos < len) {
    const lt = input.indexOf('<', pos);
    if (lt === -1) break; // reste = texte final (ignoré s'il n'est que blancs)

    if (lt > pos) {
      const chunk = input.slice(pos, lt);
      if (chunk.trim().length > 0) top().node.text += unescapeXml(chunk);
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
      top().node.text += input.slice(lt + 9, end);
      pos = end + 3;
      continue;
    }
    if (/^<!DOCTYPE(?:\s|>|\[)/i.test(input.slice(lt))) {
      throw new XmlSyntaxError('DOCTYPE interdit (aucune DTD ni entité externe autorisée)');
    }
    if (/^<!ENTITY(?:\s|>)/i.test(input.slice(lt))) {
      throw new XmlSyntaxError('déclaration ENTITY interdite');
    }
    if (input.startsWith('<!', lt)) {
      throw new XmlSyntaxError('déclaration XML interdite');
    }

    const gt = findTagEnd(input, lt + 1);
    if (gt === -1) throw new XmlSyntaxError('balise non terminée');
    const inner = input.slice(lt + 1, gt);
    pos = gt + 1;

    if (inner.startsWith('/')) {
      const name = inner.slice(1).trim();
      const current = top().node;
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
    const qualifiedName = nameMatch[1];
    const attrs = parseAttrs(nameMatch[2] ?? '');
    const namespaces = namespacesForElement(top().namespaces, attrs);
    const expandedName = expandedElementName(qualifiedName, namespaces);
    const node: XmlNode = {
      name: qualifiedName,
      localName: expandedName.localName,
      namespaceUri: expandedName.namespaceUri,
      attrs,
      children: [],
      text: '',
    };
    top().node.children.push(node);
    if (!selfClosing) stack.push({ node, namespaces });
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

function canonicalExpandedName(name: string): { localName: string; namespaceUri: string | null } {
  const { prefix, localName } = splitQualifiedName(name);
  if (prefix.length === 0) return { localName, namespaceUri: null };
  const namespaceUri = CANONICAL_NAMESPACE_URIS[prefix];
  if (namespaceUri === undefined) throw new XmlSyntaxError(`préfixe canonique inconnu : ${prefix}`);
  return { localName, namespaceUri };
}

function hasExpandedName(node: XmlNode, expected: string): boolean {
  const expanded = canonicalExpandedName(expected);
  return node.localName === expanded.localName && node.namespaceUri === expanded.namespaceUri;
}

const childrenNamed = (node: XmlNode, name: string): XmlNode[] =>
  node.children.filter((child) => hasExpandedName(child, name));

/** Descend le long d'un chemin de balises (première occurrence à chaque niveau). */
function descend(node: XmlNode, path: readonly string[]): XmlNode | undefined {
  let current: XmlNode | undefined = node;
  for (const segment of path) {
    if (current === undefined) return undefined;
    current = current.children.find((child) => hasExpandedName(child, segment));
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
function toIsoDate(
  dateTimeParent: XmlNode,
  field: string,
  dateTimeTag: 'udt:DateTimeString' | 'qdt:DateTimeString' = 'udt:DateTimeString',
): string {
  const dt = descend(dateTimeParent, [dateTimeTag]);
  if (dt === undefined) throw new FieldError(field, `${dateTimeTag} absent`);
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
  if (raw === 'S' || raw === 'E' || raw === 'Z' || raw === 'AE' || raw === 'O') return raw;
  throw new FieldError(field, `catégorie de TVA non gérée : "${raw}" (attendu S/E/Z/AE/O)`);
}

function toBillingMode(raw: string): FacturXBillingMode {
  if (isFrenchBillingMode(raw)) return raw;
  throw new FieldError('BT-23', `mode de facturation France non géré : "${raw}"`);
}

// ——————————————————————————————————————————————————————————————
// Mapping CII -> FacturXInvoiceData
// ——————————————————————————————————————————————————————————————

function parseParty(party: XmlNode, field: string): FacturXParty {
  const address = requireNode(party, ['ram:PostalTradeAddress'], `${field}.address`);
  const legalId = optionalText(party, ['ram:SpecifiedLegalOrganization', 'ram:ID']); // BT-30 (schemeID 0002)
  const taxRegistrations = childrenNamed(party, 'ram:SpecifiedTaxRegistration');
  let vatId: string | undefined;
  let fiscalId: string | undefined;
  for (const registration of taxRegistrations) {
    const id = descend(registration, ['ram:ID']);
    if (id === undefined || id.text.trim().length === 0) continue;
    const scheme = id.attrs['schemeID'];
    if (scheme === 'VA') vatId = id.text.trim();
    else if (scheme === 'FC') fiscalId = id.text.trim();
  }
  const endpoint = descend(party, ['ram:URIUniversalCommunication', 'ram:URIID']);
  let electronicAddress: FacturXParty['electronicAddress'];
  if (endpoint !== undefined) {
    const value = endpoint.text.trim();
    const schemeId = endpoint.attrs['schemeID'];
    if (!value) throw new FieldError(`${field}.electronicAddress`, 'endpoint électronique vide');
    if (schemeId !== '0225' && schemeId !== 'EM') {
      throw new FieldError(
        `${field}.electronicAddress.schemeId`,
        `scheme endpoint non géré : ${schemeId ?? '(absent)'}`,
      );
    }
    electronicAddress = { schemeId, value };
  }
  return {
    name: requireText(party, ['ram:Name'], `${field}.name`),
    ...(legalId !== undefined ? { legalId } : {}),
    ...(vatId !== undefined ? { vatId } : {}),
    ...(fiscalId !== undefined ? { fiscalId } : {}),
    ...(electronicAddress !== undefined ? { electronicAddress } : {}),
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
  const allowances = childrenNamed(settlement, 'ram:SpecifiedTradeAllowanceCharge');
  if (allowances.length > 1) {
    throw new FieldError(`${f}.allowance`, 'plusieurs remises de ligne non gérées');
  }
  let allowanceCents: number | undefined;
  const allowance = allowances[0];
  if (allowance !== undefined) {
    const indicator = requireText(allowance, ['ram:ChargeIndicator', 'udt:Indicator'], `${f}.allowance.charge`);
    if (indicator !== 'false') {
      throw new FieldError(`${f}.allowance.charge`, 'une charge ne peut pas être interprétée comme une remise');
    }
    allowanceCents = toCents(
      requireText(allowance, ['ram:ActualAmount'], `${f}.allowance.amount`),
      `${f}.allowance.amount`,
    );
    if (allowanceCents <= 0) {
      throw new FieldError(`${f}.allowance.amount`, 'une remise émise doit être strictement positive');
    }
  }
  const vatCategory = toVatCategory(
    requireText(tax, ['ram:CategoryCode'], `${f}.vatCategory`),
    `${f}.vatCategory`,
  );
  const vatRateText = optionalText(tax, ['ram:RateApplicablePercent']);
  if (vatCategory !== 'O' && vatRateText === undefined) {
    throw new FieldError(`${f}.vatRatePct`, 'taux de TVA obligatoire hors catégorie O');
  }
  if (vatCategory === 'O' && vatRateText !== undefined) {
    throw new FieldError(`${f}.vatRatePct`, 'la catégorie O ne doit pas contenir de taux de TVA');
  }
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
    ...(allowanceCents !== undefined ? { allowanceCents } : {}),
    vatCategory,
    ...(vatRateText !== undefined ? { vatRatePct: toDecimal(vatRateText, `${f}.vatRatePct`) } : {}),
  };
}

function parseVatBreakdown(tax: XmlNode, position: number): FacturXVatBreakdown {
  const f = `BG-23[${position}]`;
  const exemptionReason = optionalText(tax, ['ram:ExemptionReason']);
  const exemptionReasonCode = optionalText(tax, ['ram:ExemptionReasonCode']);
  const category = toVatCategory(
    requireText(tax, ['ram:CategoryCode'], `${f}.category`),
    `${f}.category`,
  );
  const rateText = optionalText(tax, ['ram:RateApplicablePercent']);
  if (category !== 'O' && rateText === undefined) {
    throw new FieldError(`${f}.ratePct`, 'taux de TVA obligatoire hors catégorie O');
  }
  if (category === 'O' && rateText !== undefined) {
    throw new FieldError(`${f}.ratePct`, 'la catégorie O ne doit pas contenir de taux de TVA');
  }
  return {
    category,
    ...(rateText !== undefined ? { ratePct: toDecimal(rateText, `${f}.ratePct`) } : {}),
    basisCents: toCents(requireText(tax, ['ram:BasisAmount'], `${f}.basis`), `${f}.basis`),
    vatCents: toCents(requireText(tax, ['ram:CalculatedAmount'], `${f}.vat`), `${f}.vat`),
    ...(exemptionReason !== undefined ? { exemptionReason } : {}),
    ...(exemptionReasonCode !== undefined ? { exemptionReasonCode } : {}),
  };
}

function mapInvoice(root: XmlNode): FacturXInvoiceData {
  // BT-24 : EN16931 pour les émissions actuelles ; BASIC reste accepté en lecture seule afin
  // de ne pas rendre illisibles les pièces historiques déjà archivées ou reçues.
  const profile = optionalText(root, [
    'rsm:ExchangedDocumentContext',
    'ram:GuidelineSpecifiedDocumentContextParameter',
    'ram:ID',
  ]);
  if (profile !== FACTURX_EN16931_PROFILE && profile !== FACTURX_BASIC_PROFILE) {
    throw new FieldError(
      'profile',
      `profil non géré (EN16931 ou BASIC historique attendu) : ${profile ?? '(absent)'}`,
    );
  }
  const billingModeText = optionalText(root, [
    'rsm:ExchangedDocumentContext',
    'ram:BusinessProcessSpecifiedDocumentContextParameter',
    'ram:ID',
  ]);
  const billingMode = billingModeText === undefined ? undefined : toBillingMode(billingModeText);

  // En-tête du document.
  const doc = requireNode(root, ['rsm:ExchangedDocument'], 'ExchangedDocument');
  const number = requireText(doc, ['ram:ID'], 'BT-1');
  const typeCode = requireText(doc, ['ram:TypeCode'], 'BT-3');
  const issueDate = toIsoDate(requireNode(doc, ['ram:IssueDateTime'], 'BT-2'), 'BT-2');
  const noteNodes = childrenNamed(doc, 'ram:IncludedNote');
  const notes = noteNodes.map((note, index) => ({
    content: requireText(note, ['ram:Content'], `BG-1[${index + 1}].content`),
    subject: requireText(note, ['ram:SubjectCode'], `BG-1[${index + 1}].subject`),
  }));

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
  const purchaseOrderReference = optionalText(agreement, [
    'ram:BuyerOrderReferencedDocument',
    'ram:IssuerAssignedID',
  ]);

  // Livraison et période. ShipTo n'existe que si une adresse distincte réelle a été saisie.
  // BT-72 est toujours présent dans les émissions Bob : date de fin/jour de prestation, ou
  // date de pièce quand le domaine stipule qu'elle est la date d'opération.
  const delivery = descend(tx, ['ram:ApplicableHeaderTradeDelivery']);
  const shipTo = delivery === undefined ? undefined : descend(delivery, ['ram:ShipToTradeParty', 'ram:PostalTradeAddress']);
  const shipToLine = shipTo === undefined ? undefined : optionalText(shipTo, ['ram:LineOne']);
  const deliveryAddress =
    shipToLine !== undefined && shipToLine !== buyer.address.line1 ? shipToLine : undefined;
  const actualDelivery =
    delivery === undefined
      ? undefined
      : descend(delivery, ['ram:ActualDeliverySupplyChainEvent', 'ram:OccurrenceDateTime']);

  // Règlement.
  const settlement = requireNode(tx, ['ram:ApplicableHeaderTradeSettlement'], 'settlement');
  const currency = requireText(settlement, ['ram:InvoiceCurrencyCode'], 'BT-5');

  const vatNodes = childrenNamed(settlement, 'ram:ApplicableTradeTax');
  if (vatNodes.length === 0) throw new FieldError('BG-23', 'aucune ventilation de TVA');
  const vatBreakdown = vatNodes.map((n, i) => parseVatBreakdown(n, i + 1));

  const precedingInvoiceReferences = childrenNamed(settlement, 'ram:InvoiceReferencedDocument')
    .map((node, index) => ({
      number: requireText(node, ['ram:IssuerAssignedID'], `BG-3[${index + 1}].BT-25`),
      ...(descend(node, ['ram:FormattedIssueDateTime']) !== undefined
        ? {
            issueDate: toIsoDate(
              requireNode(node, ['ram:FormattedIssueDateTime'], `BG-3[${index + 1}].BT-26`),
              `BG-3[${index + 1}].BT-26`,
              'qdt:DateTimeString',
            ),
          }
        : {}),
    }));

  const dueDateParent = descend(settlement, ['ram:SpecifiedTradePaymentTerms', 'ram:DueDateDateTime']);
  const dueDate = dueDateParent !== undefined ? toIsoDate(dueDateParent, 'BT-9') : undefined;
  const billingPeriod = descend(settlement, ['ram:BillingSpecifiedPeriod']);
  const actualDeliveryDate = actualDelivery !== undefined ? toIsoDate(actualDelivery, 'BT-72') : undefined;
  const servicePeriod =
    billingPeriod !== undefined
      ? {
          start: toIsoDate(requireNode(billingPeriod, ['ram:StartDateTime'], 'BT-73'), 'BT-73'),
          end: toIsoDate(requireNode(billingPeriod, ['ram:EndDateTime'], 'BT-74'), 'BT-74'),
        }
      : actualDeliveryDate !== undefined && actualDeliveryDate !== issueDate
        ? { start: actualDeliveryDate, end: null }
        : undefined;

  // Totaux (BG-22).
  const sum = requireNode(settlement, ['ram:SpecifiedTradeSettlementHeaderMonetarySummation'], 'BG-22');
  const prepaidText = optionalText(sum, ['ram:TotalPrepaidAmount']); // BT-113 (omis par le générateur si 0)

  return {
    number,
    typeCode,
    issueDate,
    ...(dueDate !== undefined ? { dueDate } : {}),
    currency,
    ...(billingMode !== undefined ? { billingMode } : {}),
    ...(notes.length > 0 ? { notes } : {}),
    ...(buyerReference !== undefined ? { buyerReference } : {}),
    ...(purchaseOrderReference !== undefined ? { purchaseOrderReference } : {}),
    ...(precedingInvoiceReferences.length === 1
      ? { precedingInvoiceReference: precedingInvoiceReferences[0]! }
      : precedingInvoiceReferences.length > 1
        ? { precedingInvoiceReferences }
        : {}),
    ...(servicePeriod !== undefined ? { servicePeriod } : {}),
    ...(deliveryAddress !== undefined ? { deliveryAddress } : {}),
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
 * Parse un XML CII / Factur-X EN16931 ou BASIC historique en `FacturXInvoiceData`.
 * Renvoie `err({ code: 'VALIDATION', field, message })` en cas d'échec (XML
 * vide/malformé, profil non supporté, balise obligatoire absente, montant/date
 * invalide). Jamais de throw non capturé, jamais d'objet partiel.
 */
export function parseFacturXBasic(xml: string): DomainResult<FacturXInvoiceData> {
  if (typeof xml !== 'string' || xml.trim().length === 0) {
    return err({ code: 'VALIDATION', field: 'xml', message: 'XML vide' });
  }
  try {
    const root = parseXmlTree(xml);
    if (!hasExpandedName(root, 'rsm:CrossIndustryInvoice')) {
      return err({
        code: 'VALIDATION',
        field: 'profile',
        message: `racine attendue {${CII_NAMESPACE_URI}}CrossIndustryInvoice, obtenu {${root.namespaceUri ?? ''}}${root.localName}`,
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
