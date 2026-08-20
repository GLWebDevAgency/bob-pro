/**
 * Jetons d'injection du vertical Jarvis (lot U1-d). Minimal PAR CONSTRUCTION : ce fichier ne
 * contient QUE des identités d'injection — aucun provider, aucune implémentation.
 *
 * Les providers (`JarvisModule`, adapter HMAC du port d'admission, payload store PII) arrivent
 * avec la vague B. Les consommateurs les injectent donc en OPTIONNEL : sans provider, le
 * délégué est nul et l'appelant échoue FERMÉ — jamais un boot cassé, jamais un chemin muet.
 */

/** Port `JarvisAdmissionUnitOfWorkPort` (§5.2) — la transaction d'admission unique. */
export const JARVIS_ADMISSION = Symbol('JARVIS_ADMISSION');

/** Port `JarvisProposalPayloadStorePort` (§5.5) — charge PII scellée des propositions. */
export const JARVIS_PROPOSAL_PAYLOAD_STORE = Symbol('JARVIS_PROPOSAL_PAYLOAD_STORE');

/** Autorité unique de publication, partagée par l'admission et le worker. */
export const JARVIS_ACTION_RELEASE_POLICY = Symbol('JARVIS_ACTION_RELEASE_POLICY');
