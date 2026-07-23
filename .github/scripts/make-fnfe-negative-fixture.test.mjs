import assert from 'node:assert/strict';
import test from 'node:test';
import { addInvalidSellerGlobalId } from './make-fnfe-negative-fixture.mjs';

const invoice = `<rsm:CrossIndustryInvoice>
  <ram:SellerTradeParty>
    <ram:Name>Bob Artisan</ram:Name>
  </ram:SellerTradeParty>
</rsm:CrossIndustryInvoice>`;

test('insère le GlobalID invalide avant Name pour préserver l’ordre XSD', () => {
  const output = addInvalidSellerGlobalId(invoice);
  assert.match(output, /<ram:SellerTradeParty>[\s\S]*<ram:GlobalID schemeID="0002">12345678<\/ram:GlobalID>[\s\S]*<ram:Name>/u);
});

test('refuse une source ambiguë ou déjà munie de GlobalID', () => {
  assert.throws(() => addInvalidSellerGlobalId('<x/>'), /SellerTradeParty absent/u);
  assert.throws(() => addInvalidSellerGlobalId(invoice.replace(
    '<ram:Name>',
    '<ram:GlobalID schemeID="0002">123456789</ram:GlobalID><ram:Name>',
  )), /déjà GlobalID/u);
});
