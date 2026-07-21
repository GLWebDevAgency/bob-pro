import assert from 'node:assert/strict';
import test from 'node:test';
import { assertMustangReport } from './assert-mustang-report.mjs';

const xmlReport = `<?xml version="1.0"?>
<validation filename="factur-x.xml">
  <xml><info><profile>urn:cen.eu:en16931:2017</profile><validator version="2.24.0"/><rules><fired>99</fired><failed>0</failed></rules></info><summary status="valid"/></xml>
  <summary status="valid"/>
</validation>`;

const pdfReport = `<?xml version="1.0"?>
<validation filename="facture-x.pdf">
  <pdf>ValidationResult [flavour=3b, isCompliant=true]<summary status="valid"/></pdf>
  <xml><info><profile>urn:cen.eu:en16931:2017</profile><validator version="2.24.0"/><rules><fired>99</fired><failed>0</failed></rules></info><summary status="valid"/></xml>
  <summary status="valid"/>
</validation>`;

test('accepte uniquement les rapports XML et PDF/A-3b intégralement valides', () => {
  assert.doesNotThrow(() => assertMustangReport(xmlReport, {
    expectedVersion: '2.24.0',
    kind: 'xml',
  }));
  assert.doesNotThrow(() => assertMustangReport(pdfReport, {
    expectedVersion: '2.24.0',
    kind: 'pdf',
  }));
});

test('refuse rapport tronqué, version dérivée, règle échouée et PDF non conforme', () => {
  assert.throws(() => assertMustangReport('<validation>', {
    expectedVersion: '2.24.0', kind: 'xml',
  }));
  assert.throws(() => assertMustangReport(xmlReport, {
    expectedVersion: '2.24.1', kind: 'xml',
  }));
  assert.throws(() => assertMustangReport(xmlReport.replace('<failed>0</failed>', '<failed>1</failed>'), {
    expectedVersion: '2.24.0', kind: 'xml',
  }));
  assert.throws(() => assertMustangReport(pdfReport.replace('isCompliant=true', 'isCompliant=false'), {
    expectedVersion: '2.24.0', kind: 'pdf',
  }));
  assert.throws(() => assertMustangReport(xmlReport.replace(
    'urn:cen.eu:en16931:2017',
    'urn:cen.eu:en16931:2017#compliant#urn:factur-x.eu:1p0:basic',
  ), {
    expectedVersion: '2.24.0', kind: 'xml',
  }));
  assert.throws(() => assertMustangReport(xmlReport.replace('<fired>99</fired>', '<fired>0</fired>'), {
    expectedVersion: '2.24.0', kind: 'xml',
  }));
});
