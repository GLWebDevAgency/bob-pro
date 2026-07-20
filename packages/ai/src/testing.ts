/** Adaptateurs déterministes non exportés dans le runtime de production. */
export * from './llm/demo-adapter';
export * from './voice/demo-stt';
export * from './voice/demo-tts';
export { InMemoryCompanyMemory } from './memory/company-memory.testing';
export { InMemoryJournalStore } from './runtime/journal.testing';
export * from './eval/ocr-golden';
export * from './eval/ocr-eval';
