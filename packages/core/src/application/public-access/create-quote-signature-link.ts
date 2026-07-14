import { type Result } from '../../shared-kernel/result';
import { type AppError } from '../result';
import {
  CreateQuoteSignatureToken,
  type CreateQuoteSignatureTokenDeps,
} from './create-quote-signature-token';

export type CreateQuoteSignatureLinkDeps = CreateQuoteSignatureTokenDeps;

/**
 * P0 R4 — « Envoyer le lien » déclenchait un e-mail sortant avant toute confirmation : la
 * préparation d'un lien partageable et l'envoi d'un e-mail sont désormais DEUX commandes
 * distinctes. Celle-ci prépare le lien SANS AUCUN effet sortant : ses dépendances ne
 * contiennent aucun port de notification/outbox — l'absence d'e-mail est prouvée par
 * construction, pas par discipline d'appel. Annuler le partage côté client = rien n'est parti.
 *
 * Même mécanique de jeton que `sendQuote` (via CreateQuoteSignatureToken) : le devis doit être
 * numéroté et en `sent`/`viewed`, les jetons `quote_signature` actifs sont révoqués puis un
 * nouveau jeton est émis (rotation — l'ancien lien cesse immédiatement d'être résolvable).
 */
export class CreateQuoteSignatureLink {
  constructor(private readonly deps: CreateQuoteSignatureLinkDeps) {}

  execute(input: { quoteId: string }): Promise<Result<{ token: string; expiresAt: string }, AppError>> {
    return new CreateQuoteSignatureToken(this.deps).execute(input);
  }
}
