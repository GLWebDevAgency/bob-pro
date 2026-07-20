-- Statut `cancelled` des jobs de notification : intention métier RÉVOQUÉE avant livraison.
-- Cas fondateur (embargo L221-10) : le client exerce sa rétractation en ligne entre la
-- programmation de l'encaissement à J+7 et son échéance — demander alors le paiement à un
-- consommateur rétracté (L221-25 : rien n'est dû) exposerait l'artisan (pratique trompeuse)
-- et contredirait l'accusé de réception D221-5. Le job passe pending|failed -> cancelled
-- (payload purgé côté applicatif) et n'est plus jamais réclamé par le worker (les claims ne
-- visent que pending|failed). Migration STRICTEMENT ADDITIVE : aucune ligne existante modifiée.
ALTER TYPE "NotificationJobStatus" ADD VALUE IF NOT EXISTS 'cancelled';
