import { expect, test } from '@playwright/test';
import { createBot, login } from './helpers';
import { mockConnection } from './speed-helpers';

test('echo paints while send is pending, retry reuses id, acknowledgement and cached switch stay visible', async ({ page }) => {
  test.skip(process.env.LLM_PROVIDER !== 'mock', 'Requires an isolated mock stack');
  await login(page);
  const cleanupConnection = await mockConnection(page);
  const a = await createBot(page, `speed1-a-${Date.now()}`);
  const b = await createBot(page, `speed1-b-${Date.now()}`);
  try {
    await page.goto(`/bots/${a.id}`);
    await expect(page.getByTestId('composer')).toBeVisible();
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const ids: string[] = [];
    await page.route('**/api/conversations/*/messages', async route => {
      ids.push(route.request().postDataJSON().client_id);
      if (ids.length === 1) { await route.abort('failed'); return; }
      await gate; await route.continue();
    });
    await page.getByTestId('composer').fill('What should I call you?');
    await page.getByTestId('send-chat').click();
    await expect(page.locator('[data-testid="message-item"][data-role="user"]').filter({hasText:'What should I call you?'})).toHaveCount(1);
    await expect(page.getByTestId("retry-send")).toBeVisible();
    await page.getByTestId("retry-send").click();
    release();
    await expect.poll(() => ids.length).toBe(2);
    expect(ids[1]).toBe(ids[0]);
    await expect(page.getByTestId('ack-chip')).toBeVisible({timeout:1500});
    await page.unroute('**/api/conversations/*/messages');
    await expect(page.getByTestId('send-chat')).toBeEnabled();
    await page.locator(`a[href="/bots/${b.id}"]`).first().click();
    await expect(page.getByTestId('composer')).toBeVisible();
    await page.route(`**/api/bots/${a.id}/workspace`, async route => { await new Promise(r => setTimeout(r, 1500)); await route.continue(); });
    await page.locator(`a[href="/bots/${a.id}"]`).first().click();
    await expect(page.locator('[data-testid="message-item"][data-role="user"]').filter({hasText:'What should I call you?'})).toBeVisible({timeout:200});
  } finally {
    await page.request.delete(`/api/bots/${a.id}`); await page.request.delete(`/api/bots/${b.id}`); await cleanupConnection();
  }
});
