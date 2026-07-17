/**
 * Adaptateurs strictement réservés aux tests, démonstrations isolées et génération de fixtures.
 * Cet entrypoint n'est jamais importé par une application de production.
 */
export * from './local-client';
export * from './in-memory/repositories';
export * from './in-memory/services';
