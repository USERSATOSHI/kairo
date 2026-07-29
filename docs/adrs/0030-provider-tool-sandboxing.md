# ADR-0030: Provider tools execute inside fail-closed sandboxes

- Status: Accepted
- Date: 2026-07-29

## Context

Kouro's Git worktrees isolate repository state but do not isolate an agent tool
from the host filesystem, processes, credentials, or network. Tool allowlists
reduce the exposed surface, but an allowed shell can still read or modify host
paths and open network connections.

The provider process itself must retain access to its model API and credentials.
Sandboxing the complete SDK process would either break model traffic or expose
the same credentials and provider network access to agent-controlled commands.
The isolation boundary must therefore surround tool execution rather than the
provider control plane.

## Decision

Every supported harness applies a fail-closed tool sandbox:

- Codex uses its App Server sandbox policy.
- Claude uses the Agent SDK's native command sandbox with unsandboxed-command
  escape disabled. A pre-tool hook rejects file operations outside the exact
  worktree.
- OpenCode denies external directories and ambient plugins. A Kouro-owned
  plugin rewrites every Bash command through the Bubblewrap implementation.
- Pi replaces its built-in file and Bash tools with Kouro-owned guarded tools.
  File operations reject lexical and symlink escapes; Bash runs through the
  Bubblewrap implementation.

The reusable Bubblewrap implementation is owned by
`@kouro/sandbox-worktree`. It:

1. mounts the host root read-only;
2. rebinds the exact worktree read-write only when `repository.write` is
   declared;
3. creates private process, IPC, UTS, and temporary-filesystem boundaries;
4. hides common credential directories and files from the command;
5. removes the command's network namespace unless a declared capability
   contains `network`; and
6. fails the tool call when Bubblewrap is missing or cannot establish a
   requested boundary.

Provider API traffic and provider credentials stay in the unsandboxed SDK
control process. They are not copied into the sandbox command environment.
Kouro passes a minimal environment needed for ordinary build tools.

Sandbox policy is derived only from the compiled attempt capabilities and exact
worktree path. Agents cannot broaden it. Provider settings, prompts, steering,
or tool arguments cannot request an unsandboxed fallback.

## Consequences

- Agent-controlled commands cannot write outside the worktree.
- Commands without a network capability cannot use the host network.
- Read-only agents cannot modify the worktree through direct file tools or
  shell commands.
- Common host credential paths are not readable from sandboxed commands.
- Linux installations using Claude, OpenCode, or Pi command tools require
  `bwrap`. Codex retains its own platform support.
- A command that legitimately requires network access must declare a network
  capability in both the workflow permissions and node capabilities.
- Worktree isolation, tool sandboxing, workflow authorization, and durable
  approvals remain separate layers.

This does not claim VM-grade isolation. Bubblewrap shares the host kernel, and
declared network access grants ordinary outbound network access to the command.
Stronger multi-tenant deployments should run Kouro workers inside containers,
gVisor, or virtual machines as an additional outer boundary.

## Alternatives considered

- Tool allowlists alone were rejected because an allowed shell retains host
  authority.
- Sandboxing the complete SDK process was rejected because it mixes model
  control-plane traffic and credentials with untrusted tool execution.
- Docker-only execution was rejected as the local default because it requires
  image and dependency lifecycle management for every repository. It remains
  a valid stronger outer deployment boundary.
- Silently falling back to host execution was rejected because sandbox
  availability must not change the meaning of compiled permissions.
