import type { BaseMessage } from '@langchain/core/messages';
import { HumanMessage, SystemMessage } from '@langchain/core/messages';
import { ChatOpenAI } from '@langchain/openai';
import { z } from 'zod';
import type { AiConfig } from '../config.js';
import {
  composePrompt,
  composeVars,
  IMAGE_SYSTEM,
  JUDGE_SYSTEM,
  POLICY_EXTRACT_SYSTEM,
  understandPrompt,
  understandVars,
} from './prompts.js';
import {
  composedReplySchema,
  type ComposedReply,
  imageEvidenceSchema,
  judgeSchema,
  policyFiguresSchema,
  understandingSchema,
  type ComposeInput,
  type ExtractPolicyInput,
  type JudgeInput,
  type LlmPort,
  type LlmResult,
  type UnderstandInput,
} from './types.js';
import { partialJsonString } from './partial-json.js';

/** Reasoning-family models reject a custom temperature. */
const supportsTemperature = (model: string) => !/^(o\d|gpt-5)/i.test(model);

function makeModel(config: AiConfig, model: string, temperature: number): ChatOpenAI {
  if (!config.openaiApiKey) throw new Error('OPENAI_API_KEY is required for LLM_MODE=openai');
  return new ChatOpenAI({
    model,
    apiKey: config.openaiApiKey,
    timeout: config.timeoutMs,
    maxRetries: 2,
    ...(supportsTemperature(model) ? { temperature } : {}),
  });
}

interface Raw {
  usage_metadata?: { input_tokens?: number; output_tokens?: number };
}

function toResult<T>(out: { raw: unknown; parsed: T }, model: string): LlmResult<T> {
  const usage = (out.raw as Raw).usage_metadata;
  return {
    value: out.parsed,
    usage: { input: usage?.input_tokens ?? 0, output: usage?.output_tokens ?? 0 },
    model,
  };
}

/** LangChain.js implementation of LlmPort. Every call returns schema-validated structured output. */
export function createOpenAiLlm(config: AiConfig): LlmPort {
  const chat = makeModel(config, config.chatModel, 0.2);
  const vision = makeModel(config, config.visionModel, 0);
  const judgeName = config.judgeModel ?? config.chatModel;
  const judgeModel = makeModel(config, judgeName, 0);

  async function structured<S extends z.ZodType>(
    model: ChatOpenAI,
    schema: S,
    name: string,
    messages: BaseMessage[],
    modelName: string,
  ): Promise<LlmResult<z.infer<S>>> {
    const runnable = model.withStructuredOutput(schema as never, { name, includeRaw: true });
    const out = (await runnable.invoke(messages)) as { raw: unknown; parsed: unknown };
    const parsed = schema.parse(out.parsed); // re-validate with Zod regardless of provider behaviour
    return toResult({ raw: out.raw, parsed }, modelName);
  }

  /**
   * Same call as `structured`, but the JSON is read token by token so the reply text can be previewed while it is
   * written. (`withStructuredOutput` cannot do this: it returns one chunk at the end.) The complete document is
   * still parsed and validated with the same Zod schema before anything is returned.
   */
  async function streamedCompose(
    messages: BaseMessage[],
    onReplyText: (textSoFar: string) => void,
  ): Promise<LlmResult<ComposedReply>> {
    const jsonSchema = z.toJSONSchema(composedReplySchema, {
      target: 'draft-7',
    } as never) as Record<string, unknown>;
    delete jsonSchema.$schema;
    const model = chat.withConfig({
      response_format: {
        type: 'json_schema',
        json_schema: { name: 'composed_reply', strict: true, schema: jsonSchema },
      },
    } as never);

    let json = '';
    let sent = '';
    let usage: Raw['usage_metadata'];
    for await (const chunk of await model.stream(messages)) {
      if (typeof chunk.content === 'string') json += chunk.content;
      if (chunk.usage_metadata) usage = chunk.usage_metadata;
      const text = partialJsonString(json, 'reply_body');
      if (text !== null && text !== sent) {
        sent = text;
        try {
          onReplyText(text);
        } catch {
          // a failing preview listener must never break generation
        }
      }
    }
    const parsed = composedReplySchema.parse(JSON.parse(json));
    return toResult({ raw: { usage_metadata: usage }, parsed }, config.chatModel);
  }

  return {
    chatModel: config.chatModel,

    async understand(input: UnderstandInput) {
      const messages = await understandPrompt.formatMessages(understandVars(input));
      return structured(chat, understandingSchema, 'understanding', messages, config.chatModel);
    },

    async analyzeImages({ dataUrls, customerContext }) {
      const messages = [
        new SystemMessage(IMAGE_SYSTEM),
        new HumanMessage({
          content: [
            {
              type: 'text',
              text: `The customer's message (untrusted data): ${customerContext || '(no text)'}`,
            },
            ...dataUrls.map((url) => ({
              type: 'image_url' as const,
              image_url: { url, detail: 'low' as const },
            })),
          ],
        }),
      ];
      return structured(
        vision,
        imageEvidenceSchema,
        'image_evidence',
        messages,
        config.visionModel,
      );
    },

    async compose(input: ComposeInput, hooks) {
      const messages = await composePrompt.formatMessages(composeVars(input));
      if (!hooks?.onReplyText) {
        return structured(chat, composedReplySchema, 'composed_reply', messages, config.chatModel);
      }
      return streamedCompose(messages, hooks.onReplyText);
    },

    async extractPolicyFigures({ category, title, content }: ExtractPolicyInput) {
      const messages = [
        new SystemMessage(POLICY_EXTRACT_SYSTEM),
        new HumanMessage(
          `category: ${category}\ntitle: ${title}\n\n<policy>\n${content}\n</policy>`,
        ),
      ];
      return structured(judgeModel, policyFiguresSchema, 'policy_figures', messages, judgeName);
    },

    async judge({ reply, facts }: JudgeInput) {
      const messages = [
        new SystemMessage(JUDGE_SYSTEM),
        new HumanMessage(`<facts>\n${facts}\n</facts>\n\n<reply>\n${reply}\n</reply>`),
      ];
      return structured(judgeModel, judgeSchema, 'compliance_check', messages, judgeName);
    },
  };
}
