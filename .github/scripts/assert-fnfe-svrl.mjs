import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

function decodeXml(value) {
  return value
    .replace(/&lt;/gu, '<')
    .replace(/&gt;/gu, '>')
    .replace(/&quot;/gu, '"')
    .replace(/&apos;/gu, "'")
    .replace(/&amp;/gu, '&');
}

function readAttribute(raw, name) {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
  const match = new RegExp(`(?:^|\\s)${escaped}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`, 'u').exec(raw);
  return match === null ? undefined : decodeXml(match[1] ?? match[2] ?? '');
}

function readableText(raw) {
  return decodeXml(raw.replace(/<[^>]+>/gu, ' ').replace(/\s+/gu, ' ').trim());
}

export function inspectFnfeSvrl(report) {
  if (typeof report !== 'string' || report.trim().length === 0) {
    throw new Error('Rapport SVRL FNFE absent ou vide.');
  }
  if (!/<(?:[\w.-]+:)?schematron-output\b[\s\S]*<\/(?:[\w.-]+:)?schematron-output>\s*$/u.test(report.trim())) {
    throw new Error('Rapport SVRL FNFE tronqué ou enveloppe schematron-output absente.');
  }

  const firedRuleCount = [...report.matchAll(/<(?:[\w.-]+:)?fired-rule\b/gu)].length;
  if (firedRuleCount === 0) {
    throw new Error('Aucune règle Schematron FNFE exécutée (fired-rule absent).');
  }

  const failedAssertions = [...report.matchAll(
    /<(?:[\w.-]+:)?failed-assert\b([^>]*)>([\s\S]*?)<\/(?:[\w.-]+:)?failed-assert>/gu,
  )].map((match) => {
    const attributes = match[1] ?? '';
    const flag = readAttribute(attributes, 'flag');
    const role = readAttribute(attributes, 'role');
    return {
      id: readAttribute(attributes, 'id') ?? '(sans id)',
      flag,
      role,
      location: readAttribute(attributes, 'location'),
      message: readableText(match[2] ?? ''),
      warning: [flag, role].some((value) => value?.toLowerCase() === 'warning'),
    };
  });

  return {
    firedRuleCount,
    failedAssertions,
    blockingFailures: failedAssertions.filter((failure) => !failure.warning),
  };
}

export function assertFnfeSvrl(report, options) {
  const inspected = inspectFnfeSvrl(report);
  const label = options?.label?.trim() || 'FNFE';
  const expectedFailureId = options?.expectedFailureId;

  if (expectedFailureId !== undefined) {
    const expected = inspected.blockingFailures.filter((failure) => failure.id === expectedFailureId);
    const unexpected = inspected.blockingFailures.filter((failure) => failure.id !== expectedFailureId);
    if (expected.length === 0) {
      throw new Error(`${label} : la fixture négative n’a pas déclenché ${expectedFailureId}.`);
    }
    if (unexpected.length > 0) {
      throw new Error(
        `${label} : échecs inattendus dans la fixture négative : ${unexpected.map((failure) => failure.id).join(', ')}.`,
      );
    }
    return inspected;
  }

  if (inspected.blockingFailures.length > 0) {
    const details = inspected.blockingFailures
      .slice(0, 10)
      .map((failure) => `${failure.id}${failure.message ? ` — ${failure.message}` : ''}`)
      .join('; ');
    throw new Error(`${label} : ${inspected.blockingFailures.length} assertion(s) bloquante(s) : ${details}`);
  }
  return inspected;
}

function main() {
  const [, , reportPath, label, expectedFailureId] = process.argv;
  if (!reportPath || !label) {
    throw new Error(
      'Usage: node assert-fnfe-svrl.mjs <rapport.svrl.xml> <label> [expected-failure-id]',
    );
  }
  const inspected = assertFnfeSvrl(readFileSync(reportPath, 'utf8'), {
    label,
    ...(expectedFailureId ? { expectedFailureId } : {}),
  });
  process.stdout.write(
    `${label} certifié : ${inspected.firedRuleCount} règle(s), ` +
      `${inspected.blockingFailures.length} échec(s) bloquant(s), ` +
      `${inspected.failedAssertions.length - inspected.blockingFailures.length} avertissement(s).\n`,
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
