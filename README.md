# Concurrency Coach

Raises and lowers the host thread limit every 5 minutes, one step at a time, between a min and max you set. It reads CPU load and Claude plan quota pace. It makes no model calls.

## How it works

Every 5 minutes it reads two signals and applies one of these rules:

| Rule | Condition | Action |
| --- | --- | --- |
| Quota near limit | 5-hour window at 92%+ or weekly at 90%+ | Drop to `minLimit` |
| Memory pressure | Free memory under `memFreeMinPercent` (15), or swap at `swapHotPercent` (70) or more while paging out (100 pages/s or more) | Step down, and do not raise |
| Ahead of pace | 5-hour use more than 25 points ahead of time elapsed in the window | Step down |
| Weekly ahead of pace | Weekly use more than 6 points ahead of time elapsed in the week, once 5% of the week has elapsed | Step down one per tick |
| CPU hot | 1-minute load above 85% of the core count | Step down |
| CPU idle | 1-minute load below 50% of the core count | Step up, unless a weekly rule holds it |
| Otherwise | | Hold |

Claude's paced limit never leaves `[minLimit, maxLimit]`. The host limit can be higher: while opencode threads run, it adds their headroom (up to `opencodeSlots` above `maxLimit`, see [opencode threads](#opencode-threads)). An overall cap can clamp the write lower, and Coach then stores only the headroom that landed. If the quota can't be read, Concurrency Coach scales on CPU alone. Memory is read from the Mac's `memory_pressure` (free memory), `sysctl vm.swapusage` (swap), and `vm_stat -c 2 5` (paging, a five-second sample; this adds about five seconds to a tick). A reading that fails is not a signal, and the rest still applies.

Free memory is the primary signal. Swap alone is not pressure: macOS keeps swap after a spike and does not give it back, so a host can sit at 95% swap with plenty of free memory and no paging. Swap counts only while the host is also paging out. Page-ins are not counted, because a healthy Mac pages in at several hundred per second.

Memory pressure comes before the CPU rules, because a host that is thrashing is slow whatever its load. Free memory stays low while the pressure lasts, so the limit keeps stepping down one per tick until it recovers.

## Weekly pacing

The weekly window is paced tighter than the five-hour window. Four rules apply:

- **Slack:** when weekly use is more than 6 points ahead of the week's elapsed time, the limit steps down one per tick. The slack is 6 points, not the 25 the five-hour window uses.
- **Floor:** no weekly rule runs until 5% of the week has elapsed (about 8 hours). Below that, the panel shows the weekly pace as unknown.
- **No raise above pace:** the limit does not rise while weekly use is more than 3 points ahead of elapsed. Raising resumes as soon as use is back within 3 points. This check is stateless, so it has no memory of the earlier step-down.
- **Projection (reason only):** the weekly use divided by elapsed time is the projected percent by reset. When a raise is held, the reason gives the sustainable limit, which is the current limit times 100 divided by the projected percent, rounded down. The projection does not change the limit by itself.

The effective raise gate is therefore 3 points above elapsed, not 0. Weekly use at 41% with 40% elapsed still allows a raise; 44% with 40% elapsed holds it.

**Decision:** the ticket asks for two things that conflict in the band above elapsed and within 3 points. Under a straight-line projection, a projection over 100% starts at elapsed, but the 3-point tolerance allows raises up to elapsed + 3. The 3-point gate wins in that band, so the projection is not enforced as a cap. Example: 41% used at 40% elapsed projects to 102.5% and still raises. The reason on a held raise still shows the sustainable limit. To undo this and enforce the projection cap, the idle branch of `decide()` would need a `projected > 100` check, which would change the 3-point behavior and the test at 41% / 40%.

Every weekly reason in the decision log gives used percent, elapsed percent and projected percent by reset, for example `weekly use ahead of time elapsed (21% used, 8% elapsed, projected 263% by reset)`.

Concurrency Coach reads the host's limit through the built-in `concurrency-limit` plugin (`getConfiguration` / `setConfiguration`) and quota through `bb--provider-usage` `getUsage`. It parses Claude Code windows labelled like `Five-hour limit` or `session` (five-hour) and `Weekly limit` (weekly).

When it applies a change, it also raises the global cap if the global cap would otherwise sit below the new host limit. Other hosts' overrides are kept.

## Requirements

- The built-in `concurrency-limit` plugin must be **enabled**. If it is disabled, every Concurrency Coach run fails.

## Settings

Set these with `bb plugin config concurrency-coach`.

| Setting | Default | Meaning |
| --- | --- | --- |
| `enabled` | `true` | Adjust the limit automatically. When false, the 5-minute job does nothing. |
| `host` | blank | Host name to govern. Blank means the only connected host. Errors if more than one is connected. |
| `minLimit` | `2` | Lowest limit Concurrency Coach will set. |
| `maxLimit` | `8` | Highest limit Concurrency Coach will set. |
| `overrideBackoffMinutes` | `120` | After a manual limit change, stop writing for this many minutes. `0` resumes on the next tick. |
| `swapHotPercent` | `70` | Swap used (percent of the swap total) at or above which memory counts as pressure. |
| `memFreeMinPercent` | `15` | System-wide free memory (percent) below which memory counts as pressure. |

## Manual changes

If the host limit no longer matches the value Concurrency Coach last set, someone changed it by hand. It records the change in its status reason, does not write for `overrideBackoffMinutes`, and then resumes from the manual value. `status` shows the back-off while it lasts.

The last-set value and the back-off end are kept in plugin storage, so a reload or restart does not clear an active back-off. With no stored state (the first run), the first tick records the current limit as the baseline and does not write. Otherwise the first tick after a restart compares the limit with the stored last value, so a change made while Coach was down backs off.

After a write, the baseline is the limit the host reports back, not the one Coach asked for. If a global cap or clamp lands the host elsewhere, that is not read as a manual change.

## Commands

- `bb concurrency-coach status [--json]`: show what Concurrency Coach would do now. Changes nothing.
- `bb concurrency-coach tick`: run one adjustment now and apply it.
- `bb concurrency-coach log [--last N]`: show the most recent logged decisions and Turbo events (default 20), oldest first.
- `bb concurrency-coach turbo [--limit N] [--for 2h]`: turn Turbo on. The limit is written now. Defaults: `maxLimit` for 2 h.
- `bb concurrency-coach turbo off`: turn Turbo off.

## Turbo

Turbo holds a chosen limit for a time box, for example to use quota that would otherwise expire unused at the weekly reset.

- `bb concurrency-coach turbo [--limit N] [--for 2h]` turns it on. The limit is written at once. Defaults: `maxLimit` for 2 h. `bb concurrency-coach turbo off` turns it off.
- While Turbo is on, the limit is held at its value. The CPU-hot rule does not apply, and Turbo's own writes do not start the manual back-off.
- **A manual limit change ends Turbo.** Turbo does not write over it. The change then backs off as usual (see Manual changes).
- Turbo also ends at the weekly quota reset, when the quota nears its cap (week at 90% or five-hour at 92%, and the limit drops to `minLimit`), or when the time box runs out. The end is checked on each scheduled tick, so it can be up to five minutes late.
- **Overall cap:** if the Turbo limit is above the overall cap, Turbo raises the cap. The cap goes back to its value from before Turbo when Turbo ends. The host's limit cannot stay above the restored cap, so it may be lowered at the same time.
- **Core count:** a limit above `maxLimit` or above the number of cores runs more threads than usual. The CLI warns when the limit is above the core count. The most a Turbo limit can be is 16.
- Turbo is stored in plugin storage, so it survives a reload or restart. After a restart, the first tick records the current limit as the baseline and does not write, as with the back-off.
- Turbo off leaves the limit where it is. The next scheduled tick then decides as usual.
- Starting or ending Turbo is written to the decision log with who did it (`cli`, `panel` or `scheduler`) and when.
- The panel shows a Turbo button and a countdown. It suggests Turbo when weekly use is more than 10 points behind the week's elapsed time with three hours or less to the reset.

## opencode threads

opencode threads (providerId `acp-opencode`) are not limited by Claude quota pacing. Each running opencode thread may add one slot to the host limit, up to `opencodeSlots`.

- The host limit is Claude's paced limit plus the headroom. Pacing and the quota rules see only Claude's limit, so an opencode run never lowers Claude's capacity and does not change a Claude decision.
- `opencodeSlots` (default 1, 0 to 10): how many opencode threads get headroom. 0 turns the feature off.
- `opencodeCountsAgainstLimit` (default false): true means opencode threads take Claude capacity, with no headroom.
- More opencode threads than slots: the reason and the window say so. Coach cannot block spawns; keep to one at a time.
- The reason and the window show `Claude N + opencode M`. Turbo holds its exact limit with no headroom. A manual change drops the headroom.
- The count comes from `bb agent-tv status --all-projects --json`: `acp-opencode` rows that are busy or queued (status `pending` or `queued`). A queued run counts too, so it earns its slot before it starts. Idle rows do not count. If the feed cannot be read, the headroom in effect is kept.
- The headroom is written on the next scheduled tick (up to 5 minutes), not the moment a run starts. A run that starts between ticks waits for that tick to get its slot.

## Decision log

Every applied tick (scheduled or from `tick`) appends one JSON line to `~/.bb-studio/concurrency-pacer/decisions.jsonl` (owner-only): time, host, the limit before and after, whether it was written, the reason, load, 5-hour and weekly quota, the manual-change state, and whether Turbo was on. Turbo starts and ends are written as their own lines with who did it. `status` is not logged. The file moves to `decisions.jsonl.1` at about 1 MB, replacing the previous rotation. Set `CONCURRENCY_PACER_DIR` to move it.

## Panel

The **Concurrency Coach** page in the rail is read-only. It shows the current limit and range, the overall cap, running and queued threads, a plain-sentence reason (with minutes left if backing off), CPU load per core against the 0.5 and 0.85 thresholds, free memory, swap and paging against their thresholds, the 5-hour and weekly quota used against time elapsed, a 24-hour strip of the limit with each change marked (hover for its reason), and the top process by CPU name.

- Running is threads occupying a slot now (starting or active, hidden included), counted without a cap. Queued is queued messages that the concurrency limit is holding and still waiting or retrying; messages that gave up are shown separately as "failed after retries".
- "Last decision" is the newest logged decision and when it was made. It can be older than the live load; the inputs section shows the live load.
- It refreshes at most every five minutes, the scheduler tick, and on Refresh. It has no controls.
- Colours come from the host theme, so it follows light and dark.

## Turning it off

Set `enabled` to `false`. The scheduled job then skips every run and you control the limit by hand with `bb concurrency-limit`. While `enabled` is on, Concurrency Coach writes its own limit on each tick, but backs off after a manual change (see above).

## Development

```sh
npm test               # node --test on lib/*.test.ts
npx tsc --noEmit       # type-check
bb plugin build        # emits dist/ (gitignored)
```
