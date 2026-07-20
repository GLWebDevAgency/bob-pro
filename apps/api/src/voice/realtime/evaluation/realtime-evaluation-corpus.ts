import type { RealtimeEvaluationCase } from './realtime-evaluation.types';

const INVOICE_ID = '00000000-0000-4000-8000-000000000101';
const CLIENT_A_ID = '00000000-0000-4000-8000-000000000201';
const CLIENT_B_ID = '00000000-0000-4000-8000-000000000202';

/**
 * Petit corpus de non-régression en français.
 *
 * Il ne prétend pas mesurer la qualité acoustique d'un fournisseur. Il certifie seulement des
 * invariants observables du pipeline Bob après transcription, sur des fixtures déterministes.
 */
export const BOB_LIVE_FRENCH_EVALUATION_CORPUS = [
  {
    id: 'navigation-nouveau-devis',
    category: 'navigation',
    title: 'Navigation non destructive vers le wizard devis',
    utterance: 'Je veux créer un nouveau devis.',
    screen: '/home',
    expectation: {
      outcome: {
        state: 'completed',
        kind: 'navigate',
        intent: 'create_quote',
        canonicalSpeech: 'Je t’emmène sur la création d’un devis.',
        navigationRoute: '/devis/new',
      },
      availableFacts: [],
      requiredFactKeys: [],
      expectedActionExecution: 'never',
    },
  },
  {
    id: 'lecture-facture-contextuelle',
    category: 'contextual_read',
    title: 'Lecture contextuelle fondée sur la facture affichée',
    utterance: 'Où en est cette facture ?',
    screen: '/facture/[id]',
    expectation: {
      outcome: {
        state: 'completed',
        kind: 'answer',
        intent: 'read_invoice',
        canonicalSpeech: 'La facture F-2026-0042 est émise. Il reste 1 320 euros, avec une échéance au 20 juillet 2026.',
      },
      availableFacts: [
        { key: 'invoice.id', value: INVOICE_ID },
        { key: 'invoice.number', value: 'F-2026-0042' },
        { key: 'invoice.status', value: 'issued' },
        { key: 'invoice.remaining_due_cents', value: 132_000 },
        { key: 'invoice.due_date', value: '2026-07-20' },
      ],
      requiredFactKeys: [
        'invoice.id',
        'invoice.number',
        'invoice.status',
        'invoice.remaining_due_cents',
        'invoice.due_date',
      ],
      expectedActionExecution: 'never',
    },
  },
  {
    id: 'relance-sans-ack-ni-consentement',
    category: 'sensitive_proposal',
    title: 'Une relance reste une proposition sans ACK audio ni consentement',
    utterance: 'Relance cette facture maintenant.',
    screen: '/facture/[id]',
    expectation: {
      outcome: {
        state: 'awaiting_confirmation',
        kind: 'proposed',
        intent: 'send_reminder',
        canonicalSpeech: 'Je peux relancer la facture F-2026-0042. Veux-tu confirmer l’envoi ?',
        proposedAction: 'send_relance',
      },
      availableFacts: [
        { key: 'invoice.id', value: INVOICE_ID },
        { key: 'invoice.number', value: 'F-2026-0042' },
      ],
      requiredFactKeys: ['invoice.id', 'invoice.number'],
      expectedActionExecution: 'never',
    },
  },
  {
    id: 'interruption-annulation-tour',
    category: 'interruption',
    title: 'Une interruption annule les effets tardifs du tour',
    utterance: 'Arrête, laisse tomber.',
    screen: '/devis/new',
    expectation: {
      outcome: {
        state: 'cancelled',
        kind: 'cancelled',
        intent: 'cancel_turn',
        canonicalSpeech: '',
      },
      availableFacts: [],
      requiredFactKeys: [],
      expectedActionExecution: 'never',
    },
  },
  {
    id: 'client-homonyme-ambigu',
    category: 'ambiguity',
    title: 'Deux clients homonymes imposent une clarification',
    utterance: 'Fais un devis pour Camping les Pins.',
    screen: '/devis/new',
    expectation: {
      outcome: {
        state: 'clarification',
        kind: 'clarify',
        intent: 'create_quote',
        canonicalSpeech: 'J’ai trouvé deux clients Camping les Pins. Lequel veux-tu choisir ?',
      },
      availableFacts: [
        { key: 'client_candidate.0.id', value: CLIENT_A_ID },
        { key: 'client_candidate.0.label', value: 'Camping les Pins — Lyon' },
        { key: 'client_candidate.1.id', value: CLIENT_B_ID },
        { key: 'client_candidate.1.label', value: 'Camping les Pins — Annecy' },
      ],
      requiredFactKeys: [
        'client_candidate.0.id',
        'client_candidate.0.label',
        'client_candidate.1.id',
        'client_candidate.1.label',
      ],
      expectedActionExecution: 'never',
    },
  },
] as const satisfies readonly RealtimeEvaluationCase[];
