# Kouro M1 Runtime Model

M1 proves deterministic orchestration without performing external effects.

## Pure runtime boundary

```text
CompiledWorkflow + OrderedRunEvents
                  │
                  ▼
              reduceRun
                  │
                  ▼
              RunState
                  │
                  ▼
             scheduleRun
                  │
                  ▼
       Ordered OrchestrationIntents
```

`reduceRun` and `scheduleRun` are pure. Infrastructure later commits an intent
by assigning durable envelope data and appending the resulting event.

## Minimal lifecycle

Run states:

```text
created → running → waiting_for_approval
                   ↘ paused
                   ↘ succeeded
                   ↘ failed
                   ↘ cancelled
```

Invocation states:

```text
pending → active → waiting_for_approval → succeeded
                 ↘ interrupted          ↘ failed
                 ↘ cancelled
```

Attempt states:

```text
scheduled → running → succeeded
                    ↘ failed
                    ↘ interrupted
                    ↘ cancelled
```

The simulator initially models the facts needed to prove activation, completion,
transition selection, attempt retry, counter traversal, approval waiting, and
recovery selection. Later milestones may add intermediate durable states
without changing the identity rules.

M7 lifecycle controls preserve these distinctions:

- pause changes only run scheduling state and lets an active effect finish;
- resume restores either running or approval-waiting state from history;
- interrupt durably changes the active attempt to interrupted;
- retry remains another attempt in the same invocation and is recovery-policy
  checked;
- skip completes an eligible invocation with its declared outcome and a bound
  actor, reason, workflow, artifact set, and repository HEAD;
- cancellation is terminal.

Live agent control preserves the same durable boundary:

- steering is first recorded against the exact active invocation and attempt;
- the active harness forwards it to the provider turn and records applied or
  rejected delivery;
- interruption is first recorded, then forwarded to the provider turn;
- neither operation lets the provider schedule nodes, alter graph structure,
  increase limits, or bypass approvals.

## Event ordering

Events are supplied in strictly increasing sequence order. Reduction fails with
typed data when:

- a sequence is duplicated or missing;
- an event references an unknown definition, invocation, or attempt;
- an attempt number is not the next number for its invocation;
- a terminal entity receives an illegal event;
- an event contradicts the pinned workflow checksum.

The reducer never sorts events. Reordering history would change causality and is
therefore invalid input.

## Transition selection

When an invocation completes, transition evaluation:

1. selects outgoing transitions matching its definition and outcome;
2. evaluates every non-default condition against the same immutable state;
3. fails if more than one non-default transition matches;
4. selects the sole match when exactly one matches;
5. otherwise selects the single explicit default, if present;
6. otherwise returns `missing_transition`.

Transitions are normalized by stable transition ID during compilation. Runtime
selection does not use source declaration order.

A selected transition produces an activation intent. Committing that intent
increments its declared loop counter and creates the new invocation as one
atomic state change.

## Scheduler ordering

Runnable invocations are ordered by:

1. lower declared numeric priority;
2. lower compiler-assigned definition ordinal;
3. lower invocation sequence.

M1 is sequential, so the scheduler emits at most one execution intent. Approval
and recovery intents may also be emitted when they are the unique required next
action.

## Recovery

An interruption is ambiguous external state represented as a durable fact.
Scheduling maps the snapshotted operation policy to one deterministic intent:

| Policy | Intent |
| --- | --- |
| `replay_safe` | schedule the next attempt |
| `verify_then_replay` | verify the expected effect |
| `resume_supported` with token | resume the recorded session |
| `resume_supported` without token | request reconciliation |
| `manual_reconciliation` | request reconciliation |
| `never_automatically_retry` | halt automatic recovery |

Verification results and human reconciliation decisions become new events
before scheduling continues.

## M1 exclusions

M1 does not:

- execute commands;
- create worktrees;
- invoke Git;
- call a model or harness;
- persist to SQLite;
- expose HTTP;
- run nodes in parallel;
- generate durable IDs or timestamps.
