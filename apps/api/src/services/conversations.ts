import { randomUUID } from 'node:crypto';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Attachment, Message, SendMessageRequest } from '@cx/shared';
import { assertBrandAccess, type AuthUser } from '../auth.js';
import { badRequest, forbidden, notFound } from '../errors.js';
import { EXTENSION, validateImage } from '../files.js';

const ATTACHMENT_BUCKET = 'attachments';
const SIGNED_URL_TTL_SECONDS = 60 * 60;

export interface ConversationRow {
  id: string;
  brand_id: string;
  customer_id: string;
  order_id: string | null;
  status: 'open' | 'closed';
  last_message_at: string | null;
  created_at: string;
}

/** Loads a conversation and verifies the caller may access its brand. Brand comes from the DB row. */
export async function loadConversation(
  db: SupabaseClient,
  user: AuthUser,
  id: string,
): Promise<ConversationRow> {
  const { data, error } = await db.from('conversations').select('*').eq('id', id).maybeSingle();
  if (error) throw new Error(error.message);
  if (!data) throw notFound('Conversation');
  assertBrandAccess(user, data.brand_id, 'Conversation');
  return data as ConversationRow;
}

export async function listConversations(
  db: SupabaseClient,
  user: AuthUser,
  filters: { brand_id?: string; status?: 'open' | 'closed'; q?: string },
) {
  const brandIds = filters.brand_id
    ? user.brandIds.filter((b) => b === filters.brand_id)
    : user.brandIds;
  if (brandIds.length === 0) return [];
  let query = db
    .from('conversation_list')
    .select('*')
    .in('brand_id', brandIds)
    .order('last_activity_at', { ascending: false })
    .limit(200);
  if (filters.status) query = query.eq('status', filters.status);
  if (filters.q) {
    // strip PostgREST filter metacharacters from the search term
    const term = filters.q.replace(/[%,()*\\]/g, ' ').trim();
    if (term) query = query.or(`customer_name.ilike.%${term}%,last_message_body.ilike.%${term}%`);
  }
  const { data, error } = await query;
  if (error) throw new Error(error.message);
  return data ?? [];
}

export async function signAttachments(
  db: SupabaseClient,
  rows: Omit<Attachment, 'url'>[],
): Promise<Attachment[]> {
  if (rows.length === 0) return [];
  const { data } = await db.storage.from(ATTACHMENT_BUCKET).createSignedUrls(
    rows.map((r) => r.storage_path),
    SIGNED_URL_TTL_SECONDS,
  );
  const byPath = new Map((data ?? []).map((d) => [d.path, d.signedUrl]));
  return rows.map((r) => ({ ...r, url: byPath.get(r.storage_path) ?? null }));
}

export async function listMessages(db: SupabaseClient, conversationId: string): Promise<Message[]> {
  const { data, error } = await db
    .from('messages')
    .select('*, message_attachments(id, message_id, storage_path, mime_type, size_bytes)')
    .eq('conversation_id', conversationId)
    .order('created_at', { ascending: true })
    .limit(500);
  if (error) throw new Error(error.message);
  const rows = (data ?? []) as (Message & { message_attachments: Omit<Attachment, 'url'>[] })[];
  const signed = await signAttachments(
    db,
    rows.flatMap((r) => r.message_attachments),
  );
  const byId = new Map(signed.map((a) => [a.id, a]));
  return rows.map(({ message_attachments, ...m }) => ({
    ...m,
    attachments: message_attachments.map((a) => byId.get(a.id)!),
  }));
}

export async function getConversationDetail(db: SupabaseClient, user: AuthUser, id: string) {
  const conv = await loadConversation(db, user, id);
  const [customer, brand, messages] = await Promise.all([
    db
      .from('customers')
      .select('id, brand_id, name, email, preferred_language')
      .eq('id', conv.customer_id)
      .single(),
    db.from('brands').select('id, name, slug, brand_settings(*)').eq('id', conv.brand_id).single(),
    listMessages(db, conv.id),
  ]);
  return { conversation: conv, customer: customer.data, brand: brand.data, messages };
}

export async function getOrderForConversation(db: SupabaseClient, user: AuthUser, id: string) {
  const conv = await loadConversation(db, user, id);
  if (!conv.order_id) return null;
  const { data } = await db
    .from('orders')
    .select('*, items:order_items(id, name, quantity, unit_price)')
    .eq('id', conv.order_id)
    .eq('brand_id', conv.brand_id)
    .maybeSingle();
  return data;
}

export async function createConversation(
  db: SupabaseClient,
  user: AuthUser,
  input: { customer_id: string; order_id?: string | null },
) {
  const { data: customer } = await db
    .from('customers')
    .select('id, brand_id')
    .eq('id', input.customer_id)
    .maybeSingle();
  if (!customer) throw notFound('Customer');
  assertBrandAccess(user, customer.brand_id, 'Customer');
  if (input.order_id) {
    const { data: order } = await db
      .from('orders')
      .select('id')
      .eq('id', input.order_id)
      .eq('customer_id', customer.id)
      .eq('brand_id', customer.brand_id)
      .maybeSingle();
    if (!order) throw badRequest('Order does not belong to this customer');
  }
  const { data, error } = await db
    .from('conversations')
    .insert({
      brand_id: customer.brand_id,
      customer_id: customer.id,
      order_id: input.order_id ?? null,
    })
    .select('*')
    .single();
  if (error) throw new Error(error.message);
  return data as ConversationRow;
}

export async function setConversationStatus(
  db: SupabaseClient,
  user: AuthUser,
  id: string,
  status: 'open' | 'closed',
) {
  await loadConversation(db, user, id);
  const { data, error } = await db
    .from('conversations')
    .update({ status, closed_at: status === 'closed' ? new Date().toISOString() : null })
    .eq('id', id)
    .select('*')
    .single();
  if (error) throw new Error(error.message);
  return data as ConversationRow;
}

/**
 * Persists a message. Idempotent on (conversation, client_message_id): a repeated request (double click,
 * retry) returns the original message instead of creating a duplicate.
 */
export async function sendMessage(
  db: SupabaseClient,
  user: AuthUser,
  conversationId: string,
  input: SendMessageRequest,
): Promise<{ message: Message; duplicate: boolean }> {
  const conv = await loadConversation(db, user, conversationId);

  const { data: existing } = await db
    .from('messages')
    .select('*')
    .eq('conversation_id', conv.id)
    .eq('client_message_id', input.client_message_id)
    .maybeSingle();
  if (existing) return { message: (await hydrate(db, existing)) as Message, duplicate: true };

  if (input.attachment_ids.length > 0) {
    const { data: atts } = await db
      .from('message_attachments')
      .select('id')
      .in('id', input.attachment_ids)
      .eq('conversation_id', conv.id)
      .eq('brand_id', conv.brand_id)
      .is('message_id', null);
    if ((atts ?? []).length !== input.attachment_ids.length) {
      throw badRequest('One or more attachments are invalid or already used', 'INVALID_ATTACHMENT');
    }
  }

  const { data, error } = await db
    .from('messages')
    .insert({
      brand_id: conv.brand_id,
      conversation_id: conv.id,
      sender_type: input.sender_type,
      sender_id: input.sender_type === 'agent' ? user.id : null,
      body: input.body,
      client_message_id: input.client_message_id,
    })
    .select('*')
    .single();

  if (error) {
    if (error.code === '23505') {
      // lost a race with a concurrent identical request
      const { data: winner } = await db
        .from('messages')
        .select('*')
        .eq('conversation_id', conv.id)
        .eq('client_message_id', input.client_message_id)
        .single();
      return { message: (await hydrate(db, winner)) as Message, duplicate: true };
    }
    throw new Error(error.message);
  }

  if (input.attachment_ids.length > 0) {
    const { error: linkErr } = await db
      .from('message_attachments')
      .update({ message_id: data.id })
      .in('id', input.attachment_ids)
      .eq('conversation_id', conv.id);
    if (linkErr) throw new Error(linkErr.message);
  }
  return { message: (await hydrate(db, data)) as Message, duplicate: false };
}

/**
 * Withdraws a message. Agents may unsend their own messages (admins any agent message); the customer simulator,
 * which stands in for the customer, may unsend customer messages. The row is kept as a tombstone: text and
 * attachments are removed, and drafts that were written for an unsent customer message are superseded.
 */
export async function unsendMessage(
  db: SupabaseClient,
  user: AuthUser,
  conversationId: string,
  messageId: string,
): Promise<Message> {
  const conv = await loadConversation(db, user, conversationId);
  const { data: msg, error } = await db
    .from('messages')
    .select('*')
    .eq('id', messageId)
    .eq('conversation_id', conv.id)
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!msg) throw notFound('Message');
  if (msg.sender_type === 'system')
    throw badRequest('System messages cannot be unsent', 'NOT_UNSENDABLE');
  if (msg.sender_type === 'agent' && msg.sender_id !== user.id && user.role !== 'admin')
    throw forbidden('You can only unsend your own messages');
  if (msg.unsent_at) return (await hydrate(db, msg)) as Message;

  const { data: atts } = await db
    .from('message_attachments')
    .select('id, storage_path')
    .eq('message_id', msg.id);
  const paths = (atts ?? []).map((a) => a.storage_path as string);

  const { data: updated, error: updErr } = await db
    .from('messages')
    .update({ body: '', unsent_at: new Date().toISOString(), unsent_by: user.id })
    .eq('id', msg.id)
    .select('*')
    .single();
  if (updErr) throw new Error(updErr.message);

  if (paths.length > 0) {
    await db.from('message_attachments').delete().eq('message_id', msg.id);
    await db.storage.from(ATTACHMENT_BUCKET).remove(paths);
  }
  if (msg.sender_type === 'customer') {
    // A draft answering a message that no longer exists must not be approved or sent.
    await db
      .from('ai_generations')
      .update({ status: 'superseded' })
      .eq('conversation_id', conv.id)
      .eq('trigger_message_id', msg.id)
      .in('status', ['draft', 'edited', 'approved']);
  }
  return (await hydrate(db, updated)) as Message;
}

async function hydrate(db: SupabaseClient, message: Message): Promise<Message> {
  const { data } = await db
    .from('message_attachments')
    .select('id, message_id, storage_path, mime_type, size_bytes')
    .eq('message_id', message.id);
  return {
    ...message,
    attachments: await signAttachments(db, (data ?? []) as Omit<Attachment, 'url'>[]),
  };
}

export async function uploadAttachment(
  db: SupabaseClient,
  user: AuthUser,
  conversationId: string,
  file: { buffer: Buffer; mimetype: string },
): Promise<Attachment> {
  const conv = await loadConversation(db, user, conversationId);
  const check = validateImage(file.buffer, file.mimetype);
  if (!check.ok) throw badRequest(check.reason, 'INVALID_FILE');

  const path = `brand/${conv.brand_id}/conversation/${conv.id}/${randomUUID()}.${EXTENSION[check.mime]}`;
  const up = await db.storage.from(ATTACHMENT_BUCKET).upload(path, file.buffer, {
    contentType: check.mime,
    upsert: false,
  });
  if (up.error) throw new Error(up.error.message);

  const { data, error } = await db
    .from('message_attachments')
    .insert({
      brand_id: conv.brand_id,
      conversation_id: conv.id,
      uploaded_by: user.id,
      storage_path: path,
      mime_type: check.mime,
      size_bytes: file.buffer.length,
    })
    .select('id, message_id, storage_path, mime_type, size_bytes')
    .single();
  if (error) {
    await db.storage.from(ATTACHMENT_BUCKET).remove([path]); // do not leave orphaned objects
    throw new Error(error.message);
  }
  const [signed] = await signAttachments(db, [data as Omit<Attachment, 'url'>]);
  return signed!;
}

/** `reader` is whose view is open: reading as the agent marks customer messages read, and vice versa. */
export async function markRead(
  db: SupabaseClient,
  user: AuthUser,
  id: string,
  reader: 'agent' | 'customer',
) {
  const conv = await loadConversation(db, user, id);
  const sender = reader === 'agent' ? 'customer' : 'agent';
  const { error } = await db
    .from('messages')
    .update({ read_at: new Date().toISOString() })
    .eq('conversation_id', conv.id)
    .eq('sender_type', sender)
    .is('read_at', null);
  if (error) throw new Error(error.message);
}
