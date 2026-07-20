import { rmSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const apiRoot = resolve(scriptDirectory, '..');
const output = resolve(apiRoot, 'dist');

if (output !== `${apiRoot}/dist`) {
  throw new Error('Refus de nettoyer un chemin de build non canonique.');
}

rmSync(output, { recursive: true, force: true });
