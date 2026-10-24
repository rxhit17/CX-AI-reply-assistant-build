/**
 * Deterministic workflow decisions: what the customer needs next, given the conversation-level case state, the
 * latest message and verified facts. No model is involved, so behaviour is testable and cannot drift.
 */
import type { Eligibility, Intent } from '@cx/shared';
import type {
  CaseDerived,
  CaseState,
  IssueType,
  NextAction,
  Resolution,
  WorkflowStage,
} from '../case-state.js';
import { eligibilityKindsFor, routeFor, type Route } from './intent.js';

const ISSUE_TO_INTENT: Record<IssueType, Intent | null> = {
  return: 'return_request',
  refund: 'refund_request',
  exchange: 'exchange',
  damaged: 'damaged_product',
  missing: 'missing_product',
  order_status: 'order_status',
  cancellation: 'cancellation',
  shipping: 'shipping_question',
  warranty: 'general_question',
  general: null,
  unknown: null,
};

/** Latest-message intents that are context-dependent: they only make sense given the open case. */
const CONTEXT_DEPENDENT: Intent[] = ['unclear', 'general_question', 'complaint', 'greeting'];

/**
 * A reply such as "Yes, it is unused" or "I already confirmed, what is next?" carries no intent of its own.
 * When the customer has an open case, continue that case instead of treating the message as a new, unclear one.
 */
export function effectiveIntent(intent: Intent, state: CaseState, continuesCase: boolean): Intent {
  if (!CONTEXT_DEPENDENT.includes(intent)) return intent;
  const fromCase = ISSUE_TO_INTENT[state.issue_type];
  if (!fromCase) return intent;
  const caseIsActive =
    state.confirmed_facts.length > 0 ||
    state.denied_facts.length > 0 ||
    state.resolution_confirmed ||
    state.desired_resolution !== 'unknown';
  // A bare greeting is only treated as continuing the case if the model also says it answers/continues it.
  if (intent === 'greeting' && !continuesCase) return intent;
  return caseIsActive || continuesCase ? fromCase : intent;
}

const RESOLUTION_KINDS: Record<Resolution, Eligibility['kind'][]> = {
  return: ['return'],
  refund: ['refund'],
  return_and_refund: ['return', 'refund'],
  exchange: ['return'],
  replacement: [],
  cancellation: ['cancellation'],
  none: [],
  unknown: [],
};
const RESOLUTION_INTENTS: Intent[] = [
  'return_request',
  'refund_request',
  'exchange',
  'damaged_product',
  'cancellation',
];

/** Which deterministic checks to run: the latest intent's, plus those implied by what the customer wants. */
export function eligibilityKindsForCase(intent: Intent, state: CaseState): Eligibility['kind'][] {
  const base = eligibilityKindsFor(intent);
  const implied = RESOLUTION_INTENTS.includes(intent)
    ? RESOLUTION_KINDS[state.desired_resolution]
    : [];
  return [...new Set([...base, ...implied])];
}

export interface DecisionInput {
  intent: Intent;
  asksForHuman: boolean;
  asksNextStep: boolean;
  state: CaseState;
  customerSentImage: boolean;
  orderLinked: boolean;
}

export interface Decision {
  effectiveIntent: Intent;
  route: Route;
  eligibilityKinds: Eligibility['kind'][];
  missingInformation: string[];
  workflowStage: WorkflowStage;
  /** Preliminary: `finalizeNextAction` refines it once eligibility results exist. */
  nextAction: NextAction;
}

const ACTIONABLE: Resolution[] = [
  'return',
  'refund',
  'return_and_refund',
  'exchange',
  'replacement',
  'cancellation',
];

export function decideNextAction(i: DecisionInput): Decision {
  const intent = effectiveIntent(i.intent, i.state, i.asksNextStep || i.state.resolution_confirmed);
  const route = routeFor({
    intent,
    asksForHuman: i.asksForHuman,
    hasCustomerImage: i.customerSentImage,
  });
  const kinds = eligibilityKindsForCase(intent, i.state);

  const missing: string[] = [];
  const policyRoute = route === 'policy' || route === 'image';
  if (policyRoute && !i.orderLinked && (kinds.length > 0 || intent === 'order_status'))
    missing.push('order_reference');
  if (
    policyRoute &&
    intent === 'damaged_product' &&
    !i.customerSentImage &&
    !i.state.confirmed_facts.includes('photo_provided')
  ) {
    missing.push('photo');
  }

  const wantsAction =
    ACTIONABLE.includes(i.state.desired_resolution) &&
    (i.state.resolution_confirmed || i.asksNextStep);
  let nextAction: NextAction;
  let stage: WorkflowStage;
  switch (route) {
    case 'small_talk':
      nextAction = 'acknowledge';
      stage = 'intake';
      break;
    case 'human':
      nextAction = 'handoff_to_human';
      stage = 'handoff';
      break;
    case 'unsupported':
      nextAction = 'clarify_request';
      stage = 'intake';
      break;
    case 'order':
      nextAction = missing.length ? 'ask_missing_info' : 'order_status_update';
      stage = 'resolved_by_policy';
      break;
    default:
      if (missing.length) {
        nextAction = 'ask_missing_info';
        stage = 'gathering_information';
      } else if (wantsAction) {
        nextAction = 'provide_next_step';
        stage = 'ready_to_resolve';
      } else if (kinds.length > 0) {
        nextAction = 'explain_eligibility';
        stage = 'resolved_by_policy';
      } else {
        nextAction = 'explain_policy';
        stage = 'resolved_by_policy';
      }
  }
  return {
    effectiveIntent: intent,
    route,
    eligibilityKinds: kinds,
    missingInformation: missing,
    workflowStage: stage,
    nextAction,
  };
}

export function eligibilityStatus(eligibility: Eligibility[]): CaseDerived['eligibility_status'] {
  if (eligibility.length === 0) return 'not_applicable';
  if (eligibility.some((e) => e.outcome === 'ineligible')) return 'ineligible';
  if (eligibility.some((e) => e.outcome === 'needs_review')) return 'needs_review';
  if (eligibility.every((e) => e.outcome === 'eligible')) return 'eligible';
  return 'unknown';
}

/** Second pass, after the deterministic checks ran: an "ask for the next step" can turn out to need other handling. */
export function finalizeNextAction(prelim: Decision, eligibility: Eligibility[]): CaseDerived {
  let next = prelim.nextAction;
  let stage = prelim.workflowStage;
  const missing = [...prelim.missingInformation];
  if (next === 'provide_next_step') {
    if (eligibility.some((e) => e.outcome === 'ineligible')) {
      next = 'explain_eligibility';
      stage = 'resolved_by_policy';
    } else if (eligibility.some((e) => e.outcome === 'needs_review')) {
      next = 'handoff_to_human';
      stage = 'handoff';
    } else if (
      eligibility.some(
        (e) => e.outcome === 'insufficient_data' && e.details.missing_evidence === 'photo',
      )
    ) {
      next = 'ask_missing_info';
      stage = 'gathering_information';
      if (!missing.includes('photo')) missing.push('photo');
    }
  }
  return {
    workflow_stage: stage,
    next_action: next,
    missing_information: missing,
    eligibility_status: eligibilityStatus(eligibility),
  };
}
