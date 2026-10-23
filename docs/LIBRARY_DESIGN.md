# Library: how Grok Bot does it, and a design for AI Teammates

Status: design, not built. Sizes are **estimates**. Written 2026-10-23 (Asia/Karachi).
Each finding is marked **[confirmed]** (seen on the box or on a fetched page this session) or **[inferred]** (reasoned from what I saw, not verified).

## 1. How Grok Bot's Library works

### 1.1 What the screenshot shows
Right panel, tabbed (Details, Library, Computer). Library is grouped into rounded cards headed **Today**, **This week**, **Older**. Each card has up to 5 rows: a 32 px file-type icon or a small image thumbnail, a name truncated with an ellipsis, and a **Show more** link at the foot of a group that has more rows. A file with no known type (`organize_documents.gs`) gets a grey "?" icon. Newest items sit at the top. **[confirmed from the screenshot]**

### 1.2 What the public docs say
- The Library tab lists the pages, files and links a Bot has made or shared, grouped into Today, This week and Older. Added in the 2026-09-28 release. **[confirmed]** https://x.ai/changelog/bot , https://cursor.com/help/grok-bot/pages
- A row's "More actions" (three dots) menu has **Open**, **Share…** (pages only) and **Pin**. Pinned items stay in a **Pinned** section at the top and sync across devices. **[confirmed]** same two pages.
- Hovering or focusing a row shows a preview card: who sent it, when, and who can see a Page. **[confirmed]** changelog v0.75.2.
- Pages (canvases) and documents are both labelled "Page". Shared pages are managed in the dashboard (unshare or delete). **[confirmed]** changelog 0.70.2 and 0.75.2.
- The Bot details pane is one column with tabs for Media, Computer and Routines (a newer layout than the screenshot). Images open full screen with download; HEIC photos show as images; HTML files preview with a Source toggle; large JSON/Markdown open without freezing; spreadsheet preview shows up to 10,000 rows. **[confirmed]** changelog.
- File sizes: attachments up to 250 MB, videos up to 1 GB, 20 attachments and 200 MB total per message; same-name attachments are numbered like `report.pdf (2)` per a third-party report. The older docs still say 6 files, 25 MB, 200 MB video. **[confirmed]** https://x.ai/changelog/bot (v0.71.2), https://docs.x.ai/grok-bot/files-and-results , https://grokbot.guru/bot-0-71-2-attachments-alerts/
- Deleting a Bot erases its conversations, memory, routines and attachments. **[confirmed]** changelog v0.75.2.
- Search finds attachment names across all chats. Files search reads the Bot's computer. **[confirmed]** changelog.

### 1.3 What I verified on the Grok Bot box

| Finding | Status |
|---|---|
| The shared workspace is `/workspace` ("durable project files here"); all of a user's Bots share one computer, so files are not isolated per Bot. | confirmed (https://cursor.com/docs/grok-bot/work) |
| `/workspace` on this box holds ~200 loose files and ~60 folders, so a naive "list the filesystem" Library would be noise. | confirmed (`ls`) |
| `/home/box/Downloads` holds browser downloads (3 zips). | confirmed |
| Per-agent attachment folder `/home/box/agent-data/agents/<agentId>/attachments/` holds 37 files named `<sha256>.<ext>`; the 7 I hashed matched their file contents, so it is **content-addressed**. Extensions seen: png, pdf, zip, md, jpg, gs. | confirmed |
| The synced store `/cursor/stores/<store>/grok-bot/agents/<agentId>/attachments/` holds 292 files: 226 png, 45 webp, 4 webm, 4 md, 1 pdf, 1 jpg, 1 zip, 10 `.bin`. Names are ULIDs or sha256, all flat in one folder, no folders by type or date. | confirmed |
| A `.gs` file exists among the sha256 attachments, which would produce the "?" icon in the screenshot. | confirmed that the file exists; that it is the `organize_documents.gs` row is inferred |
| The app builds Today / This week / Older from a timestamp, not from folder structure. The box files carry only mtime; the timestamp the app uses is probably its own database row (sent-at). | inferred |
| Library rows come from a server-side index of: files attached by the user in chat, files the Bot sends to the user (SendToUser), Pages (canvases), links, generated images and videos. The screenshot shows PDFs, zips, a `.tex` export, screenshots (`4-chat.png`) and `.md` docs together, which fits this. | inferred |
| `ListCanvases` returns "No pages matched" for this Bot, so Pages in Library are a separate table from files. | confirmed |
| `/home/box/reference/app-ui.md` (11 lines) says the per-agent info pane shows a live computer preview over a Routines list, plus Channels and Members. It does **not** mention Library. The skill catalogs mention Library only in `recent-changes` (2026-10-21 Pages note: "Open your bot's info pane → Library"). | confirmed |
| Hover preview, Pinned section, thumbnail generation method, exact "Show more" page size (5 in the screenshot) and the ordering key. | inferred / unknown |

**Reading:** Library is a per-Bot index over *delivered* things (what the user sent, what the Bot sent back, Pages), not a view of the filesystem. Chat is the entry point; Library is the history.

## 2. Comparable designs

| Product | What it does | Source |
|---|---|---|
| ChatGPT Library | Auto-saves uploaded and created files (documents, spreadsheets, presentations, images); search plus filters Uploaded/Generated and type (Images, Documents, Spreadsheets, Presentations, PDFs); select multiple and Download; "Add from library" in the composer; storage meter; temporary chats are not saved; locked chats keep files out of Library; generated images also in a separate Images tab. | https://help.openai.com/en/articles/20001052-using-library-to-manage-files-in-chatgpt , https://help.openai.com/en/articles/10056348-finding-your-chats-projects-and-files-in-chatgpt , https://help.openai.com/en/articles/6825453-chatgpt-release-notes%C2%A0 |
| Claude | Chat uploads: 500 MB per file, 20 files per chat. Project files: 30 MB per file, text extraction; supports PDF, DOCX, CSV, TXT, HTML, JSON, images. New project model has a Library of files you add and files Claude produces. | https://support.claude.com/en/articles/8241126-upload-files-to-claude , https://support.claude.com/en/articles/9517075-what-are-projects |
| Notion Library and Recents | Library is a full-page view with tabs (Recents, Favorites, Shared, Private); search by name, filters, multi-select bulk actions. Search sorts by Best match, Last edited, Created and filters by date (Today, Last 7 days, Last 30 days). Notion's help does **not** document Today/This week grouping, so that grouping is Grok Bot's own. | https://www.notion.com/help/manage-your-library , https://www.notion.com/help/search?id=958654%40 |

Takeaways we copy: auto-save both directions; type filter plus search; multi-download; storage meter; per-item share only for Pages; a way to exclude private/temporary items.

## 3. AI Teammates today (read from `/workspace/ai-teammates-live/src`)

Built:
- `apps/web/components/library-pane.tsx` (42 lines): merges `files` (flat `/workspace` listing, no directories) and `artifacts`; groups by day; 10 rows then **Show more**; thumbnail only for images (by mime or extension) using the raw download URL; "…" menu with Open/Download and Copy name; hover tooltip card with preview, bot avatar and time; skeleton (`library-loading`) and empty text.
- `apps/web/lib/library.ts` + `library.mjs`: `groupByDay` (Today, Yesterday, then long dates) and `formatAge`; unit-tested (2 tests).
- API: `GET /api/bots/{id}/artifacts`, `GET /api/artifacts/{id}/download` (owner-checked, loads whole object in memory), `GET/PUT /api/bots/{id}/files`, `GET /api/bots/{id}/files/raw` (always `application/octet-stream`).
- Table `artifacts` (id, bot_id, task_id, name, mime, size_bytes, sha256, object_key, source_url, created_at). Writers: `save_artifact` tool, screenshots (`evidence-*.png`) and recordings in `ComputerTools.cs` (50 MB cap).
- Composer attach (`chat-pane.tsx`) PUTs the file to `/workspace/uploads/<name>` and appends `[attached: path]` to the text.
- Path jail in `services/computer/src/workspace.py` (`locate_under` resolves and rejects paths outside the bot root with `path_escapes_workspace`).
- Output DLP in `apps/api/Dlp.cs` (redaction, health/finance phrase blocks) for text.
- e2e `tests/e2e/library-share.spec.ts` only checks the tab shows "Nothing here yet / Loading / Today / Yesterday".

### Gaps (vs. the screenshot and the research)
1. Grouping is Today / Yesterday / long dates, not Today / This week / Older; it uses the browser's timezone, not the user's saved zone.
2. Files have **no timestamp** (`createdAt` missing), so every file lands in "Today" and `formatAge` prints "now". Raw `/workspace` listing is not a Library; it shows build logs and junk.
3. Show more is client-side slicing across groups; one global limit, not per group; the API returns everything.
4. No unified item table: attachments both ways, pages, recordings, PR/diff exports are not indexed. Uploads are loose workspace files with no record of who sent them or when.
5. Thumbnails: images load the full original; no PDF, video or office thumbnails; no server-side resize; `File` icon for everything else; no "?" unknown icon distinction.
6. No click-to-preview dialog (only hover); no pdf/text/markdown/code/video viewers; `files/raw` always sends `application/octet-stream` so inline display is impossible.
7. No search, no type filter, no Pinned, no delete, no copy link, no share per item, no multi-select.
8. Download streams the whole object through API memory; no range support except video on artifacts; no `Content-Disposition` control or `X-Content-Type-Options: nosniff`.
9. DLP and the path jail are not applied to thumbnails, previews or share links.
10. Tests: no component tests, no a11y or visual tests for Library; e2e is a smoke check.

## 4. Design

### 4.1 What counts as a Library item
One row per **delivered** thing, per bot. Not every file in `/workspace`.

| Source (`source`) | Kind | Added when |
|---|---|---|
| `user_upload` | file | user attaches in chat (copy into object store; keep the `/workspace/uploads` copy for the bot) |
| `bot_send` | file | bot calls a send-file tool or saves an artifact |
| `screenshot` | image | `computer_screenshot` evidence (hidden by default behind the type filter "Screenshots" to avoid flooding; see 4.6) |
| `recording` | video | Teach / `record_start` output |
| `page` | page | a Page (canvas) is created or updated; opens the page, not a file viewer |
| `generated` | image/video | image or video generation |
| `pr_export` | patch/diff/markdown | PR summary, diff export, CI report from the Coding section |
| `link` (phase 2) | link | links the bot shares with a title and favicon |

Rule: an item exists only if a chat message, tool result or user action created it. Deleting a chat message does not delete the item.

### 4.2 Data model
New table `library_items` (migration `021_library.sql`); keep `artifacts` as the blob table and reference it.

| Column | Type | Notes |
|---|---|---|
| id | uuid PK | |
| owner_id | uuid | for fast owner checks |
| bot_id | uuid FK bots ON DELETE CASCADE | per-bot scoping |
| source | text CHECK | values from 4.1 |
| direction | text | `in` (user to bot) or `out` (bot to user) |
| name | text | display name, sanitized, max 255 |
| ext | text | lowercased, no dot |
| mime | text | sniffed on server, not trusted from client |
| kind | text | image, video, audio, pdf, text, markdown, code, doc, sheet, archive, page, link, unknown |
| size_bytes | bigint | |
| sha256 | text | dedupe within a bot; same hash plus name shows once, newest time wins |
| artifact_id | uuid FK artifacts NULL | blob location |
| page_id | uuid NULL | for pages |
| message_id | uuid NULL | chat message that carried it (for "who sent, when") |
| task_id | uuid NULL | |
| thumb_key | text NULL | object key of 256 px WebP |
| thumb_state | text | `pending`, `ready`, `none`, `failed` |
| width / height / duration_ms | int NULL | for media |
| pinned_at | timestamptz NULL | Pinned section |
| shared | text | `private` (default), `link` |
| share_token_hash | text NULL | |
| dlp_state | text | `clean`, `redacted`, `blocked` |
| created_at | timestamptz | the sort and grouping key |
| deleted_at | timestamptz NULL | soft delete, hard purge after 30 days |

Indexes: `(bot_id, created_at DESC) WHERE deleted_at IS NULL`; `(bot_id, kind, created_at DESC)`; unique `(bot_id, sha256, name)` for dedupe; GIN trigram on `name`.

### 4.3 Grouping in the user's timezone
- Add `users.timezone` (IANA, default from the browser on first login, editable in settings). The API computes boundaries; the client never guesses.
- Boundaries at the user's local midnight: **Today** = since today 00:00. **This week** = the rest of the last 7 days that is not Today (rolling, simpler to explain than calendar week; Grok Bot's exact rule is unknown, **[inferred]** from the label). **Older** = everything before that. Pinned items show first in a **Pinned** card.
- Response is already grouped: `GET /api/bots/{id}/library?group=…&limit=5&cursor=…` returns `{ pinned: [...], groups: [{key, label, total, items, nextCursor}] }`. Keyset cursor on `(created_at, id)`; **Show more** fetches the next page for that group only (5 per click, 20 after the first click is acceptable). Day rollover: refetch at the next local midnight and on window focus.
- Test with fixed timezones including Asia/Karachi (UTC+5) and one with DST (America/New_York) at 23:59 and 00:01 boundaries.

### 4.4 Icons and thumbnails
- **Icon by `kind`** (lucide): image `Image`, video `Film`, audio `AudioLines`, pdf `FileText` with a red tag, text/markdown `FileText`, code `FileCode`, sheet `Table`, doc `FileType`, archive `FileArchive`, page `LayoutPanelTop`, link `Link`, **unknown `FileQuestion`** in grey (the "?" row, e.g. `.gs`). Kind comes from a server table of extensions plus content sniff; unknown only when both fail.
- **Thumbnails, generated server side** by a worker after upload (never trust client images):
  - Images: resize to 256 px WebP with `sharp` or libvips, strip EXIF (privacy), cap input to 50 MP to avoid decompression bombs.
  - Video: `ffmpeg -ss 1 -frames:v 1` poster, 256 px WebP (ffmpeg already in the computer image).
  - PDF: `pdftoppm -r 72 -f 1 -l 1`, 256 px WebP.
  - Office docs: LibreOffice headless to PDF then as PDF, behind a 20 s timeout in the sandbox; otherwise the icon.
  - Text, code, markdown: icon only in the list; first 12 lines rendered in the hover card.
- Run thumbnailing in the computer sandbox (no network, CPU and memory limited, 20 s timeout), not in the API process. Store at `thumbs/{bot}/{item}.webp`; serve with `Cache-Control: private, max-age=31536000, immutable`.
- Row: 32 px square, 6 px radius, `object-fit: cover`; while `thumb_state=pending` show the icon, then swap in with a fade. Lazy-load with `loading="lazy"`.

### 4.5 Click to preview (modal or side sheet)
Header: icon, name, who and when, size. Footer actions: Download, Copy link, Open in chat (jumps to `message_id`), Delete. Left/right arrows move through the list; Esc closes; focus trapped and restored.

| Kind | Viewer |
|---|---|
| image | zoomable `<img>` of the original, served inline |
| pdf | `<iframe>` or pdf.js with sandbox, first page rendered, page controls |
| text, markdown, code | text fetched with a 2 MB cap, rendered in a read-only code or markdown component, **no script execution**; HTML shows as source, with an optional sandboxed preview (`sandbox=""`, no scripts) |
| csv / sheet | table of first 1,000 rows |
| video / audio | native player with Range requests |
| page | opens the Page route |
| unknown / too large / archive | file card with name, size, type guess and **Download** only; never try to render |

Serve inline previews from a **separate cookieless origin** or with `Content-Security-Policy: sandbox; default-src 'none'` and `X-Content-Type-Options: nosniff`; force `Content-Disposition: attachment` for html, svg, xml, and anything unknown so uploaded active content cannot run on the app origin.

### 4.6 Hover actions, search and filter
- Row hover or focus shows a "…" button and a quick Download icon. Menu: **Open**, **Download**, **Copy link** (only if shared; otherwise offers Share), **Pin / Unpin**, **Share** (pages and files), **Delete…** (confirm dialog: "Delete <name>? The file is removed from Library and cannot be recovered after 30 days", destructive button, Cancel focused). Delete is soft; the underlying workspace file is **not** deleted.
- Hover card (copy Grok Bot): larger preview, name, "sent by you" or the bot name with avatar, local time, size, share state.
- Search box above the groups: debounce 250 ms, name prefix/trigram match, results shown as a single flat list with type chips. Filter chips: All, Images, Documents, Spreadsheets, PDFs, Video, Code, Screenshots, Pages. Direction toggle: Uploaded / Generated (ChatGPT pattern). Screenshots are hidden under All and appear only under the Screenshots chip.
- Keyboard: arrow keys move rows, Enter previews, Space toggles select, Delete asks to delete, `/` focuses search.

### 4.7 Per-bot scoping and privacy
- Every query filters by `bot_id` **and** `owner_id` from the session; item ids are never enough on their own (return 404 not 403 to avoid probing). A Library never lists another bot's items even though the bots share one computer; this is stricter than Grok Bot, where files are shared on the computer **[confirmed]**.
- Items from a "private" or temporary chat are not indexed (copy ChatGPT's temporary and locked chat rule).
- Deleting a bot cascades items and blobs (queue blob purge). Soft-delete items hidden at once, purged after 30 days.
- Audit-log: upload, delete, share, unshare, download of shared item.

### 4.8 DLP and path-jail rules
- **Ingest by id, not by path.** The bot sends a file with a workspace path; the API resolves it with `locate_under` (resolve symlinks; must stay under the bot root; reject `..`, absolute paths outside `/workspace`, devices, FIFOs, and symlinks that leave the jail). Only regular files. Cap size at 50 MB for bot-sent files (existing `MaxArtifactBytes`) and 250 MB per user upload with 200 MB per message (Grok Bot's limits); streamed, never buffered; reject with a clear error.
- Deny list at ingest, even inside the jail: `.env`, `*.pem`, `*.key`, `id_*`, `.git/`, `.ssh/`, files under the vault or secrets folders, browser profile folders, files whose name contains `secret`, `token`, `credential`, `cookies` (a bot can still send them if the user explicitly asks, via an approval card; default is block with `dlp_blocked`).
- Text-like files (txt, md, csv, json, code, up to 2 MB) go through `Dlp.Redact` / `HasStrict` before preview. If a secret pattern matches: mark `dlp_state=redacted`, show a "Contains sensitive data" banner, and preview the redacted text; download requires confirmation. Health and finance phrase matches (`Dlp.IsHealthOrFinance`) default to private and block share links unless the user confirms.
- Thumbnails and previews are generated from the stored blob, never from a live path.
- Never trust names: strip path separators and control characters, cap length, add ` (2)` on collision in the same message (Grok Bot numbers same-name attachments, per https://grokbot.guru/bot-0-71-2-attachments-alerts/).
- Rate-limit uploads and thumbnail jobs per bot.

### 4.9 Share
- Only share on request. "Share" creates a random 256-bit token (stored hashed), default **expires in 7 days**, with Revoke. Link route `/s/{token}` serves a read-only preview, no sign-in, with the DLP gate from 4.8 and `noindex`. Pages follow Grok Bot's three levels (only you / team / anyone with the link) once teams exist; until then, only you and link.
- Copy link copies the share URL, never a storage URL. Audit every create and revoke.

### 4.10 UI states and accent
- **Skeleton** (`role="status"`, `aria-busy`, sr-only "Loading library"): three card skeletons with a heading bar and 3 rows of 32 px square plus text bar. Keep the existing `library-loading` test id.
- **Empty**: icon, "Nothing here yet", "Files you send and files your teammate shares will show up here." No call to action button; files arrive by chat.
- **Empty search**: "No files match 'x'" and a Clear search button.
- **Error**: inline card with message and **Try again**; keep the last loaded data visible (my choice, not a verified Grok Bot behaviour). A single failed row thumbnail falls back to the icon silently.
- **Show more**: text link inside the group card, shows "Loading…", error text with retry.
- **Accent**: use the bot's accent token (`bg-bot`, `text-bot`) for the focus ring, selected row, pin icon, active filter chip and "Show more" hover; thumbnails and icons stay neutral. Group cards use `rounded-xl border border-border bg-card` as in the screenshot; headings are `text-xs text-muted-foreground`. Respect `prefers-reduced-motion`.

### 4.11 API
```
GET    /api/bots/{id}/library?q=&kind=&direction=&limit=5&cursor=     grouped list (4.3)
GET    /api/bots/{id}/library/{item}                                   metadata
GET    /api/bots/{id}/library/{item}/thumb                             256 px webp
GET    /api/bots/{id}/library/{item}/content?inline=1                  Range-capable, streaming, correct mime
POST   /api/bots/{id}/library                                          user upload (multipart, streamed)
POST   /api/bots/{id}/library/{item}/pin | DELETE …/pin
POST   /api/bots/{id}/library/{item}/share | DELETE …/share
DELETE /api/bots/{id}/library/{item}                                   soft delete
GET    /s/{token}                                                      public read-only
```
Content endpoints stream from object storage (no whole-object memory copy), support `Range`, ETag from sha256, and the headers in 4.5.

### 4.12 Tests
- **Unit (node)**: grouping boundaries by timezone (Karachi, New York DST, UTC), kind detection (known, unknown `.gs`, extension spoofing), filename sanitizer, keyset cursor, dedupe.
- **API (C#)**: owner and bot scoping (other user and other bot get 404), path jail (symlink out, `..`, `/etc/passwd`, FIFO), deny-list names, size caps, content headers (nosniff, sandbox CSP, attachment for html/svg), Range, soft delete then 404, share expiry and revoke, DLP redaction and block.
- **Worker (Python)**: thumbnail for png, jpeg, webp, pdf, webm, a decompression-bomb image, a corrupt file (`thumb_state=failed`), timeout.
- **Component**: row states (skeleton, empty, error, search-empty), Show more per group, unknown icon, pending-to-ready thumbnail swap, delete confirm focus, keyboard navigation, accent classes.
- **e2e (Playwright)**: attach a file in chat and see it in Today; send an image from the bot and see the thumbnail; open the preview for each kind; delete and confirm; search and filter; run at 390 px and 1280 px; axe scan.
- **Visual**: screenshot of the three-card layout compared to the reference.

## 5. Build order (estimates, one engineer plus review)

| # | Step | Effort (estimate) |
|---|---|---|
| 1 | `library_items` migration, backfill from `artifacts`, `users.timezone`, ingest hook for uploads, `save_artifact`, screenshots, recordings | 1.5 days |
| 2 | Grouped list API with cursor paging, timezone grouping, per-group Show more; rewire the pane to Today / This week / Older; unit tests | 1.5 days |
| 3 | Kind detection, icons including unknown, row UI, skeleton, empty and error states, accent | 1 day |
| 4 | Thumbnail worker (image, video, PDF) in the computer sandbox, thumb endpoint | 2 days |
| 5 | Safe content endpoint (streaming, Range, mime, nosniff, CSP), path-jail ingest, deny list, DLP gate | 2 days |
| 6 | Preview dialog with viewers for image, PDF, text/markdown/code, video, unknown fallback | 2 days |
| 7 | Hover card and actions: download, copy link, delete with confirm, pin | 1 day |
| 8 | Search and type filters, keyboard navigation | 1 day |
| 9 | Share links, expiry, revoke, audit | 1.5 days |
| 10 | Pages and PR/diff exports as items; office thumbnails | 1.5 days |
| 11 | Full test pass (API, worker, component, e2e, a11y, visual) | 2 days |
| | **Total** | **about 17 days (estimate)**; steps 1 to 3 give a screenshot-matching Library in about 4 days. |

## 6. Sources
- https://cursor.com/help/grok-bot/pages
- https://x.ai/changelog/bot
- https://docs.x.ai/grok-bot/files-and-results
- https://grokbot.guru/bot-0-71-2-attachments-alerts/
- https://cursor.com/docs/grok-bot/work
- https://help.openai.com/en/articles/20001052-using-library-to-manage-files-in-chatgpt
- https://help.openai.com/en/articles/10056348-finding-your-chats-projects-and-files-in-chatgpt
- https://help.openai.com/en/articles/6825453-chatgpt-release-notes%C2%A0
- https://support.claude.com/en/articles/8241126-upload-files-to-claude
- https://support.claude.com/en/articles/9517075-what-are-projects
- https://www.notion.com/help/manage-your-library
- https://www.notion.com/help/search?id=958654%40
