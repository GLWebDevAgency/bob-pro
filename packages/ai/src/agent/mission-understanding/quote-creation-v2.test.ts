import { describe, expect, it, vi } from 'vitest';
import type { LlmCompletion, LlmPort } from '../../llm/port';
import {
  parseQuoteCreationSemanticToolCallV2,
  QUOTE_CREATION_UNDERSTANDING_TOOL_V2,
  understandQuoteCreationTurnV2,
} from './quote-creation-v2';

const TOOL_NAME = 'mettre_a_jour_mission_devis_v2';

function llm(output: LlmCompletion): LlmPort {
  return {
    id: 'openai-live-test',
    complete: vi.fn(async () => output),
    generate: vi.fn(async () => ({ text: '', model: output.model })),
    health: vi.fn(async () => ({ healthy: true })),
  };
}

function call(operations: readonly Record<string, unknown>[]) {
  return { name: TOOL_NAME, arguments: { operations } };
}

function line(overrides: Readonly<Record<string, unknown>> = {}) {
  return {
    service_reference: 'Main-d’œuvre plomberie',
    category_hint: 'labor',
    quantity_decimal: '2',
    unit_reference: 'heure',
    unit_price_decimal: '55',
    currency: 'EUR',
    price_basis: 'per_unit',
    vat_rate_hint: null,
    ...overrides,
  };
}

describe('parseQuoteCreationSemanticToolCallV2', () => {
  it('conserve client et plusieurs lignes dans la phrase canonique', () => {
    expect(parseQuoteCreationSemanticToolCallV2({
      call: call([{
        kind: 'start_quote_creation',
        customer_reference: 'Camping les Pins',
        lines: [
          line(),
          line({
            service_reference: 'Chauffe-eau 200 litres',
            category_hint: 'supply',
            quantity_decimal: '1',
            unit_reference: 'unité',
            unit_price_decimal: '400',
          }),
        ],
      }]),
      phase: 'inactive',
      presentedChoiceCount: 0,
      model: 'gpt-realtime-2.1',
    })).toMatchObject({
      schema: 'bob.semantic.quote-creation',
      version: 2,
      operations: [{
        kind: 'start_quote_creation',
        customerReference: 'Camping les Pins',
        lines: [
          {
            serviceReference: 'Main-d’œuvre plomberie',
            quantityDecimal: '2',
            unitPriceDecimal: '55',
          },
          {
            serviceReference: 'Chauffe-eau 200 litres',
            quantityDecimal: '1',
            unitPriceDecimal: '400',
          },
        ],
      }],
    });
  });

  it('représente 400 balles par machine sans calculer le total', () => {
    const frame = parseQuoteCreationSemanticToolCallV2({
      call: call([{
        kind: 'append_line_candidates',
        lines: [line({
          service_reference: 'Contrat fontaines RATP',
          category_hint: 'subscription',
          quantity_decimal: '3',
          unit_reference: 'machine',
          unit_price_decimal: '400',
          price_basis: 'per_unit',
        })],
      }]),
      phase: 'awaiting_lines',
      presentedChoiceCount: 0,
      model: 'gpt-realtime-2.1',
    });
    expect(frame?.operations[0]).toMatchObject({
      lines: [{
        serviceReference: 'Contrat fontaines RATP',
        quantityDecimal: '3',
        unitPriceDecimal: '400',
        priceBasis: 'per_unit',
      }],
    });
  });

  it('ne transforme pas le chiffre de Contrat 4 saisons en quantité', () => {
    const frame = parseQuoteCreationSemanticToolCallV2({
      call: call([{
        kind: 'append_line_candidates',
        lines: [line({
          service_reference: 'Contrat 4 saisons',
          quantity_decimal: null,
          unit_reference: null,
          unit_price_decimal: null,
          currency: null,
          price_basis: null,
        })],
      }]),
      phase: 'awaiting_lines',
      presentedChoiceCount: 0,
      model: 'gpt-realtime-2.1',
    });
    expect(frame?.operations[0]).toMatchObject({
      lines: [{
        serviceReference: 'Contrat 4 saisons',
        quantityDecimal: null,
      }],
    });
  });

  it('lie un ordinal au nombre exact de choix et conserve les lignes suivantes', () => {
    expect(parseQuoteCreationSemanticToolCallV2({
      call: call([{
        kind: 'select_presented_choice',
        ordinal: 2,
        lines: [line()],
      }]),
      phase: 'awaiting_customer_choice',
      presentedChoiceCount: 3,
      model: 'gpt-realtime-2.1',
    })?.operations[0]).toMatchObject({
      kind: 'select_presented_choice',
      ordinal: 2,
      lines: [{ quantityDecimal: '2' }],
    });

    expect(parseQuoteCreationSemanticToolCallV2({
      call: call([{
        kind: 'select_presented_choice',
        ordinal: 4,
        lines: [],
      }]),
      phase: 'awaiting_customer_choice',
      presentedChoiceCount: 3,
      model: 'gpt-realtime-2.1',
    })).toBeNull();
  });

  it('comprend une correction comme patch et non comme nouvelle ligne', () => {
    expect(parseQuoteCreationSemanticToolCallV2({
      call: call([{
        kind: 'patch_pending_line',
        patch: {
          field: 'unit_price',
          decimal: '450',
          currency: 'EUR',
          basis: 'per_unit',
        },
      }]),
      phase: 'awaiting_line_details',
      presentedChoiceCount: 0,
      model: 'gpt-realtime-2.1',
    })?.operations).toEqual([{
      kind: 'patch_pending_line',
      patch: {
        field: 'unit_price',
        decimal: '450',
        currency: 'EUR',
        basis: 'per_unit',
      },
    }]);
  });

  it.each([
    ['clé inconnue profonde', line({ hallucinated_id: 'catalogue-1' })],
    ['virgule non canonique', line({ quantity_decimal: '2,5' })],
    ['zéro préfixé', line({ unit_price_decimal: '055' })],
    ['prix sans devise', line({ currency: null })],
    ['unité trop longue pour QuoteDraft V1', line({ unit_reference: 'u'.repeat(41) })],
  ])('refuse %s', (_label, candidate) => {
    expect(parseQuoteCreationSemanticToolCallV2({
      call: call([{ kind: 'append_line_candidates', lines: [candidate] }]),
      phase: 'awaiting_lines',
      presentedChoiceCount: 0,
      model: 'gpt-realtime-2.1',
    })).toBeNull();
  });

  it('refuse plus de vingt lignes globales et toute combinaison hors phase', () => {
    expect(parseQuoteCreationSemanticToolCallV2({
      call: call([{
        kind: 'append_line_candidates',
        lines: Array.from({ length: 20 }, () => line()),
      }, {
        kind: 'append_line_candidates',
        lines: [line()],
      }]),
      phase: 'awaiting_lines',
      presentedChoiceCount: 0,
      model: 'gpt-realtime-2.1',
    })).toBeNull();

    expect(parseQuoteCreationSemanticToolCallV2({
      call: call([{ kind: 'confirm_current_proposal' }]),
      phase: 'awaiting_lines',
      presentedChoiceCount: 0,
      model: 'gpt-realtime-2.1',
    })).toBeNull();
  });
});

describe('understandQuoteCreationTurnV2', () => {
  it('n’envoie au modèle que le tour courant et un contexte structurel', async () => {
    const sentinel = 'CATALOGUE SECRET 987 €';
    const fake = llm({
      text: null,
      toolCalls: [call([{
        kind: 'start_quote_creation',
        customer_reference: 'Camping les Pins',
        lines: [line()],
      }])],
      model: 'gpt-realtime-2.1',
    });

    const result = await understandQuoteCreationTurnV2(fake, {
      transcript: 'Fais le devis Camping les Pins, ajoute deux heures à 55 euros',
      phase: 'inactive',
      presentedChoiceCount: 0,
      requiredFact: null,
      timeZone: null,
      locale: 'fr-FR',
    });

    expect(result.status).toBe('understood');
    const [messages, options] = vi.mocked(fake.complete).mock.calls[0]!;
    expect(JSON.stringify(messages)).not.toContain(sentinel);
    expect(messages).toHaveLength(1);
    expect(options).toMatchObject({
      toolChoice: 'required',
      temperature: 0,
      maxTokens: 2_048,
      tools: [QUOTE_CREATION_UNDERSTANDING_TOOL_V2],
    });
  });

  it('rejette le contexte incohérent avant tout appel fournisseur', async () => {
    const fake = llm({
      text: null,
      toolCalls: [],
      model: 'gpt-realtime-2.1',
    });
    await expect(understandQuoteCreationTurnV2(fake, {
      transcript: 'Le deuxième',
      phase: 'awaiting_catalogue_choice',
      presentedChoiceCount: 0,
      requiredFact: null,
      timeZone: null,
      locale: 'fr-FR',
    })).resolves.toEqual({ status: 'rejected', reason: 'invalid_input' });
    expect(fake.complete).not.toHaveBeenCalled();
  });

  it('refuse texte libre, outil multiple et outil inattendu', async () => {
    const input = {
      transcript: 'Ajoute deux heures',
      phase: 'awaiting_lines' as const,
      presentedChoiceCount: 0,
      requiredFact: null,
      timeZone: null,
      locale: 'fr-FR' as const,
    };
    await expect(understandQuoteCreationTurnV2(llm({
      text: 'Bien sûr.',
      toolCalls: [],
      model: 'gpt-realtime-2.1',
    }), input)).resolves.toEqual({
      status: 'rejected',
      reason: 'missing_tool_call',
    });
    await expect(understandQuoteCreationTurnV2(llm({
      text: null,
      toolCalls: [call([]), call([])],
      model: 'gpt-realtime-2.1',
    }), input)).resolves.toEqual({
      status: 'rejected',
      reason: 'multiple_tool_calls',
    });
    await expect(understandQuoteCreationTurnV2(llm({
      text: null,
      toolCalls: [{ name: 'autre_outil', arguments: {} }],
      model: 'gpt-realtime-2.1',
    }), input)).resolves.toEqual({
      status: 'rejected',
      reason: 'unexpected_tool',
    });
  });
});
