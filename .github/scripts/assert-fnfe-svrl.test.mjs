import assert from 'node:assert/strict';
import test from 'node:test';
import { assertFnfeSvrl, inspectFnfeSvrl } from './assert-fnfe-svrl.mjs';

const report = (failed = '') => `<?xml version="1.0"?>
<svrl:schematron-output xmlns:svrl="http://purl.oclc.org/dsdl/svrl">
  <svrl:active-pattern id="rules"/>
  <svrl:fired-rule context="rsm:CrossIndustryInvoice"/>
  ${failed}
</svrl:schematron-output>`;

const failure = (id, attributes = '') =>
  `<svrl:failed-assert id="${id}" ${attributes}><svrl:text>Violation &amp; détail</svrl:text></svrl:failed-assert>`;

test('accepte un verdict exercé sans assertion bloquante et conserve les warnings', () => {
  const inspected = assertFnfeSvrl(report(failure('WARN-1', 'flag="warning"')), {
    label: 'profil EN16931',
  });
  assert.equal(inspected.firedRuleCount, 1);
  assert.equal(inspected.blockingFailures.length, 0);
  assert.equal(inspected.failedAssertions[0]?.message, 'Violation & détail');
});

test('refuse rapport vide, tronqué, non exercé et assertion bloquante', () => {
  assert.throws(() => inspectFnfeSvrl(''));
  assert.throws(() => inspectFnfeSvrl('<svrl:schematron-output>'));
  assert.throws(() => inspectFnfeSvrl('<svrl:schematron-output></svrl:schematron-output>'));
  assert.throws(() => assertFnfeSvrl(report(failure('BR-CO-10', 'flag="fatal"')), {
    label: 'BR-FR strict',
  }), /BR-CO-10/u);
});

test('fixture négative : exige la règle attendue et aucune autre', () => {
  assert.doesNotThrow(() => assertFnfeSvrl(report(failure('BR-FR-32-GLOBALID', 'flag="fatal"')), {
    label: 'fixture négative',
    expectedFailureId: 'BR-FR-32-GLOBALID',
  }));
  assert.throws(() => assertFnfeSvrl(report(failure('BR-FR-10', 'flag="fatal"')), {
    label: 'fixture négative',
    expectedFailureId: 'BR-FR-32-GLOBALID',
  }), /n.a pas déclenché/u);
  assert.throws(() => assertFnfeSvrl(report(
    failure('BR-FR-32-GLOBALID', 'flag="fatal"') + failure('BR-FR-10', 'flag="fatal"'),
  ), {
    label: 'fixture négative',
    expectedFailureId: 'BR-FR-32-GLOBALID',
  }), /échecs inattendus/u);
});
