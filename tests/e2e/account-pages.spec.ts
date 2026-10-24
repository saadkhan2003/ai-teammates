import { mkdir } from "node:fs/promises";
import { expect, test, type Page } from "@playwright/test";
import { login } from "./helpers";

const shots = "/workspace/shots-account-v1";

async function capture(page: Page, route: string, name: string, ready: () => Promise<unknown>) {
  await page.goto(route);
  await ready();
  if (route === "/settings") {
    const layers = await page.getByTestId("settings-modal").evaluate((panel) => {
      const describe = (element: Element) => {
        const style = getComputedStyle(element);
        return {
          element: `${element.tagName.toLowerCase()}${element.id ? `#${element.id}` : ""}${element.getAttribute("data-testid") ? `[data-testid=${element.getAttribute("data-testid")}]` : ""}`,
          opacity: style.opacity,
          filter: style.filter,
          backdropFilter: style.backdropFilter,
          zIndex: style.zIndex,
          isDialogOverlay: element.hasAttribute("data-radix-dialog-overlay"),
        };
      };
      const ancestors: Element[] = [];
      for (let node: Element | null = panel; node; node = node.parentElement) ancestors.push(node);
      const siblings = Array.from(panel.parentElement?.children ?? []).filter((node) => node !== panel).map(describe);
      const rect = panel.getBoundingClientRect();
      const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
      return { ancestors: ancestors.map(describe), siblings, centerInsidePanel: !!hit && panel.contains(hit) };
    });
    console.log("Settings modal layer diagnostics", JSON.stringify(layers));
    expect(layers.ancestors.every((node) => node.opacity === "1"), "settings panel and ancestors must be fully opaque").toBe(true);
    expect(layers.centerInsidePanel, "the settings panel must be above the overlay at its center").toBe(true);
    const overlay = layers.siblings.find((node) => node.isDialogOverlay);
    const panel = layers.ancestors[0];
    if (overlay && Number(overlay.zIndex) >= Number(panel.zIndex)) throw new Error("Dialog overlay is at or above the settings panel");
  }
  for (const theme of ["light", "dark"] as const) {
    await page.evaluate((value) => {
      localStorage.setItem("teammates-theme", value);
      document.documentElement.dataset.theme = value;
      document.documentElement.classList.toggle("light", value === "light");
    }, theme);
    await page.evaluate(async () => {
      await Promise.all(document.getAnimations().map(animation => animation.finished.catch(() => undefined)));
      await document.fonts.ready;
    });
    await page.screenshot({ path: `${shots}/${name}-${theme}.png`, fullPage: false, animations: "disabled" });
  }
}

test("account, support, legal, status, changelog and pricing pages", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await mkdir(shots, { recursive: true });
  await login(page);

  await capture(page, "/settings/account", "01-account", () => expect(page.getByTestId("account-page")).toBeVisible());
  await capture(page, "/settings/security", "02-security-2fa", async () => {
    await page.getByRole("button", { name: "Set up two-step sign-in" }).click();
    await expect(page.getByAltText("Authenticator setup QR code")).toBeVisible();
  });
  await capture(page, "/settings/sessions", "03-sessions", () => expect(page.getByTestId("sessions-page")).toBeVisible());
  await capture(page, "/settings/delete", "04-delete-dialog", async () => {
    await page.getByRole("button", { name: "Review deletion" }).click();
    await expect(page.getByTestId("delete-dialog")).toBeVisible();
  });
  await capture(page, "/settings", "05-profile", () => expect(page.getByTestId("settings-modal")).toBeVisible());
  await capture(page, "/settings/help", "06-help-faq-search", async () => {
    await page.getByTestId("faq-search").fill("password");
    await expect(page.getByText("How do I protect my account?")).toBeVisible();
  });
  await capture(page, "/settings/contact", "07-contact", () => expect(page.getByTestId("contact-page")).toBeVisible());
  await capture(page, "/settings/tickets", "08-my-tickets", () => expect(page.getByTestId("tickets-page")).toBeVisible());
  await capture(page, "/settings/support", "09-admin-support", () => expect(page.getByTestId("admin-support-page")).toBeVisible());
  await capture(page, "/legal/terms", "10-terms", () => expect(page.getByRole("heading", { name: "Terms" })).toBeVisible());
  await capture(page, "/legal/privacy", "11-privacy", () => expect(page.getByRole("heading", { name: "Privacy" })).toBeVisible());
  await capture(page, "/legal/acceptable-use", "12-aup", () => expect(page.getByRole("heading", { name: "Acceptable use" })).toBeVisible());
  await capture(page, "/status", "13-status", async () => {
    await expect(page.getByTestId("status-page")).toBeVisible();
    await expect(page.getByRole("heading", { name: "API", exact: true })).toBeVisible();
  });
  await capture(page, "/changelog", "14-changelog", () => expect(page.getByTestId("changelog-page")).toBeVisible());
  await capture(page, "/pricing", "15-pricing-pkr", () => expect(page.getByTestId("pricing-page")).toBeVisible());
  await capture(page, "/settings/billing", "16-billing", () => expect(page.getByTestId("billing-page")).toBeVisible());
  await page.evaluate(async () => {
    const response = await fetch("/api/admin/billing/config", {
      method: "PUT", credentials: "include", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ currencyRatePkrPerUsd: 280, plans: [
        { name: "Starter", priceUsd: 5, interval: "month", description: "Test sample plan", features: ["A few teammates", "Standard support"] },
        { name: "Team", priceUsd: 15, interval: "month", description: "Test sample plan", features: ["More teammates", "Priority support"] },
      ] }),
    });
    if (!response.ok) throw new Error("Could not configure test pricing");
  });
  await capture(page, "/pricing", "17-pricing-configured", () => expect(page.getByText("PKR 1,400")).toBeVisible());
  await page.evaluate(async () => {
    const response = await fetch("/api/admin/billing/config", {
      method: "PUT", credentials: "include", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ currencyRatePkrPerUsd: null, plans: [] }),
    });
    if (!response.ok) throw new Error("Could not clear test pricing");
  });
  await capture(page, "/pricing", "18-pricing-unconfigured", () => expect(page.getByText("Pricing has not been set yet")).toBeVisible());
  await capture(page, "/settings/incidents", "19-admin-incidents", () => expect(page.getByTestId("incidents-admin")).toBeVisible());
});
