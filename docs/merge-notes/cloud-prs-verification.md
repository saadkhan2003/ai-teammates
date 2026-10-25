# Cloud PR merge verification (#7, #8, #9, #10, #11, #6)

Historical tree-comparison snapshot for the listed cloud PRs. The local reconstruction refs and ancestry results below were checked against the stated HEAD; re-fetch the current repository refs before using this note to decide what to merge.

ui-integrate HEAD before this note: 80e9c94. Origin SHAs return 403, so each pr/* ref is the local reconstruction, tree-verified against Origin.

## Ancestry and per-file tree comparison (PR changed files vs HEAD)

```
#7 pr/grok-chat-ui-2a3b local=c834f2a origin=4c0a9ec base=0a8a3fa ancestor=yes changed=266 identical=134 evolved=125 absent/renamed=7
#8 pr/ui-avatar-motion local=72678aa origin=e6e529a base=0a8a3fa ancestor=yes changed=172 identical=49 evolved=117 absent/renamed=6
#9 pr/ui-chat-messages local=282a99c origin=246455e base=0a8a3fa ancestor=yes changed=159 identical=40 evolved=113 absent/renamed=6
#10 pr/ui-right-panel local=a9d3f7b origin=e654227 base=0a8a3fa ancestor=yes changed=160 identical=41 evolved=113 absent/renamed=6
#11 pr/ui-account-pages local=658791e origin=4372419 base=d070a69 ancestor=yes changed=115 identical=48 evolved=64 absent/renamed=3
#6 pr/bot-app-awareness-a02f local=3096311 origin=46adc87 base=a6370b1 ancestor=yes changed=31 identical=1 evolved=30 absent/renamed=0
```

identical = same blob at HEAD; evolved = file present but changed later; absent = renamed or replaced.

## Line-level presence (regress_x.py, token-normalized, any tracked file)

```
#7 (0a8a3fa..c834f2a): TOTAL missing anywhere (token-normalized) 483
#8 (0a8a3fa..72678aa): TOTAL missing anywhere (token-normalized) 551
#9 (0a8a3fa..282a99c): TOTAL missing anywhere (token-normalized) 526
#10 (0a8a3fa..a9d3f7b): TOTAL missing anywhere (token-normalized) 523
#11 (d070a69..658791e): TOTAL missing anywhere (token-normalized) 187
#6 (a6370b1..3096311): TOTAL missing anywhere (token-normalized) 87
```

#8-#10 are counted from 0a8a3fa, so their totals include the shared stack under #7.
Against the final cloud tree (regress.py), #8/#9/#10 lack only 1/8/18 lines, and
each of those exists in an extended form.

Reviewed categories of lines not present verbatim, all intentional or superseded:
- Absent files: db/015-020 renumbered to db/057-063. services/computer/desktop
  rc.xml/tint2rc/wallpaper were replaced by the xfwm4 + Plank desktop (2637800).
- Provider/model names removed from user-facing copy and the app guide (product rule).
- Settings, admin and plans pages were refactored in v0.5 (grouped settings-nav-config,
  credits/plans), with classes mapped to ui-integrate tokens (text-title, rounded-card,
  cardClass, SectionTitle, --space-section).
- Chat, workspace and computer panes: cloud UI restored in 53f78d9 (131 of 167 files
  at >=90% line retention). The rest are newer v0.5 behaviour, e.g. the RoutinesSection
  drawer and the extended jump-to-latest/fullscreen conditions.
- #6 deep links: every app-guide settings id resolves (unit test passes), and panel tabs
  map to the current INFO_TABS.
