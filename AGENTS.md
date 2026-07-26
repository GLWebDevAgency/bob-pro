# Bob Pro Agent Collaboration Protocol

This repository may be worked on by multiple AI coding agents, especially Codex and Claude Opus.
Only one agent writes at a time. The other agents review, challenge, audit, or prepare a handoff in
read-only mode until the active writer explicitly passes the baton. The goal is to combine strengths
without parallel branches, overwritten work, duplicated effort, or weakened architecture.

## Non-Negotiables

- Treat `git status`, the working tree, `.agent-sync/`, and `refs/agents/*` as the source of truth. Do not rely on memory.
- Before editing, run `git status --short --branch`, inspect current diffs, and read the other agent's Git-ref/file claims.
- Never revert, overwrite, or reformat another agent's changes unless the user explicitly asks for it.
- Keep Clean Architecture boundaries: core domain/application stay framework-free; infra details stay in adapters.
- Every financial/security change must include a targeted test or a written reason why it cannot be tested locally.
- Prefer small, atomic changes. If committing, commit only your own coherent changes after validations pass.
- Work is objective-driven and spec-driven: no significant implementation starts without a written
  objective, explicit scope, invariants, binary acceptance criteria, and Definition of Done.

## Objective and Specification Gate

- The publication authority is
  `design_handoff_bob_pro/OBJECTIFS_SPECS_DOD_PUBLICATION.md`. A narrower track spec may refine it
  but may not contradict it silently.
- Before editing code, identify the objective ID served by the change and the exact acceptance
  criterion that will prove it. If either is absent, write or amend the spec first.
- Track status uses only `specified`, `implemented`, `certified`, and `released`. Code existence is
  at most `implemented`; only reproducible evidence promotes it to `certified` or `released`.
- A Definition of Done is binary. Percentages, intuition, a passing typecheck, or an uncalled module
  are never substitutes for the required tests, runtime wiring, data truth, device proof, and
  operational checks.
- When product direction changes, update the objective/spec/ADR first, then change code, flags and
  deployment configuration atomically.

## Communication Channels

Preferred live channel:

- `.agent-sync/git-native/PROTOCOL.md` describes the Git-ref coordination protocol.
- `.agent-sync/git-native/agent.sh` writes status and claims to `refs/agents/<id>` without touching the working tree.
- Codex uses `AGENT_ID=gpt`; Claude uses `AGENT_ID=claude`.
- Read live claims with `git show refs/agents/<other>:claims.tsv`.

Fallback readable channel:

- `.agent-sync/README.md` explains the coordination model.
- `.agent-sync/codex.md` is written by Codex only.
- `.agent-sync/claude.md` is written by Claude only.
- `.agent-sync/claims/codex.md` is Codex's current file/path claim.
- `.agent-sync/claims/claude.md` is Claude's current file/path claim.
- `.agent-sync/handoffs/*.md` are immutable handoff notes. Create a new timestamped file instead of editing old ones.

## Work Cycle

1. Context and spec:
   - Read the canonical objective, relevant track spec, ADRs, and Definition of Done.
   - State the objective ID, scope, non-goals, acceptance criteria, and planned evidence.
   - Amend the spec before code when the requested direction is not represented accurately.
2. Sync:
   - Run `git status --short --branch`.
   - Run `git log --oneline --decorate -n 8`.
   - Run `git diff --name-status`.
   - Run `git for-each-ref --format='%(refname:short) %(objectname:short)' refs/agents`.
   - Read the other agent's Git-ref claims/status first, then fallback files if they exist.
3. Claim:
   - Prefer `AGENT_ID=<gpt|claude> bash .agent-sync/git-native/agent.sh claim ...`.
   - If the helper is unavailable, update only your own file under `.agent-sync/claims/`.
   - Include objective, files/areas you intend to touch, start time, and planned validation.
4. Execute:
   - Avoid paths claimed by the other agent.
   - If overlap is unavoidable, create a handoff note and wait for the file to become unclaimed or clearly handed off.
   - Re-run `git status` before editing any file that could plausibly have changed concurrently.
5. Verify:
   - Run the smallest meaningful targeted validation first.
   - Run broader validations before declaring the task complete.
6. Handoff:
   - Update only your own status file.
   - If another agent should continue, create a new file in `.agent-sync/handoffs/`.

## Default Role Split

- Codex default lane: implementation, tests, refactoring, transactionality, type/lint/build verification, security hardening.
- Claude default lane: adversarial review, product/compliance depth, UX/accounting-agent strategy, gap analysis, architectural critique.
- Either agent may take any lane after an explicit handoff. The incoming writer starts from fresh
  `main`; the outgoing writer becomes read-only until the next pass.

## Conflict Rules

- If another agent has changed a file you need, read it first and adapt to it.
- If both agents need the same file, the active writer finishes or writes a handoff; the reviewer
  does not modify a different worktree in parallel.
- If a merge/conflict-like situation appears, stop broad edits and produce a status note with exact paths and recommended resolution.
- Do not use destructive git commands (`reset --hard`, `checkout --`, forced cleanups`) without explicit user instruction.

## Commit Rules

- Do not auto-commit purely process/status files unless the user asked for commits or the repository is already using agent commits.
- When committing code, include only the coherent change set you own.
- Mention the agent in the commit body if useful, but keep commit subjects product-focused.

## Release Lessons — 25 July 2026

These rules come from observed staging/production incidents and are permanent:

- CI on an ephemeral superuser PostgreSQL never proves Supabase production. ACL and membership
  certifications must run as a non-superuser deployer. On Supabase, use
  `createrole_self_grant='set'` at role creation instead of granting membership back to the
  deployer; run post-transfer operations under `SET ROLE` to the owner; and explicitly revoke the
  default `anon`, `authenticated`, and `service_role` exposure on every new public table or
  function. Replay every new release SQL script against Supabase staging before merge.
- Every expand migration has a writer N-1 test. It inserts the exact N-1 row shape under every
  intermediate and final trigger state. Put `SET LOCAL lock_timeout` and
  `SET LOCAL statement_timeout` at the start of every migration. If `NOT VALID` is used,
  validation is a later migration. Generate CHECK value lists from their TypeScript source of
  truth and guard them against drift.
- A domain semantic change requires an exhaustive consumer audit in the same commit: renderer,
  PDF, Factur-X, API, mobile, export, and any persisted immutable artifact. Add an end-to-end
  integration test for the visible result.
- A paginated maintenance protocol acknowledges a page once the owned page was entirely attempted.
  Individual failures remain due and are rediscovered; one failing tenant must not freeze every
  other tenant or key rotation.
- Agents never self-authorize a founder decision. Record the date and channel of the actual founder
  instruction and obtain the other agent's countersignature before changing the flag matrix or
  unique publication list. Resolve an “À confirmer” item explicitly; never overwrite it.
- Describe a fix truthfully. If correctness is restored by closing a capability, state the closed
  capability, product impact, and fallback instead of calling it a transparent correction.
- Environment law is `PR -> validated staging -> production`. Only production APKs target
  production Railway; preview, development, and simulators target staging. Never relink a working
  directory to another environment without a recorded handoff.
- Any publication requirement that needs unavailable founder input is marked
  `[BLOQUÉ FONDATEUR : <input>]`; a Definition of Done must remain executable.
- Every CI/monitoring output has an explicit empty-value default. One incident creates one issue
  without periodic noise. Tokens are environment-scoped, and a secret is considered available only
  after it is actually installed and verified.

## Final Response Rule

When replying to the user, summarize:

- what changed,
- which validations ran,
- what remains risky or unverified,
- whether another agent has an active claim or handoff.
