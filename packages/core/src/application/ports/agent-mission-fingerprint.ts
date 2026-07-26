export interface AgentMissionFingerprint {
  readonly keyVersion: number;
  readonly hmac: string;
}

/**
 * Keyring versionné. `null` est fail-closed : la version demandée n'est plus disponible.
 * Aucun matériau de clé n'entre dans le core, les erreurs ou les logs.
 */
export interface AgentMissionFingerprintPort {
  sign(canonicalRequest: string, keyVersion?: number): AgentMissionFingerprint | null;
  matches(canonicalRequest: string, fingerprint: AgentMissionFingerprint): boolean | null;
}
