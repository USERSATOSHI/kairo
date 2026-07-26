# Kairo — Milestone TODO

> Auto-generated from `plan.md`. Update checkboxes as work progresses.

---

## M1 — Deterministic compiler and simulator

Status: **Complete** (accepted 2026-07-26)

### Deliverables

- [x] Terminology and invariants (`docs/terminology.md`, `docs/invariants.md`)
- [x] Five foundational ADRs (`docs/adrs/0001-0005`)
- [x] Content-addressed compiled bundle
- [x] Canonical serialization and checksum
- [x] Pure reducer
- [x] Exact transition selection
- [x] Explicit loop counters
- [x] Deterministic scheduler intents
- [x] Executable replay simulations

### Exit criteria

- [x] Recompiling unchanged input is byte-identical
- [x] Same bundle and events always produce same state and intents
- [x] Invalid, missing, or ambiguous transitions produce typed failures
- [x] Every cycle has an explicit bound
- [x] Retries do not increment repair counters
- [x] Recovery decisions depend only on recorded state and declared policy

### Evidence

| Test | Status |
| --- | --- |
| `package-compiler.test.ts` | [x] |
| `deterministic-replay.test.ts` | [x] |
| `compiler-validation.test.ts` | [x] |
| `transition-selection.test.ts` | [x] |
| `invocation-vs-attempt.test.ts` | [x] |
| `bounded-loop.test.ts` | [x] |
| `recovery-decision.test.ts` | [x] |
| `command-approval-command.test.ts` | [x] |
| `malformed-history.test.ts` | [x] |

### Packages delivered

- [x] `@kairo/domain` — pure types
- [x] `@kairo/adw` — ADW compilation
- [x] `@kairo/runtime` — pure reduction, scheduling, transition

---

## M2 — Durable command and approval runtime

Status: **Complete** (accepted 2026-07-26)

### Packages to create

- [x] `packages/persistence-sqlite/` — scaffold via `bun run create-package persistence-sqlite`
- [x] `packages/executors/` — scaffold
- [x] `packages/api-contracts/` — scaffold

### Deliverables

- [x] SQLite event store and projections
- [x] Command, approval, and complete executors
- [x] Invocation and attempt persistence
- [x] Idempotency records
- [x] Restart recovery

### Exit criteria

- [x] Command -> approval -> command -> complete survives restart
- [x] Approvals remain pending across restart
- [x] Completed invocations are not duplicated
- [x] Duplicate event sequences are rejected

### Evidence

| Test | Status |
| --- | --- |
| `sqlite-event-store.test.ts` | [x] |
| `run-store.contract.ts` | [x] |

---

## M3 — Worktree and Git recovery

Status: **Complete** (accepted 2026-07-26)

### Packages to create

- [x] `packages/sandbox-worktree/` — scaffold

### Deliverables

- [x] Repository registration and pinned starting commit
- [x] One worktree per run
- [x] Git status and diff artifacts
- [x] Controlled commit operations
- [x] Repository mutation coordination
- [x] Cleanup and recovery

### Exit criteria

- [x] Concurrent runs use isolated worktrees
- [x] Interrupted creation reuses or safely reconciles the worktree
- [x] Commit recovery verifies the expected tree and does not duplicate commits

### Evidence

| Test | Status |
| --- | --- |
| `worktree-sandbox-provider.test.ts` | [x] |

---

## M4 — Harness-independent agent execution

Status: **Complete** (accepted 2026-07-26)

### Packages to create

- [x] `packages/harnesses/` — scaffold

### Deliverables

- [x] Normalized harness contract and registry
- [x] Scripted fake harness
- [x] Agent executor
- [x] Structured output validation
- [x] Event and artifact persistence
- [x] Claude Code, Codex, OpenCode, and Pi adapters
- [x] Per-agent-node harness routing with node-specific fallback order
- [x] Optional workflow-level agent harness pins
- [x] Explicit fallback and resume policies

### Exit criteria

- [x] The same ADW runs through every supported harness
- [x] One run routes different agent nodes through different harnesses
- [x] Workflow pins override run policy; omitted pins use CLI routing
- [x] Harness-specific details do not leak into workflow definitions
- [x] Invalid structured output becomes a typed node failure
- [x] Retry and fallback remain attempts of one invocation

### Evidence

| Test | Status |
| --- | --- |
| `harness-independent-agent.test.ts` | [x] |

---

## M5 — Feature-development vertical slice

Status: **Complete** (accepted 2026-07-26)

### Workflow

```
worktree -> plan -> approval -> implement -> validate
                                      ^ failure |
                         review --changes------+
                            | approved
                    delivery approval -> complete
```

### Limits

- [x] Maximum validation-feedback traversals to the implementation agent: 3
- [x] Maximum review-feedback traversals to the implementation agent: 2
- [x] Maximum run duration: 8 hours
- [x] Maximum node invocations: 30

### Exit criteria

- [x] A fixture task reaches a merge-ready branch
- [x] Interruption and restart preserve the run
- [x] Repair loops stop at their exact bounds
- [x] Review is read-only by policy
- [x] Final artifacts include plan, tests, review, and diff

---

## M6 — Observable Elysia and web MVP

Status: **Complete** (accepted 2026-07-26)

### Deliverables

- [x] Elysia application factory and composition root
- [x] Application use cases and typed API contracts
- [x] Eden client
- [x] Run, workflow, repository, artifact, event, and approval endpoints
- [x] Typed reconnectable event stream
- [x] Run list and read-only React Flow graph
- [x] Node details, logs, artifacts, diff, and approval controls

### Exit criteria

- [x] API tests run without opening a network port
- [x] Domain and runtime packages do not import Elysia
- [x] A run can be understood without reading SQLite
- [x] Approval can be completed through the web UI
- [x] Reconnecting clients replay events after the last received sequence

---

## M7 — Runnable local MVP and operator CLI

Status: **Complete** (accepted 2026-07-26)

### Package to create

- [x] `packages/cli/` — scaffold via `bun run create-package cli`

### Deliverables

- [x] Distributable `kairo` binary with stable help, version, and typed errors
- [x] Predictable local data and configuration paths
- [x] Local ADW run, run list, and run inspection commands
- [x] Approval and rejection commands
- [x] Pause, resume, cancel, interrupt, retry, and policy-eligible skip commands
- [x] Long-lived worker loop with startup recovery and clean shutdown
- [x] Single-process SQLite, worktree, artifact, harness, API, and web composition
- [x] Packaged built-in feature-development ADW
- [x] Repository registration, starting-commit pinning, and run worktree orchestration
- [x] Automatic final test, status, diff, and review artifact publication
- [x] Controlled commit and named merge-ready branch delivery
- [x] Durable lifecycle events and application use cases
- [x] Run creation, lifecycle, and complete local repository API surfaces
- [x] Harness availability diagnostics
- [x] Lifecycle, worker-ownership, and composition ADRs

### CLI surface

- [x] `kairo run <adw> --repo <path> [--harness <id>]`
- [x] `kairo runs`
- [x] `kairo status <run-id>`
- [x] `kairo approve <run-id> <invocation> --reason <text>`
- [x] `kairo reject <run-id> <invocation> --reason <text>`
- [x] `kairo pause|resume|cancel <run-id>`
- [x] `kairo interrupt|retry|skip <run-id> <invocation> --reason <text>`
- [x] `kairo serve`

### Exit criteria

- [x] A fresh checkout can invoke `kairo --help` without a custom host script
- [x] The built-in feature workflow reaches a named merge-ready branch
- [x] CLI approvals stop and resume the same durable run
- [x] Process termination and restart do not duplicate completed work or Git effects
- [x] Pause and interrupt remain distinct durable operations
- [x] Resume and retry obey the declared recovery policy
- [x] Skip requires workflow eligibility and a durable bound actor and reason
- [x] CLI and web share one observable approval and run state
- [x] Decision-affecting CLI configuration is snapshotted into the run
- [x] End-to-end tests cover subprocess, SQLite, Git, worktree, restart, and HTTP boundaries

---

## Deferred (post-MVP)

- [ ] Bug-fix, chore, and hotfix ADWs
- [ ] Subworkflows and explicit input/output mapping
- [ ] Parallel branches, joins, branch cancellation, and leases
- [ ] Installable Git-based ADW packs and lockfiles
- [ ] Hosted registry or marketplace
- [ ] Kyuki and Vedh integrations
- [ ] Ticket and Git hosting integrations
- [ ] Docker, VM, SSH, or remote-worker sandboxes
- [ ] PostgreSQL and separate workers
- [ ] Visual workflow editing
- [ ] Deployment and merge automation
