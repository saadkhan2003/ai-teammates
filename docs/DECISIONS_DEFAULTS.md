# Open decisions: defaults chosen for the build

Saad approved building the long-run resume and memory-notes designs in full. Where a design left a question open, the build uses the safe default the design recommends. Each default is a config value or a single code path, so changing it is small. Tell the build agent which line to change.

## Long-run resume (docs/LONG_RUN_RESUME_DESIGN.md, section 8)
| # | Question | Default used | How to change |
|---|---|---|---|
| LR1 | Budget hit: pause with Continue, or fail? | Pause: task goes to `waiting_human` with reason `budget_reached` and a Continue/Raise card. | `RunBudget:PauseOnBudget=false` makes it fail. |
| LR2 | 12-model-round cap for coding tasks | Becomes a cumulative budget (default 12 rounds per attempt kept, cumulative cap 60) that pauses with Continue. | `RunBudget:CodingRounds`, `RunBudget:CodingRoundsCumulative`. |
| LR3 | Compaction summary model | The task's own model (consistency). The summary is logged as `model_calls.role='compactor'`. | `Compaction:Model` (empty = task model). |
| LR4 | Auto-resume ceiling | 5 per rolling hour per task, global setting. No per-bot setting yet. | `Resume:MaxAutoResumesPerHour`. |
| LR5 | Push-notify on resume? | No. Only "needs you" cards notify. A normal resume shows one collapsed chat line. | `Resume:NotifyOnResume=true` (flag only, no push channel wired). |
| LR6 | Git snapshot refs | On by default for coding tasks, written under `refs/atlas/snapshots/<task>`, branch and index untouched. | `Resume:GitSnapshot=false`. |

## Memory notes (docs/MEMORY_NOTES_DESIGN.md, section 17)
| # | Question | Default used | How to change |
|---|---|---|---|
| D1 | Close the "no chat history" gap | Nothing for now (M11 skipped). Notes only. | Build M11 later. |
| D2 | Pass in first release? | Hot path first. The post-turn pass is built but `MEMORY_PASS=off` by default. | `MEMORY_PASS=shadow|on`. |
| D3 | Share what I learn with my other bots | On for `profile` notes only, per-owner switch. | Per-bot `memory_mode` and the owner switch. |
| D4 | `CONTACT` secret type | Not built. Contact details are refused and the bot is told to use the vault. | Build M12 later. |
| D5 | Peer-origin tasks | Rules only. No shared profile for peer-origin work. | Code path in `MemoryGuard`. |
| D6 | Deleted notes and clones | Content purged 10 minutes after delete. Clones start fresh. | `Memory:PurgeMinutes`, `Memory:CloneCopy`. |
| D7 | Tab label | Stays "Memory" (matches tests). | One string in the panel. |
| D8 | `forget_memory` approval class | `Write` (reversible via undo for 10 minutes). | `PolicyClasses` entry. |
| D9 | Inject bot `role` and `instructions` | Yes, at the same assembly point, in the bot-owned block, capped small. | Flag `Memory:InjectRole`. |
| D10 | Embedding model | `openai/text-embedding-3-small` via OpenRouter, with the mock server in tests. `MEMORY_EMBED=off` by default. | `MEMORY_EMBED_MODEL`. |

## Flags and spend
- Memory flags ship `MEMORY_NOTES=shadow`, `MEMORY_PASS=off`, `MEMORY_EMBED=off`. The mock stack turns notes `on` for tests.
- Standing rules (`kind=rule`) are injected in `shadow` mode too, so rules work in the default release; only `MEMORY_NOTES=off` or a bot memory mode of `off` stops them. Rules never loosen approval gates.
- Migrations: 027 memory notes, 028 is reserved by long-run resume, 030 approval rules, 031 rule scope (029 left free).
- Live-model evals: total cap $0.50, hard stop at $0.40. None are run unless the key is present and the spend script says there is room.
