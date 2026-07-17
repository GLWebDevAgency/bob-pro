import { randomUUID } from 'node:crypto';
import type { IdGeneratorPort } from '@bob/core';

/** Générateur runtime : UUID v4 non énumérable, sans dépendance aux adapters de test. */
export class UuidGenerator implements IdGeneratorPort {
  newId(): string {
    return randomUUID();
  }
}
