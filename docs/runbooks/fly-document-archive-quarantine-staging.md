# Quarantaine exacte des brouillons FLY — staging

Ce runbook exécute la saga de
`design_handoff_bob_pro/SPEC_FLY_DOCUMENT_ARCHIVE_QUARANTINE_20260805.md`. Il ne s'applique ni à
la production, ni à un autre tenant, ni à une liste saisie par l'opérateur. Le périmètre fermé des
cinq objets est compilé dans l'artefact et vérifié contre un rapport Archive frais.

Exécuter les commandes dans une même session Bash. Les preuves locales sont privées et ne doivent
jamais être ajoutées au dépôt.

## 1. Préflight et capture de gouvernance

La CI `main` du SHA exact doit être verte, ce SHA doit être servi par staging après une release
normale, et aucun run du groupe `railway-api-staging` ne doit être actif.

```bash
set -euo pipefail

export REPO=GLWebDevAgency/bob-pro
export ENVIRONMENT=staging
export FOUNDER_ID=84627817
export STAGING_ENVIRONMENT_ID=18040709974
export RAILWAY_BIN=/chemin/absolu/vers/railway
export RELEASE_SHA="$(gh api "repos/$REPO/commits/main" --jq .sha)"
umask 077
export EVIDENCE_DIR="$(mktemp -d)"
chmod 700 "$EVIDENCE_DIR"

test "$(gh api user --jq .id)" = "$FOUNDER_ID"
test "$(gh api "repos/$REPO/commits/main" --jq .sha)" = "$RELEASE_SHA"
gh run list -R "$REPO" --limit 100 --json status,workflowName \
  --jq '[.[] | select(.status != "completed") | select(.workflowName as $name |
    ["AgentMission M2-A-3 Staging Preview",
     "AgentMission M2-A-3 Supabase Staging Schema",
     "AgentMission M1-B Staging Certification",
     "AgentMission M2-A-3 Semantic Model Staging",
     "Document Archive Quarantine Staging",
     "Railway API Release",
     "Realtime Voice Trace V2 Staging"] | index($name))] | length' \
  | grep -qx '0'
gh secret list --env "$ENVIRONMENT" -R "$REPO" --json name,updatedAt \
  > "$EVIDENCE_DIR/github-secrets-before.json"
jq -e '[.[] | select(.name == "DOCUMENT_ARCHIVE_RAILWAY_SSH_PRIVATE_KEY")] | length == 0' \
  "$EVIDENCE_DIR/github-secrets-before.json"

gh api "repos/$REPO/environments/$ENVIRONMENT" > "$EVIDENCE_DIR/environment-before.json"
gh api "repos/$REPO/environments/$ENVIRONMENT/deployment-branch-policies" \
  > "$EVIDENCE_DIR/branch-policies-before.json"

jq -S '{branch_policies: [.branch_policies[] | {id, name, type}] | sort_by(.id)}' \
  "$EVIDENCE_DIR/branch-policies-before.json" \
  > "$EVIDENCE_DIR/branch-policies-before.normalized.json"
jq -e '.branch_policies == [{id: 56135899, name: "main", type: "branch"}]' \
  "$EVIDENCE_DIR/branch-policies-before.normalized.json"

jq '
  def saved_reviewers:
    [.protection_rules[]? | select(.type == "required_reviewers") | .reviewers[]? |
      {type: .type, id: .reviewer.id}];
  {
    wait_timer: ([.protection_rules[]? | select(.type == "wait_timer") | .wait_timer][0] // 0),
    reviewers: saved_reviewers,
    prevent_self_review:
      ([.protection_rules[]? | select(.type == "required_reviewers") |
        .prevent_self_review][0] // false),
    can_admins_bypass: .can_admins_bypass,
    deployment_branch_policy: .deployment_branch_policy
  }
' "$EVIDENCE_DIR/environment-before.json" \
  > "$EVIDENCE_DIR/environment-restore-payload.json"
chmod 600 "$EVIDENCE_DIR"/*.json
```

Le SHA est maintenant gelé : si `main` avance avant la fin de l'apply, arrêter, redéployer le
nouveau SHA et recommencer par un nouveau plan.

## 2. Durcir temporairement l'environnement GitHub

```bash
jq -n --argjson founder "$FOUNDER_ID" '{
  wait_timer: 0,
  reviewers: [{type: "User", id: $founder}],
  prevent_self_review: false,
  can_admins_bypass: false,
  deployment_branch_policy: {protected_branches: false, custom_branch_policies: true}
}' > "$EVIDENCE_DIR/environment-jit-payload.json"

gh api --method PUT "repos/$REPO/environments/$ENVIRONMENT" \
  --input "$EVIDENCE_DIR/environment-jit-payload.json" \
  > "$EVIDENCE_DIR/environment-jit-response.json"
gh api "repos/$REPO/environments/$ENVIRONMENT" \
  > "$EVIDENCE_DIR/environment-jit-observed.json"
gh api "repos/$REPO/environments/$ENVIRONMENT/deployment-branch-policies" \
  > "$EVIDENCE_DIR/branch-policies-jit.json"

jq -e --argjson founder "$FOUNDER_ID" '
  .can_admins_bypass == false and
  .deployment_branch_policy == {protected_branches: false, custom_branch_policies: true} and
  ([.protection_rules[] | select(.type == "required_reviewers")] | length) == 1 and
  ([.protection_rules[] | select(.type == "required_reviewers") |
    select(.prevent_self_review == false) | .reviewers[] |
    select(.type == "User" and .reviewer.id == $founder)] | length) == 1
' "$EVIDENCE_DIR/environment-jit-observed.json"
jq -S '{branch_policies: [.branch_policies[] | {id, name, type}] | sort_by(.id)}' \
  "$EVIDENCE_DIR/branch-policies-jit.json" \
  > "$EVIDENCE_DIR/branch-policies-jit.normalized.json"
cmp "$EVIDENCE_DIR/branch-policies-before.normalized.json" \
  "$EVIDENCE_DIR/branch-policies-jit.normalized.json"
```

Cette protection reste active jusqu'à la révocation de la deuxième clé Railway et la suppression
prouvée du secret GitHub.

## 3. Fonctions JIT et dispatch exact

Chaque phase crée une clé Ed25519 dans un répertoire éphémère distinct. Le trap retire d'abord la
clé Railway, prouve son absence, supprime le secret GitHub, prouve son absence, puis détruit les
octets locaux. Les sorties de contrôle restent dans le répertoire privé de preuve.

```bash
JIT_REGISTERED=false
JIT_SECRET_SET=false
JIT_AGENT_STARTED=false
JIT_DIR=''
KEY=''
SSH_FINGERPRINT=''
SSH_KEY_NAME=''
JIT_AGENT_PID=''
JIT_AGENT_SOCKET=''
PHASE=''
ORIGINAL_SSH_AUTH_SOCK="${SSH_AUTH_SOCK-}"
ORIGINAL_SSH_AGENT_PID="${SSH_AGENT_PID-}"

extract_registered_railway_keys() {
  awk '
    /^Registered SSH Keys:$/ { registered=1; next }
    registered && /^[^[:space:]]/ { exit }
    registered { print }
  ' "$1"
}

stop_jit_agent() {
  local attempt
  [ "$JIT_AGENT_STARTED" = true ] || return 0

  SSH_AUTH_SOCK="$JIT_AGENT_SOCKET" SSH_AGENT_PID="$JIT_AGENT_PID" \
    ssh-agent -k > "$EVIDENCE_DIR/$PHASE-ssh-agent-stop.txt" 2>&1 || true
  for attempt in $(seq 1 5); do
    ! kill -0 "$JIT_AGENT_PID" 2>/dev/null && break
    sleep 1
  done
  if kill -0 "$JIT_AGENT_PID" 2>/dev/null; then
    kill -TERM "$JIT_AGENT_PID" 2>/dev/null || true
    for attempt in $(seq 1 5); do
      ! kill -0 "$JIT_AGENT_PID" 2>/dev/null && break
      sleep 1
    done
  fi
  if kill -0 "$JIT_AGENT_PID" 2>/dev/null; then
    kill -KILL "$JIT_AGENT_PID" 2>/dev/null || true
    for attempt in $(seq 1 5); do
      ! kill -0 "$JIT_AGENT_PID" 2>/dev/null && break
      sleep 1
    done
  fi
  wait "$JIT_AGENT_PID" 2>/dev/null || true
  ! kill -0 "$JIT_AGENT_PID" 2>/dev/null || return 1
  find "$JIT_DIR" -maxdepth 1 -type s -name agent.sock -delete || return 1
  ! test -S "$JIT_AGENT_SOCKET" || return 1
  JIT_AGENT_STARTED=false
}

close_jit() {
  local failed=0
  local railway_list_ok=true
  local secret_list_ok=true
  set +e
  if [ "$JIT_REGISTERED" = true ]; then
    "$RAILWAY_BIN" ssh keys remove "$SSH_FINGERPRINT" \
      > "$EVIDENCE_DIR/$PHASE-railway-remove.txt" 2>&1 || true
  fi
  # Railway CLI 5.26 lists both registered keys and keys still visible in the local agent.
  # Stop the isolated agent before proving the remote registration absent, otherwise the
  # just-revoked fingerprint is reported as an unregistered local key and creates a false alarm.
  stop_jit_agent || failed=1
  unset SSH_AUTH_SOCK SSH_AGENT_PID
  if [ "$JIT_REGISTERED" = true ]; then
    "$RAILWAY_BIN" ssh keys list \
      > "$EVIDENCE_DIR/$PHASE-railway-list-after-remove.txt" 2>&1 || {
        failed=1
        railway_list_ok=false
      }
    if [ "$railway_list_ok" = true ] &&
      ! grep -Fq -- "$SSH_FINGERPRINT" \
        "$EVIDENCE_DIR/$PHASE-railway-list-after-remove.txt"; then
      JIT_REGISTERED=false
    else
      failed=1
    fi
  fi
  if [ -n "$ORIGINAL_SSH_AUTH_SOCK" ]; then
    export SSH_AUTH_SOCK="$ORIGINAL_SSH_AUTH_SOCK"
  else
    unset SSH_AUTH_SOCK
  fi
  if [ -n "$ORIGINAL_SSH_AGENT_PID" ]; then
    export SSH_AGENT_PID="$ORIGINAL_SSH_AGENT_PID"
  else
    unset SSH_AGENT_PID
  fi
  if [ "$JIT_SECRET_SET" = true ]; then
    gh secret delete DOCUMENT_ARCHIVE_RAILWAY_SSH_PRIVATE_KEY \
      --env "$ENVIRONMENT" -R "$REPO" \
      > "$EVIDENCE_DIR/$PHASE-github-secret-delete.txt" 2>&1 || true
    gh secret list --env "$ENVIRONMENT" -R "$REPO" --json name,updatedAt \
      > "$EVIDENCE_DIR/$PHASE-github-secrets-after-delete.json" 2>&1 || {
        failed=1
        secret_list_ok=false
      }
    if [ "$secret_list_ok" = true ] && jq -e \
      '[.[] | select(.name == "DOCUMENT_ARCHIVE_RAILWAY_SSH_PRIVATE_KEY")] | length == 0' \
      "$EVIDENCE_DIR/$PHASE-github-secrets-after-delete.json" >/dev/null; then
      JIT_SECRET_SET=false
    else
      failed=1
    fi
  fi
  rm -rf -- "$JIT_DIR" || failed=1
  printf '{"phase":"%s","closedAt":"%s","fingerprint":"%s","jitAgentStopped":%s,"jitAgentSocketAbsent":%s,"success":%s}\n' \
    "$PHASE" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$SSH_FINGERPRINT" \
    "$([ "$JIT_AGENT_STARTED" = false ] && printf true || printf false)" \
    "$([ ! -S "$JIT_AGENT_SOCKET" ] && printf true || printf false)" \
    "$([ "$failed" -eq 0 ] && printf true || printf false)" \
    > "$EVIDENCE_DIR/$PHASE-jit-close-receipt.json" || failed=1
  chmod 600 "$EVIDENCE_DIR/$PHASE-jit-close-receipt.json" || failed=1
  set -e
  [ "$failed" -eq 0 ]
}

abort_with_jit_cleanup() {
  local original_status="$?"
  trap - EXIT HUP INT TERM
  close_jit || original_status=1
  exit "$original_status"
}

open_jit() {
  PHASE="$1"
  JIT_REGISTERED=false
  JIT_SECRET_SET=false
  JIT_AGENT_STARTED=false
  JIT_AGENT_PID=''
  JIT_DIR="$(mktemp -d)"
  chmod 700 "$JIT_DIR"
  KEY="$JIT_DIR/id_ed25519"
  ssh-keygen -q -t ed25519 -N '' -C "bob-quarantine-$PHASE-$RELEASE_SHA" -f "$KEY"
  SSH_FINGERPRINT="$(ssh-keygen -lf "$KEY" -E sha256 | awk '{print $2}')"
  SSH_KEY_NAME="bob-quarantine-$PHASE-${RELEASE_SHA:0:12}"
  SSH_STARTED_AT="$(date -u +%s)"
  SSH_EXPIRES_AT="$((SSH_STARTED_AT + 10800))"

  gh secret list --env "$ENVIRONMENT" -R "$REPO" --json name,updatedAt \
    > "$EVIDENCE_DIR/$PHASE-github-secrets-before-set.json"
  jq -e '[.[] | select(.name == "DOCUMENT_ARCHIVE_RAILWAY_SSH_PRIVATE_KEY")] | length == 0' \
    "$EVIDENCE_DIR/$PHASE-github-secrets-before-set.json"

  trap abort_with_jit_cleanup EXIT
  trap 'exit 129' HUP
  trap 'exit 130' INT
  trap 'exit 143' TERM

  # v5.26 selects only keys discovered through ssh-agent or ~/.ssh; it does not load an
  # arbitrary public-key path. Keep this one-off key outside ~/.ssh and expose it solely
  # through an isolated agent for the duration of the phase.
  JIT_AGENT_SOCKET="$JIT_DIR/agent.sock"
  agent_environment="$(ssh-agent -a "$JIT_AGENT_SOCKET" -s)"
  printf '%s\n' "$agent_environment" > "$EVIDENCE_DIR/$PHASE-ssh-agent-start.txt"
  eval "$agent_environment" >/dev/null
  JIT_AGENT_PID="${SSH_AGENT_PID:?ssh-agent did not publish its PID}"
  JIT_AGENT_STARTED=true
  test "$SSH_AUTH_SOCK" = "$JIT_AGENT_SOCKET"
  kill -0 "$JIT_AGENT_PID"
  test -S "$JIT_AGENT_SOCKET"
  ssh-add "$KEY" > "$EVIDENCE_DIR/$PHASE-ssh-add.txt" 2>&1
  ssh-add -l -E sha256 > "$EVIDENCE_DIR/$PHASE-ssh-agent-list.txt"
  grep -Fq -- "$SSH_FINGERPRINT" "$EVIDENCE_DIR/$PHASE-ssh-agent-list.txt"

  # Set before each mutation so a lost ACK still triggers reconciliation by fingerprint/name.
  JIT_REGISTERED=true
  "$RAILWAY_BIN" ssh keys add --key "$SSH_FINGERPRINT" \
    --name "$SSH_KEY_NAME" \
    > "$EVIDENCE_DIR/$PHASE-railway-add.txt" 2>&1
  "$RAILWAY_BIN" ssh keys list \
    > "$EVIDENCE_DIR/$PHASE-railway-list-after-add.txt" 2>&1
  extract_registered_railway_keys "$EVIDENCE_DIR/$PHASE-railway-list-after-add.txt" \
    > "$EVIDENCE_DIR/$PHASE-railway-registered-after-add.txt"
  grep -Fqx -- "  $SSH_KEY_NAME" "$EVIDENCE_DIR/$PHASE-railway-registered-after-add.txt"
  grep -Fqx -- "    Fingerprint: $SSH_FINGERPRINT" \
    "$EVIDENCE_DIR/$PHASE-railway-registered-after-add.txt"
  add_output_sha256="$(shasum -a 256 "$EVIDENCE_DIR/$PHASE-railway-add.txt" | awk '{print $1}')"
  list_output_sha256="$(shasum -a 256 \
    "$EVIDENCE_DIR/$PHASE-railway-list-after-add.txt" | awk '{print $1}')"
  printf '{"phase":"%s","startedAtEpoch":%s,"expiresAtEpoch":%s,"registeredAt":"%s","fingerprint":"%s","releaseSha":"%s","addOutputSha256":"%s","listOutputSha256":"%s"}\n' \
    "$PHASE" "$SSH_STARTED_AT" "$SSH_EXPIRES_AT" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
    "$SSH_FINGERPRINT" "$RELEASE_SHA" "$add_output_sha256" "$list_output_sha256" \
    > "$EVIDENCE_DIR/$PHASE-jit-open-receipt.json"
  chmod 600 "$EVIDENCE_DIR/$PHASE-jit-open-receipt.json"

  JIT_SECRET_SET=true
  gh secret set DOCUMENT_ARCHIVE_RAILWAY_SSH_PRIVATE_KEY \
    --env "$ENVIRONMENT" -R "$REPO" < "$KEY"
  gh secret list --env "$ENVIRONMENT" -R "$REPO" --json name,updatedAt \
    > "$EVIDENCE_DIR/$PHASE-github-secrets-after-set.json"
  jq -e '[.[] | select(.name == "DOCUMENT_ARCHIVE_RAILWAY_SSH_PRIVATE_KEY")] | length == 1' \
    "$EVIDENCE_DIR/$PHASE-github-secrets-after-set.json"

}

dispatch_quarantine() {
  local mode="$1"
  local digest="$2"
  local confirmation="$3"
  local output urls pending attempt

  test "$(gh api "repos/$REPO/commits/main" --jq .sha)" = "$RELEASE_SHA"
  output="$(gh workflow run document-archive-quarantine-staging.yml -R "$REPO" --ref main \
    -f mode="$mode" \
    -f expected_sha="$RELEASE_SHA" \
    -f manifest_digest="$digest" \
    -f confirmation="$confirmation" \
    -f ssh_key_fingerprint="$SSH_FINGERPRINT" \
    -f ssh_authorization_started_at_epoch="$SSH_STARTED_AT" \
    -f ssh_authorization_expires_at_epoch="$SSH_EXPIRES_AT")"
  printf '%s\n' "$output" > "$EVIDENCE_DIR/$mode-dispatch.txt"
  urls="$(printf '%s\n' "$output" |
    grep -Eo "https://github.com/$REPO/actions/runs/[0-9]+" || true)"
  test "$(printf '%s\n' "$urls" | sed '/^$/d' | wc -l | tr -d ' ')" = 1
  RUN_URL="$urls"
  RUN_ID="${RUN_URL##*/}"
  [[ "$RUN_ID" =~ ^[0-9]+$ ]]

  gh run view "$RUN_ID" -R "$REPO" \
    --json databaseId,event,headBranch,headSha,status,workflowName,url \
    > "$EVIDENCE_DIR/$mode-run-created.json"
  jq -e --arg sha "$RELEASE_SHA" --argjson id "$RUN_ID" '
    .databaseId == $id and .event == "workflow_dispatch" and .headBranch == "main" and
    .headSha == $sha and .workflowName == "Document Archive Quarantine Staging"
  ' "$EVIDENCE_DIR/$mode-run-created.json"

  pending="$EVIDENCE_DIR/$mode-pending-deployments.json"
  for attempt in $(seq 1 60); do
    gh api "repos/$REPO/actions/runs/$RUN_ID/pending_deployments" > "$pending"
    if jq -e --argjson environment "$STAGING_ENVIRONMENT_ID" '
      length == 1 and .[0].environment.id == $environment
    ' "$pending" >/dev/null; then break; fi
    sleep 2
  done
  jq -e --argjson environment "$STAGING_ENVIRONMENT_ID" '
    length == 1 and .[0].environment.id == $environment
  ' "$pending"

  jq -n --argjson environment "$STAGING_ENVIRONMENT_ID" --arg mode "$mode" '{
    environment_ids: [$environment], state: "approved",
    comment: ("Quarantaine staging autorisée — phase " + $mode + ", périmètre fermé")
  }' > "$EVIDENCE_DIR/$mode-approval.json"
  gh api --method POST "repos/$REPO/actions/runs/$RUN_ID/pending_deployments" \
    --input "$EVIDENCE_DIR/$mode-approval.json" \
    > "$EVIDENCE_DIR/$mode-approval-response.json"

  gh run watch "$RUN_ID" -R "$REPO" --exit-status
  gh run view "$RUN_ID" -R "$REPO" --json conclusion,headSha,status,workflowName \
    > "$EVIDENCE_DIR/$mode-run-completed.json"
  jq -e --arg sha "$RELEASE_SHA" '
    .status == "completed" and .conclusion == "success" and .headSha == $sha and
    .workflowName == "Document Archive Quarantine Staging"
  ' "$EVIDENCE_DIR/$mode-run-completed.json"

  close_jit
  trap - EXIT HUP INT TERM
}
```

## 4. Plan et validation de l'audit antérieur

```bash
open_jit plan
dispatch_quarantine plan '' ''
gh run download "$RUN_ID" -R "$REPO" \
  --name "document-archive-quarantine-plan-$RELEASE_SHA" \
  --dir "$EVIDENCE_DIR/plan"

export PLAN_RECEIPT="$EVIDENCE_DIR/plan/document-archive-quarantine-plan-receipt.json"
export INITIAL_AUDIT="$EVIDENCE_DIR/plan/.quarantine-evidence/initial-audit.json"
jq -e --arg sha "$RELEASE_SHA" '
  .schemaVersion == 2 and .environment == "staging" and .releaseSha == $sha and
  .entryCount == 5 and (.manifestDigest | test("^[0-9a-f]{64}$")) and
  (.companyIdSha256 | test("^[0-9a-f]{64}$"))
' "$PLAN_RECEIPT"
jq -e --arg sha "$RELEASE_SHA" '
  .schemaVersion == 1 and .releaseSha == $sha and .protocolVersion == 2 and
  .mode == "protocol-v2-verified" and .readyForActivation == false and
  .counts.storageOrphans == 5 and .counts.missingStoredObjects == 0 and
  .counts.p0Issues == 6 and
  .issueCodes == ["ARCHIVE_PROTOCOL_V2_STORAGE_ORPHAN_PRESENT",
                  "STORAGE_OBJECT_WITHOUT_SQL_REFERENCE"]
' "$INITIAL_AUDIT"
export MANIFEST_DIGEST="$(jq -r .manifestDigest "$PLAN_RECEIPT")"
[[ "$MANIFEST_DIGEST" =~ ^[0-9a-f]{64}$ ]]
```

Le plan ne retire aucune source. Un sixième orphelin, une référence SQL manquante, une anomalie
étrangère ou un autre SHA ferme le run.

## 5. Apply et validation croisée de l'audit 0/0/0

```bash
test "$(gh api "repos/$REPO/commits/main" --jq .sha)" = "$RELEASE_SHA"
open_jit apply
dispatch_quarantine apply "$MANIFEST_DIGEST" "QUARANTINE-STAGING:$MANIFEST_DIGEST"
gh run download "$RUN_ID" -R "$REPO" \
  --name "document-archive-quarantine-apply-$RELEASE_SHA" \
  --dir "$EVIDENCE_DIR/apply"

export DELETED_RECEIPT="$EVIDENCE_DIR/apply/document-archive-quarantine-deleted-receipt.json"
export COMPLETED_RECEIPT="$EVIDENCE_DIR/apply/document-archive-quarantine-completed-receipt.json"
export CURRENT_FINAL_AUDIT="$EVIDENCE_DIR/apply/.quarantine-evidence/final-audit.json"
if [ -f "$CURRENT_FINAL_AUDIT" ]; then
  export FINAL_AUDIT="$CURRENT_FINAL_AUDIT"
else
  : "${PRIOR_FINAL_AUDIT:?La reprise exige le final-audit.json privé du run précédent}"
  test -f "$PRIOR_FINAL_AUDIT"
  export FINAL_AUDIT="$PRIOR_FINAL_AUDIT"
fi
jq -e --arg sha "$RELEASE_SHA" --arg digest "$MANIFEST_DIGEST" '
  .schemaVersion == 2 and .environment == "staging" and .releaseSha == $sha and
  .manifestDigest == $digest and .phase == "deleted_verified" and .sourceCount == 5 and
  (.receiptSha256 | test("^[0-9a-f]{64}$"))
' "$DELETED_RECEIPT"
jq -e --arg sha "$RELEASE_SHA" '
  .schemaVersion == 1 and .releaseSha == $sha and .protocolVersion == 2 and
  .mode == "protocol-v2-verified" and .readyForActivation == true and
  .counts.storageOrphans == 0 and .counts.missingStoredObjects == 0 and
  .counts.p0Issues == 0 and .issueCodes == []
' "$FINAL_AUDIT"
jq -e --arg sha "$RELEASE_SHA" --arg digest "$MANIFEST_DIGEST" \
  --slurpfile audit "$FINAL_AUDIT" '
  .schemaVersion == 2 and .environment == "staging" and .releaseSha == $sha and
  .manifestDigest == $digest and .phase == "completed" and .sourceCount == 5 and
  .finalAuditDeploymentId == $audit[0].deploymentId and
  .finalAuditInventoryDigest == $audit[0].inventoryDigest and
  .finalAuditReportSha256 == $audit[0].reportSha256 and
  (.receiptSha256 | test("^[0-9a-f]{64}$"))
' "$COMPLETED_RECEIPT"
test "$(gh api "repos/$REPO/commits/main" --jq .sha)" = "$RELEASE_SHA"
```

À ce stade, les cinq sources sont absentes et leurs cinq copies vérifiées restent dans le bucket
privé de quarantaine. La preuve finale globale est exactement `0/0/0`.

## 6. Restaurer exactement la gouvernance capturée

La deuxième clé et le secret ont déjà été retirés par `dispatch_quarantine`. Restaurer seulement
après avoir vérifié les deux reçus JIT :

```bash
jq -e '
  .phase == "plan" and .jitAgentStopped == true and
  .jitAgentSocketAbsent == true and .success == true
' "$EVIDENCE_DIR/plan-jit-close-receipt.json"
jq -e '
  .phase == "apply" and .jitAgentStopped == true and
  .jitAgentSocketAbsent == true and .success == true
' "$EVIDENCE_DIR/apply-jit-close-receipt.json"

gh api --method PUT "repos/$REPO/environments/$ENVIRONMENT" \
  --input "$EVIDENCE_DIR/environment-restore-payload.json" \
  > "$EVIDENCE_DIR/environment-restore-response.json"
gh api "repos/$REPO/environments/$ENVIRONMENT" \
  > "$EVIDENCE_DIR/environment-after.json"
gh api "repos/$REPO/environments/$ENVIRONMENT/deployment-branch-policies" \
  > "$EVIDENCE_DIR/branch-policies-after.json"

jq '
  def saved_reviewers:
    [.protection_rules[]? | select(.type == "required_reviewers") | .reviewers[]? |
      {type: .type, id: .reviewer.id}];
  {
    wait_timer: ([.protection_rules[]? | select(.type == "wait_timer") | .wait_timer][0] // 0),
    reviewers: saved_reviewers,
    prevent_self_review:
      ([.protection_rules[]? | select(.type == "required_reviewers") |
        .prevent_self_review][0] // false),
    can_admins_bypass: .can_admins_bypass,
    deployment_branch_policy: .deployment_branch_policy
  }
' "$EVIDENCE_DIR/environment-after.json" \
  > "$EVIDENCE_DIR/environment-after.normalized.json"
cmp "$EVIDENCE_DIR/environment-restore-payload.json" \
  "$EVIDENCE_DIR/environment-after.normalized.json"

jq -S '{branch_policies: [.branch_policies[] | {id, name, type}] | sort_by(.id)}' \
  "$EVIDENCE_DIR/branch-policies-after.json" \
  > "$EVIDENCE_DIR/branch-policies-after.normalized.json"
cmp "$EVIDENCE_DIR/branch-policies-before.normalized.json" \
  "$EVIDENCE_DIR/branch-policies-after.normalized.json"
```

## 7. Release normale finale du même SHA

```bash
test "$(gh api "repos/$REPO/commits/main" --jq .sha)" = "$RELEASE_SHA"
output="$(gh workflow run railway-api.yml -R "$REPO" --ref main \
  -f purpose=release -f environment=staging -f service=bob-pro-api)"
printf '%s\n' "$output" > "$EVIDENCE_DIR/final-release-dispatch.txt"
urls="$(printf '%s\n' "$output" |
  grep -Eo "https://github.com/$REPO/actions/runs/[0-9]+" || true)"
test "$(printf '%s\n' "$urls" | sed '/^$/d' | wc -l | tr -d ' ')" = 1
export FINAL_RELEASE_RUN_ID="${urls##*/}"
[[ "$FINAL_RELEASE_RUN_ID" =~ ^[0-9]+$ ]]

gh run view "$FINAL_RELEASE_RUN_ID" -R "$REPO" \
  --json databaseId,event,headBranch,headSha,workflowName \
  > "$EVIDENCE_DIR/final-release-created.json"
jq -e --arg sha "$RELEASE_SHA" --argjson id "$FINAL_RELEASE_RUN_ID" '
  .databaseId == $id and .event == "workflow_dispatch" and .headBranch == "main" and
  .headSha == $sha and .workflowName == "Railway API Release"
' "$EVIDENCE_DIR/final-release-created.json"
gh run watch "$FINAL_RELEASE_RUN_ID" -R "$REPO" --exit-status
gh run download "$FINAL_RELEASE_RUN_ID" -R "$REPO" \
  --name "document-archive-staging-$RELEASE_SHA" \
  --dir "$EVIDENCE_DIR/final-release"

export RELEASE_AUDIT="$EVIDENCE_DIR/final-release/audit-$RELEASE_SHA.json"
jq -e --arg sha "$RELEASE_SHA" '
  .schemaVersion == 1 and .releaseSha == $sha and .protocolVersion == 2 and
  .mode == "protocol-v2-verified" and .readyForActivation == true and
  .counts.storageOrphans == 0 and .counts.missingStoredObjects == 0 and
  .counts.p0Issues == 0 and .issueCodes == []
' "$RELEASE_AUDIT"

export API_BASE_URL="$(gh variable get API_BASE_URL --env "$ENVIRONMENT" -R "$REPO")"
curl --proto '=https' --tlsv1.2 --fail --silent --show-error --max-time 15 \
  "${API_BASE_URL%/}/health/ready" > "$EVIDENCE_DIR/final-readiness.json"
jq -e --arg sha "$RELEASE_SHA" '
  .ready == true and .release.sha == $sha and .release.environment == "staging"
' "$EVIDENCE_DIR/final-readiness.json"
test "$(gh api "repos/$REPO/commits/main" --jq .sha)" = "$RELEASE_SHA"
```

La demande est `released` uniquement après ce dernier audit `0/0/0`, la readiness du SHA exact et
la conservation privée du reçu final.

## Incident et reprise

- Ne jamais supprimer directement dans `storage.objects` ni via la console Supabase.
- Ne jamais modifier le manifeste ou remplacer le digest après le plan.
- Après un apply interrompu, noter son `RUN_ID`, laisser le trap fermer la fenêtre JIT, puis
  télécharger son artefact privé avant la relance :

  ```bash
  export PRIOR_APPLY_RUN_ID=<run-id-échoué>
  gh run view "$PRIOR_APPLY_RUN_ID" -R "$REPO" \
    --json event,headSha,workflowName > "$EVIDENCE_DIR/prior-apply-run.json"
  jq -e --arg sha "$RELEASE_SHA" '
    .event == "workflow_dispatch" and .headSha == $sha and
    .workflowName == "Document Archive Quarantine Staging"
  ' "$EVIDENCE_DIR/prior-apply-run.json"
  gh run download "$PRIOR_APPLY_RUN_ID" -R "$REPO" \
    --name "document-archive-quarantine-apply-$RELEASE_SHA" \
    --dir "$EVIDENCE_DIR/prior-apply"
  export PRIOR_FINAL_AUDIT="$EVIDENCE_DIR/prior-apply/.quarantine-evidence/final-audit.json"
  test -f "$PRIOR_FINAL_AUDIT"
  ```

  Relancer ensuite le même `apply` avec une nouvelle clé JIT et le même digest. Si le workflow
  reprend une preuve `final_audit_verified` durable, il saute volontairement le nouvel audit ; la
  section 5 exige alors ce `PRIOR_FINAL_AUDIT` et le recoupe avec le reçu `completed`. Sans cette
  preuve antérieure exacte, la reprise reste fermée. La machine d'état ne rejoue jamais une
  suppression acquittée.

- Si une révocation Railway ou la suppression du secret GitHub n'est pas prouvée, l'incident reste
  ouvert et la protection staging ne doit pas être restaurée.
- Si `main` avance, l'ancien manifeste n'est plus applicable : redéployer et replanifier.
- Les preuves privées peuvent contenir des identifiants opérationnels. Garder `EVIDENCE_DIR` hors
  dépôt avec permissions `0700`, puis l'archiver selon la politique interne.
