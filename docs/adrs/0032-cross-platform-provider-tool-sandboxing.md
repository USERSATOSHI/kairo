# ADR-0032: Provider tool sandboxes are capability-aware and cross-platform

- Status: Accepted
- Date: 2026-07-31
- Supersedes: the Bubblewrap-only OpenCode and Pi portions of ADR-0030

## Context

ADR-0030 made agent-controlled shell execution fail closed, but its reusable
adapter directly implemented Linux Bubblewrap. The CLI then incorrectly used
Bubblewrap presence as the availability signal for Claude, OpenCode, and Pi.
This reports Claude unavailable on macOS even though Claude uses its own native
Agent SDK sandbox, and it prevents OpenCode and Pi command tools from running
on supported non-Linux hosts.

Harness availability and command-sandbox availability are different facts. A
harness may safely support guarded file tools while its shell capability is
unavailable on the current host. Kouro must validate the capabilities required
by the compiled node rather than advertise one misleading process-wide boolean.

## Decision

Kouro owns two separate infrastructure boundaries:

1. `WorktreePathGuard` performs platform-neutral lexical, canonical-path, and
   symbolic-link containment checks for direct file tools.
2. `AgentCommandSandbox` executes agent-controlled commands with OS-enforced
   filesystem and network restrictions.

The default command adapter uses the pinned `@anthropic-ai/sandbox-runtime`
package:

- macOS uses Seatbelt through the runtime's generated profiles;
- Linux and WSL2 use Bubblewrap and the runtime's network bridge;
- native Windows uses the runtime's dedicated sandbox account, filesystem
  ACLs, and Windows Filtering Platform egress fence.

The sandbox runtime has process-global policy state. Kouro therefore invokes it
inside one short-lived helper process per command. Parallel attempts never
share or replace another attempt's sandbox policy. The helper initializes the
exact policy, wraps and executes one command, forwards output and termination,
and resets the runtime before exiting.

Policy continues to derive only from the compiled node capabilities and exact
worktree path. The worktree is writable only with `repository.write`; outbound
network access is denied unless `network.access` is declared; sensitive host
credential paths and environment variables are denied; and unavailable or
incomplete platform isolation is a typed failure with no unsandboxed fallback.

Harness ownership is:

- Codex uses its App Server sandbox.
- Claude uses the Agent SDK native sandbox plus `WorktreePathGuard`.
- OpenCode uses `AgentCommandSandbox` for Bash and keeps its provider-owned
  file permission policy.
- Pi uses `WorktreePathGuard` for file tools and `AgentCommandSandbox` for Bash.

Diagnostics report provider availability separately from shell-sandbox
availability and include an actionable reason. Run creation checks the
capabilities of explicitly routed harnesses before creating repository state.

Windows requires the sandbox runtime's one-time elevated provisioning. Kouro
exposes this only as an explicit operator setup command; ordinary execution
never self-elevates or silently provisions the host.

## Recovery and lifecycle

The helper is an imperative infrastructure process, not durable workflow
state. Attempt start, interruption, and recovery remain represented by Kouro's
existing events. Termination stops the helper and its sandboxed child. The
runtime performs normal cleanup on exit; its Windows adapter reconciles stale
session ACL state during the next initialization after an unclean exit.

## Consequences

- Claude diagnostics no longer depend on Bubblewrap.
- OpenCode and Pi command tools gain macOS and provisioned native-Windows
  support without weakening Linux isolation.
- Read/write capability and terminal capability can be diagnosed separately.
- The beta sandbox dependency is pinned exactly and remains behind Kouro's
  declared port so it can be replaced without changing domain or runtime code.
- macOS requires its built-in Seatbelt support and `rg`; Linux/WSL2 requires
  the runtime's documented Bubblewrap, `socat`, and `rg` dependencies; Windows
  requires one explicit provisioning step.

## Alternatives considered

- Treating every harness as unavailable without Bubblewrap preserves a false
  Linux-only product boundary and misrepresents Claude's native sandbox.
- Running unsandboxed on unsupported hosts violates ADR-0030 and makes compiled
  permissions host-dependent.
- Maintaining a Kouro-specific Seatbelt profile and Windows native helper
  duplicates security-sensitive platform code already provided by the pinned
  sandbox runtime.
- A singleton in-process sandbox manager cannot safely represent concurrent
  attempts with different policies.
