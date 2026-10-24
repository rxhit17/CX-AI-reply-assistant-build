/**
 * Conversation-aware case state: what the CUSTOMER has told us so far, kept separate from verified backend
 * facts (order data, eligibility), which always come from the database and rules engine.
 *
 * Representation: extracted by the existing `understand` model call (no extra call), merged deterministically
 * with the previous state, and persisted as JSON on each generation (`ai_generations.case_state`). The message
 * history stays authoritative: persisted state is a cache that preserves facts beyond the history window and
 * is re-derived from the messages on every run (see `mergeCaseState`).
 */
import { z } from 'zod';

export const ISSUE_TYPES = [
  'return',
  'refund',
  'exchange',
  'damaged',
  'missing',
  'order_status',
  'cancellation',
  'shipping',
  'warranty',
  'general',
  'unknown',
] as const;
export const issueTypeSchema = z.enum(ISSUE_TYPES);
export type IssueType = z.infer<typeof issueTypeSchema>;

/** Facts a customer can state about their case. Open-ended details go in `other_facts`. */
export const FACT_KEYS = [
  'item_unused',
  'original_packaging',
  'item_damaged',
  'customer_ordered_wrong_item',
  'item_differs_from_listing',
  'item_missing_or_incomplete',
  'photo_provided',
  'order_number_provided',
] as const;
export const factKeySchema = z.enum(FACT_KEYS);
export type FactKey = z.infer<typeof factKeySchema>;

export const RESOLUTIONS = [
  'return',
  'refund',
  'return_and_refund',
  'exchange',
  'replacement',
  'cancellation',
  'none',
  'unknown',
] as const;
export const resolutionSchema = z.enum(RESOLUTIONS);
export type Resolution = z.infer<typeof resolutionSchema>;

/** Topics a reply's questions can be about; used to detect re-asking something already answered. */
export const QUESTION_TOPICS = [
  ...FACT_KEYS,
  'resolution_confirmation',
  'order_reference',
  'other',
] as const;
export const questionTopicSchema = z.enum(QUESTION_TOPICS);
export type QuestionTopic = z.infer<typeof questionTopicSchema>;

/** What the understanding model extracts from the conversation so far (OpenAI-strict: no optionals). */
export const caseUpdateSchema = z.object({
  issue_type: issueTypeSchema.describe(
    'The customer’s CURRENT issue after applying any correction they made',
  ),
  confirmed_facts: z
    .array(factKeySchema)
    .describe('Facts the customer has stated are TRUE (answers to the agent’s questions count)'),
  denied_facts: z.array(factKeySchema).describe('Facts the customer has stated are NOT true'),
  retracted_facts: z
    .array(factKeySchema)
    .describe('Facts the customer withdrew or corrected in the latest message'),
  other_facts: z
    .array(z.string())
    .describe(
      'Other short factual statements by the customer worth remembering (max 5), in English',
    ),
  desired_resolution: resolutionSchema.describe(
    'What the customer wants: return, refund, return_and_refund, exchange, replacement, cancellation, none (withdrawn), unknown',
  ),
  resolution_confirmed: z
    .boolean()
    .describe(
      'True once the customer has explicitly said they want that resolution (not merely asked whether it is possible)',
    ),
  asks_next_step: z
    .boolean()
    .describe('True if the latest message asks what happens next / how to proceed'),
  corrections: z
    .array(z.string())
    .describe(
      'Short notes on anything the customer corrected in the latest message, e.g. "customer says they ordered the wrong item, not that the seller sent the wrong one"',
    ),
});
export type CaseUpdate = z.infer<typeof caseUpdateSchema>;

export const caseStateSchema = z.object({
  issue_type: issueTypeSchema,
  confirmed_facts: z.array(factKeySchema),
  denied_facts: z.array(factKeySchema),
  other_facts: z.array(z.string()),
  desired_resolution: resolutionSchema,
  resolution_confirmed: z.boolean(),
  corrections: z.array(z.string()),
  /** Last customer message this state accounts for (set by code, never by the model). */
  as_of_message_id: z.string().nullable(),
});
export type CaseState = z.infer<typeof caseStateSchema>;

export const WORKFLOW_STAGES = [
  'intake',
  'gathering_information',
  'ready_to_resolve',
  'resolved_by_policy',
  'handoff',
] as const;
export const NEXT_ACTIONS = [
  'acknowledge',
  'clarify_request',
  'ask_missing_info',
  'explain_policy',
  'explain_eligibility',
  'provide_next_step',
  'order_status_update',
  'handoff_to_human',
] as const;
export type WorkflowStage = (typeof WORKFLOW_STAGES)[number];
export type NextAction = (typeof NEXT_ACTIONS)[number];

/** Derived (by code, not by the model) and stored with the state for auditability. */
export interface CaseDerived {
  workflow_stage: WorkflowStage;
  next_action: NextAction;
  missing_information: string[];
  eligibility_status: 'eligible' | 'ineligible' | 'needs_review' | 'unknown' | 'not_applicable';
}
export interface PersistedCaseState extends CaseState {
  derived?: CaseDerived;
}

export const emptyCaseState = (): CaseState => ({
  issue_type: 'unknown',
  confirmed_facts: [],
  denied_facts: [],
  other_facts: [],
  desired_resolution: 'unknown',
  resolution_confirmed: false,
  corrections: [],
  as_of_message_id: null,
});

const union = <T>(...lists: T[][]): T[] => [...new Set(lists.flat())];
const without = <T>(list: T[], ...remove: T[][]): T[] => {
  const drop = new Set(remove.flat());
  return list.filter((x) => !drop.has(x));
};

/**
 * Deterministic merge of the previous state with the model's extraction for the latest messages.
 *  - facts accumulate; a later statement overrides an earlier one (confirmed ↔ denied), and retractions remove;
 *  - `unknown` never overwrites a known issue/resolution (the model not knowing is not a correction);
 *  - confirmation of a resolution is sticky until the resolution itself changes or is withdrawn.
 */
export function mergeCaseState(
  previous: CaseState | null,
  update: CaseUpdate,
  latestMessageId: string,
): CaseState {
  const prev = previous ?? emptyCaseState();
  const confirmed = without(
    union(prev.confirmed_facts, update.confirmed_facts),
    update.denied_facts,
    update.retracted_facts,
  );
  const denied = without(
    union(prev.denied_facts, update.denied_facts),
    update.confirmed_facts,
    update.retracted_facts,
  );

  const resolutionChanged =
    update.desired_resolution !== 'unknown' &&
    update.desired_resolution !== prev.desired_resolution;
  const desired =
    update.desired_resolution === 'unknown' ? prev.desired_resolution : update.desired_resolution;
  const confirmedResolution =
    desired === 'none' || desired === 'unknown'
      ? false
      : resolutionChanged
        ? update.resolution_confirmed
        : prev.resolution_confirmed || update.resolution_confirmed;

  return {
    issue_type: update.issue_type === 'unknown' ? prev.issue_type : update.issue_type,
    confirmed_facts: confirmed,
    denied_facts: denied,
    other_facts: union(prev.other_facts, update.other_facts).slice(-12),
    desired_resolution: desired,
    resolution_confirmed: confirmedResolution,
    corrections: union(prev.corrections, update.corrections).slice(-5),
    as_of_message_id: latestMessageId,
  };
}

/**
 * Facts that are asked as a closed yes/no question. Descriptive facts ("the item differs from the listing",
 * "it is damaged") are deliberately NOT here: asking the customer for DETAILS about them is a legitimate
 * clarification, not a repeat.
 */
const CLOSED_FACTS: FactKey[] = [
  'item_unused',
  'original_packaging',
  'photo_provided',
  'order_number_provided',
];

/** Topics the customer has already answered; a reply must not ask about them again. */
export function answeredTopics(
  state: CaseState,
  opts: { orderLinked: boolean; customerSentImage: boolean },
): Set<QuestionTopic> {
  const topics = new Set<QuestionTopic>(
    [...state.confirmed_facts, ...state.denied_facts].filter((f) => CLOSED_FACTS.includes(f)),
  );
  if (state.resolution_confirmed) topics.add('resolution_confirmation');
  if (opts.orderLinked) topics.add('order_reference');
  if (opts.customerSentImage) topics.add('photo_provided');
  return topics;
}

/** Compact, model-facing description. Customer statements are labelled as unverified. */
export function describeCaseState(state: CaseState): string {
  const lines = [
    `issue: ${state.issue_type}`,
    `customer wants: ${state.desired_resolution}${state.resolution_confirmed ? ' (CONFIRMED by the customer)' : ' (not yet confirmed)'}`,
    `customer states TRUE (unverified): ${state.confirmed_facts.join(', ') || 'nothing yet'}`,
    `customer states NOT true: ${state.denied_facts.join(', ') || 'nothing'}`,
  ];
  if (state.other_facts.length)
    lines.push(`other customer statements: ${state.other_facts.join('; ')}`);
  if (state.corrections.length)
    lines.push(`customer corrections (use the corrected version): ${state.corrections.join('; ')}`);
  return lines.join('\n');
}
