# Every UI detail Saad asked for (Oct 23-24, 2026). ALL of these are required. Copy Grok Bot behaviour with our own branding and logo.

## Accent colour (bot colour) everywhere
- The colour he picks for a bot is its accent everywhere: avatar, his sent bubbles, send and voice buttons, bot name label, active icons, overall accent.
- Right panel: avatar, routine toggles, Details/Library/Computer tab states, coding status icons, PR icons, "Open" hover.
- The answered-card letter badge and similar per-bot accents use that bot's own avatar colour, never a fixed red.

## The approved list of 22 items (all approved, including eyes follow cursor, a tint behind the big avatar on hover, and the row ⋯ button)
1. Avatar loop: the big sidebar avatar and the small avatar above the composer run one continuous looping animation, frame-perfectly in sync and always on: slow clockwise rotation (about 40 s per turn) with smooth breathing or wobble of the points, eyes blinking every 4-5 s and darting left and right with snappy easing. Other list avatars stay static except on hover (item 4).
2. Eyes follow the cursor.
3. Hover card: hovering the big sidebar avatar fades in a small card over about 1 s with the bot name and a preview of its last message, and fades out on leave. No stretch effect. A subtle tint appears behind the big avatar on hover.
4. Row hover: sidebar rows turn light grey instantly, and that row's avatar morphs shape and grows slightly (wiggle). There's a row ⋯ button on hover.
5. Status shimmer: the status line beside the small composer avatar shimmers left to right (about 2 s per sweep, repeating about every 8 s) and slides in.
6. Reply display: when the user replies, a small rounded grey pill with the quoted text in grey, cut off with "…", sits above his own bubble, aligned right. When the bot replies, the quote goes inside the top of its grey bubble: a small speech-bubble icon, the quoted text in grey with "…", then the answer. Clicking a quote scrolls to the original message, highlights it for 3 s and fades out. A reply chip appears above the composer while replying.
7. Message hover toolbar: smiley, reply, ⋯.
8. Attachment hover: on a user message with attachments, a reply icon and a ⋯ menu appear beside EACH attachment (image, video, file).
9. Reaction picker: clicking the smiley opens a small rounded pill just under the toolbar with 👍 👎 ❤️ 😂 🎉 and an add-emoji button for the full picker; it flips above when there's no room. NOT a wide 288px panel.
10. Reaction pill: a small pill on the reacted message's corner. Hover shows a white rounded tooltip above it: "<Bot name> reacted with <emoji>". Bots react only to the user's messages.
11. Question card restyle: a white rounded card, a bold question, and options as plain rows with a small grey letter badge (A, B, C) on the left, not filled buttons. Pressing the letter key picks it.
12. Answered card: the question stays, greyed out, and only the chosen option remains, its letter badge filled in the bot's colour with a white letter. The other options disappear.
13. Header pill: a floating centred pill with the bot avatar and name at the top of the chat, with a hover state.
14. A thin scrollbar that hides automatically.
15. Computer thumbnail (info pane, Computer tab): it shows the live desktop whenever the computer is on. On hover the preview dims and a centred "↗ Open" label opens the full computer view. Caption: "<Bot>'s screen".
16. Sleep card, only when the computer is stopped: a grey rounded card with our greyed logo and "z z", "Computer is asleep", the "<Bot>'s screen" caption, and tap to wake.
17. Computer view control pill: one white rounded pill on the dark desktop replaces the old pills and the "Hand back" button. While watching: an eye icon, grey "Watching" and a black "Take control" button. While in control: a pointer icon, "You're in control" and a light grey "Stop" button. When the bot asked for help (a sign-in or handoff), the button reads "I'm done" and hands control back. Clean frame, no bot overlay, desktop taskbar visible.
18. Jump to latest: when scrolled up, a round white down-arrow button appears. When new messages arrive while scrolled up, a "↓ N new message(s) ×" pill appears in the bot colour. Clicking it jumps to the newest message; × dismisses it.
19. Upload state: a thin bar under the file card slides left to right on a loop while uploading. Images and videos show a shimmering skeleton until the preview renders, then it fades in.
20. Composer: a white pill with fully rounded ends and a thin light border. ＋ on the left, placeholder "Message <bot name>", a mic icon on the right, then a round bot-colour button with a voice icon that turns into an ↑ arrow while typing.
21. Sidebar footer: two pills. A rounded account pill (photo and name) opens the account menu. A separate pill with overlapping connected-app icons opens Connect apps or plugins. Keep the notifications bell. HOVER: the apps pill smoothly expands right to left into a wide "Connect apps" pill with the icons, while the account pill shrinks to just the round photo (name hidden but still clickable). It reverts on mouse leave.
22. Coding jobs card: a header with a count and one row per job with a live status icon (spinning while running, a check when finished, a green check when merged, red on failure). On hover the row turns grey and shows an eye (Watch, opens the live view in the app) and ↗ (Open, opens the full page or PR in a new window). Clicking the row opens the job details. A finished-job card in chat shows the title and status icon, the branch and PR number, files changed with green additions and red deletions, a View PR button and an open-in-app button.

## Also requested
- Share button at the top of the right panel, with a menu: "Create a copy" and "Share a template link".
- Right panel tabs: Details, Library and Computer. Routines panel with accent toggles.
- Themes: Light, Dark and System (live, the default). Every surface follows the theme.
- Remove the "Assign work" button unless a feature needs it.
- Bots are self-aware: in-app link pills, short warm replies.

## 23. Link pill hover preview (added Oct 24)

Owned by the chat-messages agent. Not built on this branch.

- Inline link pills show a small icon plus a label.
- Hovering a link pill shows a small rounded card just above it: a bold title on 1–2 lines, then a row with a favicon, the URL truncated with an ellipsis, and a ↗ icon. Click opens external links in the browser and in-app links in the app.
- The message toolbar appears to the right of a hovered bot bubble at the same time.
- The card follows the theme.

## What this branch builds

Items 13, 14, 20, and 21, plus the grey row and ⋯ button from item 4, Light/Dark/System, and removal of Assign work. The send and voice buttons use the bot colour. Avatar motion (items 1–3, 5, and the row morph in item 4) is the avatar agent. Chat message items 6–12, 18, 19, 22's in-chat card, and item 23 are the chat agent. The right panel, computer view, and item 22's panel rows are the right-panel agent. The notifications bell is a round button in the sidebar header so the footer stays the two pills in the reference.
