import { mkdir } from "node:fs/promises";
import { expect, test, type Page } from "@playwright/test";

const ARTIFACTS = "/opt/cursor/artifacts";

type Matrix = { a: number; b: number; c: number; d: number; tx: number; ty: number } | null;

function readMatrix(transform: string): Matrix {
  if (!transform || transform === "none") return null;
  const matrix3d = transform.match(/matrix3d\(([^)]+)\)/);
  if (matrix3d) {
    const n = matrix3d[1].split(",").map((part) => Number(part.trim()));
    return { a: n[0], b: n[1], c: n[4], d: n[5], tx: n[12], ty: n[13] };
  }
  const matrix = transform.match(/matrix\(([^)]+)\)/);
  if (!matrix) return null;
  const n = matrix[1].split(",").map((part) => Number(part.trim()));
  return { a: n[0], b: n[1], c: n[2], d: n[3], tx: n[4], ty: n[5] };
}

function rotationOf(transform: string) {
  const matrix = readMatrix(transform);
  if (!matrix) return 0;
  let degrees = (Math.atan2(matrix.b, matrix.a) * 180) / Math.PI;
  if (degrees < 0) degrees += 360;
  return degrees;
}

async function partTransform(page: Page, slot: string, part: string) {
  return page.locator(`[data-avatar-slot="${slot}"] [data-avatar-part="${part}"]`).evaluate((el) => getComputedStyle(el).transform);
}

async function setTime(page: Page, time: number) {
  await page.evaluate((value) => {
    document.documentElement.dataset.avatarDebug = "1";
    window.__avatarMotionFreeze = true;
    window.__avatarMotionNow = value;
  }, time);
  const expectedSpin = ((time % 40) + 40) % 40 * 9;
  await page.waitForFunction((expected) => {
    const spin = Number(document.documentElement.dataset.avatarSpin);
    return Number.isFinite(spin) && (Math.abs(spin - expected) < 0.08 || (expected < 0.08 && spin < 0.08));
  }, expectedSpin);
}

test.beforeEach(async ({ page, baseURL }) => {
  if (!baseURL || /:(18080|18443)\b/.test(baseURL)) {
    throw new Error("Refusing to run avatar motion tests against the shared stack.");
  }
  await page.addInitScript(() => {
    document.documentElement.dataset.avatarDebug = "1";
  });
  await mkdir(ARTIFACTS, { recursive: true });
});

test("live avatars share one clock, blink, and follow the pointer", async ({ page }) => {
  await page.goto("/dev/avatar-motion");
  await page.waitForFunction(() => document.documentElement.dataset.avatarReduced === "0");
  const stage = page.getByTestId("avatar-motion-stage");

  await setTime(page, 0);
  const openHero = await partTransform(page, "hero", "eyes");
  const openComposer = await partTransform(page, "composer", "eyes");
  expect(readMatrix(openHero)?.d ?? 0).toBeGreaterThan(0.9);
  expect(readMatrix(openComposer)?.d ?? 0).toBeGreaterThan(0.9);
  expect(rotationOf(await partTransform(page, "hero", "spin"))).toBeLessThan(1);
  expect(rotationOf(await partTransform(page, "composer", "spin"))).toBeLessThan(1);
  await stage.screenshot({ path: `${ARTIFACTS}/avatar-frame-open.png` });

  await setTime(page, 4.18);
  await stage.screenshot({ path: `${ARTIFACTS}/avatar-frame-blink-closing.png` });

  await setTime(page, 4.23);
  const shutHero = readMatrix(await partTransform(page, "hero", "eyes"));
  const shutComposer = readMatrix(await partTransform(page, "composer", "eyes"));
  expect(shutHero?.d ?? 1).toBeLessThan(0.2);
  expect(shutComposer?.d ?? 1).toBeLessThan(0.2);
  expect(Math.abs((shutHero?.d ?? 0) - (shutComposer?.d ?? 0))).toBeLessThan(0.02);
  await stage.screenshot({ path: `${ARTIFACTS}/avatar-frame-blink-shut.png` });

  await setTime(page, 4.36);
  await stage.screenshot({ path: `${ARTIFACTS}/avatar-frame-blink-opening.png` });

  await setTime(page, 10);
  const heroSpin = rotationOf(await partTransform(page, "hero", "spin"));
  const composerSpin = rotationOf(await partTransform(page, "composer", "spin"));
  expect(heroSpin).toBeGreaterThan(89);
  expect(heroSpin).toBeLessThan(91);
  expect(Math.abs(heroSpin - composerSpin)).toBeLessThan(0.2);
  const heroBreath = readMatrix(await partTransform(page, "hero", "breathe"));
  const composerBreath = readMatrix(await partTransform(page, "composer", "breathe"));
  expect(Math.abs((heroBreath?.a ?? 0) - (composerBreath?.a ?? 0))).toBeLessThan(0.002);
  expect(Math.abs((heroBreath?.d ?? 0) - (composerBreath?.d ?? 0))).toBeLessThan(0.002);
  await stage.screenshot({ path: `${ARTIFACTS}/avatar-frame-quarter-turn.png` });

  await page.evaluate(() => {
    window.__avatarMotionFreeze = false;
    window.__avatarMotionNow = undefined;
  });
  const live = [];
  for (let index = 0; index < 8; index += 1) {
    const sample = await page.evaluate(() => {
      const read = (slot: string, part: string) => {
        const el = document.querySelector(`[data-avatar-slot="${slot}"] [data-avatar-part="${part}"]`);
        return el ? getComputedStyle(el).transform : "";
      };
      return {
        heroSpin: read("hero", "spin"),
        composerSpin: read("composer", "spin"),
        heroBreath: read("hero", "breathe"),
        composerBreath: read("composer", "breathe"),
        heroBlink: read("hero", "eyes"),
        composerBlink: read("composer", "eyes"),
        spinVar: getComputedStyle(document.documentElement).getPropertyValue("--avatar-spin"),
        frozen: window.__avatarMotionFreeze === true,
        now: window.__avatarMotionNow ?? null,
      };
    });
    expect(sample.heroSpin).toBe(sample.composerSpin);
    expect(sample.heroBreath).toBe(sample.composerBreath);
    const heroBlink = readMatrix(sample.heroBlink)?.d ?? 0;
    const composerBlink = readMatrix(sample.composerBlink)?.d ?? 0;
    expect(Math.abs(heroBlink - composerBlink)).toBeLessThan(0.02);
    live.push(`${sample.spinVar}|freeze:${sample.frozen}|now:${sample.now}`);
    if (index === 0 || index === 4 || index === 7) {
      await stage.screenshot({ path: `${ARTIFACTS}/avatar-live-${index}.png` });
    }
    await page.waitForTimeout(180);
  }
  expect(new Set(live).size, live.join("\n")).toBeGreaterThan(1);

  const rowSpin = page.locator("[data-avatar-slot='pulse'] [data-avatar-part='spin']");
  await expect(rowSpin).toHaveCount(0);

  const hero = page.getByTestId("avatar-hero");
  const before = await hero.boundingBox();
  await hero.hover();
  const after = await hero.boundingBox();
  expect(Math.abs((before?.width ?? 0) - (after?.width ?? 0))).toBeLessThan(1);
  const card = page.getByTestId("avatar-hover-card");
  await expect(card).toHaveCSS("transition-duration", "1s");
  await page.waitForFunction(() => {
    const node = document.querySelector("[data-testid='avatar-hover-card']");
    const opacity = node ? Number(getComputedStyle(node).opacity) : 0;
    return opacity > 0.12 && opacity < 0.85;
  });
  await expect(page.getByTestId("avatar-hover-name")).toHaveText("ATLAS");
  await expect(page.getByTestId("avatar-hover-preview")).toContainText("white composer");
  await expect(card).toHaveCSS("opacity", "1");
  await expect(page.getByTestId("avatar-hero-tint")).toHaveCSS("opacity", "1");
  await stage.screenshot({ path: `${ARTIFACTS}/avatar-hover-card.png` });
  const cardBox = await card.boundingBox();
  await page.mouse.move(8, 8);
  await page.waitForTimeout(200);
  const fading = Number(await card.evaluate((el) => getComputedStyle(el).opacity));
  expect(fading).toBeLessThan(0.95);
  expect(cardBox?.width ?? 0).toBeGreaterThan(40);

  const heroBox = await page.getByTestId("motion-avatar-hero").boundingBox();
  const composerBox = await page.getByTestId("motion-avatar-composer").boundingBox();
  expect(heroBox && composerBox).toBeTruthy();
  const midX = ((heroBox?.x ?? 0) + (heroBox?.width ?? 0) + (composerBox?.x ?? 0)) / 2;
  const midY = (heroBox?.y ?? 0) + (heroBox?.height ?? 0) / 2;
  await page.mouse.move(midX, midY);
  await page.waitForTimeout(50);
  const looks = await page.evaluate(() => ({
    hero: Number(getComputedStyle(document.querySelector("[data-avatar-slot='hero']") as HTMLElement).getPropertyValue("--look-x")),
    composer: Number(getComputedStyle(document.querySelector("[data-avatar-slot='composer']") as HTMLElement).getPropertyValue("--look-x")),
  }));
  expect(looks.hero).toBeGreaterThan(0.4);
  expect(looks.composer).toBeLessThan(-0.4);
  await stage.screenshot({ path: `${ARTIFACTS}/avatar-eyes-follow.png` });
});

test("row hover morphs and grows the avatar", async ({ page }) => {
  await page.goto("/dev/avatar-motion");
  await page.waitForFunction(() => document.documentElement.dataset.avatarReduced === "0");
  const row = page.getByTestId("avatar-motion-row");
  const scaler = row.locator("[data-avatar-part='row']");
  await row.hover();
  await page.waitForTimeout(650);
  const transform = await scaler.evaluate((el) => getComputedStyle(el).transform);
  const matrix = readMatrix(transform);
  const scale = Math.hypot(matrix?.a ?? 1, matrix?.b ?? 0);
  expect(scale).toBeGreaterThan(1.05);
  expect(scale).toBeLessThan(1.2);
  const alt = await row.locator(".avatar-shape-alt").evaluate((el) => getComputedStyle(el).opacity);
  expect(Number(alt)).toBeGreaterThan(0.95);
  await row.screenshot({ path: `${ARTIFACTS}/avatar-row-hover.png` });
});

test("status line slides in and shimmers for 2s inside an 8s loop", async ({ page }) => {
  await page.goto("/dev/avatar-motion");
  const shimmer = page.getByTestId("avatar-status-shimmer");
  await expect(shimmer).toHaveCSS("animation-duration", "8s");
  const frames = await shimmer.evaluate((el) => {
    const sheetFrames: string[] = [];
    for (const sheet of document.styleSheets) {
      let rules: CSSRuleList;
      try {
        rules = sheet.cssRules;
      } catch {
        continue;
      }
      for (const rule of rules) {
        if (rule instanceof CSSKeyframesRule && rule.name === "avatar-status-shimmer") {
          for (const frame of rule.cssRules) sheetFrames.push(`${frame.keyText} ${frame.style.backgroundPosition}`);
        }
      }
    }
    const animation = el.getAnimations().find((item) => (item as CSSAnimation).animationName === "avatar-status-shimmer");
    if (!animation) return { sheetFrames, positions: [] as string[] };
    animation.pause();
    const positions: string[] = [];
    for (const time of [0, 2000, 7000]) {
      animation.currentTime = time;
      positions.push(getComputedStyle(el).backgroundPosition);
    }
    return { sheetFrames, positions };
  });
  expect(frames.sheetFrames.join(" ")).toContain("0%");
  expect(frames.sheetFrames.join(" ")).toContain("25%");
  expect(frames.sheetFrames.join(" ")).toContain("100%");
  expect(frames.positions[0]).not.toBe(frames.positions[1]);
  expect(frames.positions[1]).toBe(frames.positions[2]);

  await page.getByTestId("toggle-status").click();
  await expect(page.getByTestId("avatar-status")).toHaveCount(0);
  await page.getByTestId("toggle-status").click();
  const line = page.getByTestId("avatar-status");
  const motion = await line.evaluate((el) => {
    const animation = el.getAnimations().find((item) => (item as CSSAnimation).animationName === "avatar-status-in");
    if (!animation) return { missing: true, start: "", end: "" };
    animation.pause();
    animation.currentTime = 0;
    const start = getComputedStyle(el).transform;
    animation.currentTime = 450;
    const end = getComputedStyle(el).transform;
    return { missing: false, start, end };
  });
  expect(motion.missing).toBe(false);
  expect(motion.start).toContain("-12");
  const end = readMatrix(motion.end);
  expect(Math.abs(end?.tx ?? 12)).toBeLessThan(0.5);
  await page.getByTestId("avatar-motion-stage").screenshot({ path: `${ARTIFACTS}/avatar-status.png` });
});

test("reduced motion keeps the avatars still", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/dev/avatar-motion");
  await page.waitForFunction(() => document.documentElement.dataset.avatarReduced === "1");
  await page.evaluate(() => {
    window.__avatarMotionNow = 10;
  });
  await page.waitForTimeout(100);
  await expect(page.locator("[data-avatar-slot='hero'] [data-avatar-part='spin']")).toHaveCSS("transform", "none");
  await expect(page.locator("[data-avatar-slot='composer'] [data-avatar-part='eyes']")).toHaveCSS("transform", "none");
  await expect(page.getByTestId("avatar-status-shimmer")).toHaveCSS("animation-name", "none");
  const row = page.getByTestId("avatar-motion-row");
  await row.hover();
  await expect(row.locator("[data-avatar-part='row']")).toHaveCSS("transform", "matrix(1.08, 0, 0, 1.08, 0, 0)");
  await page.getByTestId("avatar-motion-stage").screenshot({ path: `${ARTIFACTS}/avatar-reduced-motion.png` });
});

test("idle clock work stays under a 2% frame budget", async ({ page }) => {
  await page.goto("/dev/avatar-motion");
  await page.waitForFunction(() => document.documentElement.dataset.avatarReduced === "0");
  await page.evaluate(() => {
    document.documentElement.dataset.avatarDebug = "1";
    delete window.__avatarMotionNow;
  });
  const samples = await page.evaluate(async () => {
    const values: number[] = [];
    for (let index = 0; index < 70; index += 1) {
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      values.push(Number(document.documentElement.dataset.avatarFrameMs || 0));
    }
    return values.slice(5);
  });
  const sorted = [...samples].sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)] ?? 99;
  expect(median).toBeLessThan(0.8);
  expect(Math.max(...samples)).toBeLessThan(4);
});
