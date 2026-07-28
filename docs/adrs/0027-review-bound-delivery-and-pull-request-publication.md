# ADR-0027 — Delivery is bound to an exact reviewed tree

- Status: Accepted
- Date: 2026-07-28

## Context

Kouro previously captured the final diff, committed it with a hard-coded
message, and created a branch immediately before a successful complete node.
The operator therefore approved a workflow action rather than the exact tree,
commit message, and pull-request proposal that Kouro delivered.

Approvals can also be submitted from the launching CLI or web dashboard while a
leased worker owns orchestration. Pull-request creation adds another
interruptible side effect whose retry must not create duplicates.

## Decision

`delivery_review` is an explicit compiled node authored with a title and the
read-only agent node that proposes delivery metadata. New runs never receive
implicit Git finalization. A custom workflow without a delivery-review node
finishes without a Kouro commit or branch. Runs created before this decision
retain legacy finalization only for restart compatibility.

Before requesting delivery approval, the worker:

1. captures checksum-bearing status and binary diff artifacts;
2. stages the worktree and records its exact HEAD and tree;
3. validates commit and pull-request titles as non-empty single lines;
4. publishes the metadata proposal as an artifact; and
5. appends `delivery.proposed`.

The approval binding includes the workflow checksum, invocation, repository
HEAD, all published artifact checksums, prepared tree, and proposal checksum.
Metadata edits append `delivery.metadata_updated` and replace the bound proposal
checksum. The first decision event committed at the expected event sequence
wins. A stale CLI or web submission receives a conflict and refreshes durable
state; the worker lease remains the only orchestration owner.

Approval commits the prepared tree with the approved metadata and deterministic
Kouro identity, then creates `kouro/<run-id>`. Commit recovery is
`verify_then_replay`: the worktree must still produce the prepared tree, HEAD
must still name the prepared parent, and a delivery branch may only already
exist at the same commit. Kouro never silently recaptures a changed tree.

`changes_requested` returns the required reason to the same implementation
agent context. Shipped starters bound this path to two traversals. Rejection is
terminal but preserves the worktree, artifacts, and audit history; deletion
remains a separate confirmed operation.

Run creation snapshots a named base branch. The base must resolve to the pinned
starting commit; detached repositories require `--base`.

Pull-request publication uses the provider-neutral `PullRequestProvider` port
with GitHub and Forgejo adapters. The local branch is pushed without force after
verifying that the configured remote repository matches the selected provider.
Retries inspect the remote branch and an existing head/base pull request before
creating either. Push and pull-request failures append a retryable publication
failure without changing the successful local run result. Credentials remain
constructor inputs and are never durable state.

## Consequences

- CLI and web review one durable proposal and observe decisions through the
  same event stream.
- The approved content and metadata are explicit, inspectable, and recoverable.
- Provider project-board configuration is not required for pull requests.
- Local success and remote publication are separate results.
- Existing active runs remain restartable without changing their historical
  compiled workflow.

## Alternatives considered

- Keeping finalization as a worker hook leaves the delivered tree outside the
  approval binding.
- Letting a CLI or browser own an approval would make detachment and concurrent
  review unsafe.
- Force-pushing a delivery branch would overwrite external state and defeat
  verify-then-replay recovery.
- Provider-specific orchestration in the CLI would duplicate recovery rules and
  couple the application boundary to one forge.
