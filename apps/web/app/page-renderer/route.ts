import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { rendererCss } from "@/lib/pages-renderer.mjs";

export const dynamic = "force-dynamic";
export async function GET() {
  // Read the trusted source verbatim: production minification must not rename serialized function dependencies.
  const script = (await readFile(join(process.cwd(), "lib/pages-renderer.mjs"), "utf8")).replace(/^export /gm, "") + "\nrunRenderer();";
  const nonce = randomBytes(24).toString("base64");
  return new Response(`<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style nonce="${nonce}">${rendererCss}</style></head><body><main id="page"></main><script nonce="${nonce}">${script}</script></body></html>`, {
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Content-Security-Policy": `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; img-src data: blob:; connect-src 'none'; form-action 'none'; frame-ancestors 'self'; base-uri 'none'; object-src 'none'; sandbox allow-scripts`,
      "Cache-Control": "no-store", "Referrer-Policy": "no-referrer", "X-Content-Type-Options": "nosniff",
      "Permissions-Policy": "camera=(), microphone=(), geolocation=(), payment=(), usb=()",
    },
  });
}
