export type LlmProviderFailureCategory =
  | 'invalid_function_parameters'
  | 'authentication_failed'
  | 'permission_denied'
  | 'rate_limited'
  | 'quota_exceeded'
  | 'provider_unavailable'
  | 'provider_http_error';

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

/**
 * Réduit une réponse d'erreur fournisseur à une classe fermée sans conserver son message,
 * ses paramètres, son corps ou son identifiant de requête.
 */
export function classifyLlmProviderHttpFailure(
  status: number,
  payload: unknown,
): LlmProviderFailureCategory {
  const error = record(record(payload)?.['error']);
  const code = typeof error?.['code'] === 'string' ? error['code'] : null;
  if (status === 401) return 'authentication_failed';
  if (status === 403) return 'permission_denied';
  if (status === 429 && code === 'insufficient_quota') return 'quota_exceeded';
  if (status === 429) return 'rate_limited';
  if (status >= 500 && status <= 599) return 'provider_unavailable';
  if (
    (status === 400 || status === 422)
    && code === 'invalid_function_parameters'
  ) {
    return 'invalid_function_parameters';
  }
  return 'provider_http_error';
}

export class LlmProviderHttpError extends Error {
  readonly status: number;
  readonly category: LlmProviderFailureCategory;

  constructor(status: number, category: LlmProviderFailureCategory) {
    super(category.startsWith('provider_') ? `llm_${category}` : `llm_provider_${category}`);
    this.name = 'LlmProviderHttpError';
    this.status = Number.isSafeInteger(status) && status >= 100 && status <= 599
      ? status
      : 0;
    this.category = category;
  }
}

export class LlmStrictSchemaError extends Error {
  constructor() {
    super('llm_strict_schema_invalid');
    this.name = 'LlmStrictSchemaError';
  }
}

export function llmProviderFailureCategory(
  error: unknown,
): LlmProviderFailureCategory | null {
  return error instanceof LlmProviderHttpError ? error.category : null;
}

export function isLlmStrictSchemaError(error: unknown): error is LlmStrictSchemaError {
  return error instanceof LlmStrictSchemaError;
}
