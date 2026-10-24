import { createClient } from '@supabase/supabase-js';
import { expect, type Browser, type Page } from '@playwright/test';
import { id } from '../../supabase/seed/data.js';

export const PASSWORD = process.env.SEED_PASSWORD ?? 'DemoPass!2026';
export const db = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, {
  auth: { persistSession: false, autoRefreshToken: false },
});

export const IDS = {
  bloom: id('brand:bloom'),
  nordic: id('brand:nordic'),
  maya: id('conversation:maya'),
  liam: id('conversation:liam'),
  emma: id('conversation:emma'),
  bloomRefundKb: id('kb:bloom-refund'),
};

/** 1x1 transparent PNG */
export const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64',
);

export async function login(page: Page, email: string) {
  await page.goto('/login');
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('navigation', { name: 'Main' })).toBeVisible();
}

export async function newSession(browser: Browser, email: string) {
  const context = await browser.newContext();
  const page = await context.newPage();
  await login(page, email);
  return { context, page };
}

export async function openConversation(page: Page, customer: string) {
  await page.goto('/conversations');
  await page.getByTestId('conversation-item').filter({ hasText: customer }).first().click();
  await expect(page.getByTestId('chat-customer')).toHaveText(customer);
}

export const tag = () => `e2e-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;

/** Removes everything the e2e run created so the demo data stays clean. */
export async function cleanup(conversationIds: string[]) {
  const { data: gens } = await db
    .from('ai_generations')
    .select('id')
    .in('conversation_id', conversationIds);
  const genIds = (gens ?? []).map((g) => g.id);
  if (genIds.length) {
    await db.from('escalation_requests').delete().in('generation_id', genIds);
    await db.from('messages').delete().in('ai_generation_id', genIds);
    await db.from('ai_generations').delete().in('id', genIds);
  }
  const { data: msgs } = await db
    .from('messages')
    .select('id, body, client_message_id')
    .in('conversation_id', conversationIds);
  const mine = (msgs ?? []).filter(
    (m) => m.body.startsWith('e2e-') || (m.client_message_id ?? '').length === 36,
  );
  if (mine.length) {
    const { data: atts } = await db
      .from('message_attachments')
      .select('storage_path')
      .in(
        'message_id',
        mine.map((m) => m.id),
      );
    if (atts?.length) await db.storage.from('attachments').remove(atts.map((a) => a.storage_path));
    await db
      .from('messages')
      .delete()
      .in(
        'id',
        mine.map((m) => m.id),
      );
  }
  // orphaned uploads (attached to nothing)
  const { data: orphans } = await db
    .from('message_attachments')
    .select('id, storage_path')
    .in('conversation_id', conversationIds)
    .is('message_id', null);
  if (orphans?.length) {
    await db.storage.from('attachments').remove(orphans.map((a) => a.storage_path));
    await db
      .from('message_attachments')
      .delete()
      .in(
        'id',
        orphans.map((a) => a.id),
      );
  }
}
