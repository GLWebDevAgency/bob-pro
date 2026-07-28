/**
 * Budget wire partagé entre le client et l'autorité d'admission.
 *
 * Deux tentatives sont nécessaires pour rendre le reçu réellement at-least-once : la première
 * réponse peut être perdue après commit, puis le rejeu exact confirme l'autorité. Le serveur
 * réserve en plus une seconde de marge hors des budgets réseau bornés.
 */
export const AGENT_MISSION_BOOTSTRAP_RECEIPT_ATTEMPTS = 2 as const;
export const AGENT_MISSION_BOOTSTRAP_RECEIPT_REQUEST_TIMEOUT_MS = 4_000 as const;
export const AGENT_MISSION_BOOTSTRAP_RECEIPT_SAFETY_MARGIN_MS = 1_000 as const;
export const AGENT_MISSION_BOOTSTRAP_RECEIPT_REQUIRED_BUDGET_MS =
  AGENT_MISSION_BOOTSTRAP_RECEIPT_ATTEMPTS
  * AGENT_MISSION_BOOTSTRAP_RECEIPT_REQUEST_TIMEOUT_MS
  + AGENT_MISSION_BOOTSTRAP_RECEIPT_SAFETY_MARGIN_MS;
