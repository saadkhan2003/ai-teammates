import { expect, test, type Locator, type Page } from "@playwright/test";

const labels = ["button-primary", "button-secondary", "button-ghost", "button-danger", "button-primary-sm"] as const;

async function labelContrast(locator: Locator) {
  return locator.evaluate((node) => {
    function parse(color: string) {
      const match = color.match(/rgba?\(([^)]+)\)/);
      if (!match) return null;
      const parts = match[1].split(",").map((part) => Number(part.trim()));
      return { r: parts[0], g: parts[1], b: parts[2], a: parts.length > 3 ? parts[3] : 1 };
    }
    function channel(value: number) {
      const scaled = value / 255;
      return scaled <= 0.04045 ? scaled / 12.92 : ((scaled + 0.055) / 1.055) ** 2.4;
    }
    function lum(color: { r: number; g: number; b: number }) {
      return 0.2126 * channel(color.r) + 0.7152 * channel(color.g) + 0.0722 * channel(color.b);
    }
    function over(front: { r: number; g: number; b: number; a: number }, back: { r: number; g: number; b: number; a: number }) {
      const a = front.a + back.a * (1 - front.a);
      const mix = (fg: number, bg: number) => (a === 0 ? 0 : (fg * front.a + bg * back.a * (1 - front.a)) / a);
      return { r: mix(front.r, back.r), g: mix(front.g, back.g), b: mix(front.b, back.b), a };
    }
    const layers: { r: number; g: number; b: number; a: number }[] = [];
    let current: Element | null = node;
    while (current) {
      const color = parse(getComputedStyle(current).backgroundColor);
      if (color && color.a > 0) layers.push(color);
      if (color && color.a >= 0.99) break;
      current = current.parentElement;
    }
    let background = { r: 255, g: 255, b: 255, a: 1 };
    for (const layer of layers.reverse()) background = over(layer, background);
    const foreground = parse(getComputedStyle(node).color);
    if (!foreground) return 0;
    const lighter = Math.max(lum(foreground), lum(background));
    const darker = Math.min(lum(foreground), lum(background));
    return (lighter + 0.05) / (darker + 0.05);
  });
}

async function expectLabels(page: Page, theme: "light" | "dark") {
  await page.addInitScript((value) => {
    localStorage.setItem("teammates-theme", value);
  }, theme);
  await page.goto(`/dev/buttons?theme=${theme}`);
  await expect(page.getByTestId("button-contrast")).toBeVisible();
  await expect(page.locator("html")).toHaveClass(theme === "light" ? /light/ : /^((?!light).)*$/);
  for (const id of labels) {
    const button = page.getByTestId(id);
    await expect(button).toBeVisible();
    const text = (await button.innerText()).trim();
    expect(text.length).toBeGreaterThan(0);
    const ratio = await labelContrast(button);
    expect(ratio, `${theme} ${id} "${text}" contrast ${ratio.toFixed(2)}`).toBeGreaterThanOrEqual(4.5);
  }
}

test("button labels meet WCAG AA in light and dark", async ({ page }) => {
  await expectLabels(page, "dark");
  await expectLabels(page, "light");
});
