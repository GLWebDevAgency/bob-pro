import {
  DEFAULT_DOCUMENT_FOLDERS,
  DOCUMENT_FOLDER_SYSTEM_KEYS,
  type DocumentFolderSystemKey,
} from './document-folder';

/**
 * Suggestion de destination d'un document — le « Je pense : … » de Bob.
 *
 * RAPPEL FONDATEUR : un document n'est PAS forcément lié à un chantier (dépense carte
 * société, abonnement, Kbis, attestation…). `system_folder` est donc un résultat de
 * première classe, jamais un échec. Toute suggestion est VALIDÉE contre un contexte
 * tenant réel : un chantierId inventé par le modèle est rejeté (anti-hallucination),
 * et le libellé provient toujours du contexte, jamais du modèle.
 */
export type DocumentDestinationSuggestion =
  | {
      kind: 'chantier';
      /** Id d'un chantier ouvert PRÉSENT dans le contexte fourni au modèle. */
      chantierId: string;
      /** Libellé prêt à afficher — le nom réel du chantier, jamais un libellé du modèle. */
      label: string;
      /** Motif court (« matériel pour le chantier Durand »), assaini. */
      motif: string;
    }
  | {
      kind: 'system_folder';
      systemKey: DocumentFolderSystemKey;
      /** Libellé produit du dossier système (« Achats », « Assurances »…). */
      label: string;
      motif: string;
    };

/** Forme non fiable produite par un adapter LLM avant validation du domaine. */
export interface DocumentDestinationSuggestionDraft {
  kind?: string | null;
  chantierId?: string | null;
  systemKey?: string | null;
  /** Ignoré volontairement : le libellé est toujours dérivé du contexte validé. */
  label?: string | null;
  motif?: string | null;
}

/**
 * Contexte tenant autoritaire pour la validation : seules ces cibles existent.
 * Il reflète ce qui a été FOURNI au modèle — tout id hors contexte est une hallucination.
 */
export interface DocumentDestinationContext {
  /** Chantiers ouverts du tenant (id réel + nom). */
  chantiers: readonly { id: string; nom: string }[];
  /** Clés système autorisées — par défaut, toutes les clés produit. */
  systemKeys?: readonly DocumentFolderSystemKey[];
}

export const DOCUMENT_DESTINATION_MOTIF_MAX_LENGTH = 140;

/** Motifs déterministes quand le modèle n'en fournit pas d'exploitable. */
const DEFAULT_CHANTIER_MOTIF = 'Chantier reconnu dans le document.';
const DEFAULT_SYSTEM_FOLDER_MOTIF = 'Classement selon le type de document.';

const SYSTEM_FOLDER_LABELS = new Map<DocumentFolderSystemKey, string>(
  DEFAULT_DOCUMENT_FOLDERS.map((folder) => [folder.systemKey, folder.name]),
);

/** Libellé produit d'un dossier système (« purchases » → « Achats »). */
export function documentSystemFolderLabel(systemKey: DocumentFolderSystemKey): string {
  return SYSTEM_FOLDER_LABELS.get(systemKey) ?? systemKey;
}

/** Assainit un texte court : caractères de contrôle → espace, espaces réduits, borné. */
function cleanShortText(value: string, maxLength: number): string {
  return [...value]
    .map((character) => {
      const code = character.charCodeAt(0);
      return code <= 31 || code === 127 ? ' ' : character;
    })
    .join('')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxLength)
    .trim();
}

function isSystemKey(value: string): value is DocumentFolderSystemKey {
  return (DOCUMENT_FOLDER_SYSTEM_KEYS as readonly string[]).includes(value);
}

/**
 * Valide une suggestion de destination non fiable contre le contexte tenant.
 *
 * Rejet (null) — jamais d'exception, jamais de devinette :
 * - chantierId absent du contexte (anti-hallucination) ;
 * - clé système inconnue ou hors de la liste autorisée ;
 * - kind inconnu ou brouillon vide.
 * L'appelant enchaîne alors sur le fallback déterministe (`fallbackDocumentDestinationFor`).
 */
export function makeDocumentDestinationSuggestion(
  raw: DocumentDestinationSuggestionDraft | null | undefined,
  contexte: DocumentDestinationContext,
): DocumentDestinationSuggestion | null {
  if (!raw) return null;
  const motif = cleanShortText(raw.motif ?? '', DOCUMENT_DESTINATION_MOTIF_MAX_LENGTH);

  if (raw.kind === 'chantier') {
    const chantierId = (raw.chantierId ?? '').trim();
    if (!chantierId) return null;
    const chantier = contexte.chantiers.find((candidate) => candidate.id === chantierId);
    if (!chantier) return null; // id inventé par le modèle — rejet anti-hallucination
    const label = chantier.nom.replace(/\s+/g, ' ').trim();
    if (!label) return null;
    return { kind: 'chantier', chantierId, label, motif: motif || DEFAULT_CHANTIER_MOTIF };
  }

  if (raw.kind === 'system_folder') {
    const systemKey = (raw.systemKey ?? '').trim();
    if (!isSystemKey(systemKey)) return null;
    const allowed = contexte.systemKeys ?? DOCUMENT_FOLDER_SYSTEM_KEYS;
    if (!allowed.includes(systemKey)) return null;
    return {
      kind: 'system_folder',
      systemKey,
      label: documentSystemFolderLabel(systemKey),
      motif: motif || DEFAULT_SYSTEM_FOLDER_MOTIF,
    };
  }

  return null;
}
