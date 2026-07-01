# Bob Pro Agent Collaboration Protocol

This repository may be edited by multiple AI coding agents at the same time, especially Codex and Claude Opus.
The goal is to combine strengths without overwriting work, duplicating effort, or weakening architecture.

## Non-Negotiables

- Treat `git status`, the working tree, `.agent-sync/`, and `refs/agents/*` as the source of truth. Do not rely on memory.
- Before editing, run `git status --short --branch`, inspect current diffs, and read the other agent's Git-ref/file claims.
- Never revert, overwrite, or reformat another agent's changes unless the user explicitly asks for it.
- Keep Clean Architecture boundaries: core domain/application stay framework-free; infra details stay in adapters.
- Every financial/security change must include a targeted test or a written reason why it cannot be tested locally.
- Prefer small, atomic changes. If committing, commit only your own coherent changes after validations pass.

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

1. Sync:
   - Run `git status --short --branch`.
   - Run `git log --oneline --decorate -n 8`.
   - Run `git diff --name-status`.
   - Run `git for-each-ref --format='%(refname:short) %(objectname:short)' refs/agents`.
   - Read the other agent's Git-ref claims/status first, then fallback files if they exist.
2. Claim:
   - Prefer `AGENT_ID=<gpt|claude> bash .agent-sync/git-native/agent.sh claim ...`.
   - If the helper is unavailable, update only your own file under `.agent-sync/claims/`.
   - Include objective, files/areas you intend to touch, start time, and planned validation.
3. Execute:
   - Avoid paths claimed by the other agent.
   - If overlap is unavoidable, create a handoff note and wait for the file to become unclaimed or clearly handed off.
   - Re-run `git status` before editing any file that could plausibly have changed concurrently.
4. Verify:
   - Run the smallest meaningful targeted validation first.
   - Run broader validations before declaring the task complete.
5. Handoff:
   - Update only your own status file.
   - If another agent should continue, create a new file in `.agent-sync/handoffs/`.

## Default Role Split

- Codex default lane: implementation, tests, refactoring, transactionality, type/lint/build verification, security hardening.
- Claude default lane: adversarial review, product/compliance depth, UX/accounting-agent strategy, gap analysis, architectural critique.
- Either agent may take any lane after an explicit handoff or when the other lane is idle.

## Conflict Rules

- If another agent has changed a file you need, read it first and adapt to it.
- If both agents need the same file, the agent with the active claim finishes or writes a handoff.
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
