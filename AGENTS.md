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

## Final Response Rule

When replying to the user, summarize:

- what changed,
- which validations ran,
- what remains risky or unverified,
- whether another agent has an active claim or handoff.
