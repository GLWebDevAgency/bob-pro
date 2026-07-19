export interface AuthenticatedRuntimeIdentity {
  readonly subjectId: string;
  readonly companyId: string;
}

/**
 * Cle de montage du sous-arbre qui possede les ressources tenant (micro, sockets, brouillons).
 *
 * Le JSON d'un tuple evite toute collision par separateur. Un changement de societe pour le
 * meme utilisateur doit demonter synchronement l'ancien runtime, au meme titre qu'un changement
 * de compte : aucune ressource temps reel ne peut survivre a cette frontiere d'autorite.
 */
export function authenticatedRuntimeBoundaryKey(
  identity: AuthenticatedRuntimeIdentity,
): string {
  if (identity.subjectId.length === 0 || identity.companyId.length === 0) {
    throw new Error('authenticated_runtime_identity_missing');
  }
  return JSON.stringify([identity.subjectId, identity.companyId]);
}
