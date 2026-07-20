\set ON_ERROR_STOP on

-- Fixtures release flags posées par le rôle migration. Le rôle runtime certifie ensuite qu'il
-- peut seulement lire ses propres ciblages et ne peut jamais les muter.
INSERT INTO release_flag_subjects (
  id, "flagId", "subjectType", "subjectId", enabled, version, "updatedByUserId", "createdAt", "updatedAt"
)
VALUES
  ('rls-flag-user-pilot', 'cabinet-slice0-development', 'user', 'rls-user-pilot', true, 1, 'system:rls-cert', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  ('rls-flag-cab-a', 'cabinet-slice0-development', 'cabinet', 'rls-cab-a', true, 1, 'system:rls-cert', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  ('rls-flag-cab-b', 'cabinet-slice0-development', 'cabinet', 'rls-cab-b', true, 1, 'system:rls-cert', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
ON CONFLICT ("flagId", "subjectType", "subjectId") DO UPDATE
SET enabled = EXCLUDED.enabled,
    version = release_flag_subjects.version + 1,
    "updatedByUserId" = EXCLUDED."updatedByUserId",
    "updatedAt" = CURRENT_TIMESTAMP;
