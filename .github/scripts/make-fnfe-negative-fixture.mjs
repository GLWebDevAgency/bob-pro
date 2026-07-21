import { readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export function addInvalidSellerGlobalId(xml) {
  const start = xml.indexOf('<ram:SellerTradeParty>');
  const end = xml.indexOf('</ram:SellerTradeParty>', start);
  if (start < 0 || end < 0) {
    throw new Error('SellerTradeParty absent : fixture négative impossible à construire.');
  }
  const seller = xml.slice(start, end);
  if (/<ram:GlobalID\b/u.test(seller)) {
    throw new Error('SellerTradeParty contient déjà GlobalID : refus de masquer la fixture source.');
  }
  const name = xml.indexOf('<ram:Name>', start);
  if (name < 0 || name >= end) {
    throw new Error('SellerTradeParty/Name absent : point d’insertion XSD introuvable.');
  }
  return `${xml.slice(0, name)}<ram:GlobalID schemeID="0002">12345678</ram:GlobalID>\n        ${xml.slice(name)}`;
}

function main() {
  const [, , sourcePath, destinationPath] = process.argv;
  if (!sourcePath || !destinationPath) {
    throw new Error(
      'Usage: node make-fnfe-negative-fixture.mjs <source.xml> <destination.xml>',
    );
  }
  const fixture = addInvalidSellerGlobalId(readFileSync(sourcePath, 'utf8'));
  writeFileSync(destinationPath, fixture, 'utf8');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
