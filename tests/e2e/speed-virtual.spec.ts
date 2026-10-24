import { expect, test, type Page } from '@playwright/test';
import { login } from './helpers';

const BOT = '44444444-4444-4444-8444-444444444444';
const bot = { id: BOT, name: 'Virtual history', role: 'Teammate', section: 'Teammates', avatarShape: 'blob1', avatarColor: '#4f46e5', isPrimary: true };
const message = (index: number) => ({
  id: `virtual-${index}`, role: index % 2 ? 'assistant' : 'user',
  content: `History row ${index}. ` + 'Variable height text. '.repeat(1 + Math.abs(index % 9) * 8),
  createdAt: new Date(Date.UTC(2026, 9, 24, 0, index + 100)).toISOString(),
});

async function fixture(page: Page, count = 500, older = false) {
  await login(page);
  // Exercise the real subscriber and streaming leaf without a model or stored fixtures.
  await page.addInitScript(() => {
    const original = window.fetch.bind(window);
    window.fetch = async (input, init) => {
      const path = new URL(typeof input === 'string' ? input : input instanceof Request ? input.url : input.toString(), location.href).pathname;
      if (path !== '/api/events') return original(input, init);
      const body = new ReadableStream<Uint8Array>({ start(controller) {
        (window as any).__virtualEmit = (event: unknown) => controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(event)}\n\n`));
        controller.enqueue(new TextEncoder().encode(': ready\n\n'));
        init?.signal?.addEventListener('abort', () => controller.close(), { once: true });
      }});
      return new Response(body, { headers: { 'Content-Type': 'text/event-stream' } });
    };
  });
  await page.route('**/api/bots', route => route.fulfill({ json: { bots: [bot] } }));
  await page.route(`**/api/bots/${BOT}/**`, route => route.fulfill({ json: [] }));
  await page.route('**/api/system/llm-status', route => route.fulfill({ json: { aiConnected: true } }));
  await page.route(`**/api/bots/${BOT}/workspace`, route => route.fulfill({ json: {
    bot, conversationId: BOT, messages: Array.from({ length: count }, (_, index) => message(index)),
    tasks: [], approvals: [], pages: [], holder: 'agent', aiConnected: true, messagesHasMore: older,
  } }));
  await page.route(`**/api/bots/${BOT}/messages?*`, route => route.fulfill({ json: {
    messages: Array.from({ length: 100 }, (_, index) => message(index - 100)), hasMore: false,
  } }));
  await page.goto(`/bots/${BOT}`);
  await expect(page.getByTestId('composer')).toBeVisible();
  await expect.poll(() => page.evaluate(() => typeof (window as any).__virtualEmit)).toBe('function');
  await expect(page.locator(`[data-chat-row="virtual-${count - 1}"]`)).toBeVisible();
}
async function emit(page: Page, event: Record<string, unknown>) {
  await page.evaluate(event => (window as any).__virtualEmit(event), { botId: BOT, taskId: 'virtual-task', roundId: 'virtual-round', ...event });
}
async function bottomGap(page: Page) {
  return page.getByTestId('chat-scroll').evaluate(node => node.scrollHeight - node.clientHeight - node.scrollTop);
}
async function anchor(page: Page) {
  return page.getByTestId('chat-scroll').evaluate(scroll => {
    const top = scroll.getBoundingClientRect().top;
    const rows = [...scroll.querySelectorAll<HTMLElement>('[data-chat-row]')];
    const row = rows.find(row => row.getBoundingClientRect().bottom > top)!;
    return { id: row.dataset.chatRow!, offset: row.getBoundingClientRect().top - top };
  });
}

test('500 variable-height messages render a window and respond to scrolling and keyboard navigation', async ({ page }) => {
  await fixture(page);
  await expect(page.getByTestId('chat-message-list')).toHaveAttribute('data-virtualized', 'true');
  expect(await page.getByTestId('message-item').count()).toBeLessThan(60);
  // Sample frame intervals while moving through the full history. Strict timing
  // is opt-in on the calibrated performance host; DOM/window correctness is required everywhere.
  const frames = await page.getByTestId('chat-scroll').evaluate(async node => {
    const intervals: number[] = []; let previous = performance.now();
    for (let step = 20; step >= 0; step--) {
      node.scrollTop = (node.scrollHeight - node.clientHeight) * step / 20;
      await new Promise<void>(resolve => requestAnimationFrame(now => { intervals.push(now - previous); previous = now; resolve(); }));
    }
    return intervals.sort((a, b) => a - b);
  });
  if (process.env.PERF_ENFORCE === '1') expect(frames[Math.floor(frames.length * .95)]).toBeLessThan(100);
  await expect(page.locator('[data-chat-row="virtual-0"]')).toBeVisible();
  expect(await page.getByTestId('message-item').count()).toBeLessThan(60);
  const row = page.locator('[data-chat-row="virtual-0"] article');
  await row.focus();
  for (let index = 1; index <= 20; index++) {
    await page.keyboard.press('ArrowDown');
    await expect(page.locator(`[data-chat-row="virtual-${index}"] article`)).toBeFocused();
  }
  await expect(page.getByRole('log', { name: 'Messages' })).toBeVisible();
});

test('stream growth, tools, optimistic echo and final message follow the bottom, respecting scroll-up', async ({ page }) => {
  await fixture(page);
  await emit(page, { type: 'tool.delta', index: 0, name: 'read_file' });
  await expect(page.getByTestId('tool-call-card')).toBeVisible();
  for (let index = 0; index < 8; index++) {
    await emit(page, { type: 'message.delta', delta: `Streaming paragraph ${index}. ` + 'Live content. '.repeat(30) + '\n\n' });
    await expect.poll(() => bottomGap(page)).toBeLessThan(4);
  }
  await page.getByTestId('chat-scroll').hover();
  await page.mouse.wheel(0, -900);
  await expect(page.getByTestId('jump-to-latest')).toBeVisible();
  const reading = await anchor(page);
  await emit(page, { type: 'message.delta', delta: 'Another live paragraph. '.repeat(100) });
  await expect.poll(async () => (await anchor(page)).id).toBe(reading.id);
  expect(Math.abs((await anchor(page)).offset - reading.offset)).toBeLessThan(4);
  await page.getByTestId('jump-to-latest').click();
  await expect.poll(() => bottomGap(page)).toBeLessThan(4);
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let clientId = '';
  await page.route('**/api/conversations/*/messages', async route => {
    clientId = route.request().postDataJSON().client_id;
    await gate;
    await route.fulfill({ json: { messageId: clientId } });
  });
  try {
    await page.getByTestId('composer').fill('Immediate virtual echo');
    await page.getByTestId('send-chat').click();
    await expect(page.getByTestId('message-item').filter({ hasText: 'Immediate virtual echo' })).toBeVisible();
    await expect.poll(() => bottomGap(page)).toBeLessThan(4);
  } finally { release(); }
  const final = { ...message(500), role: 'assistant', requestId: 'virtual-task', content: 'Final virtual assistant reply.' };
  await emit(page, { type: 'messages', messages: [final] });
  await expect(page.getByTestId('streaming-text')).toHaveCount(0);
  await expect(page.getByTestId('message-item').filter({ hasText: final.content })).toBeVisible();
  await expect(page.getByTestId('chat-live')).toContainText(final.content);
  await expect.poll(() => bottomGap(page)).toBeLessThan(4);
  expect(await page.getByTestId('message-item').count()).toBeLessThan(60);
});

test('prepending history keeps the reading row in place, including the short-chat threshold', async ({ page }) => {
  for (const count of [500, 40]) {
    await fixture(page, count, true);
    await page.getByTestId('chat-scroll').evaluate(node => { node.scrollTop = 0; });
    await expect(page.getByTestId('load-older')).toBeVisible();
    const before = await anchor(page);
    await page.getByTestId('load-older').click();
    await expect(page.getByTestId('chat-message-list')).toHaveAttribute('data-message-count', String(count + 100));
    await expect.poll(async () => (await anchor(page)).id).toBe(before.id);
    await expect.poll(async () => Math.abs((await anchor(page)).offset - before.offset)).toBeLessThan(4);
  }
});

test('short chats keep all rows, and reply jumps mount an offscreen original', async ({ page }) => {
  await fixture(page, 40);
  await expect(page.getByTestId('chat-message-list')).toHaveAttribute('data-virtualized', 'false');
  await expect(page.getByTestId('message-item')).toHaveCount(40);
  await fixture(page);
  const reply = { ...message(500), parts: [
    { type: 'reply', messageId: 'virtual-0', author: 'You', excerpt: 'History row 0' },
    { type: 'text', text: 'Reply to the beginning.' },
  ] };
  await emit(page, { type: 'messages', messages: [reply] });
  await page.getByTestId('reply-block').click();
  await expect(page.locator('#msg-virtual-0')).toBeVisible();
  await expect(page.locator('#msg-virtual-0')).toHaveAttribute('data-jump', 'on');
});
