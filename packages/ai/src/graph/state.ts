import { Annotation } from '@langchain/langgraph';
import type { Eligibility, GuardrailResult } from '@cx/shared';
import type { ImageEvidence, ComposedReply, ComposeMode, Understanding } from '../llm/types.js';
import type { DeliveryEstimate, OrderFacts, PolicyRef } from '../policy/rules.js';
import type { Route } from '../policy/intent.js';
import type { Intent } from '@cx/shared';
import type {
  CaseDerived,
  CaseState,
  NextAction,
  PersistedCaseState,
  WorkflowStage,
} from '../case-state.js';
import type { ConversationContext, TraceEntry } from '../ports.js';
import type { RetrievalResult } from '../retrieval.js';

export interface SourceRef {
  id: string;
  label: string;
  category: string | null;
  title: string;
  version: number;
  content: string;
  rank: number;
  vector_score: number | null;
  text_score: number | null;
  fused_score: number;
}

export interface LatestMessage {
  id: string;
  body: string;
  attachmentIds: string[];
}

export interface GraphError {
  code: string;
  message: string;
  node: string;
}

const replace = <T>() => Annotation<T>();
const withDefault = <T>(value: T) =>
  Annotation<T>({ reducer: (_a: T, b: T) => b, default: () => value });
const append = <T>() => Annotation<T[]>({ reducer: (a, b) => a.concat(b), default: () => [] });

/** Explicit, typed workflow state. Reducers are only used for append-only observability fields. */
export const GenerationState = Annotation.Root({
  // ---- inputs (trusted: resolved and authorised by the API before the run starts)
  conversationId: replace<string>(),
  brandId: replace<string>(),
  customerId: replace<string>(),
  orderId: withDefault<string | null>(null),
  requestedBy: withDefault<string | null>(null),
  parentGenerationId: withDefault<string | null>(null),
  extraInstruction: withDefault<string | null>(null),
  startedAt: withDefault<number>(0),

  // ---- loaded context
  context: withDefault<ConversationContext | null>(null),
  latest: withDefault<LatestMessage | null>(null),
  customerSentImage: withDefault<boolean>(false),
  priorAgentMessage: withDefault<boolean>(false),
  orderFacts: withDefault<OrderFacts | null>(null),
  policies: withDefault<(PolicyRef & { content: string })[]>([]),

  // ---- understanding & routing
  understanding: withDefault<Understanding | null>(null),
  injectionSuspected: withDefault<boolean>(false),
  customerLanguage: withDefault<string>('en'),
  replyLanguage: withDefault<string>('en'),
  route: withDefault<Route | null>(null),
  searchQuery: withDefault<string | null>(null),

  // ---- conversation-aware case state (customer statements, kept apart from verified facts)
  previousCaseState: withDefault<PersistedCaseState | null>(null),
  caseState: withDefault<CaseState | null>(null),
  asksNextStep: withDefault<boolean>(false),
  /** The latest message asks something outside the open case (answered directly, not folded into the case). */
  sideQuestion: withDefault<boolean>(false),
  asksClarification: withDefault<boolean>(false),
  customerRepeated: withDefault<boolean>(false),
  /** An agent already gave the next step / handoff for the open case (derived from the message history). */
  nextStepAlreadyGiven: withDefault<boolean>(false),
  /** Policy figures agents already stated earlier in this conversation. */
  previouslyStatedFigures: withDefault<string[]>([]),
  lastAgentReply: withDefault<string | null>(null),
  lastAgentAt: withDefault<string | null>(null),
  effectiveIntent: withDefault<Intent | null>(null),
  eligibilityKinds: withDefault<string[]>([]),
  missingInformation: withDefault<string[]>([]),
  workflowStage: withDefault<WorkflowStage>('intake'),
  nextAction: withDefault<NextAction>('explain_policy'),
  derived: withDefault<CaseDerived | null>(null),

  // ---- evidence
  retrieval: withDefault<RetrievalResult | null>(null),
  imageEvidence: withDefault<ImageEvidence | null>(null),
  imageAnalysisFailed: withDefault<boolean>(false),
  eligibility: withDefault<Eligibility[]>([]),
  deliveryEstimate: withDefault<DeliveryEstimate | null>(null),
  sources: withDefault<SourceRef[]>([]),

  // ---- drafting & validation
  composeMode: withDefault<ComposeMode>('policy'),
  composed: withDefault<ComposedReply | null>(null),
  proposedResponse: withDefault<string | null>(null),
  guardrails: withDefault<GuardrailResult[]>([]),
  attempts: withDefault<number>(0),
  violationFeedback: withDefault<string[]>([]),
  escalate: withDefault<boolean>(false),
  escalationReason: withDefault<string | null>(null),
  fallbackUsed: withDefault<boolean>(false),

  // ---- outcome
  generationId: withDefault<string | null>(null),
  error: withDefault<GraphError | null>(null),

  // ---- observability (append-only)
  trace: append<TraceEntry>(),
  inputTokens: Annotation<number>({ reducer: (a, b) => a + b, default: () => 0 }),
  outputTokens: Annotation<number>({ reducer: (a, b) => a + b, default: () => 0 }),
  models: Annotation<string[]>({
    reducer: (a, b) => [...new Set([...a, ...b])],
    default: () => [],
  }),
});

export type GState = typeof GenerationState.State;
export type GUpdate = typeof GenerationState.Update;
