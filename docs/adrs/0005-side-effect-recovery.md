# ADR-0005: Side effects declare recovery classifications

- Status: Accepted
- Date: 2026-07-26

## Context

A process can crash after an external effect completes but before its completion
event commits. Kouro cannot generally determine whether replaying an arbitrary
operation is safe and therefore cannot promise universal exactly-once effects.

## Decision

Every concrete side-effecting node operation snapshots one recovery policy:

```ts
type RecoveryPolicy =
	| "replay_safe"
	| "verify_then_replay"
	| "resume_supported"
	| "manual_reconciliation"
	| "never_automatically_retry";
```

Policy is configured per operation. An executor may validate which policies it
supports but does not impose one policy on all nodes of its type.

Recovery decisions depend only on the recorded interruption, snapshotted
policy, attempt history, and recorded resume or verification data.

## Serialized representation

```ts
interface OperationRecovery {
	policy: RecoveryPolicy;
	resumeToken?: string;
}

type RecoveryIntent =
	| { type: "attempt.schedule"; invocationSequence: number; attempt: number }
	| { type: "effect.verify"; invocationSequence: number; attempt: number }
	| { type: "session.resume"; invocationSequence: number; token: string }
	| { type: "reconciliation.request"; invocationSequence: number }
	| { type: "recovery.halt"; invocationSequence: number };
```

## Failure behavior

Missing resume data for `resume_supported` requests reconciliation. Manual and
never-retry policies never create another automatic attempt. Unsupported or
unknown policies are compilation failures.

## Counterexample

Automatically rerunning a deployment command after a crash may deploy twice.
An idempotency key alone cannot prove whether the first remote deployment
completed.

## Executable acceptance scenarios

1. `replay_safe` schedules the next attempt.
2. `verify_then_replay` requests verification before replay.
3. `resume_supported` resumes when a durable token exists.
4. Missing resume data requests reconciliation.
5. Manual and never-retry policies do not schedule automatic execution.
6. Replaying the same interrupted state produces the same recovery intent.
