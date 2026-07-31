import type {
  LlmToolCall,
  LlmToolSpec,
} from '../../llm/port';

const MAX_CUSTOMER_REFERENCE_LENGTH = 300;
const MAX_PRESENTED_CUSTOMERS = 5;

export type QuoteCreationUnderstandingPhase =
  | 'inactive'
  | 'awaiting_customer'
  | 'awaiting_customer_choice';

export type QuoteCreationSemanticOperation =
  | {
      readonly kind: 'start_quote_creation';
      readonly customerReference: string | null;
    }
  | {
      readonly kind: 'set_customer_reference';
      readonly customerReference: string;
    }
  | {
      readonly kind: 'select_presented_customer';
      readonly ordinal: number;
    }
  | { readonly kind: 'unrelated' };

export interface QuoteCreationSemanticFrameV1 {
  readonly schema: 'bob.semantic.quote-creation';
  readonly version: 1;
  readonly operation: QuoteCreationSemanticOperation;
  readonly model: string;
}

interface QuoteCreationToolArguments {
  readonly action:
    | 'start_quote_creation'
    | 'set_customer_reference'
    | 'select_presented_customer'
    | 'unrelated';
  readonly customer_reference: string | null;
  readonly choice_ordinal: number | null;
}

const QUOTE_CREATION_TOOL_NAME = 'mettre_a_jour_mission_devis';

export const QUOTE_CREATION_UNDERSTANDING_TOOL: LlmToolSpec = Object.freeze({
  name: QUOTE_CREATION_TOOL_NAME,
  description:
    "Comprendre uniquement l'étape client d'une mission de création de devis. Extraire la référence humaine du client sans inventer d'identifiant, ou l'ordinal d'un choix déjà présenté.",
  parameters: {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        enum: [
          'start_quote_creation',
          'set_customer_reference',
          'select_presented_customer',
          'unrelated',
        ],
      },
      customer_reference: {
        type: ['string', 'null'],
        description:
          'Nom ou référence client exactement compris dans la parole. Jamais un identifiant interne.',
        maxLength: MAX_CUSTOMER_REFERENCE_LENGTH,
      },
      choice_ordinal: {
        type: ['integer', 'null'],
        minimum: 1,
        maximum: MAX_PRESENTED_CUSTOMERS,
      },
    },
    required: ['action', 'customer_reference', 'choice_ordinal'],
    additionalProperties: false,
  },
});

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return (
    Object.keys(value).length === keys.length
    && keys.every((key) => Object.hasOwn(value, key))
  );
}

function hasDisallowedControlCharacter(value: string, allowFormattingWhitespace = false): boolean {
  for (const character of value) {
    const point = character.codePointAt(0);
    if (point === undefined) continue;
    if (
      point === 127
      || (
        point < 32
        && !(allowFormattingWhitespace && (point === 9 || point === 10 || point === 13))
      )
    ) {
      return true;
    }
  }
  return false;
}

function canonicalSingleLine(value: unknown, maxLength: number): string | null {
  if (typeof value !== 'string') return null;
  const normalized = value.trim().replace(/\s+/gu, ' ');
  if (
    normalized.length === 0
    || normalized.length > maxLength
    || hasDisallowedControlCharacter(normalized)
  ) {
    return null;
  }
  return normalized;
}

function parseToolArguments(value: unknown): QuoteCreationToolArguments | null {
  if (
    !isRecord(value)
    || !exactKeys(value, ['action', 'customer_reference', 'choice_ordinal'])
  ) {
    return null;
  }
  if (
    value['action'] !== 'start_quote_creation'
    && value['action'] !== 'set_customer_reference'
    && value['action'] !== 'select_presented_customer'
    && value['action'] !== 'unrelated'
  ) {
    return null;
  }
  if (
    value['customer_reference'] !== null
    && typeof value['customer_reference'] !== 'string'
  ) {
    return null;
  }
  if (
    value['choice_ordinal'] !== null
    && (
      !Number.isInteger(value['choice_ordinal'])
      || (value['choice_ordinal'] as number) < 1
      || (value['choice_ordinal'] as number) > MAX_PRESENTED_CUSTOMERS
    )
  ) {
    return null;
  }
  return {
    action: value['action'],
    customer_reference: value['customer_reference'],
    choice_ordinal: value['choice_ordinal'] as number | null,
  };
}

export function parseQuoteCreationSemanticToolCall(input: {
  readonly call: LlmToolCall;
  readonly phase: QuoteCreationUnderstandingPhase;
  readonly presentedCustomerCount: number;
  readonly model: string;
}): QuoteCreationSemanticFrameV1 | null {
  if (input.call.name !== QUOTE_CREATION_TOOL_NAME) return null;
  const parsed = parseToolArguments(input.call.arguments);
  if (parsed === null) return null;

  let operation: QuoteCreationSemanticOperation;
  if (parsed.action === 'start_quote_creation') {
    if (
      input.phase !== 'inactive'
      || parsed.choice_ordinal !== null
    ) return null;
    const customerReference = parsed.customer_reference === null
      ? null
      : canonicalSingleLine(parsed.customer_reference, MAX_CUSTOMER_REFERENCE_LENGTH);
    if (parsed.customer_reference !== null && customerReference === null) return null;
    operation = { kind: 'start_quote_creation', customerReference };
  } else if (parsed.action === 'set_customer_reference') {
    if (
      input.phase === 'inactive'
      || parsed.choice_ordinal !== null
    ) return null;
    const customerReference = canonicalSingleLine(
      parsed.customer_reference,
      MAX_CUSTOMER_REFERENCE_LENGTH,
    );
    if (customerReference === null) return null;
    operation = { kind: 'set_customer_reference', customerReference };
  } else if (parsed.action === 'select_presented_customer') {
    if (
      input.phase !== 'awaiting_customer_choice'
      || parsed.customer_reference !== null
      || parsed.choice_ordinal === null
      || parsed.choice_ordinal > input.presentedCustomerCount
    ) return null;
    operation = { kind: 'select_presented_customer', ordinal: parsed.choice_ordinal };
  } else {
    if (
      parsed.customer_reference !== null
      || parsed.choice_ordinal !== null
    ) return null;
    operation = { kind: 'unrelated' };
  }

  return {
    schema: 'bob.semantic.quote-creation',
    version: 1,
    operation,
    model: input.model,
  };
}
