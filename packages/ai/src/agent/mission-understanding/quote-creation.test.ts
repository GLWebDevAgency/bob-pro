import { describe, expect, it, vi } from 'vitest';
import type { LlmCompletion, LlmPort } from '../../llm/port';
import {
  parseQuoteCreationSemanticToolCall,
  QUOTE_CREATION_UNDERSTANDING_TOOL,
  understandQuoteCreationTurn,
} from './quote-creation';

const TOOL_NAME = 'mettre_a_jour_mission_devis';

function llm(output: LlmCompletion): LlmPort {
  return {
    id: 'openai-live-test',
    complete: vi.fn(async () => output),
    generate: vi.fn(async () => ({ text: '', model: output.model })),
    health: vi.fn(async () => ({ healthy: true })),
  };
}

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
describe('understandQuoteCreationTurn', () => {
  it('impose un unique appel d’outil strict et transmet la phase comme donnée', async () => {
    const fake = llm({
      text: null,
      toolCalls: [call({
        action: 'start_quote_creation',
        customer_reference: 'Camping les Pins',
        choice_ordinal: null,
      })],
      model: 'gpt-realtime-2.1',
    });

    const result = await understandQuoteCreationTurn(fake, {
      transcript: 'Fais-moi un devis pour Camping les Pins',
      phase: 'inactive',
      presentedCustomerCount: 0,
    });

    expect(result).toMatchObject({
      status: 'understood',
      frame: {
        operation: {
          kind: 'start_quote_creation',
          customerReference: 'Camping les Pins',
        },
      },
    });
    expect(fake.complete).toHaveBeenCalledOnce();
    const [, options] = vi.mocked(fake.complete).mock.calls[0]!;
    expect(options).toMatchObject({
      toolChoice: 'required',
      temperature: 0,
      maxTokens: 256,
      tools: [QUOTE_CREATION_UNDERSTANDING_TOOL],
    });
  });

  it('refuse le texte libre, plusieurs outils et des arguments hors contrat', async () => {
    const base = {
      transcript: 'Crée un devis',
      phase: 'inactive' as const,
      presentedCustomerCount: 0,
    };
    await expect(understandQuoteCreationTurn(llm({
      text: 'Bien sûr.',
      toolCalls: [],
      model: 'gpt-realtime-2.1',
    }), base)).resolves.toEqual({
      status: 'rejected',
      reason: 'missing_tool_call',
    });
    await expect(understandQuoteCreationTurn(llm({
      text: null,
      toolCalls: [
        call({ action: 'start_quote_creation', customer_reference: null, choice_ordinal: null }),
        call({ action: 'start_quote_creation', customer_reference: null, choice_ordinal: null }),
      ],
      model: 'gpt-realtime-2.1',
    }), base)).resolves.toEqual({
      status: 'rejected',
      reason: 'multiple_tool_calls',
    });
    await expect(understandQuoteCreationTurn(llm({
      text: null,
      toolCalls: [call({})],
      model: 'gpt-realtime-2.1',
    }), base)).resolves.toEqual({
      status: 'rejected',
      reason: 'invalid_arguments',
    });
  });

  it('rejette une phase incohérente avant tout appel fournisseur', async () => {
    const fake = llm({
      text: null,
      toolCalls: [],
      model: 'gpt-realtime-2.1',
    });
    await expect(understandQuoteCreationTurn(fake, {
      transcript: 'Le deuxième',
      phase: 'awaiting_customer_choice',
      presentedCustomerCount: 0,
    })).resolves.toEqual({
      status: 'rejected',
      reason: 'invalid_input',
    });
    expect(fake.complete).not.toHaveBeenCalled();
  });
});
