import { mkdir } from "node:fs/promises";
import { expect, test } from "@playwright/test";
import { login } from "./helpers";

test.use({ viewport: { width: 1440, height: 900 } });
const payload = `# Security report
Safe content remains visible.
<script>window.pagePwned=true;fetch('/api/bots');document.cookie;top.location='/escaped';parent.document.body.textContent='pwned'</script>
<img src="https://pages-exfil.invalid/image" onerror="window.pagePwned=true;fetch('/api/bots')">
[Escape](javascript:top.location='/escaped')
<iframe src="/api/bots"></iframe>
<form action="/api/bots" method="post"><input name="name" value="pwned"><button>Send</button></form>
<style>@import 'https://pages-exfil.invalid/style';body{background:url(https://pages-exfil.invalid/css)}</style>
\`\`\`page
{"type":"callout","text":"<img onerror='alert(1)' src='https://pages-exfil.invalid/data'>"}
\`\`\`
\`\`\`page
{"type":"calculator","expression":"parent.document.cookie"}
\`\`\`
\`\`\`page
{"type":"input","id":"constructor","label":"Unsafe identifier","value":1}
\`\`\`
`;

for (const theme of ["light", "dark"]) {
  test(`Malicious Page cannot access cookies, API, parent, top or network (${theme})`, async ({ page, browser }) => {
    await page.addInitScript(mode => localStorage.setItem("teammates-theme", mode), theme);
    await login(page);
    const made = await page.request.post("/api/bots", { data: { name: `Pages security ${Date.now()}` } });
    expect(made.ok()).toBeTruthy(); const bot = await made.json() as { id: string };
    const isolated = await browser.newContext({ viewport: { width: 1440, height: 900 }, storageState: { cookies: [], origins: [] } });
    try {
      const created = await page.request.post(`/api/bots/${bot.id}/pages`, { data: { title: "Security report", kind: "report", source: payload } });
      expect(created.ok()).toBeTruthy(); const pageDoc = await created.json() as { id: string };
      const shared = await page.request.post(`/api/pages/${pageDoc.id}/shares`); const link = await shared.json() as { url: string };
      const view = await isolated.newPage();
      await view.addInitScript(mode => localStorage.setItem("teammates-theme", mode), theme);
      const origin = new URL(page.url()).origin;
      // A readable sentinel makes a cookie-read success detectable without exposing any session value.
      await isolated.addCookies([{ name: "page_security_sentinel", value: "sentinel", url: origin, httpOnly: false, sameSite: "Lax" }]);
      const unexpected: string[] = [];
      view.on("request", request => {
        let renderer = false; try { renderer = request.frame().url().includes("/page-renderer"); } catch { /* no frame */ }
        if (request.url().includes("pages-exfil.invalid") || (renderer && !new URL(request.url()).pathname.startsWith("/page-renderer"))) unexpected.push(new URL(request.url()).pathname);
      });
      await view.goto(new URL(link.url, origin).href);
      const locator = view.frameLocator('[data-testid="page-frame"]');
      await expect(locator.getByRole("heading", { name: "Security report", exact: true })).toBeVisible();
      await expect(locator.getByText("Check inputs", { exact: true })).toBeVisible();
      await expect(locator.locator("script:not([nonce]),iframe,form,img,a[href],style:not([nonce])")).toHaveCount(0);
      await expect(view.getByTestId("page-frame")).toHaveAttribute("sandbox", "allow-scripts");
      await expect(view.getByTestId("page-frame")).toHaveAttribute("credentialless", "");
      const rendererResponse = await view.request.get(new URL("/page-renderer", origin).href);
      const csp = rendererResponse.headers()["content-security-policy"];
      expect(csp).toContain("default-src 'none'"); expect(csp).toContain("connect-src 'none'"); expect(csp).toContain("form-action 'none'"); expect(csp).toContain("frame-ancestors 'self'"); expect(csp).toContain("sandbox allow-scripts");
      expect(csp).not.toMatch(/allow-same-origin|unsafe-inline|unsafe-eval/);
      const frame = view.frames().find(f => f.url().includes("/page-renderer"))!;
      const topUrl = view.url();
      // DevTools evaluation probes the browser boundary even though source scripts were stripped.
      const probe = await frame.evaluate(async () => {
        let cookie = false, parentRead = false, api = false, storage = false;
        try { cookie = document.cookie.includes("sentinel"); } catch { /* opaque origin */ }
        try { parentRead = !!parent.document.body; } catch { /* cross-origin */ }
        try { localStorage.setItem("probe", "x"); storage = true; } catch { /* opaque origin */ }
        try { await fetch("/api/bots", { credentials: "include" }); api = true; } catch { /* CSP */ }
        try { top!.location.href = "/escaped"; } catch { /* sandbox */ }
        const script = document.createElement("script"); script.textContent = "window.pagePwned=true"; document.body.append(script);
        const style = document.createElement("style"); style.textContent = "body{background:url(https://pages-exfil.invalid/probe)}"; document.head.append(style);
        const form = document.createElement("form"); form.action = "/api/bots"; form.method = "post"; document.body.append(form); try { form.submit(); } catch { /* sandbox + CSP */ }
        return { cookie, parentRead, api, storage, pwned: !!(window as Window & { pagePwned?: boolean }).pagePwned };
      });
      expect(probe).toEqual({ cookie: false, parentRead: false, api: false, storage: false, pwned: false });
      await expect(view).toHaveURL(topUrl);
      expect(unexpected).toEqual([]);
      // A forged sibling/top-level sender cannot replace content in the frame.
      await view.evaluate(() => {
        const sibling = document.createElement("iframe"); sibling.setAttribute("sandbox", "allow-scripts"); sibling.hidden = true;
        sibling.srcdoc = '<script>parent.frames[0].postMessage({type:"page:render",source:"# Forged"},"*")<\/script>';
        document.body.append(sibling);
      });
      await expect(locator.getByRole("heading", { name: "Security report", exact: true })).toBeVisible();
      await mkdir("/workspace/shots-pages-v1", { recursive: true });
      await view.screenshot({ path: `/workspace/shots-pages-v1/07-security-view-${theme}.png`, fullPage: false });
      expect(unexpected).toEqual([]);
    } finally { await isolated.close(); await page.request.delete(`/api/bots/${bot.id}`); }
  });
}
