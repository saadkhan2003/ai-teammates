# UI requirements

Source: the owner's UI notes (Oct 23–24, 2026), committed here so later work keeps the same list. Copy Grok Bot behaviour with our own branding and logo. Surfaces use `apps/web/styles/theme-tokens.css`.

This branch (`cursor/grok-chat-ui-2a3b`) implements the theme, the removal of Assign work, the left sidebar, the composer, and the floating header pill. The other rows are owned by the parallel agents and are not built here.

## Accent colour (bot colour) everywhere

- The colour picked for a bot is its accent everywhere: avatar, sent bubbles, send and voice buttons, bot name label, active icons, overall accent.
- Right panel: avatar, routine toggles, Details/Library/Computer tab states, coding status icons, PR icons, "Open" hover. Owned by agent 3.
- The answered-card letter badge and similar per-bot accents use that bot's own avatar colour, never a fixed red. Owned by agent 2.

## Approved list

1. Avatar loop. The big sidebar avatar and the small avatar above the composer run one continuous looping animation, in sync and always on: slow clockwise rotation (about 40 s per turn) with breathing or wobble, eyes blinking every 4–5 s and darting with snappy easing. Other list avatars stay static except on hover (item 4). Owned by agent 4.
2. Eyes follow the cursor. Owned by agent 4.
3. Hover card. Hovering the big sidebar avatar fades in a small card over about 1 s with the bot name and a preview of its last message, and fades out on leave. A subtle tint appears behind the big avatar. Owned by agent 4.
4. Row hover. Sidebar rows turn light grey instantly, and a ⋯ button appears (Open, Delete). The avatar morph and grow on that hover is owned by agent 4. The grey row and ⋯ button are on this branch.
5. Status shimmer. The status line beside the small composer avatar shimmers left to right (about 2 s per sweep, repeating about every 8 s) and slides in. Owned by agent 4.
6. Reply display. A quoted pill or quote inside the bubble, click-to-scroll with a 3 s highlight, and a reply chip above the composer. Owned by agent 2.
7. Message hover toolbar: smiley, reply, ⋯. Owned by agent 2.
8. Attachment hover: reply and ⋯ beside each attachment. Owned by agent 2.
9. Reaction picker: a small pill (👍 👎 ❤️ 😂 🎉 plus add), not a wide panel. Owned by agent 2.
10. Reaction pill on the message corner, with the tooltip "<Bot name> reacted with <emoji>". Bots react only to the user's messages. Owned by agent 2.
11. Question card: letter badges and letter-key shortcuts. Owned by agent 2.
12. Answered card: chosen option only, letter badge filled with the bot colour. Owned by agent 2.
13. Header pill. A floating centred pill with the bot avatar, name, and status, overlapping the thread, with a hover shadow. On this branch.
14. A thin scrollbar that hides until the sidebar list is hovered, focused, or scrolling. On this branch.
15. Computer thumbnail, hover "↗ Open", caption "<Bot>'s screen". Owned by agent 3.
16. Sleep card when the computer is stopped. Owned by agent 3.
17. Computer control pill: Watching / Take control, You're in control / Stop, and I'm done. Owned by agent 3.
18. Jump to latest: round down-arrow, and "↓ N new message(s) ×" in the bot colour. Owned by agent 2.
19. Upload bar and image/video skeletons. Owned by agent 2.
20. Composer. A fully rounded pill on the card colour, thin border, ＋ on the left (Attach files, Teach a task), placeholder "Message <bot name>", mic, then a round bot-colour button that shows a voice icon when empty and an up arrow while typing. On this branch. Theme-aware, so dark mode uses the dark card rather than a hard-coded white fill.
21. Sidebar footer. Two fully rounded pills on the sidebar background, matching the reference. Left pill: round photo (or initials) and the full name, medium weight, truncated; click opens the account menu. Right pill: up to three overlapping connected-app marks; click opens Connect apps. Hovering the footer expands the apps pill leftward into a wide "Connect apps" pill and shrinks the account pill to the round photo. It reverts on mouse leave. Notifications stay in the account menu so the footer stays two pills. Dark mode keeps the same shape on dark card surfaces. On this branch.
22. Coding jobs card, hover Watch/Open, and the finished-job card. Owned by agent 3 (panel) and agent 2 (the in-chat card).

## 23. Link pill hover preview

Owned by agent 2. Not built on this branch.

- Inline link pills show a small icon plus a label.
- Hovering a link pill shows a small rounded card just above it: a bold title on 1–2 lines, then a row with a favicon, the URL truncated with an ellipsis, and a ↗ icon. Click opens external links in the browser and in-app links in the app.
- The message toolbar (smiley, reply, ⋯) appears to the right of a hovered bot bubble at the same time.
- The card follows the theme.

## Also requested

- Share button on the right panel, with "Create a copy" and "Share a template link". Owned by agent 3.
- Right panel tabs: Details, Library, and Computer. Routines with accent toggles. Owned by agent 3.
- Themes: Light, Dark, and System (live, the default). Every surface follows the theme. On this branch, including the composer.
- No "Assign work" button. Send already creates the task. On this branch.
- Bots are self-aware: in-app link pills and short warm replies. Link pills are owned by agent 2.

## Full-window checklist (this branch)

| Spec line | Result |
| --- | --- |
| 3-column layout, right panel, window glyphs | Owned by agent 3 |
| Sidebar search and new as round card buttons | On this branch |
| Selected bot tile: centred rounded square, name, subtitle, status dot | On this branch |
| Bot rows: avatar, status dot, name, subtitle, grey hover, ⋯ | On this branch (avatar motion owned by agent 4) |
| Thin auto-hide sidebar scrollbar | On this branch |
| Footer pills and hover expand, notifications bell kept | On this branch |
| Floating header pill | On this branch |
| Composer pill | On this branch |
| Message bubbles, quotes, link pills, working line | Owned by agent 2 |
| Link pill hover card (item 23) | Owned by agent 2 |
| Right info panel, coding rows, routine toggles, computer view | Owned by agent 3 |
| Avatar loop, eyes, hover card, row morph, status shimmer | Owned by agent 4 |
| Light, Dark, System | On this branch |
| Assign work removed | On this branch |
