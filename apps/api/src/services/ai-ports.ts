import type { SupabaseClient } from '@supabase/supabase-js';
import type { GenerationPorts, OrderFacts, PersistedCaseState, PolicyRef } from '@cx/ai';
import { createKbSearchPort } from './kb-search.js';

const MAX_HISTORY = 40;

/**
 * Supabase-backed implementation of the workflow's ports. Each method is scoped by the ids it is given; the
 * graph only passes ids it received from the (already authorised) API request, never ids from model output.
 */
export function createGenerationPorts(db: SupabaseClient): GenerationPorts {
  return {
    async loadConversation(conversationId) {
      const { data: conv, error } = await db
        .from('conversations')
        .select('id, brand_id, customer_id, order_id, status')
        .eq('id', conversationId)
        .single();
      if (error || !conv) throw new Error('Conversation not found');

      const [brand, settings, customer, messages] = await Promise.all([
        db.from('brands').select('id, name').eq('id', conv.brand_id).single(),
        db.from('brand_settings').select('*').eq('brand_id', conv.brand_id).single(),
        db
          .from('customers')
          .select('id, name, preferred_language')
          .eq('id', conv.customer_id)
          .eq('brand_id', conv.brand_id)
          .single(),
        db
          .from('messages')
          .select('id, sender_type, body, created_at, message_attachments(id, mime_type)')
          .eq('conversation_id', conversationId)
          .is('unsent_at', null)
          .order('created_at', { ascending: false })
          .limit(MAX_HISTORY),
      ]);
      if (brand.error || settings.error || customer.error || messages.error) {
        throw new Error('Failed to load conversation context');
      }
      return {
        conversation: conv,
        brand: {
          id: brand.data.id,
          name: brand.data.name,
          voice: {
            tone: settings.data.tone,
            communication_style: settings.data.communication_style,
            greeting_preference: settings.data.greeting_preference,
            sign_off: settings.data.sign_off,
            supported_languages: settings.data.supported_languages,
          },
        },
        customer: customer.data,
        messages: (messages.data ?? [])
          .map((m) => ({
            id: m.id,
            sender_type: m.sender_type,
            body: m.body,
            created_at: m.created_at,
            attachments: (m.message_attachments ?? []) as { id: string; mime_type: string }[],
          }))
          .reverse(),
      };
    },

    async loadOrder(orderId, brandId, customerId): Promise<OrderFacts | null> {
      const { data } = await db
        .from('orders')
        .select(
          'order_number, status, total, currency, placed_at, shipped_at, delivered_at, estimated_delivery_at, order_items(name, quantity, unit_price)',
        )
        .eq('id', orderId)
        .eq('brand_id', brandId)
        .eq('customer_id', customerId)
        .maybeSingle();
      if (!data) return null;
      const { order_items, ...rest } = data;
      return {
        ...rest,
        total: Number(rest.total),
        items: (order_items ?? []).map((i) => ({ ...i, unit_price: Number(i.unit_price) })),
      } as OrderFacts;
    },

    async loadPolicies(brandId) {
      const { data, error } = await db
        .from('knowledge_base')
        .select('id, title, category, version, content, conditions')
        .eq('brand_id', brandId)
        .eq('is_active', true)
        .is('archived_at', null)
        .not('conditions', 'is', null);
      if (error) throw new Error(error.message);
      return (data ?? []).map((k) => ({
        kbId: k.id,
        version: k.version,
        title: k.title,
        category: k.category,
        conditions: k.conditions,
        content: k.content,
      })) as (PolicyRef & { content: string })[];
    },

    /**
     * Case state is a cache of what the customer said, so it must describe the conversation BEFORE the message being
     * answered. Rules (each one protects against a stale or wrong state):
     *  - scoped to this conversation only (brand and customer follow from the conversation);
     *  - the state computed for the current message is excluded, so a regeneration re-derives it from the messages
     *    instead of inheriting its own earlier extraction;
     *  - "latest" means the latest customer MESSAGE a state covers, not the latest write: a slower, older generation
     *    that finishes after a newer one cannot shadow it;
     *  - failed generations are ignored.
     */
    async loadPreviousCaseState(conversationId, beforeMessageId) {
      const [{ data: rows }, { data: current }] = await Promise.all([
        db
          .from('ai_generations')
          .select(
            'case_state, trigger_message_id, created_at, trigger:messages!ai_generations_trigger_message_id_fkey(created_at)',
          )
          .eq('conversation_id', conversationId)
          .not('case_state', 'is', null)
          .not('trigger_message_id', 'is', null)
          .neq('status', 'failed')
          .neq('trigger_message_id', beforeMessageId)
          .order('created_at', { ascending: false })
          .limit(25),
        db
          .from('messages')
          .select('created_at')
          .eq('id', beforeMessageId)
          .eq('conversation_id', conversationId)
          .maybeSingle(),
      ]);
      if (!current) return null;
      const at = (r: { trigger: unknown }) => {
        const t = Array.isArray(r.trigger) ? r.trigger[0] : r.trigger;
        return t && typeof t === 'object' && 'created_at' in t
          ? new Date(String((t as { created_at: string }).created_at)).getTime()
          : NaN;
      };
      const before = new Date(current.created_at).getTime();
      const best = (rows ?? [])
        .map((r) => ({ r, t: at(r) }))
        .filter((x) => Number.isFinite(x.t) && x.t < before)
        // newest covered message first; among generations for the same message, the most recently written
        .sort(
          (a, b) =>
            b.t - a.t || new Date(b.r.created_at).getTime() - new Date(a.r.created_at).getTime(),
        )[0];
      return (best?.r.case_state as PersistedCaseState | null) ?? null;
    },

    search: createKbSearchPort(db),

    async listOtherBrandNames(brandId) {
      const { data } = await db.from('brands').select('name').neq('id', brandId);
      return (data ?? []).map((b) => b.name as string);
    },

    async loadImages({ attachmentIds, brandId, conversationId }) {
      if (attachmentIds.length === 0) return [];
      const { data } = await db
        .from('message_attachments')
        .select('id, storage_path, mime_type')
        .in('id', attachmentIds)
        .eq('brand_id', brandId)
        .eq('conversation_id', conversationId);
      const images: { id: string; dataUrl: string }[] = [];
      for (const row of data ?? []) {
        const file = await db.storage.from('attachments').download(row.storage_path);
        if (file.error || !file.data) continue;
        const buf = Buffer.from(await file.data.arrayBuffer());
        images.push({
          id: row.id,
          dataUrl: `data:${row.mime_type};base64,${buf.toString('base64')}`,
        });
      }
      return images;
    },

    async saveGeneration(record) {
      const { data, error } = await db.rpc('fn_save_generation', { p_payload: record });
      if (error) throw new Error(`Failed to save generation: ${error.message}`);
      return data as string;
    },

    async createEscalation({ brandId, conversationId, generationId, reason, createdBy }) {
      const { error } = await db.from('escalation_requests').insert({
        brand_id: brandId,
        conversation_id: conversationId,
        generation_id: generationId,
        reason,
        created_by: createdBy,
      });
      if (error) throw new Error(`Failed to record escalation: ${error.message}`);
    },
  };
}
