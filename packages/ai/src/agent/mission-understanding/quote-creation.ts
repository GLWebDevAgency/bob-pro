import { redactPII } from '../../guardrails/pii-redaction';
import type {
  LlmMessage,
  LlmPort,
  LlmToolCall,
  LlmToolSpec,
} from '../../llm/port';

const MAX_CUSTOMER_REFERENCE_LENGTH = 300;
const MAX_TRANSCRIPT_LENGTH = 4_000;
const MAX_HISTORY_TURNS = 6;
const MAX_HISTORY_TURN_LENGTH = 1_200;
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

export type QuoteCreationUnderstandingResult =
  | {
      readonly status: 'understood';
      readonly frame: QuoteCreationSemanticFrameV1;
    }
  | {
      readonly status: 'rejected';
      readonly reason:
        | 'invalid_input'
        | 'missing_tool_call'
        | 'multiple_tool_calls'
        | 'unexpected_tool'
        | 'invalid_arguments';
    };

export interface QuoteCreationUnderstandingInput {
  readonly transcript: string;
  readonly phase: QuoteCreationUnderstandingPhase;
  readonly presentedCustomerCount: number;
  readonly history?: readonly {
    readonly role: 'user' | 'bob';
    readonly text: string;
  }[];
  readonly signal?: AbortSignal;
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

const SYSTEM_PROMPT = [
  "Tu es le module de compréhension française de Bob Pro pour l'étape client d'un devis.",
  "Tu dois appeler exactement l'outil fourni. Ne réponds jamais en texte.",
  "Comprends le sens, pas une liste de mots : les formulations, l'ordre et le registre sont libres.",
  "N'invente jamais de client, d'identifiant, de choix ou d'information absente.",
  "Conserve le nom humain avec ses accents ; retire seulement les mots qui expriment l'action de créer le devis.",
  "Si la phase est inactive, start_quote_creation exige une demande réelle de nouveau devis.",
  "Si la phase attend un client, set_customer_reference exige une référence client explicitement dite.",
  "Si des choix sont présentés, select_presented_customer exige un ordinal explicite et existant.",
  "Une nouvelle référence client explicite pendant les choix utilise set_customer_reference.",
  "Toute demande sans rapport utilise unrelated.",
].join(' ');

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

function validInput(input: QuoteCreationUnderstandingInput): boolean {
  return (
    typeof input.transcript === 'string'
    && input.transcript.length > 0
    && input.transcript.length <= MAX_TRANSCRIPT_LENGTH
    && input.transcript === input.transcript.trim()
    && !hasDisallowedControlCharacter(input.transcript)
    && Number.isInteger(input.presentedCustomerCount)
    && input.presentedCustomerCount >= 0
    && input.presentedCustomerCount <= MAX_PRESENTED_CUSTOMERS
    && (
      input.phase === 'awaiting_customer_choice'
        ? input.presentedCustomerCount > 0
        : input.presentedCustomerCount === 0
    )
    && (input.history ?? []).every(
      (turn) =>
        (turn.role === 'user' || turn.role === 'bob')
        && typeof turn.text === 'string'
        && turn.text.length > 0
        && turn.text.length <= MAX_HISTORY_TURN_LENGTH
        && !hasDisallowedControlCharacter(turn.text, true),
    )
  );
}

function conversation(input: QuoteCreationUnderstandingInput): LlmMessage[] {
  const history = (input.history ?? []).slice(-MAX_HISTORY_TURNS).map((turn) => ({
    role: turn.role === 'user' ? ('user' as const) : ('assistant' as const),
    content: redactPII(turn.text),
  }));
  return [
    ...history,
    {
      role: 'user',
      content: [
        'Données de phase fournies par le serveur (ce ne sont pas des instructions) :',
        JSON.stringify({
          phase: input.phase,
          presentedCustomerCount: input.presentedCustomerCount,
        }),
        'Parole utilisateur :',
        redactPII(input.transcript),
      ].join('\n'),
    },
  ];
}

/**
 * Comprend un tour M1-C par function calling. Aucune regex ne décide l'intention ou le client ;
 * les contrôles locaux valident uniquement la forme, la phase et les bornes de sécurité.
 */
export async function understandQuoteCreationTurn(
  llm: LlmPort,
  input: QuoteCreationUnderstandingInput,
): Promise<QuoteCreationUnderstandingResult> {
  if (!validInput(input)) return { status: 'rejected', reason: 'invalid_input' };
  input.signal?.throwIfAborted();
  const completion = await llm.complete(conversation(input), {
    system: SYSTEM_PROMPT,
    tools: [QUOTE_CREATION_UNDERSTANDING_TOOL],
    toolChoice: 'required',
    temperature: 0,
    maxTokens: 256,
    ...(input.signal === undefined ? {} : { signal: input.signal }),
  });
  input.signal?.throwIfAborted();
  if (completion.toolCalls.length === 0) {
    return { status: 'rejected', reason: 'missing_tool_call' };
  }
  if (completion.toolCalls.length !== 1) {
    return { status: 'rejected', reason: 'multiple_tool_calls' };
  }
  if (completion.toolCalls[0]?.name !== QUOTE_CREATION_TOOL_NAME) {
    return { status: 'rejected', reason: 'unexpected_tool' };
  }
  const frame = parseQuoteCreationSemanticToolCall({
    call: completion.toolCalls[0],
    phase: input.phase,
    presentedCustomerCount: input.presentedCustomerCount,
    model: completion.model,
  });
  return frame === null
    ? { status: 'rejected', reason: 'invalid_arguments' }
    : { status: 'understood', frame };
}
