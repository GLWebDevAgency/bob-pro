-- Les colonnes suivantes étaient des valeurs saisissables/seedées sans autorité comptable.
-- Les métriques client sont désormais dérivées à la lecture des factures et paiements du tenant.
-- Leur suppression est volontaire : aucune donnée historique de ces colonnes n'est réputée fiable.
ALTER TABLE "customers"
  DROP COLUMN "score",
  DROP COLUMN "avgDelayDays",
  DROP COLUMN "outstanding";
