import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test, type Locator, type Page } from "@playwright/test";
import { IMAGE_GRID_GAP, IMAGE_GRID_SINGLE_MAX_HEIGHT, IMAGE_GRID_TILE_HEIGHT, imageGridColumns } from "../../apps/web/lib/image-grid-layout";

const fixtures = [join(process.cwd(), "fixtures/gallery"), join(process.cwd(), "tests/e2e/fixtures/gallery")].find((dir) => existsSync(dir));
if (!fixtures) throw new Error("gallery photo fixtures are missing");

const bot = "11111111-1111-4111-8111-111111111111";
const dir = "/opt/cursor/artifacts/image-gallery";
const line = "These shots line up in one row under the message and share the bubble width.";

function shots(names: string[]) {
  return names.map((name) => `![${name}](/gallery/${encodeURIComponent(name)}.jpg)`).join(" ");
}

async function install(page: Page, theme: { value: "light" | "dark" }) {
  await page.addInitScript(() => {
    const chosen = sessionStorage.getItem("shot-theme") || "dark";
    localStorage.setItem("teammates-theme", chosen);
  });
  await page.route("**/gallery/**", async (route) => {
    const url = route.request().url();
    if (url.includes("missing")) {
      await route.fulfill({ status: 404, body: "missing" });
      return;
    }
    const file = decodeURIComponent(url.split("/").pop() || "image.jpg").replace(/\.(jpg|jpeg|svg)$/i, "");
    await route.fulfill({ status: 200, contentType: "image/jpeg", body: readFileSync(join(fixtures, `${file}.jpg`)) });
  });
  await page.route("**/api/**", async (route) => {
    const url = route.request().url();
    if (url.includes("/api/events")) {
      await route.fulfill({ status: 200, headers: { "content-type": "text/event-stream" }, body: ": connected\n\n" });
      return;
    }
    if (url.includes("/api/auth/me")) {
      await route.fulfill({ json: { username: "saad", displayName: "Muhammad Saad Khan", role: "owner", theme: theme.value } });
      return;
    }
    if (url.includes("/files")) {
      await route.fulfill({ json: [{ path: "notes/overview.png", name: "overview.png", directory: false, updatedAt: "2026-10-24T08:00:00Z" }] });
      return;
    }
    if (url.includes("/workspace")) {
      await route.fulfill({
        json: {
          bot: { id: bot, name: "Ada", role: "Teammate", avatarColor: "#3b6fd8" },
          conversationId: bot,
          tasks: [],
          approvals: [],
          pages: [],
          holder: "agent",
          openrouterConnected: true,
          codingJobs: [],
          messages: [
            { id: "user-two", role: "user", content: `Two frames. ${line}\n${shots(["land-pair", "port-pair"])}`, createdAt: "2026-10-24T01:00:00Z" },
            { id: "one", role: "assistant", content: `One frame. ${line}\n${shots(["land-solo"])}`, createdAt: "2026-10-24T01:01:00Z" },
            { id: "three", role: "assistant", content: `Three frames. ${line}\n${shots(["port-one", "land-two", "land-three"])}`, createdAt: "2026-10-24T01:02:00Z" },
            { id: "four", role: "assistant", content: `Four frames. ${line}\n${shots(["land-four", "port-five", "land-six", "port-seven"])}`, createdAt: "2026-10-24T01:03:00Z" },
            { id: "six", role: "assistant", content: `Six frames. ${line}\n${shots(["port-a", "land-b", "port-c", "land-d", "land-e", "port-f"])}`, createdAt: "2026-10-24T01:04:00Z" },
            { id: "broken", role: "assistant", content: "![Missing file](/gallery/missing.jpg)", createdAt: "2026-10-24T01:05:00Z" },
          ],
        },
      });
      return;
    }
    if (url.includes("/api/bots")) {
      await route.fulfill({ json: [{ id: bot, name: "Ada", role: "Teammate", status: "idle", section: "Teammates" }] });
      return;
    }
    await route.fulfill({ json: [] });
  });
}

function message(page: Page, text: string) {
  return page.getByTestId("message-item").filter({ hasText: text });
}

async function expectGrid(card: Locator, count: number) {
  await expect(card).toHaveAttribute("data-image-count", String(count));
  await expect(card.locator("[data-testid=media-skeleton]")).toHaveCount(0);
  if (count === 1) {
    const tile = card.getByTestId("image-tile");
    await expect(tile).toHaveCount(1);
    await expect(tile.locator("img")).toHaveCSS("object-fit", "contain");
    const box = await tile.locator("img").evaluate((node) => {
      const style = getComputedStyle(node);
      const rect = node.getBoundingClientRect();
      return { maxHeight: style.maxHeight, width: rect.width, height: rect.height, radius: getComputedStyle(node.parentElement!).borderRadius };
    });
    expect(box.maxHeight).toBe(`${IMAGE_GRID_SINGLE_MAX_HEIGHT}px`);
    expect(box.height).toBeLessThanOrEqual(IMAGE_GRID_SINGLE_MAX_HEIGHT + 1);
    expect(box.width / box.height).toBeGreaterThan(1.4);
    expect(box.radius).toBe("12px");
    await expect(card.getByTestId("image-more")).toHaveCount(0);
    return;
  }
  const width = await card.evaluate((node) => node.clientWidth);
  const columns = imageGridColumns(width, count);
  await expect(card).toHaveAttribute("data-columns", String(columns));
  await expect(card.getByTestId("image-tile")).toHaveCount(columns);
  const strip = card.getByTestId("image-strip");
  const gap = await strip.evaluate((node) => getComputedStyle(node).gap);
  expect(gap.startsWith(`${IMAGE_GRID_GAP}px`)).toBe(true);
  const metrics = await strip.evaluate((node) => {
    const tiles = [...node.querySelectorAll("[data-testid='image-tile']")].map((tile) => {
      const rect = tile.getBoundingClientRect();
      const img = tile.querySelector("img");
      return { width: rect.width, height: rect.height, fit: img ? getComputedStyle(img).objectFit : "" };
    });
    return { strip: node.clientWidth, host: node.parentElement?.clientWidth ?? 0, tiles };
  });
  expect(metrics.host).toBeGreaterThan(0);
  expect(Math.abs(metrics.strip - metrics.host)).toBeLessThanOrEqual(1);
  expect(metrics.tiles).toHaveLength(columns);
  for (const tile of metrics.tiles) {
    expect(tile.fit).toBe("cover");
    expect(Math.abs(tile.height - IMAGE_GRID_TILE_HEIGHT)).toBeLessThanOrEqual(1);
  }
  const widths = metrics.tiles.map((tile) => tile.width);
  expect(Math.max(...widths) - Math.min(...widths)).toBeLessThanOrEqual(1);
  if (count > columns) await expect(card.getByTestId("image-more")).toHaveText(`+${count - columns}`);
  else await expect(card.getByTestId("image-more")).toHaveCount(0);
}

test("image grids fill the bubble and open one lightbox", async ({ page }) => {
  mkdirSync(dir, { recursive: true });
  const theme = { value: "dark" as "light" | "dark" };
  await install(page, theme);
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto(`/bots/${bot}?theme=dark`);

  const userTwo = message(page, "Two frames.");
  await expect(userTwo).toHaveAttribute("data-role", "user");
  const one = message(page, "One frame.");
  const three = message(page, "Three frames.");
  const four = message(page, "Four frames.");
  const six = message(page, "Six frames.");
  await expect(one).toHaveAttribute("data-role", "assistant");

  await expectGrid(userTwo.getByTestId("attachment-card"), 2);
  await expectGrid(one.getByTestId("attachment-card"), 1);
  await expectGrid(three.getByTestId("attachment-card"), 3);
  await expectGrid(four.getByTestId("attachment-card"), 4);
  await expectGrid(six.getByTestId("attachment-card"), 6);

  await expect(page.getByTestId("image-fallback")).toBeVisible();
  await page.evaluate(() => {
    document.querySelector("[data-testid='image-fallback']")?.closest("[data-testid='message-item']")?.remove();
  });

  const columns = Number(await six.getByTestId("attachment-card").getAttribute("data-columns"));
  expect(columns).toBeLessThan(6);
  await six.hover();
  await expect(six.getByTestId("message-react")).toBeVisible();
  await expect(six.getByTestId("message-reply")).toBeVisible();
  await expect(six.getByTestId("message-more")).toBeVisible();

  async function saveGrids(tone: "dark" | "light") {
    const shots = [
      ["Two frames.", "grid-2"],
      ["One frame.", "grid-1"],
      ["Three frames.", "grid-3"],
      ["Four frames.", "grid-4"],
      ["Six frames.", "grid-6"],
    ] as const;
    for (const [label, file] of shots) {
      const card = message(page, label).getByTestId("attachment-card");
      await card.scrollIntoViewIfNeeded();
      await page.evaluate(() => {
        document.querySelectorAll<HTMLElement>("[data-testid='jump-to-latest']").forEach((node) => {
          node.style.visibility = "hidden";
        });
      });
      await card.screenshot({ path: `${dir}/${file}-${tone}.png` });
    }
  }
  await saveGrids("dark");

  await six.getByTestId("image-more").click();
  const lightbox = page.getByTestId("image-lightbox");
  await expect(lightbox).toBeVisible();
  await expect(lightbox.getByTestId("lightbox-count")).toHaveText(`${columns} / 6`);
  await expect(lightbox.getByTestId("lightbox-caption")).toContainText(["port-a", "land-b", "port-c", "land-d"][columns - 1]);
  await expect(lightbox.getByTestId("lightbox-prev")).toBeVisible();
  await expect(lightbox.getByTestId("lightbox-next")).toBeVisible();
  const overlay = await lightbox.evaluate((node) => getComputedStyle(node).backgroundColor);
  expect(overlay).toBe("rgba(0, 0, 0, 0.9)");
  const scrimOpacity = await lightbox.evaluate((node) => getComputedStyle(node).opacity);
  expect(scrimOpacity).toBe("1");
  const frame = lightbox.getByTestId("lightbox-image");
  await expect(frame).toHaveJSProperty("complete", true);
  const presented = await frame.evaluate((node) => {
    const img = node as HTMLImageElement;
    const style = getComputedStyle(img);
    const box = img.getBoundingClientRect();
    return {
      opacity: style.opacity,
      fit: style.objectFit,
      radius: style.borderRadius,
      natural: img.naturalWidth / img.naturalHeight,
      shown: box.width / box.height,
    };
  });
  expect(presented.opacity).toBe("1");
  expect(presented.fit).toBe("contain");
  expect(presented.radius).toBe("12px");
  expect(Math.abs(presented.shown - presented.natural)).toBeLessThan(0.08);
  await expect(lightbox.getByTestId("lightbox-thumb")).toHaveCount(6);
  await expect(lightbox.getByTestId("lightbox-thumb").nth(columns - 1)).toHaveAttribute("data-active", "true");
  const activeRing = await lightbox.getByTestId("lightbox-thumb").nth(columns - 1).evaluate((node) => getComputedStyle(node).boxShadow);
  expect(activeRing).not.toBe("none");
  await page.screenshot({ path: `${dir}/lightbox-dark.png` });

  await page.keyboard.press("ArrowRight");
  await expect(lightbox.getByTestId("lightbox-count")).toHaveText(`${columns + 1} / 6`);
  await lightbox.getByTestId("lightbox-thumb").first().click();
  await expect(lightbox.getByTestId("lightbox-count")).toHaveText("1 / 6");
  await expect(lightbox.getByTestId("lightbox-prev")).toHaveCount(0);
  await page.keyboard.press("Escape");
  await expect(lightbox).toBeHidden();

  await one.getByTestId("image-tile").click();
  await expect(page.getByTestId("lightbox-count")).toHaveText("1 / 1");
  await expect(page.getByTestId("lightbox-caption")).toContainText("land-solo");
  await page.getByTestId("image-lightbox").click({ position: { x: 8, y: 8 } });
  await expect(page.getByTestId("image-lightbox")).toBeHidden();

  await page.getByTestId("bot-name-button").click();
  await page.getByRole("tab", { name: "Library", exact: true }).click();
  await page.getByTestId("library-row").filter({ hasText: "overview.png" }).click();
  await expect(page.getByTestId("image-lightbox")).toBeVisible();
  await expect(page.getByTestId("lightbox-caption")).toContainText("overview.png");
  await page.getByTestId("lightbox-close").click();

  theme.value = "light";
  await page.evaluate(() => sessionStorage.setItem("shot-theme", "light"));
  await page.reload();
  await expect(page.locator("html")).toHaveClass(/light/);
  const lightSix = message(page, "Six frames.");
  await expectGrid(lightSix.getByTestId("attachment-card"), 6);
  await expectGrid(message(page, "One frame.").getByTestId("attachment-card"), 1);
  await lightSix.getByTestId("image-more").click();
  const lightBox = page.getByTestId("image-lightbox");
  await expect(lightBox).toBeVisible();
  const lightOverlay = await lightBox.evaluate((node) => getComputedStyle(node).backgroundColor);
  expect(lightOverlay).toBe("rgba(0, 0, 0, 0.9)");
  const lightFrame = lightBox.getByTestId("lightbox-image");
  await expect(lightFrame).toHaveJSProperty("complete", true);
  const lightOpacity = await lightFrame.evaluate((node) => getComputedStyle(node).opacity);
  expect(lightOpacity).toBe("1");
  await page.screenshot({ path: `${dir}/lightbox-light.png` });
  await page.getByTestId("lightbox-close").click();
  await saveGrids("light");
});
