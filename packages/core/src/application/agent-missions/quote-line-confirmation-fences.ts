import {
  type LineConfirmationDecisionV1,
} from '../../domain/agent/agent-mission';
import {
  type AgentMissionQuoteLineWork,
} from './quote-line-work';

/**
 * Invariant commun à la reprise froide et à la confirmation.
 *
 * Une décision scellée n'est exécutable que si elle décrit exactement la même tête durable. Une
 * divergence ici est une corruption interne/fence stale, jamais un changement fiscal récupérable.
 */
export function lineConfirmationDecisionMatchesWork(
  decision: LineConfirmationDecisionV1,
  workItem: AgentMissionQuoteLineWork,
): boolean {
  const catalogueMatches = decision.expectedCatalogue === null
    ? (
        workItem.catalogueResolution === 'free'
        && workItem.catalogueItemId === null
        && workItem.expectedCatalogueRevision === null
      )
    : (
        workItem.catalogueResolution === 'selected'
        && workItem.catalogueItemId === decision.expectedCatalogue.itemId
        && workItem.expectedCatalogueRevision
          === decision.expectedCatalogue.revision
      );
  return (
    workItem.id === decision.pendingLineId
    && workItem.revision === decision.expectedWorkRevision
    && workItem.state === 'awaiting_confirmation'
    && workItem.proposalId === decision.proposalId
    && workItem.proposalRevision === decision.proposalRevision
    && workItem.proposalDiffHash === decision.diffHash
    && catalogueMatches
  );
}
