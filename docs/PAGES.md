# Pages

Pages turn a chat result into a private canvas. Open the card in chat or find it in Library → Pages. The canvas supports resize, full screen, copy/export Markdown, version history with added/removed line counts, viewing older versions and restoring one as a new version. Inputs and checklist changes are local to the preview; ask the bot to save source changes.

`write_page(title, kind, source)` creates a page. Kinds: `report`, `dashboard`, `tracker`, `plan`, `other`. For follow-ups, use `edit_page(page_id?, source?, edits?, summary)`. Omit page_id to edit the latest page in this chat. An edit can replace the full source or supply up to 50 `{find, replace}` objects; every find must match exactly once. A bot can only edit pages in its own chat. Existing page ids and titles are supplied as untrusted context. Page tools pass through the normal policy, approval, task lease and deduplication path. They cannot publish share links.

Source is Markdown plus fenced JSON components. No HTML or MDX is executed. Links and images are inert labels; no external assets are loaded. Use one object per `page` fence. Unknown components show a fallback message. Maximum UTF-8 source size: 256 KB. Maximum rendered blocks: 200, nesting: 4, grid rows: 1,000, columns: 30. Plain Markdown pipe tables and `- [ ]` checklists also work.

````markdown
# Quarterly plan

**Revenue** and delivery, at a glance.

```page
{"type":"grid","title":"Delivery","columns":["Project","Status","Budget"],"rows":[["Atlas","Active",2400],["Beacon","Planning",1800]]}
```

```page
{"type":"input","id":"price","label":"Price","kind":"number","value":20,"min":0}
```
```page
{"type":"input","id":"quantity","label":"Quantity","kind":"slider","value":3,"min":1,"max":20,"step":1}
```
```page
{"type":"calculator","label":"Total","expression":"price * quantity"}
```
````

Whitelisted components:

| Type | Fields |
| --- | --- |
| `table` | `title?`, `columns` (strings), `rows` (arrays of cells) |
| `grid` | Same as table, with column sorting and a row filter |
| `chart` | `title?`, `chart`: `bar`, `line` or `pie`, `data`: `[{"label":"Jan","value":12}]`; nonnegative finite values |
| `input` | `id` (identifier), `label?`, `kind`: `number`, `text`, `select`, `slider`; `value`, `min?`, `max?`, `step?`, `options?` (select strings) |
| `calculator` | `label?`, `expression` |
| `callout` | `title?`, `text` |
| `tabs` | `tabs`: `[{"label":"Overview","blocks":[{"type":"callout","text":"Ready"}]}]` |
| `progress` | `label?`, `value` (0–100) |
| `checklist` | `title?`, `items`: `[{"text":"Review","done":false}]` |
| `markdown` | `text` (also accepted inside tabs) |

Calculators use a recursive descent arithmetic parser: numeric inputs, numeric constants (including decimals and exponents), `+ - * / %`, unary signs and parentheses. No functions, property access, assignment, globals, evaluation or JavaScript. Expressions are limited to 512 characters, 128 tokens and depth 32. Invalid and non-finite results show “Check inputs”. Numeric select values and numeric text are usable as calculator inputs.

## Isolation and sharing

The renderer lives at `/page-renderer`, in a credentialless iframe with `sandbox="allow-scripts"`. There is no `allow-same-origin`, navigation, popup, download or forms permission. The route also sends a CSP sandbox, a nonce-authorized renderer script/style only, `default-src 'none'`, `connect-src 'none'`, `form-action 'none'`, `base-uri 'none'`, `object-src 'none'`, `img-src data: blob:` and `frame-ancestors 'self'`. No user-controlled URL, HTML, CSS or JavaScript is inserted into the document. Charts use generated SVG geometry. The document has no API or cookie bridge. The parent checks the iframe window and opaque origin (`null`) on messages; the renderer checks the parent window and same site URL origin. The only parent message is source plus theme; renderer replies only indicate readiness/completion.

Pages are private by default. Owners may create read-only bearer links at `/p/<token>` and revoke them independently. Only SHA-256 hashes of random 256-bit tokens are stored. Links expose the latest version, not history, owner/bot ids or mutation controls. Treat links as access to the source; source can be copied by a recipient. Links do not authenticate API mutations. Revoked links stop resolving on the next request; a recipient can retain content already viewed.

All private API queries require the session owner; bot mutations additionally require bot and chat scope. Source and metadata pass existing DLP checks/redaction. Edits lock the page row and append a version transactionally. Creation, edits, restores, sharing and revocation are audited without logging source or raw tokens. Owner reads/writes and public link resolution are rate limited; page write envelopes are capped at 2 MB to permit JSON escaping while source itself is capped at 256 KB.

API: `GET/POST /api/bots/:bot/pages`, `GET/PUT /api/pages/:id`, `GET /api/pages/:id/versions`, `POST /api/pages/:id/restore/:version`, `GET/POST /api/pages/:id/shares`, `DELETE /api/pages/:id/shares/:link`, `GET /api/public/pages/:token`. Private list accepts `q` and `kind`; document read accepts `version`.

## Validation

Local checks cover storage scoping/versioning/shares, tool policy and mock planning, DOM-only rendering and arithmetic. Stack tests are `tests/integration/test_pages.py`, `tests/e2e/pages.spec.ts` and `tests/e2e/pages-security.spec.ts`. Run with the mock provider only. Playwright writes viewport screenshots in both themes to `/workspace/shots-pages-v1/`.
