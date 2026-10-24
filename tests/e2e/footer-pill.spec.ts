import { mkdirSync } from "node:fs";
import { expect, test, type Page } from "@playwright/test";

const bot = "11111111-1111-4111-8111-111111111111";
const dir = "/opt/cursor/artifacts/footer-pill";
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAIAAAACACAIAAABMXPacAAAC2ElEQVR42u3dv030QBCG8S2EgNAioB4CAoqhBiogIKQaQqq4AkA66XQYn+U/45l3dh5rw09m9vkJ+DjfQjtxhV6NBAAAwAUAAFwAbLoe7u8A8Gu9fAEQ0z2dROu1exaJVqS+rEErkl6WoZVKL8jQatbXMWhl64sYtMr1FQxa8frhBo36sQaN+rEGAJQEEKwfZQBAPQDZ+iEGjfqxBgAAAAD1Aw0a9WMNAKgBkK6+m0GjfqwBAL0DpK7vYABA1wAd1D/aAAAAAKB+oAEAAABA/UADAAAAAAAAAACgM4Dr6/vz7bwStb7MnP7l6MtOEhmMZgYAAACSAox2ksJgcuauAJQNbg0MAACmAJoGM9MCAIA1gJrB/Kh9AswYDAckHrbW7xngv8Hwd1mln7nnkiFTAizZ2MhgmFq29Uf3XD5kt58B1wbOAOH1hQB+13Aj1mBd/7xWzVYC4JbBEZ8BawcDAAAXgP8GR/wvaMNUhQAuDFY/r03eE4Aty/AnWwAsVRw+Sj9PxDKurh5JAgBAMYDsBkfHAaAAQF4DhzIAALBsfbw8rV0AWBr4A/hkcf2NWXzxAaA2QBYDzyABv7iV+sEAygb+KQAoCaBpENIh8i9oUP+k8Ed8yqZXAYg1CN/7NMDj84fzCqnvv01dAGeGqA2qA/gYBO5uxfeAwCm/3l9/l3n3822l6ksDGDJc3xCAdQB7JCbvA8B2g1swy/9x7Kb6BFi1MgH0ZyBYHwAAvAzC97LxtaA+DGTrJwDYb6CwhdwAewxE5t/1crTIHtYy6Iy993mAzk4WMqgNbPBARm1LIw/l8WyeiCnvUHyZPZIk5RH1AcgDgMER9QFIBYCBeX0AsgFgYFt/4zvjSGxVf/tbEwltUh+AtAAYmNTf++5oou+sb/D2dNLvqW9zPoD68Qc0qA9AbYCCDKJnxKgff0iP+vGnJKkff0yV+hLnhEkff1Cb+vEn5ak/c/0ArjewIYATQCIAAAAASUVORK5CYII=", "base64");

async function installApi(page: Page) {
  await page.addInitScript(() => {
    const theme = new URLSearchParams(location.search).get("theme");
    if (theme === "light" || theme === "dark" || theme === "system") localStorage.setItem("teammates-theme", theme);
  });
  await page.route("**/owner-avatar.png", (route) => route.fulfill({ status: 200, contentType: "image/png", body: png }));
  await page.route("**/api/**", async (route) => {
    const url = route.request().url();
    if (url.includes("/api/events")) {
      await route.fulfill({ status: 200, headers: { "content-type": "text/event-stream" }, body: ": connected\n\n" });
      return;
    }
    if (url.includes("/api/auth/me")) {
      await route.fulfill({ json: { username: "saad", displayName: "Muhammad Saad Khan", avatarUrl: "/owner-avatar.png", role: "owner" } });
      return;
    }
    if (url.includes("/api/plugins")) {
      await route.fulfill({
        json: [
          { id: "p-notion", name: "Notion" },
          { id: "p-slack", name: "Slack" },
          { id: "p-drive", name: "Drive" },
          { id: "p-gmail", name: "Gmail" },
        ],
      });
      return;
    }
    if (url.includes("/workspace")) {
      await route.fulfill({
        json: {
          bot: { id: bot, name: "Ada", role: "Teammate", status: "idle", avatarColor: "#ff3045" },
          conversationId: bot,
          tasks: [],
          messages: [],
          approvals: [],
          pages: [],
          holder: "agent",
          openrouterConnected: true,
          codingJobs: [],
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

async function expectAppsPillFits(page: Page) {
  const fit = await page.evaluate(() => {
    const sidebar = document.querySelector("[data-testid='sidebar']")?.getBoundingClientRect();
    const apps = document.querySelector("[data-testid='open-plugins']")?.getBoundingClientRect();
    const logos = [...document.querySelectorAll("[data-testid='open-plugins'] [data-testid='app-logo']")].map((node) => {
      const box = node.getBoundingClientRect();
      const style = getComputedStyle(node);
      const art = node.querySelector("svg, img");
      const artBox = art?.getBoundingClientRect();
      let artInside = true;
      if (artBox && box.width > 0) {
        const cx = box.left + box.width / 2;
        const cy = box.top + box.height / 2;
        const radius = box.width / 2 + 0.5;
        const corners = [
          [artBox.left, artBox.top],
          [artBox.right, artBox.top],
          [artBox.left, artBox.bottom],
          [artBox.right, artBox.bottom],
        ];
        artInside = corners.every(([x, y]) => (x - cx) ** 2 + (y - cy) ** 2 <= radius * radius);
      }
      return { box, overflow: style.overflow, artInside };
    });
    const count = document.querySelector("[data-testid='apps-pill-count'], [data-testid='apps-pill-plus']")?.getBoundingClientRect();
    const marks = logos.map((logo) => logo.box);
    const edges = count ? [...marks, count] : marks;
    return {
      rightGap: sidebar && apps ? sidebar.right - apps.right : 0,
      logosInside: Boolean(
        sidebar &&
          apps &&
          edges.every((logo) => logo.left >= apps.left + 2 && logo.right <= apps.right - 2 && logo.left >= sidebar.left && logo.right <= sidebar.right - 8),
      ),
      ringsVisible: logos.every((logo) => logo.overflow === "visible"),
      artInside: logos.every((logo) => logo.artInside),
      widths: marks.map((logo) => logo.width),
    };
  });
  expect(fit.rightGap).toBeGreaterThanOrEqual(8);
  expect(fit.logosInside).toBe(true);
  expect(fit.ringsVisible).toBe(true);
  expect(fit.artInside).toBe(true);
  expect(fit.widths.length).toBeGreaterThanOrEqual(3);
  for (const width of fit.widths) {
    expect(width).toBeGreaterThanOrEqual(18);
    expect(width).toBeLessThanOrEqual(20);
  }
}

test("footer name stays readable at 280px and the apps pill shows icons", async ({ page }) => {
  mkdirSync(dir, { recursive: true });
  await installApi(page);
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto(`/bots/${bot}?theme=dark`);
  const sidebar = page.getByTestId("sidebar");
  const width = await sidebar.evaluate((node) => node.getBoundingClientRect().width);
  expect(width).toBeGreaterThanOrEqual(280);
  expect(width).toBeLessThanOrEqual(360);
  const name = page.getByTestId("account-name");
  await expect(name).toHaveText("Muhammad Saad Khan");
  const fit = await name.evaluate((node) => {
    const style = getComputedStyle(node);
    return { scroll: node.scrollWidth, client: node.clientWidth, overflow: style.textOverflow, whiteSpace: style.whiteSpace };
  });
  if (fit.scroll > fit.client + 1) {
    expect(fit.overflow).toBe("ellipsis");
    expect(fit.whiteSpace).toBe("nowrap");
  }
  const apps = page.getByTestId("open-plugins");
  await expect(apps).toContainText("+1");
  await expect(apps).toHaveAccessibleName("Connect apps");
  const account = page.getByTestId("account-button");
  const height = await account.evaluate((node) => node.getBoundingClientRect().height);
  expect(height).toBeGreaterThanOrEqual(44);
  const photo = account.getByTestId("account-avatar");
  const photoBox = await photo.boundingBox();
  expect(photoBox?.width ?? 0).toBeGreaterThanOrEqual(32);
  expect(photoBox?.height ?? 0).toBeGreaterThanOrEqual(32);
  const avatarShadow = await photo.evaluate((node) => getComputedStyle(node).boxShadow);
  expect(avatarShadow).toBe("none");
  const appsBox = await apps.boundingBox();
  await expect(account.getByTestId("account-avatar")).toHaveCount(1);
  const badgeOverlap = await page.evaluate(() => {
    const avatar = document.querySelector('[data-testid="account-avatar"]')?.getBoundingClientRect();
    const portal = document.querySelector("nextjs-portal");
    const root = portal?.shadowRoot;
    if (!avatar || !root) return false;
    return [...root.querySelectorAll("*")].some((node) => {
      const box = node.getBoundingClientRect();
      return box.width > 8 && box.height > 8 && box.left < avatar.right && box.right > avatar.left && box.top < avatar.bottom && box.bottom > avatar.top;
    });
  });
  expect(badgeOverlap).toBe(false);
  const marks = apps.getByTestId("app-logo");
  await expect(marks).toHaveCount(3);
  await expect(marks.first()).toHaveAttribute("data-logo", "brand");
  const markCount = await marks.count();
  let previous = 0;
  for (let index = 0; index < markCount; index += 1) {
    const markBox = await marks.nth(index).boundingBox();
    const ring = await marks.nth(index).evaluate((node) => getComputedStyle(node).boxShadow);
    expect(ring).not.toBe("none");
    expect(markBox?.width ?? 0).toBeGreaterThanOrEqual(20);
    expect(markBox?.height ?? 0).toBeGreaterThanOrEqual(20);
    expect(markBox?.x ?? 0).toBeGreaterThanOrEqual((appsBox?.x ?? 0) - 1);
    expect((markBox?.x ?? 0) + (markBox?.width ?? 0)).toBeLessThanOrEqual((appsBox?.x ?? 0) + (appsBox?.width ?? 0) + 1);
    expect(markBox?.x ?? 0).toBeGreaterThanOrEqual((photoBox?.x ?? 0) + (photoBox?.width ?? 0));
    if (index > 0) expect((markBox?.x ?? 0) - previous).toBeGreaterThanOrEqual(12);
    previous = markBox?.x ?? 0;
  }
  await expectAppsPillFits(page);
  await page.getByTestId("sidebar-footer").screenshot({ path: `${dir}/dark-280.png` });

  await page.getByTestId("sidebar").evaluate((node) => {
    node.style.width = "320px";
  });
  await expect(name).toHaveText("Muhammad Saad Khan");
  await expectAppsPillFits(page);
  await page.getByTestId("sidebar-footer").screenshot({ path: `${dir}/dark-320.png` });

  await page.goto(`/bots/${bot}?theme=light`);
  await expect(page.locator("html")).toHaveClass(/light/);
  await expect(page.getByTestId("account-name")).toHaveText("Muhammad Saad Khan");
  await page.getByTestId("sidebar").evaluate((node) => {
    node.style.width = "280px";
  });
  await expectAppsPillFits(page);
  await page.getByTestId("sidebar-footer").screenshot({ path: `${dir}/light-280.png` });
  await page.getByTestId("sidebar").evaluate((node) => {
    node.style.width = "320px";
  });
  await expectAppsPillFits(page);
  await page.getByTestId("sidebar-footer").screenshot({ path: `${dir}/light-320.png` });
});

test("empty apps pill shows three recommended logos and opens the catalog", async ({ page }) => {
  mkdirSync(dir, { recursive: true });
  await installApi(page);
  await page.route("**/api/**", async (route) => {
    const url = route.request().url();
    if (url.includes("/api/plugins/catalog")) {
      await route.fulfill({
        json: {
          items: [
            { id: "seed-notion", name: "Notion", category: "Productivity", trust: "official", label: "tested", description: "Notes" },
            { id: "seed-slack", name: "Slack", category: "Communication", trust: "official", label: "tested", description: "Chat" },
            { id: "seed-gmail", name: "Gmail", category: "Communication", trust: "official", label: "tested", description: "Mail" },
          ],
        },
      });
      return;
    }
    if (url.includes("/api/plugins")) {
      await route.fulfill({ json: [] });
      return;
    }
    await route.fallback();
  });
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto(`/bots/${bot}?theme=dark`);
  const apps = page.getByTestId("open-plugins");
  await expect(apps).toHaveAttribute("data-testid", "open-plugins");
  await expect(page.getByTestId("apps-pill-empty")).toBeVisible();
  await expect(apps.getByTestId("app-logo")).toHaveCount(3);
  await expect(apps.getByTestId("apps-pill-plus")).toHaveText("+");
  await expect(apps).not.toContainText("+1");
  await expect(page.getByTestId("account-name")).toHaveText("Muhammad Saad Khan");
  await page.getByTestId("sidebar").evaluate((node) => {
    node.style.width = "280px";
  });
  await expectAppsPillFits(page);
  await page.getByTestId("sidebar-footer").screenshot({ path: `${dir}/empty-dark.png` });
  await page.getByTestId("sidebar").evaluate((node) => {
    node.style.width = "320px";
  });
  await expectAppsPillFits(page);
  await page.getByTestId("sidebar-footer").screenshot({ path: `${dir}/empty-dark-320.png` });
  await page.getByTestId("sidebar").evaluate((node) => {
    node.style.width = "280px";
  });
  await apps.click();
  await expect(page.getByTestId("plugins-modal")).toBeVisible();
  await expect(page.getByTestId("plugins-modal").getByText("Notion").first()).toBeVisible();
  await page.getByTestId("plugins-modal").screenshot({ path: `${dir}/empty-modal-dark.png` });
  await page.goto(`/bots/${bot}?theme=light`);
  await expect(page.locator("html")).toHaveClass(/light/);
  await expect(page.getByTestId("apps-pill-empty")).toBeVisible();
  await page.getByTestId("sidebar").evaluate((node) => {
    node.style.width = "280px";
  });
  await expectAppsPillFits(page);
  await page.getByTestId("sidebar-footer").screenshot({ path: `${dir}/empty-light.png` });
  await page.getByTestId("sidebar").evaluate((node) => {
    node.style.width = "320px";
  });
  await expectAppsPillFits(page);
  await page.getByTestId("sidebar-footer").screenshot({ path: `${dir}/empty-light-320.png` });
});

test("account fallback is one initial from the display name", async ({ page }) => {
  await installApi(page);
  await page.route("**/api/auth/me", (route) => route.fulfill({ json: { username: "saad", displayName: "Muhammad Saad Khan", avatarUrl: "", role: "owner" } }));
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto(`/bots/${bot}?theme=dark`);
  const avatar = page.getByTestId("account-avatar");
  await expect(avatar).toHaveCount(1);
  await expect(avatar).toHaveText("M");
  const box = await avatar.boundingBox();
  expect(box?.width ?? 0).toBeGreaterThanOrEqual(32);
  expect(box?.height ?? 0).toBeGreaterThanOrEqual(32);
});
