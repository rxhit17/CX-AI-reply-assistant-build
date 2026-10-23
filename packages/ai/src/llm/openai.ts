import type { BaseMessage } from '@langchain/core/messages';
import { HumanMessage, SystemMessage } from '@langchain/core/messages';
import { ChatOpenAI } from '@langchain/openai';
import type { z } from 'zod';
import type { AiConfig } from '../config.js';
import {
  composePrompt,
  composeVars,
  IMAGE_SYSTEM,
  JUDGE_SYSTEM,
  understandPrompt,
  understandVars,
} from './prompts.js';
import {
  composedReplySchema,
  imageEvidenceSchema,
  judgeSchema,
  understandingSchema,
  type ComposeInput,
  type JudgeInput,
  type LlmPort,
  type LlmResult,
  type UnderstandInput,
} from './types.js';

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

    async compose(input: ComposeInput) {
      const messages = await composePrompt.formatMessages(composeVars(input));
      return structured(chat, composedReplySchema, 'composed_reply', messages, config.chatModel);
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
