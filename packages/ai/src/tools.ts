/**
 * The controlled tool registry. A small, fixed set of read-only tools, each bound at construction to ONE
 * conversation scope (brand, customer, conversation). Tool inputs never contain brand/customer/user ids, so
 * neither the model nor a customer message can widen the scope. No tool can modify an order, issue a refund,
 * cancel anything or make a financial commitment; the only write is recording an escalation request.
 *
 * The graph invokes these directly at fixed points (no free-form agent loop). They are also exposed as
 * LangChain tools (`langchainTools`) for the documented registry and for validating input/output schemas.
 */
import { tool } from '@langchain/core/tools';
import { z } from 'zod';
import { eligibilitySchema, type Eligibility, type RetrievedKb } from '@cx/shared';
import type { RetrievalThresholds } from './config.js';
import type { EmbeddingService } from './embeddings.js';
import type { ImageEvidence, LlmPort } from './llm/types.js';
import {
  calculateDeliveryEstimate,
  calculateShippingEligibility,
  checkCancellationEligibility,
  checkDamageEligibility,
  checkRefundEligibility,
  checkReturnEligibility,
  type DamageEvidence,
  type DeliveryEstimate,
  type OrderFacts,
  type PolicyRef,
} from './policy/rules.js';
import type { ConversationContext, GenerationPorts } from './ports.js';
import { retrieveBrandKnowledge, type RetrievalResult } from './retrieval.js';

export interface ToolScope {
  brandId: string;
  customerId: string;
  conversationId: string;
  orderId: string | null;
  actorId: string | null;
}

export interface ToolDeps {
  ports: GenerationPorts;
  llm: LlmPort;
  embeddings: EmbeddingService | null;
  thresholds: RetrievalThresholds;
  now: () => Date;
}

const POLICY_CATEGORY = {
  return: 'return_policy',
  refund: 'refund_policy',
  damage: 'damaged_products',
  shipping: 'shipping_policy',
  cancellation: 'cancellation_policy',
} as const;

export const NO_ORDER: Pick<Eligibility, 'outcome' | 'reason' | 'details'> = {
  outcome: 'insufficient_data',
  reason: 'No order is linked to this conversation, so eligibility cannot be checked',
  details: {},
};

export function createToolRegistry(scope: ToolScope, deps: ToolDeps) {
  const { ports, llm, now } = deps;
  let orderCache: OrderFacts | null | undefined;
  let policyCache: (PolicyRef & { content: string })[] | undefined;

  const policies = async () => (policyCache ??= await ports.loadPolicies(scope.brandId));
  const policyFor = async (kind: keyof typeof POLICY_CATEGORY) =>
    (await policies()).find((p) => p.category === POLICY_CATEGORY[kind]);

  const registry = {
    scope,

    /** Reads the conversation (history, brand voice, customer) for the scoped conversation only. */
    async getConversation(): Promise<ConversationContext> {
      const ctx = await ports.loadConversation(scope.conversationId);
      if (ctx.conversation.brand_id !== scope.brandId)
        throw new Error('Conversation scope mismatch');
      return ctx;
    },

    /** Verified order facts for the conversation's own order (brand + customer scoped in the port). */
    async getOrderDetails(): Promise<OrderFacts | null> {
      if (orderCache !== undefined) return orderCache;
      orderCache = scope.orderId
        ? await ports.loadOrder(scope.orderId, scope.brandId, scope.customerId)
        : null;
      return orderCache;
    },

    /** Hybrid retrieval restricted to the scoped brand in SQL. */
    async retrieveBrandPolicies(
      query: string,
      categories: Parameters<typeof retrieveBrandKnowledge>[1]['categories'],
    ): Promise<RetrievalResult> {
      return retrieveBrandKnowledge(
        { search: ports.search, embeddings: deps.embeddings, thresholds: deps.thresholds },
        { brandId: scope.brandId, query, categories },
      );
    },

    async checkReturnEligibility(): Promise<Eligibility> {
      const order = await registry.getOrderDetails();
      return order
        ? checkReturnEligibility(order, await policyFor('return'), now())
        : { kind: 'return', ...NO_ORDER };
    },
    async checkRefundEligibility(): Promise<Eligibility> {
      const order = await registry.getOrderDetails();
      return order
        ? checkRefundEligibility(order, await policyFor('refund'), now())
        : { kind: 'refund', ...NO_ORDER };
    },
    async checkDamageEligibility(evidence: DamageEvidence): Promise<Eligibility> {
      const order = await registry.getOrderDetails();
      return order
        ? checkDamageEligibility(order, await policyFor('damage'), evidence, now())
        : { kind: 'damage', ...NO_ORDER };
    },
    async checkCancellationEligibility(): Promise<Eligibility> {
      const order = await registry.getOrderDetails();
      return order
        ? checkCancellationEligibility(order, await policyFor('cancellation'))
        : { kind: 'cancellation', ...NO_ORDER };
    },
    async calculateShippingEligibility(): Promise<Eligibility> {
      const order = await registry.getOrderDetails();
      return order
        ? calculateShippingEligibility(order.total, await policyFor('shipping'))
        : { kind: 'shipping', ...NO_ORDER };
    },
    async calculateDeliveryEstimate(): Promise<DeliveryEstimate | null> {
      const order = await registry.getOrderDetails();
      return order ? calculateDeliveryEstimate(order, await policyFor('shipping'), now()) : null;
    },

    /** Vision analysis of attachments that belong to the scoped conversation. */
    async analyzeCustomerImage(attachmentIds: string[], customerContext: string) {
      const images = await ports.loadImages({
        attachmentIds,
        brandId: scope.brandId,
        conversationId: scope.conversationId,
      });
      if (images.length === 0) return null;
      return llm.analyzeImages({ dataUrls: images.map((i) => i.dataUrl), customerContext });
    },

    /** Records that a human must take over. Records a request only; changes nothing else. */
    async requestHumanEscalation(generationId: string, reason: string): Promise<void> {
      await ports.createEscalation({
        brandId: scope.brandId,
        conversationId: scope.conversationId,
        generationId,
        reason: reason.slice(0, 500),
        createdBy: scope.actorId,
      });
    },

    policyFor,
    allPolicies: policies,
  };

  // ---- LangChain tool definitions (schemas for the registry; same implementations as above) ----
  const noArgs = z.object({});
  const langchainTools = [
    tool(async () => JSON.stringify((await registry.getConversation()).messages.length), {
      name: 'getConversation',
      description: 'Read the current conversation history.',
      schema: noArgs,
    }),
    tool(async () => JSON.stringify(await registry.getOrderDetails()), {
      name: 'getOrderDetails',
      description: 'Get verified facts about the order linked to this conversation.',
      schema: noArgs,
    }),
    tool(
      async ({ query }) =>
        JSON.stringify((await registry.retrieveBrandPolicies(query, null)).relevant),
      {
        name: 'retrieveBrandPolicies',
        description:
          'Search this brand’s knowledge base. Only this brand’s entries can be returned.',
        schema: z.object({ query: z.string().min(2).max(500) }),
      },
    ),
    tool(
      async () => JSON.stringify(eligibilitySchema.parse(await registry.checkReturnEligibility())),
      {
        name: 'checkReturnEligibility',
        description:
          'Deterministically check whether the order is within the brand’s return window.',
        schema: noArgs,
      },
    ),
    tool(
      async () => JSON.stringify(eligibilitySchema.parse(await registry.checkRefundEligibility())),
      {
        name: 'checkRefundEligibility',
        description:
          'Deterministically check whether the order is within the brand’s refund window.',
        schema: noArgs,
      },
    ),
    tool(
      async () =>
        JSON.stringify(eligibilitySchema.parse(await registry.calculateShippingEligibility())),
      {
        name: 'calculateShippingEligibility',
        description: 'Check whether the order total qualifies for free shipping.',
        schema: noArgs,
      },
    ),
    tool(async () => JSON.stringify(await registry.calculateDeliveryEstimate()), {
      name: 'calculateDeliveryEstimate',
      description: 'Compute the delivery state or estimate for the order.',
      schema: noArgs,
    }),
    tool(async () => 'invoked by the workflow with the conversation’s own attachments', {
      name: 'analyzeCustomerImage',
      description: 'Analyse photos the customer sent in this conversation.',
      schema: noArgs,
    }),
    tool(async ({ reason }) => `escalation requested: ${reason}`, {
      name: 'requestHumanEscalation',
      description: 'Request that a human agent takes over. Records a request only.',
      schema: z.object({ reason: z.string().min(3).max(500) }),
    }),
  ];

  return Object.assign(registry, { langchainTools });
}

export type ToolRegistry = ReturnType<typeof createToolRegistry>;
export type { ImageEvidence, RetrievedKb };
