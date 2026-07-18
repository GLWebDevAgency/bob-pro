-- Chaque tenant doit porter un état d'abonnement explicite. Les sociétés créées avant la table
-- subscriptions recevaient historiquement un accès anticipé Business gratuit en mémoire : cette
-- décision produit devient une vraie ligne BDD, auditable et tenant-scoped.
INSERT INTO "subscriptions" (
  "id",
  "companyId",
  "plan",
  "status",
  "trialEndsAt",
  "currentPeriodEnd",
  "store",
  "storeRef",
  "createdAt",
  "updatedAt"
)
SELECT
  'sub-' || c."id",
  c."id",
  'business'::"SubscriptionPlan",
  'active'::"SubscriptionStatus",
  NULL,
  NULL,
  'none'::"SubscriptionStore",
  NULL,
  CURRENT_TIMESTAMP,
  CURRENT_TIMESTAMP
FROM "companies" c
WHERE NOT EXISTS (
  SELECT 1
  FROM "subscriptions" s
  WHERE s."companyId" = c."id"
)
ON CONFLICT ("companyId") DO NOTHING;
