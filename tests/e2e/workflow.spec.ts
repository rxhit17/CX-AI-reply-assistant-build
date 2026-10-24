import { expect, test } from '@playwright/test';
const API = 'http://127.0.0.1:3201';
import { cleanup, db, IDS, login, newSession, openConversation, PNG, tag } from './helpers.js';

async function restoreRefundPolicy() {
  await db
    .from('knowledge_base')
    .update({
      conditions: { window_days: 7, window_anchor: 'delivery', discretionary_review: true },
    })
    .eq('id', IDS.bloomRefundKb);
}

/** Every test starts with no open AI drafts so results never depend on test order. */
async function resetDrafts() {
  const convs = [IDS.maya, IDS.liam, IDS.emma];
  const { data } = await db
    .from('ai_generations')
    .select('id')
    .in('conversation_id', convs)
    .in('status', ['draft', 'edited', 'approved']);
  const ids = (data ?? []).map((g) => g.id);
  if (ids.length) {
    await db.from('escalation_requests').delete().in('generation_id', ids);
    await db.from('ai_generations').delete().in('id', ids);
  }
}
test.beforeEach(resetDrafts);

test.afterAll(async () => {
  await restoreRefundPolicy();
  await cleanup([IDS.maya, IDS.liam, IDS.emma]);
});

test.describe('agent workspace', () => {
  test('1-2: agent signs in and selects a conversation; brand and customer are obvious', async ({
    page,
  }) => {
    await login(page, 'agent.bloom@demo.test');
    await openConversation(page, 'Maya Patel');
    await expect(page.getByTestId('chat-brand')).toHaveText('Bloom Botanics');
    await expect(page.getByTestId('profile-name')).toHaveText('Maya Patel');
    await expect(page.getByTestId('order-number')).toHaveText('BB-10041');
    await expect(page.getByTestId('message-list')).toContainText('the bottle is broken');
  });

  test('unauthenticated users are redirected to login; wrong password shows an error', async ({
    page,
  }) => {
    await page.goto('/conversations');
    await expect(page).toHaveURL(/\/login/);
    await page.getByLabel('Email').fill('agent.bloom@demo.test');
    await page.getByLabel('Password').fill('definitely-wrong');
    await page.getByRole('button', { name: 'Sign in' }).click();
    await expect(page.getByRole('alert')).toContainText('Incorrect email or password');
  });

  test('agents only see their own brand’s conversations', async ({ page }) => {
    await login(page, 'agent.bloom@demo.test');
    await page.goto('/conversations');
    const items = page.getByTestId('conversation-item');
    await expect(items.first()).toBeVisible();
    await expect(page.getByTestId('conversation-list')).not.toContainText('Nordic Living');
    await expect(page.getByTestId('conversation-list')).not.toContainText('Emma Larsen');
  });

  test('3-4, 9: customer simulator message reaches the agent in realtime; sent reply reaches the customer', async ({
    browser,
  }) => {
    const text = `${tag()} Hello from the customer`;
    const agent = await newSession(browser, 'agent.bloom@demo.test');
    const customer = await newSession(browser, 'agent.bloom@demo.test'); // second window acting as the customer simulator
    try {
      await openConversation(agent.page, 'Maya Patel');
      await openConversation(customer.page, 'Maya Patel');
      await customer.page.getByRole('button', { name: 'Customer simulator' }).click();
      await customer.page.getByLabel('Message as customer').fill(text);
      await customer.page.getByTestId('send-message').click();
      await expect(
        customer.page.getByTestId('message-customer').filter({ hasText: text }),
      ).toBeVisible();
      // the agent window was not touched: it must receive the message through Realtime
      await expect(
        agent.page.getByTestId('message-customer').filter({ hasText: text }),
      ).toBeVisible({ timeout: 20_000 });

      const reply = `${tag()} Thanks, we are on it`;
      await agent.page.getByLabel('Message to customer').fill(reply);
      await agent.page.getByTestId('send-message').click();
      await expect(
        customer.page.getByTestId('message-agent').filter({ hasText: reply }),
      ).toBeVisible({ timeout: 20_000 });
    } finally {
      await agent.context.close();
      await customer.context.close();
    }
  });

  test('14: a manual agent message is sent without invoking the AI', async ({ page }) => {
    const text = `${tag()} manual reply`;
    await login(page, 'agent.bloom@demo.test');
    await openConversation(page, 'Maya Patel');
    await page.getByLabel('Message to customer').fill(text);
    await page.getByTestId('send-message').click();
    await expect(page.getByTestId('message-agent').filter({ hasText: text })).toBeVisible();
    const { data } = await db
      .from('messages')
      .select('ai_generation_id, sender_type')
      .eq('body', text);
    expect(data).toEqual([{ ai_generation_id: null, sender_type: 'agent' }]);
  });

  test('15: double-clicking send creates exactly one message', async ({ page }) => {
    const text = `${tag()} double click`;
    await login(page, 'agent.bloom@demo.test');
    await openConversation(page, 'Maya Patel');
    await page.getByLabel('Message to customer').fill(text);
    await page.getByTestId('send-message').dblclick();
    await expect(page.getByTestId('message-agent').filter({ hasText: text })).toHaveCount(1);
    await page.waitForTimeout(1500);
    const { data } = await db.from('messages').select('id').eq('body', text);
    expect(data).toHaveLength(1);
  });

  test('13: an image can be attached, previewed and is shown in the chat', async ({ page }) => {
    await login(page, 'agent.bloom@demo.test');
    await openConversation(page, 'Maya Patel');
    await page.getByRole('button', { name: 'Customer simulator' }).click();
    await page
      .getByTestId('file-input')
      .setInputFiles({ name: 'broken-bottle.png', mimeType: 'image/png', buffer: PNG });
    await expect(
      page.getByRole('list', { name: 'Attachments to send' }).getByAltText('Attachment preview'),
    ).toBeVisible();
    await page.getByLabel('Message as customer').fill(`${tag()} here is the photo`);
    await page.getByTestId('send-message').click();
    const bubble = page.getByTestId('message-customer').filter({ hasText: 'here is the photo' });
    await expect(bubble.getByAltText('Attached image')).toBeVisible();
    await expect(bubble.getByAltText('Attached image')).toHaveJSProperty('complete', true);
  });

  test('rejects unsupported and oversized files before upload', async ({ page }) => {
    await login(page, 'agent.bloom@demo.test');
    await openConversation(page, 'Maya Patel');
    await page
      .getByTestId('file-input')
      .setInputFiles({ name: 'notes.txt', mimeType: 'text/plain', buffer: Buffer.from('hello') });
    await expect(
      page.getByText('Only PNG, JPEG, WebP and GIF images can be attached.'),
    ).toBeVisible();
    await page.getByTestId('file-input').setInputFiles({
      name: 'huge.png',
      mimeType: 'image/png',
      buffer: Buffer.alloc(5 * 1024 * 1024 + 1, 1),
    });
    await expect(page.getByText('That image is larger than 5 MB.')).toBeVisible();
  });
});

test.describe('AI reply lifecycle', () => {
  test('5-8: generate → sources shown → edit → approve → send; sending is a separate step', async ({
    page,
  }) => {
    await login(page, 'agent.bloom@demo.test');
    await openConversation(page, 'Maya Patel');

    await page.getByTestId('generate-reply').click();
    await expect(page.getByTestId('draft-body')).toBeVisible({ timeout: 45_000 });
    await expect(page.getByTestId('draft-status')).toHaveText('draft');
    // 6: retrieved policy and verified checks are visible
    await expect(page.getByTestId('sources')).toContainText('Damaged Items Policy');
    await expect(page.getByTestId('eligibility')).toContainText('Damage');
    // (greeting and fixed sign-off are added to the first reply / after a pause, not to every live-chat reply)
    await expect(page.getByTestId('draft-body')).toHaveValue(/photo|eligible|team/i);
    await expect(page.getByTestId('case-understanding')).toContainText('Next action');

    // 7: edit
    const edited = `${tag()} Hi Maya! Sorry about the bottle. Happy growing, The Bloom Botanics Team`;
    await page.getByTestId('draft-body').fill(edited);
    await page.getByTestId('approve-draft').click(); // "Save & approve"
    await expect(page.getByTestId('draft-status')).toHaveText('approved');
    // approval alone must not deliver anything
    await expect(page.getByTestId('message-agent').filter({ hasText: edited })).toHaveCount(0);

    // 8: send
    await page.getByTestId('send-draft').click();
    await expect(page.getByTestId('message-agent').filter({ hasText: edited })).toBeVisible();
    await expect(
      page.getByTestId('message-agent').filter({ hasText: edited }).getByText('AI-assisted'),
    ).toBeVisible();

    const { data } = await db
      .from('ai_generations')
      .select('status, original_body, current_body')
      .eq('conversation_id', IDS.maya)
      .eq('status', 'sent');
    expect(data?.[0]?.current_body).toBe(edited);
    expect(data?.[0]?.original_body).not.toBe(edited);
  });

  test('regenerate and discard work', async ({ page }) => {
    await login(page, 'agent.bloom@demo.test');
    await openConversation(page, 'Liam Chen');
    await page.getByTestId('generate-reply').click();
    await expect(page.getByTestId('draft-body')).toBeVisible({ timeout: 45_000 });
    const first = await page.getByTestId('draft-body').inputValue();
    await page.getByText('Regenerate with an instruction').click();
    await page.getByTestId('regenerate').click();
    await expect(page.getByTestId('draft-body')).toBeVisible({ timeout: 45_000 });
    expect(await page.getByTestId('draft-body').inputValue()).toContain('Liam');
    expect(first).toContain('Liam');
    await page.getByTestId('discard-draft').click();
    await expect(page.getByTestId('generate-reply')).toBeVisible();
  });

  test('refund beyond the window is shown as ineligible and promises nothing', async ({ page }) => {
    await login(page, 'agent.bloom@demo.test');
    await openConversation(page, 'Liam Chen');
    await page.getByTestId('generate-reply').click();
    await expect(page.getByTestId('eligibility')).toContainText('Ineligible', { timeout: 45_000 });
    await expect(page.getByTestId('draft-body')).not.toHaveValue(/we will refund|i have refunded/i);
    await page.getByTestId('discard-draft').click();
    await expect(page.getByTestId('generate-reply')).toBeVisible();
  });

  test('10-11: an admin edits a policy and the next generated reply uses it; stale drafts are flagged', async ({
    browser,
  }) => {
    test.setTimeout(240_000);
    const admin = await newSession(browser, 'admin@demo.test');
    const agent = await newSession(browser, 'agent.bloom@demo.test');
    try {
      await openConversation(agent.page, 'Liam Chen');
      await agent.page.getByTestId('generate-reply').click();
      await expect(agent.page.getByTestId('eligibility')).toContainText('Ineligible', {
        timeout: 45_000,
      });

      // the admin rewrites the policy wording from 7 to 30 days; the eligibility figures follow the text
      await admin.page.goto('/knowledge-base');
      const entry = admin.page
        .getByTestId('kb-entry')
        .filter({ hasText: 'Bloom Botanics Refund Policy' });
      await entry.getByRole('button', { name: 'Edit entry' }).click();
      const content = admin.page.getByLabel('Policy content');
      await content.fill((await content.inputValue()).replaceAll('7 days', '30 days'));
      await admin.page.getByTestId('save-kb-entry').click();
      await expect(admin.page.getByText('Entry updated')).toBeVisible();
      await expect(admin.page.getByText(/7 days → 30 days/)).toBeVisible();

      try {
        // the already-generated draft relied on the old version → stale
        await agent.page.reload();
        await expect(agent.page.getByTestId('stale-warning')).toBeVisible();
        await expect(agent.page.getByTestId('approve-draft')).toBeDisabled();

        // regenerate: the new draft evaluates the updated 30-day window
        await agent.page.getByText('Regenerate with an instruction').click();
        await agent.page.getByTestId('regenerate').click();
        await expect(agent.page.getByTestId('eligibility')).toContainText('Eligible', {
          timeout: 45_000,
        });
        await expect(agent.page.getByTestId('eligibility')).toContainText('30-day');
        await expect(agent.page.getByTestId('stale-warning')).toHaveCount(0);
        await agent.page.getByTestId('discard-draft').click();
        await expect(agent.page.getByTestId('generate-reply')).toBeVisible();
      } finally {
        await restoreRefundPolicy(); // via the database so a timeout can never leave the policy altered
      }
    } finally {
      await admin.context.close();
      await agent.context.close();
    }
  });
});

test.describe('isolation, roles and logs', () => {
  test('12: a Bloom agent cannot retrieve Nordic knowledge', async ({ page }) => {
    await login(page, 'agent.bloom@demo.test');
    await page.goto('/knowledge-base');
    await expect(page.getByTestId('kb-list')).toBeVisible();
    await expect(page.getByTestId('kb-list')).not.toContainText('Nordic Living');
    await expect(page.getByTestId('new-kb-entry')).toHaveCount(0); // read-only for agents

    await page.getByRole('button', { name: 'Preview retrieval' }).click();
    await page.locator('#pv-brand').click();
    await expect(page.getByRole('option')).toHaveText(['Bloom Botanics']);
    await page.keyboard.press('Escape');

    // and the API refuses outright when asked for the other brand
    const token = await page.evaluate(() => {
      const key = Object.keys(localStorage).find((k) => k.includes('auth-token'))!;
      return JSON.parse(localStorage.getItem(key)!).access_token as string;
    });
    const res = await page.request.post(`${API}/api/knowledge-base/preview`, {
      headers: { Authorization: `Bearer ${token}` },
      data: { brand_id: IDS.nordic, query: 'return policy 30 days' },
    });
    expect(res.status()).toBe(404);
    const conv = await page.request.get(`http://localhost:3001/api/conversations/${IDS.emma}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(conv.status()).toBe(404);
  });

  test('admins see both brands and can manage policies; agents cannot', async ({ browser }) => {
    const admin = await newSession(browser, 'admin@demo.test');
    try {
      await admin.page.goto('/knowledge-base');
      await expect(admin.page.getByTestId('kb-list')).toContainText('Nordic Living');
      await expect(admin.page.getByTestId('kb-list')).toContainText('Bloom Botanics');
      await expect(admin.page.getByTestId('new-kb-entry')).toBeVisible();
    } finally {
      await admin.context.close();
    }
  });

  test('16: the Logs page contains the generation records', async ({ page }) => {
    await login(page, 'agent.bloom@demo.test');
    await openConversation(page, 'Maya Patel');
    await page.getByTestId('generate-reply').click();
    await expect(page.getByTestId('draft-body')).toBeVisible({ timeout: 45_000 });

    await page.goto('/logs');
    const row = page.getByTestId('log-row').first();
    await expect(row).toContainText('Maya Patel');
    await expect(row).toContainText('Bloom Botanics');
    await expect(row).toContainText('Damaged Product');
    await expect(row).toContainText('ms');
    await row.click();
    const detail = page.getByTestId('log-detail');
    await expect(detail).toContainText('Customer message');
    await expect(detail).toContainText('Retrieved knowledge');
    await expect(detail).toContainText('Damaged Items Policy');
    await expect(detail).toContainText('Safety checks');
    await expect(detail).not.toContainText(/sb_secret|OPENAI_API_KEY|system prompt/i);
  });

  test('settings: agents see brand voice read-only; admins can edit', async ({ browser }) => {
    const agent = await newSession(browser, 'agent.bloom@demo.test');
    const admin = await newSession(browser, 'admin@demo.test');
    try {
      await agent.page.goto('/settings');
      await expect(agent.page.getByLabel('Tone')).toBeDisabled();
      await expect(agent.page.getByRole('button', { name: 'Save brand voice' })).toHaveCount(0);
      await admin.page.goto('/settings');
      await expect(admin.page.getByLabel('Tone')).toBeEnabled();
    } finally {
      await agent.context.close();
      await admin.context.close();
    }
  });
});
