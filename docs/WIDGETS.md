# Chat widgets

Bots can stream structured, version 1 widgets as message parts. Every widget has `version`, a stable `id`, and a `type`; `title` is optional. Payloads are bounded to 48 KB and eight levels deep. Use `send_widget` with a widget object from `services/agent/widgets.py`. The client validates again before rendering. It never interprets widget text as HTML. Images accept HTTPS and base64 PNG/JPEG/GIF/WebP data URLs; SVG and other schemes are rejected.

All examples below omit the optional title where it is not relevant.

- **card**: `{ "version":1, "id":"summary", "type":"card", "title":"Summary", "body":"Three items are ready.", "items":["Alpha","Beta"], "actions":[{"id":"open","label":"Open","action":"open"}] }`
- **list**: `{ "version":1, "id":"tasks", "type":"list", "items":["Review draft",{"title":"Ship release","description":"After review"}] }`
- **table**: `{ "version":1, "id":"metrics", "type":"table", "columns":["Name","Count"], "rows":[["Jobs",4]] }`
- **form**: `{ "version":1, "id":"contact", "type":"form", "fields":[{"name":"email","label":"Email","type":"email","required":true}], "submit":{"id":"send","label":"Send","action":"send"} }`
- **buttons**: `{ "version":1, "id":"choice", "type":"buttons", "actions":[{"id":"yes","label":"Yes","action":"yes"}] }`
- **badges**: `{ "version":1, "id":"labels", "type":"badges", "items":[{"label":"Ready","tone":"success"}] }`
- **key-value**: `{ "version":1, "id":"details", "type":"key-value", "items":[{"key":"Owner","value":"Sam"}] }`
- **progress**: `{ "version":1, "id":"upload","type":"progress","value":64,"label":"Upload" }`
- **image-grid**: `{ "version":1, "id":"photos","type":"image-grid","images":[{"url":"https://example.com/photo.jpg","alt":"A landscape"}] }`
- **chart**: `{ "version":1, "id":"weekly","type":"chart","chart":"bar","data":[{"label":"Mon","value":3}],"xKey":"label","yKey":"value" }` (chart is `bar`, `line`, `area`, or `pie`)
- **flow**: `{ "version":1, "id":"steps","type":"flow","nodes":[{"id":"start","label":"Start","x":0,"y":0}],"edges":[] }`
- **code**: `{ "version":1, "id":"patch","type":"code","language":"typescript","filename":"math.ts","code":"export const answer = 42" }`; supply `original` to show a read-only diff.

Actions have an id, label, action name, optional payload, and optional `requires_approval`. The API checks action names against the stored widget before accepting a click. Do not put secrets or provider names in widget text.
