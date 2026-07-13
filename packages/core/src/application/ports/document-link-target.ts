import { type DocumentLinkedEntityType } from '../../domain/document/document';

export interface DocumentLinkTargetInput {
  companyId: string;
  linkedEntityType: DocumentLinkedEntityType;
  linkedEntityId: string;
}

/**
 * Preuve d'existence tenant-scoped pour les rattachements polymorphes du coffre.
 *
 * Le port ne distingue volontairement pas « absent » de « autre tenant » : l'adaptateur
 * doit répondre false dans les deux cas afin de ne jamais transformer le coffre en oracle IDOR.
 */
export interface DocumentLinkTargetPort {
  exists(input: DocumentLinkTargetInput): Promise<boolean>;
}
