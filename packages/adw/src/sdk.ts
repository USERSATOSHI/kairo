import type {
  Expression,
  JsonPrimitive,
  JsonValue,
  RecoveryPolicy,
  SourceTransition,
} from '@kouro/domain';

export interface AgentNodeAuthoring {
  readonly type: 'agent';
  readonly role: string;
  readonly prompt: string;
  readonly outputSchema?: string;
  readonly harness?: string;
  readonly models?: Readonly<Record<string, string>>;
  readonly clearContext?: boolean;
  readonly capabilities?: readonly string[];
  readonly priority?: number;
  readonly recoveryPolicy: RecoveryPolicy;
  readonly skipOutcome?: string;
}

export interface ApprovalNodeAuthoring {
  readonly type: 'approval';
  readonly title: string;
  readonly priority?: number;
  readonly skipOutcome?: string;
}

export interface CommandNodeAuthoring {
  readonly type: 'command';
  readonly command: string;
  readonly capabilities?: readonly string[];
  readonly priority?: number;
  readonly recoveryPolicy: RecoveryPolicy;
  readonly skipOutcome?: string;
}

export interface CompleteNodeAuthoring {
  readonly type: 'complete';
  readonly priority?: number;
  readonly result?: 'succeeded' | 'failed';
}

export type NodeAuthoring =
  | AgentNodeAuthoring
  | ApprovalNodeAuthoring
  | CommandNodeAuthoring
  | CompleteNodeAuthoring;

export interface WorkflowAuthoringDefinition {
  readonly id: string;
  readonly version: string;
  readonly entry: string;
  readonly nodes: Readonly<Record<string, NodeAuthoring>>;
  readonly transitions: readonly SourceTransition[];
  readonly permissions?: readonly string[];
  readonly defaults?: Readonly<Record<string, JsonValue>>;
  readonly limits?: {
    readonly counters?: Readonly<Record<string, number>>;
    readonly maxDurationMs?: number;
    readonly maxNodeInvocations?: number;
  };
  readonly subworkflows?: Readonly<
    Record<
      string,
      {
        readonly package: string;
        readonly version: string;
      }
    >
  >;
}

export interface WorkflowBuilderOptions {
  readonly id: string;
  readonly version: string;
}

export interface RunLimitsAuthoring {
  readonly maxDurationMs?: number;
  readonly maxNodeInvocations?: number;
}

export interface SubworkflowAuthoring {
  readonly package: string;
  readonly version: string;
}

export const enum WorkflowAuthoringErrorKind {
  DuplicateNode = 'duplicate_node',
  DuplicateCounter = 'duplicate_counter',
  ForeignNodeHandle = 'foreign_node_handle',
  ForeignCounterHandle = 'foreign_counter_handle',
  DuplicateEntry = 'duplicate_entry',
  IncompleteTransition = 'incomplete_transition',
  MissingEntry = 'missing_entry',
}

/** A fail-fast error caused by inconsistent local builder usage. */
export class WorkflowAuthoringError extends Error {
  constructor(
    readonly kind: WorkflowAuthoringErrorKind,
    message: string,
  ) {
    super(message);
    this.name = 'WorkflowAuthoringError';
  }
}

export interface NodeHandle {
  readonly id: string;
}

export interface TransitionNodeHandle extends NodeHandle {
  on(outcome: string): TransitionStart;
}

export interface CompleteNodeHandle extends NodeHandle {}

export interface CounterHandle {
  readonly name: string;
  readonly limit: number;
  lessThan(value: number): Expression;
  atLeast(value: number): Expression;
  belowLimit(): Expression;
  atLimit(): Expression;
}

export interface TransitionTarget {
  increment(counter: CounterHandle): TransitionTarget;
  to(target: NodeHandle): void;
}

export interface TransitionStart {
  when(condition: Expression): TransitionTarget;
  otherwise(): TransitionTarget;
  increment(counter: CounterHandle): TransitionStart;
  to(target: NodeHandle): void;
}

interface BuilderContext {
  beginTransition(node: NodeHandle, outcome: string): TransitionDraftBuilder;
  addTransition(draft: TransitionDraft, target: NodeHandle): void;
  assertCounterOwnership(counter: CounterHandle): void;
}

interface TransitionDraft {
  readonly from: NodeHandle;
  readonly outcome: string;
  condition?: Expression;
  default?: true;
  increment?: CounterHandle;
}

class AuthoredNodeHandle implements TransitionNodeHandle {
  constructor(
    readonly id: string,
    private readonly context: BuilderContext,
  ) {}

  on(outcome: string): TransitionStart {
    return this.context.beginTransition(this, outcome);
  }
}

class AuthoredCompleteNodeHandle implements CompleteNodeHandle {
  constructor(readonly id: string) {}
}

class AuthoredCounterHandle implements CounterHandle {
  constructor(
    readonly name: string,
    readonly limit: number,
  ) {}

  lessThan(value: number): Expression {
    return comparison('lt', this.name, value);
  }

  atLeast(value: number): Expression {
    return comparison('gte', this.name, value);
  }

  belowLimit(): Expression {
    return this.lessThan(this.limit);
  }

  atLimit(): Expression {
    return this.atLeast(this.limit);
  }
}

class TransitionDraftBuilder implements TransitionStart, TransitionTarget {
  constructor(
    private readonly context: BuilderContext,
    private readonly draft: TransitionDraft,
  ) {}

  when(condition: Expression): TransitionTarget {
    this.draft.condition = condition;
    return this;
  }

  otherwise(): TransitionTarget {
    this.draft.default = true;
    return this;
  }

  increment(counter: CounterHandle): this {
    this.context.assertCounterOwnership(counter);
    this.draft.increment = counter;
    return this;
  }

  to(target: NodeHandle): void {
    this.context.addTransition(this.draft, target);
  }
}

/** Owns the mutable state used to author a data-only workflow definition. */
export class WorkflowBuilder implements BuilderContext {
  private readonly nodes = new Map<string, NodeAuthoring>();
  private readonly nodeHandles = new Set<NodeHandle>();
  private readonly counters = new Map<string, number>();
  private readonly counterHandles = new Set<CounterHandle>();
  private readonly transitions: SourceTransition[] = [];
  private readonly pendingTransitions = new Set<TransitionDraft>();
  private readonly subworkflows = new Map<string, SubworkflowAuthoring>();
  private entryHandle: NodeHandle | undefined;
  private declaredPermissions: readonly string[] | undefined;
  private declaredDefaults: Readonly<Record<string, JsonValue>> | undefined;
  private declaredRunLimits: RunLimitsAuthoring | undefined;

  constructor(private readonly options: WorkflowBuilderOptions) {}

  permissions(...permissions: readonly string[]): this {
    this.declaredPermissions = [...permissions];
    return this;
  }

  defaults(defaults: Readonly<Record<string, JsonValue>>): this {
    this.declaredDefaults = { ...defaults };
    return this;
  }

  runLimits(limits: RunLimitsAuthoring): this {
    this.declaredRunLimits = { ...limits };
    return this;
  }

  counter(name: string, limit: number): CounterHandle {
    if (this.counters.has(name)) {
      throw authoringError(
        WorkflowAuthoringErrorKind.DuplicateCounter,
        `Counter "${name}" is already declared`,
      );
    }
    const handle = new AuthoredCounterHandle(name, limit);
    this.counters.set(name, limit);
    this.counterHandles.add(handle);
    return handle;
  }

  subworkflow(name: string, definition: SubworkflowAuthoring): this {
    this.subworkflows.set(name, { ...definition });
    return this;
  }

  agent(name: string, config: Omit<AgentNodeAuthoring, 'type'>): TransitionNodeHandle {
    return this.addTransitionNode(name, { type: 'agent', ...config });
  }

  approval(name: string, config: Omit<ApprovalNodeAuthoring, 'type'>): TransitionNodeHandle {
    return this.addTransitionNode(name, { type: 'approval', ...config });
  }

  command(name: string, config: Omit<CommandNodeAuthoring, 'type'>): TransitionNodeHandle {
    return this.addTransitionNode(name, { type: 'command', ...config });
  }

  complete(name: string, config: Omit<CompleteNodeAuthoring, 'type'> = {}): CompleteNodeHandle {
    this.assertUniqueNode(name);
    const handle = new AuthoredCompleteNodeHandle(name);
    this.nodes.set(name, { type: 'complete', ...config });
    this.nodeHandles.add(handle);
    return handle;
  }

  startAt(node: NodeHandle): this {
    this.assertNodeOwnership(node);
    if (this.entryHandle) {
      throw authoringError(
        WorkflowAuthoringErrorKind.DuplicateEntry,
        `Entry node is already assigned to "${this.entryHandle.id}"`,
      );
    }
    this.entryHandle = node;
    return this;
  }

  build(): WorkflowAuthoringDefinition {
    if (!this.entryHandle) {
      throw authoringError(
        WorkflowAuthoringErrorKind.MissingEntry,
        'Workflow entry node has not been assigned',
      );
    }
    const incomplete = this.pendingTransitions.values().next().value;
    if (incomplete) {
      throw authoringError(
        WorkflowAuthoringErrorKind.IncompleteTransition,
        `Transition from "${incomplete.from.id}.${incomplete.outcome}" has no target`,
      );
    }

    const limits = this.buildLimits();
    return {
      id: this.options.id,
      version: this.options.version,
      entry: this.entryHandle.id,
      nodes: Object.fromEntries(this.nodes),
      transitions: this.transitions.map((transition) => ({ ...transition })),
      ...(this.declaredPermissions ? { permissions: [...this.declaredPermissions] } : {}),
      ...(this.declaredDefaults ? { defaults: { ...this.declaredDefaults } } : {}),
      ...(limits ? { limits } : {}),
      ...(this.subworkflows.size > 0
        ? { subworkflows: Object.fromEntries(this.subworkflows) }
        : {}),
    };
  }

  beginTransition(node: NodeHandle, outcome: string): TransitionDraftBuilder {
    this.assertNodeOwnership(node);
    const draft: TransitionDraft = { from: node, outcome };
    this.pendingTransitions.add(draft);
    return new TransitionDraftBuilder(this, draft);
  }

  addTransition(draft: TransitionDraft, target: NodeHandle): void {
    this.assertNodeOwnership(target);
    if (!this.pendingTransitions.delete(draft)) {
      throw authoringError(
        WorkflowAuthoringErrorKind.IncompleteTransition,
        `Transition from "${draft.from.id}.${draft.outcome}" is already complete`,
      );
    }
    const source = `${draft.from.id}.${draft.outcome}`;
    this.transitions.push({
      id: `${source}.${target.id}`,
      from: { nodeId: draft.from.id, outcome: draft.outcome },
      toNodeId: target.id,
      ...(draft.condition ? { condition: draft.condition } : {}),
      ...(draft.default ? { default: true } : {}),
      ...(draft.increment ? { increment: draft.increment.name } : {}),
    });
  }

  assertCounterOwnership(counter: CounterHandle): void {
    if (!this.counterHandles.has(counter)) {
      throw authoringError(
        WorkflowAuthoringErrorKind.ForeignCounterHandle,
        `Counter "${counter.name}" belongs to another workflow builder`,
      );
    }
  }

  private addTransitionNode(name: string, node: NodeAuthoring): TransitionNodeHandle {
    this.assertUniqueNode(name);
    const handle = new AuthoredNodeHandle(name, this);
    this.nodes.set(name, node);
    this.nodeHandles.add(handle);
    return handle;
  }

  private assertUniqueNode(name: string): void {
    if (this.nodes.has(name)) {
      throw authoringError(
        WorkflowAuthoringErrorKind.DuplicateNode,
        `Node "${name}" is already declared`,
      );
    }
  }

  private assertNodeOwnership(node: NodeHandle): void {
    if (!this.nodeHandles.has(node)) {
      throw authoringError(
        WorkflowAuthoringErrorKind.ForeignNodeHandle,
        `Node "${node.id}" belongs to another workflow builder`,
      );
    }
  }

  private buildLimits(): WorkflowAuthoringDefinition['limits'] | undefined {
    const counters = this.counters.size > 0 ? Object.fromEntries(this.counters) : undefined;
    if (!counters && !this.declaredRunLimits) {
      return undefined;
    }
    return {
      ...(counters ? { counters } : {}),
      ...this.declaredRunLimits,
    };
  }
}

interface OutputExpression {
  equals(value: JsonPrimitive): Expression;
}

/** Creates an output reference rooted at the provided non-empty path. */
export function output(...path: readonly string[]): OutputExpression {
  const reference = Object.freeze({ scope: 'output' as const, path: Object.freeze([...path]) });
  return Object.freeze({
    equals(value: JsonPrimitive): Expression {
      return Object.freeze({ op: 'eq', left: reference, right: value });
    },
  });
}

/** Requires every provided expression to match. */
export function all(...expressions: readonly Expression[]): Expression {
  return Object.freeze({ op: 'and', expressions: Object.freeze([...expressions]) });
}

/** Requires at least one provided expression to match. */
export function any(...expressions: readonly Expression[]): Expression {
  return Object.freeze({ op: 'or', expressions: Object.freeze([...expressions]) });
}

/** Negates an expression. */
export function not(expression: Expression): Expression {
  return Object.freeze({ op: 'not', expression });
}

function comparison(op: 'gte' | 'lt', counter: string, right: number): Expression {
  return Object.freeze({
    op,
    left: Object.freeze({ scope: 'counter' as const, name: counter }),
    right,
  });
}

function authoringError(kind: WorkflowAuthoringErrorKind, message: string): WorkflowAuthoringError {
  return new WorkflowAuthoringError(kind, message);
}
