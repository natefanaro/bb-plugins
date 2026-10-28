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
| `host` | blank | Host name to govern. Blank means the only connected host; with more than one connected, Coach manages every host (see [Every connected host](#every-connected-host)). A name keeps Coach on that one host, exactly as before. |
| `hostLimits` | blank | Per-host ranges when every host is managed, for example `macstudio:2-12,macmini:1-6`. A host not listed uses `minLimit` and `maxLimit`. A bad entry is dropped. |
| `minLimit` | `2` | Lowest limit Concurrency Coach will set. |
| `maxLimit` | `8` | Highest limit Concurrency Coach will set. |
| `overrideBackoffMinutes` | `120` | After a manual limit change, stop writing for this many minutes. `0` resumes on the next tick. |
| `swapHotPercent` | `70` | Swap used (percent of the swap total) at or above which memory counts as pressure. |
| `memFreeMinPercent` | `15` | System-wide free memory (percent) below which memory counts as pressure. |
| `turboChoices` | `30,60,120` | The Turbo duration buttons, in minutes, comma separated. Up to six, each 1 to 720. A bad entry is dropped; if none is left the default applies. |
| `turboAllowUntilOff` | `true` | Offer Turbo "until off" (no time box). |
| `turboSwapEndPercent` | `0` | Optional extra: swap used (percent) at or above which Turbo ends, on top of memory pressure. `0` leaves it off; otherwise 50 to 100 (a bad value falls back to off). Swap alone is not pressure, so leave it off unless you want it. |

## Manual changes

If the host limit no longer matches the value Concurrency Coach last set, someone changed it by hand. It records the change in its status reason, does not write for `overrideBackoffMinutes`, and then resumes from the manual value. `status` shows the back-off while it lasts.

The last-set value and the back-off end are kept in plugin storage, so a reload or restart does not clear an active back-off. With no stored state (the first run), the first tick records the current limit as the baseline and does not write. Otherwise the first tick after a restart compares the limit with the stored last value, so a change made while Coach was down backs off.

After a write, the baseline is the limit the host reports back, not the one Coach asked for. If a global cap or clamp lands the host elsewhere, that is not read as a manual change.

## Commands

- `bb concurrency-coach status [--json]`: show what Concurrency Coach would do now. Changes nothing.
- `bb concurrency-coach tick`: run one adjustment now and apply it.
- `bb concurrency-coach log [--last N]`: show the most recent logged decisions and Turbo events (default 20), oldest first.
- `bb concurrency-coach turbo [--limit N] [--for 2h | --until-off]`: turn Turbo on. The limit is written now. Defaults: `maxLimit` for 2 h. `--until-off` has no time box. It is refused, with the reason, when the quota is already near its cap or memory is already under pressure.
- `bb concurrency-coach turbo off`: turn Turbo off.

## Turbo

Turbo holds a chosen limit for a time box (30 min, 1 h or 2 h by default, or until you turn it off), for example to use quota that would otherwise expire unused at the weekly reset.

- `bb concurrency-coach turbo [--limit N] [--for 2h]` turns it on. The limit is written at once. Defaults: `maxLimit` for 2 h. `bb concurrency-coach turbo off` turns it off.
- While Turbo is on, the limit is held at its value. The CPU-hot rule does not apply, and Turbo's own writes do not start the manual back-off.
- **A manual limit change ends Turbo.** Turbo does not write over it. The change then backs off as usual (see Manual changes).
- Turbo also ends at the weekly quota reset, when the quota nears its cap (week at 90% or five-hour at 92%, and the limit drops to `minLimit`), under memory pressure (free memory under `memFreeMinPercent`, or swap at `swapHotPercent` or more while paging out; the same rule the scheduler uses, which Turbo would otherwise skip), or when the time box runs out. An unreadable figure does not end it. "Until off" has no time box, so only the other reasons, a manual change, or `turbo off` end it. The end is checked on each scheduled tick, so it can be up to five minutes late.
- **Overall cap:** if the Turbo limit is above the overall cap, Turbo raises the cap. The cap goes back to its value from before Turbo when Turbo ends. The host's limit cannot stay above the restored cap, so it may be lowered at the same time.
- **Core count:** a limit above `maxLimit` or above the number of cores runs more threads than usual. The CLI warns when the limit is above the core count. The most a Turbo limit can be is 16.
- **Rollback:** an until-off Turbo is stored with a far-future numeric time box, so an older build still reads it (it then runs as a very long time box, and still restores the overall cap when it ends). If you revert, you can run `turbo off` first anyway.
- Turbo is stored in plugin storage, so it survives a reload or restart. After a restart, the first tick records the current limit as the baseline and does not write, as with the back-off.
- Turbo off leaves the limit where it is. The next scheduled tick then decides as usual.
- Starting or ending Turbo is written to the decision log with who did it (`cli`, `panel` or `scheduler`) and when.
- The buttons are disabled, with the reason, while a start would end at once (quota near its cap, or memory pressure).
- The panel shows one button per duration (from `turboChoices`, plus "Until off" unless `turboAllowUntilOff` is false), and a countdown, or "until you turn it off". It suggests Turbo when weekly use is more than 10 points behind the week's elapsed time with three hours or less to the reset.

## opencode threads

opencode threads (providerId `acp-opencode`) are not limited by Claude quota pacing. Each running opencode thread may add one slot to the host limit, up to `opencodeSlots`.

- The host limit is Claude's paced limit plus the headroom. Pacing and the quota rules see only Claude's limit, so an opencode run never lowers Claude's capacity and does not change a Claude decision.
- `opencodeSlots` (default 1, 0 to 10): how many opencode threads get headroom. 0 turns the feature off.
- `opencodeCountsAgainstLimit` (default false): true means opencode threads take Claude capacity, with no headroom.
- More opencode threads than slots: the reason and the window say so. Coach cannot block spawns; keep to one at a time.
- The reason and the window show `Claude N + opencode M`. Turbo holds its exact limit with no headroom. A manual change drops the headroom.
- The count comes from `bb agent-tv status --all-projects --json`: `acp-opencode` rows that are busy or queued (status `pending` or `queued`). A queued run counts too, so it earns its slot before it starts. Idle rows do not count. If the feed cannot be read, the headroom in effect is kept.
- The headroom is written on the next scheduled tick (up to 5 minutes), not the moment a run starts. A run that starts between ticks waits for that tick to get its slot.

## Every connected host

With the `host` setting **blank** and more than one host connected, Coach manages every connected host. This is the case it used to refuse (`set the host setting: 2 hosts are connected`). With `host` set to a name, or with one connected host, nothing changes: Coach governs that host with the same readings, rules and stored state as before.

- **Own readings.** A small host entry (`host.ts`) runs on each enrolled machine and answers with that machine's own load per core and memory (free, swap, paging). Each host steps on its own CPU and memory rules. If a host cannot be read it is held for that tick, with the reason shown, and is never stepped on a guess; the other hosts carry on.
- **Own range.** `hostLimits` gives each host its own minimum and maximum (a 24-core Studio and a 10-core mini do not want the same ceiling). Hosts not listed use `minLimit` and `maxLimit`.
- **Own state.** Each host has its own back-off after a manual change, kept apart from the other hosts and from the single-host state, so turning fleet mode on or off does not mix them. The decision log names the host on every line.
- **The quota is one pool.** The Claude plan quota is shared, so a pace step down (5-hour or weekly use ahead of time elapsed) is taken by **one host per round**: the one furthest above its own minimum steps, and the others hold with `hold: quota step taken on <host> this tick`. They still apply their own memory and CPU rules, and they do not raise while the quota says the account is ahead. Quota near its cap drops every host to its own minimum. Raising on idle CPU is per host.
- **Not in fleet mode:** Turbo (it holds one host's limit, so its buttons are disabled with the reason; set `host` to use it) and the opencode and urgent lanes (they are off, so each host's limit is Claude's alone).
- **Panel and CLI.** The page shows each host's limit, range, CPU and memory and its last reason; the footer window shows a row per host. `bb concurrency-coach status` and `tick` print a block per host.
- **Rounds run one at a time.** The scheduled round, `tick` and `status` queue behind each other, so two never run together and the quota step cannot be taken twice. A round that never settles would hold the ones behind it; each host call has a timeout (30 s for the readings), which bounds that.
- **A Turbo left from single-host mode is ended** at the start of the first applied fleet round (`status` changes nothing) (nothing ticks the single-host state any more), which also restores any overall cap it raised; the log says `fleet mode started`.
- **A bad `hostLimits` entry is logged once** (`hostLimits: ignored 1 bad entry ("bogus")`) and the good entries still apply.
- **Turning it on:** `bb plugin config concurrency-coach unset host`. To go back: `bb plugin config concurrency-coach set host <name>`. The host entry must be installed on each machine (a plugin reload does it), and a host that has not loaded it is reported as not stepped.
- **Rollback:** revert the merge and refresh the install. Fleet state is under separate keys; single-host state is untouched.

## Urgent lane

Threads whose task has priority **urgent** (and is todo, in progress or in review) get slots reserved above Claude's paced limit, so a pace hold does not starve a release blocker. It works like the opencode headroom: the host limit is Claude's paced limit, plus the opencode headroom, plus one slot per urgent thread that is running or waiting, up to `urgentSlots`.

- `urgentSlots` (default 1, 0 to 5): slots reserved for urgent threads. **It is on by default**, so the lane is live as soon as this is installed. 0 turns it off, and then no task or feed is read for it.
- **How wide "urgent" is:** every task in every tracker project with priority urgent that is todo, in progress or in review, and any thread attached to one. On 2026-10-27 that was 24 tasks, most with attached threads, so the lane opens whenever any of those threads runs or waits. If that is too wide, lower the priority of tasks that are not blockers, or set `urgentSlots` to 0.
- `urgentReportMinutes` (default 120, 0 to 1440): how long urgent work may wait behind the limit before it is flagged. The flag shows in the reason (`urgent work has waited 2 h 0 min`), in the panel and footer window, and the decision log carries `urgentRunning`, `urgentWaiting` and `urgentHeadroom`. Coach does not message anyone; something that reads the log or `status` can.
- The urgent threads come from the tasks tracker (`bb tasks list --priority urgent`, then each task's attached threads) matched against the agent feed. The tracker is read without the calling thread's project scope, so every project is seen (with the scope, the list fails with `project_ambiguous` when a project links several trackers, or silently covers one project). `--active` is not used: it keeps only threads that are starting or working, and a waiting thread is neither.
- The task-to-thread map is kept for 10 minutes (a full scan is about 5 s), so a thread newly attached to an urgent task is picked up within that time. With no running or waiting thread nothing is looked up.
- **If the tasks or the feed cannot be read**, the lane stays as it was and the reason, the panel, the footer window and the decision log say `urgent: unreadable`. A map up to 30 minutes old is used if only a refresh fails.
- The panel shows the urgent slot as its own cell (heavier ring), the reason and header show `Claude N + opencode M + urgent U`, and the count of urgent threads running and waiting.
- Coach sets how many slots exist, not which queued thread takes one: the host starts waiting messages in its own order, so an urgent thread gets the benefit of the extra slot but is not placed first. Moving it ahead would need priority in the limit plugin.
- Turbo holds its exact limit with no lane. A manual change drops the lane. If the overall cap clamps the write, the urgent slot is kept before the opencode slots.
- Rollback: the total is still stored under the old `headroom` key, so an older build reads it (as opencode headroom).

## Decision log

Every applied tick (scheduled or from `tick`) appends one JSON line to `~/.bb-studio/concurrency-pacer/decisions.jsonl` (owner-only): time, host, the limit before and after, whether it was written, the reason, load, 5-hour and weekly quota, the manual-change state, and whether Turbo was on. Turbo starts and ends are written as their own lines with who did it. `status` is not logged. The file moves to `decisions.jsonl.1` at about 1 MB, replacing the previous rotation. Set `CONCURRENCY_PACER_DIR` to move it.

## Panel

The **Concurrency Coach** page in the rail is read-only. It shows the current limit and range, the overall cap, running and queued threads, a plain-sentence reason (with minutes left if backing off), CPU load per core against its idle and hot thresholds, free memory, swap and paging against their thresholds, the 5-hour and weekly quota used against time elapsed, a 24-hour strip of the limit with each change marked (hover for its reason), and the top process by CPU name.

- Running is threads occupying a slot now (starting or active, hidden included), counted without a cap. Queued is queued messages that the concurrency limit is holding and still waiting or retrying; messages that gave up are shown separately as "failed after retries".
- **What limits it** is one line that says whether the limit is held by capacity (memory, or CPU) or by quota (pace), from the current readings (the same ones the policy reads), for example `Held by quota (pace: week 53% used vs 44% of the week elapsed). Not memory: it has room (free memory 70%, swap 40%).` It also says when both apply, when quota is near its cap (the limit is at the minimum), and when Turbo is holding the limit. Swap alone is not memory pressure: free memory under `memFreeMinPercent`, or swap at `swapHotPercent` or more while paging out, is. The memory section shows free memory and swap as two bars against those lines. The footer window shows the same line in place of the reason sentence.
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
