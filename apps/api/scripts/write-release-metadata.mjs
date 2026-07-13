import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const [sha, environment] = process.argv.slice(2);
if (!/^[0-9a-f]{40}$/.test(sha ?? '')) {
  throw new Error('Release SHA must contain exactly 40 lowercase hexadecimal characters.');
}
if (environment !== 'staging' && environment !== 'production') {
  throw new Error('Release environment must be staging or production.');
}

writeFileSync(
  resolve(import.meta.dirname, '../../..', '.bob-release.json'),
  `${JSON.stringify({ sha, environment })}\n`,
  { encoding: 'utf8', mode: 0o644 },
);
