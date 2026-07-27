import type { JsonValue } from '@kouro/domain';

function isRecord(value: JsonValue | undefined): value is Readonly<Record<string, JsonValue>> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function harnessList(value: JsonValue | undefined): readonly string[] | undefined {
  return Array.isArray(value) &&
    value.length > 0 &&
    value.every((id) => typeof id === 'string' && id.trim())
    ? value
    : undefined;
}

/**
 * Selects the snapshotted ordered harness policy for one compiled agent node.
 *
 * A node-specific policy takes precedence over the run default. An explicitly
 * configured but invalid node policy does not fall through to the default.
 */
export function agentHarnessesForNode(
  configuration: Readonly<Record<string, JsonValue>>,
  nodeId: string,
  declaredHarness?: string,
): readonly string[] | undefined {
  if (declaredHarness !== undefined) {
    return declaredHarness.trim() ? [declaredHarness] : undefined;
  }
  const byNode = configuration.agentHarnessesByNode;
  if (byNode !== undefined && !isRecord(byNode)) return undefined;
  if (isRecord(byNode) && Object.hasOwn(byNode, nodeId)) {
    return harnessList(byNode[nodeId]);
  }
  return harnessList(configuration.agentHarnesses);
}
