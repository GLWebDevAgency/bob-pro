import { type NotificationJob } from '../persistence/notification-jobs';

/**
 * Deep link d'une notification (C25) — dérivé du couple (kind, dedupeKey) que les jobs posent
 * déjà (`invoice:{id}:relance:{date}`, `quote:{id}:token:{hash}`, `digest:{companyId}:{isoWeek}:v1`).
 * Aucune colonne supplémentaire : la clé de dédup EST la référence métier. null = notification
 * sans écran cible.
 */
export function notificationRoute(job: Pick<NotificationJob, 'kind' | 'dedupeKey'>): string | null {
  const [head, id] = job.dedupeKey.split(':');
  if (!id) return null;
  if (job.kind === 'invoice-relance' && head === 'invoice') return `/facture/${id}`;
  if (job.kind === 'quote-signature' && head === 'quote') return `/devis/${id}`;
  // Le digest hebdo n'a pas d'écran dédié : il ramène sur Aujourd'hui (la carte digest y vit — SPEC pilier 2).
  if (job.kind === 'weekly-digest' && head === 'digest') return '/(tabs)';
  return null;
}
