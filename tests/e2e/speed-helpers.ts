import { expect, type Page } from '@playwright/test';
export async function mockConnection(page: Page): Promise<() => Promise<void>> {
  const status = await (await page.request.get('/api/system/llm-status')).json();
  if (status.hasKey || status.aiConnected) return async () => {};
  const response = await page.request.post('/api/secrets', {data:{namespace:'openrouter',name:'default',type:'API_KEY',value:`sk-or-speed-fixture-only-${Date.now()}`}});
  expect(response.ok()).toBeTruthy();
  const {id} = await response.json();
  return async () => { await page.request.delete(`/api/secrets/${id}`); };
}
