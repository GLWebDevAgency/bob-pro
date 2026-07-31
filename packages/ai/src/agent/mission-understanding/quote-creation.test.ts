import { describe, expect, it } from 'vitest';
import {
  parseQuoteCreationSemanticToolCall,
} from './quote-creation';

const TOOL_NAME = 'mettre_a_jour_mission_devis';

function call(arguments_: Record<string, unknown>) {
  return { name: TOOL_NAME, arguments: arguments_ };
}

describe('parseQuoteCreationSemanticToolCall', () => {
  it('conserve le client donné dans la même phrase que la création du devis', () => {
    expect(parseQuoteCreationSemanticToolCall({
      call: call({
        action: 'start_quote_creation',
        customer_reference: 'Camping les Pins',
        choice_ordinal: null,
      }),
      phase: 'inactive',
      presentedCustomerCount: 0,
      model: 'gpt-realtime-2.1',
    })).toEqual({
      schema: 'bob.semantic.quote-creation',
      version: 1,
      operation: {
        kind: 'start_quote_creation',
        customerReference: 'Camping les Pins',
      },
      model: 'gpt-realtime-2.1',
    });
  });

  it('accepte une référence complémentaire pendant la mission', () => {
    expect(parseQuoteCreationSemanticToolCall({
      call: call({
        action: 'set_customer_reference',
        customer_reference: '  Camping   les Pins ',
        choice_ordinal: null,
      }),
      phase: 'awaiting_customer',
      presentedCustomerCount: 0,
      model: 'gpt-realtime-2.1',
    })?.operation).toEqual({
      kind: 'set_customer_reference',
      customerReference: 'Camping les Pins',
    });
  });

  it('lie un ordinal uniquement au jeu courant et à ses bornes réelles', () => {
    expect(parseQuoteCreationSemanticToolCall({
      call: call({
        action: 'select_presented_customer',
        customer_reference: null,
        choice_ordinal: 2,
      }),
      phase: 'awaiting_customer_choice',
      presentedCustomerCount: 3,
      model: 'gpt-realtime-2.1',
    })?.operation).toEqual({ kind: 'select_presented_customer', ordinal: 2 });

    expect(parseQuoteCreationSemanticToolCall({
      call: call({
        action: 'select_presented_customer',
        customer_reference: null,
        choice_ordinal: 4,
      }),
      phase: 'awaiting_customer_choice',
      presentedCustomerCount: 3,
      model: 'gpt-realtime-2.1',
    })).toBeNull();
  });

  it.each([
    [
      'clé inconnue',
      {
        action: 'start_quote_creation',
        customer_reference: null,
        choice_ordinal: null,
        customerId: 'hallucinated',
      },
    ],
    [
      'référence vide',
      {
        action: 'set_customer_reference',
        customer_reference: ' ',
        choice_ordinal: null,
      },
    ],
    [
      'ordinal et référence concurrents',
      {
        action: 'select_presented_customer',
        customer_reference: 'Camping les Pins',
        choice_ordinal: 1,
      },
    ],
  ])('refuse %s', (_case, arguments_) => {
    expect(parseQuoteCreationSemanticToolCall({
      call: call(arguments_),
      phase: 'awaiting_customer_choice',
      presentedCustomerCount: 3,
      model: 'gpt-realtime-2.1',
    })).toBeNull();
  });
});
