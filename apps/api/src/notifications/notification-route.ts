import { type NotificationJob } from '../persistence/notification-jobs';

/**
 * Deep link d'une notification (C25) — dérivé du couple (kind, dedupeKey) que les jobs posent
 * déjà (`invoice:{id}:relance:{date}`, `quote:{id}:token:{hash}`). Aucune colonne supplémentaire :
 * la clé de dédup EST la référence métier. null = notification sans écran cible.
 */
export function notificationRoute(job: Pick<NotificationJob, 'kind' | 'dedupeKey'>): string | null {
  const [head, id] = job.dedupeKey.split(':');
  if (!id) return null;
  if (job.kind === 'invoice-relance' && head === 'invoice') return `/facture/${id}`;
  if (job.kind === 'quote-signature' && head === 'quote') return `/devis/${id}`;
  return null;
}
