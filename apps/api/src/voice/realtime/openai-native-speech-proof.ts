import { createHmac, type Hmac } from 'node:crypto';
import {
  normalizeOpenAiNativeSpokenTranscriptV1,
  OPENAI_NATIVE_RESPONSE_LIMITS,
} from './openai-native-response-protocol';
import {
  OPENAI_NATIVE_SPEECH_POLICY_VERSION,
  OPENAI_NATIVE_SPEECH_PROOF_FORMAT_VERSION,
} from './openai-native-speech-delivery';

const POSTGRES_INT_MAX = 2_147_483_647;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const SHA256_HEX = /^[a-f0-9]{64}$/u;
const COMPANY_ID = /^[A-Za-z0-9-]{1,64}$/u;
const REQUEST_NONCE = /^[A-Za-z0-9_-]{32,128}$/u;
const PROVIDER_ID = /^[A-Za-z0-9_-]{1,200}$/u;

export interface OpenAiNativeSpeechProofBinding {
  readonly companyId: string;
  readonly deliveryId: string;
  readonly sessionId: string;
  readonly turnId: string;
  readonly contextRevision: number;
  readonly contextDigest: string;
  readonly speechPolicyVersion: typeof OPENAI_NATIVE_SPEECH_POLICY_VERSION;
  readonly speechScenarioId: 'generic_help_v1' | 'generic_unknown_v1';
}

export interface OpenAiNativeSpeechPreparationProof {
  readonly proofFormatVersion: typeof OPENAI_NATIVE_SPEECH_PROOF_FORMAT_VERSION;
  readonly proofKeyVersion: number;
  readonly canonicalSpeechHmac: string;
  readonly factsHmac: string;
  readonly requestNonceHmac: string;
}

interface ProofInput {
  readonly secret: string;
  readonly proofKeyVersion: number;
  readonly binding: OpenAiNativeSpeechProofBinding;
}

function validPositiveInteger(value: unknown): value is number {
  return typeof value === 'number'
    && Number.isInteger(value)
    && !Object.is(value, -0)
    && value >= 1
    && value <= POSTGRES_INT_MAX;
}

function assertProofInput(input: ProofInput): void {
  if (
    typeof input.secret !== 'string'
    || Buffer.byteLength(input.secret, 'utf8') < 32
    || input.secret.includes('[')
    || input.secret.includes(']')
    || !validPositiveInteger(input.proofKeyVersion)
    || !COMPANY_ID.test(input.binding.companyId)
    || !UUID.test(input.binding.deliveryId)
    || !UUID.test(input.binding.sessionId)
    || !UUID.test(input.binding.turnId)
    || !validPositiveInteger(input.binding.contextRevision)
    || !SHA256_HEX.test(input.binding.contextDigest)
    || input.binding.speechPolicyVersion !== OPENAI_NATIVE_SPEECH_POLICY_VERSION
    || (input.binding.speechScenarioId !== 'generic_help_v1'
      && input.binding.speechScenarioId !== 'generic_unknown_v1')
  ) throw new Error('Invalid OpenAI native speech proof input.');
}

function updateLengthPrefixed(mac: Hmac, name: string, value: string | number): void {
  const serialized = String(value);
  mac.update('\u0000', 'utf8');
  mac.update(name, 'utf8');
  mac.update(':', 'utf8');
  mac.update(String(Buffer.byteLength(serialized, 'utf8')), 'utf8');
  mac.update(':', 'utf8');
  mac.update(serialized, 'utf8');
}

function proofHmac(input: ProofInput, domain: string, value: string): string {
  assertProofInput(input);
  const mac = createHmac('sha256', input.secret);
  mac.update(
    `bob-pro:openai-native-speech-proof:${domain}:v${OPENAI_NATIVE_SPEECH_PROOF_FORMAT_VERSION}`,
    'utf8',
  );
  updateLengthPrefixed(mac, 'proofKeyVersion', input.proofKeyVersion);
  updateLengthPrefixed(mac, 'companyId', input.binding.companyId);
  updateLengthPrefixed(mac, 'deliveryId', input.binding.deliveryId);
  updateLengthPrefixed(mac, 'sessionId', input.binding.sessionId);
  updateLengthPrefixed(mac, 'turnId', input.binding.turnId);
  updateLengthPrefixed(mac, 'contextRevision', input.binding.contextRevision);
  updateLengthPrefixed(mac, 'contextDigest', input.binding.contextDigest);
  updateLengthPrefixed(mac, 'speechPolicyVersion', input.binding.speechPolicyVersion);
  updateLengthPrefixed(mac, 'speechScenarioId', input.binding.speechScenarioId);
  updateLengthPrefixed(mac, 'value', value);
  return mac.digest('hex');
}

/**
 * Preuve du contenu effectivement prononcé. Le canonique et le transcript fournisseur passent
 * obligatoirement par cette même dérivation ; aucune copie arbitraire du HMAC canonique n'est
 * autorisée après un simple booléen de concordance.
 */
export function createOpenAiNativeSpeechTranscriptHmac(
  input: ProofInput & { readonly transcript: string },
): string {
  if (
    typeof input.transcript !== 'string'
    || input.transcript.length === 0
    || Buffer.byteLength(input.transcript, 'utf8')
      > OPENAI_NATIVE_RESPONSE_LIMITS.maxTranscriptUtf8Bytes
  ) throw new Error('Invalid OpenAI native speech transcript proof input.');
  const normalized = normalizeOpenAiNativeSpokenTranscriptV1(input.transcript);
  if (normalized.length === 0) {
    throw new Error('Invalid OpenAI native speech transcript proof input.');
  }
  return proofHmac(input, 'spoken-transcript', normalized);
}

export function createOpenAiNativeSpeechPreparationProof(
  input: ProofInput & {
    readonly canonicalSpeech: string;
    readonly factsSha256: string;
    readonly requestNonce: string;
  },
): OpenAiNativeSpeechPreparationProof {
  if (!SHA256_HEX.test(input.factsSha256) || !REQUEST_NONCE.test(input.requestNonce)) {
    throw new Error('Invalid OpenAI native speech preparation proof input.');
  }
  return Object.freeze({
    proofFormatVersion: OPENAI_NATIVE_SPEECH_PROOF_FORMAT_VERSION,
    proofKeyVersion: input.proofKeyVersion,
    canonicalSpeechHmac: createOpenAiNativeSpeechTranscriptHmac({
      ...input,
      transcript: input.canonicalSpeech,
    }),
    factsHmac: proofHmac(input, 'canonical-facts', input.factsSha256),
    requestNonceHmac: proofHmac(input, 'request-nonce', input.requestNonce),
  });
}

export function createOpenAiNativeProviderResponseIdHmac(
  input: ProofInput & { readonly providerResponseId: string },
): string {
  if (!PROVIDER_ID.test(input.providerResponseId)) {
    throw new Error('Invalid OpenAI native provider response proof input.');
  }
  return proofHmac(input, 'provider-response-id', input.providerResponseId);
}
