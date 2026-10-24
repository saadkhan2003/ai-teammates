import {expect, test} from '@playwright/test';
import {createBot, login} from './helpers';
import {mockConnection} from './speed-helpers';

test('progressive text precedes completion, tool chips arrive, and one stream serves the tab', async ({page}) => {
  test.skip(process.env.LLM_PROVIDER !== 'mock', 'Requires an isolated mock stack');
  await login(page);
  const cleanupConnection = await mockConnection(page);
  const bot = await createBot(page,`speed2-${Date.now()}`);
  let opened=0; let active=0; let peak=0;
  const streams = new Set<object>();
  page.on('request',request=>{if(new URL(request.url()).pathname==='/api/events'){opened++;active++;peak=Math.max(peak,active);streams.add(request);}});
  const closed=(request: object)=>{if(streams.delete(request))active--;};
  page.on('requestfinished',closed);page.on('requestfailed',closed);
  try {
    await page.goto(`/bots/${bot.id}`);
    await expect(page.getByTestId('composer')).toBeVisible();
    await page.getByTestId('composer').fill('SPEED STREAM DEMO');
    await page.getByTestId('send-chat').click();
    const text=page.getByTestId('streaming-text');
    await expect(text).toContainText('The first sentence is ready.');
    const early=await text.innerText();
    expect(early).not.toContain('The streamed reply is complete.');
    await expect.poll(async()=>await text.isVisible()? (await text.innerText()).length : early.length+1).toBeGreaterThan(early.length);
    await expect(page.locator('[data-testid="message-item"][data-role="assistant"]').filter({hasText:'The streamed reply is complete.'})).toBeVisible();
    await expect(text).toHaveCount(0);
    expect(opened).toBe(1);expect(peak).toBe(1);
    await page.getByTestId('composer').fill('SPEED TOOL DEMO');
    await page.getByTestId('send-chat').click();
    await expect(page.getByTestId('tool-call-card').filter({hasText:'Reading a file'})).toBeVisible();
    await expect(page.locator('[data-testid="message-item"][data-role="assistant"]').filter({hasText:'The file has been checked.'})).toBeVisible();
    expect(peak).toBe(1);
  } finally {await page.request.delete(`/api/bots/${bot.id}`);await cleanupConnection();}
});
