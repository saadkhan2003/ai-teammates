import { expect, test } from "@playwright/test";
import { login } from "./helpers";

test("pair once, edit device permissions, heartbeat and revoke", async ({ page, request }) => {
  // Anonymous management cannot list devices.
  expect((await request.get("/api/devices")).status()).toBe(403);
  await login(page);
  await page.goto("/settings/computer");
  await expect(page.getByTestId("device-version")).toContainText("Latest companion");
  const issued = page.waitForResponse(response => response.url().endsWith("/api/devices/pair") && response.request().method() === "POST");
  await page.getByTestId("add-device").click();
  const issue = await (await issued).json();
  expect(Date.parse(issue.expiresAt) - Date.now()).toBeGreaterThan(9 * 60_000);
  expect(Date.parse(issue.expiresAt) - Date.now()).toBeLessThanOrEqual(10 * 60_000);
  const pairing = page.getByTestId("pairing-code");
  await expect(pairing).toBeVisible();
  const code = (await pairing.locator(".font-mono").innerText()).trim();
  const body = { code, name: `E2E device ${Date.now()}`, os: "Linux", version: "0.4.0" };
  const registered = await request.post("/api/devices/pair/complete", { data: body });
  expect(registered.ok()).toBeTruthy();
  const device = await registered.json();
  try {
    expect((await request.post("/api/devices/pair/complete", { data: body })).status()).toBe(400);
    expect((await request.post(`/api/devices/${device.id}/heartbeat`, { data: { version: "0.4.0" } })).status()).toBe(401);
    const beat = await request.post(`/api/devices/${device.id}/heartbeat`, { headers: { Authorization: `Bearer ${device.deviceToken}` }, data: { version: "0.4.0" } });
    expect(beat.ok()).toBeTruthy();
    const status = await beat.json();
    expect(status.execution).toBe("ask");
    expect(status.allowFiles).toBe(false);
    expect(status.routeTraffic).toBe(false);
    expect(JSON.stringify(status)).not.toContain("token");
    expect((await page.request.patch(`/api/devices/${device.id}`, { data: { execution: "invalid" } })).status()).toBe(400);
    expect((await request.post(`/api/devices/22222222-2222-4222-8222-222222222222/heartbeat`, { headers: { Authorization: `Bearer ${device.deviceToken}` }, data: { version: "0.4.0" } })).status()).toBe(401);
    await page.reload();
    const row = page.getByTestId("device-row").filter({ hasText: body.name });
    await expect(row).toContainText("Online");
    await row.getByTestId(`${device.id}-execution`).click();
    await page.getByRole("option", { name: "Off", exact: true }).click();
    await expect(row.getByTestId(`${device.id}-execution`)).toContainText("Off");
    await row.getByTestId(`${device.id}-allowFiles`).click();
    await expect(row.getByTestId(`${device.id}-allowFiles`)).toBeChecked();
    await row.getByTestId("revoke-device").click();
    await row.getByRole("button", { name: "Confirm revoke" }).click();
    await expect(row).toHaveCount(0);
    expect((await request.post(`/api/devices/${device.id}/heartbeat`, { headers: { Authorization: `Bearer ${device.deviceToken}` }, data: { version: "0.4.0" } })).status()).toBe(401);
  } finally { await page.request.delete(`/api/devices/${device.id}`); }
});
