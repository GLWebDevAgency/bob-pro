import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // Monorepo : ancre le traçage des fichiers à la racine (évite l'inférence ambiguë).
  outputFileTracingRoot: join(here, '../..'),
};

export default nextConfig;
