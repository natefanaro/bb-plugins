---
name: concurrency-pacer
description: Scales the host thread limit up and down from CPU load and Claude plan quota pace. Use to see why threads are queued, what the limit is, or to run an adjustment now.
---

# Concurrency Pacer

Every 5 minutes the plugin moves the host's thread limit by one step, between the `minLimit` and `maxLimit` settings.

- **Quota near the limit** (5-hour window at 92% or week at 90%): drop to the minimum.
- **Burning ahead of pace** (5-hour use more than 25 points ahead of time elapsed): step down.
- **Burning ahead of weekly pace** (weekly use more than 6 points ahead of time elapsed in the week, once 5% of the week has elapsed): step down one per tick. Weekly use more than 3 points ahead of elapsed blocks raising. Unknown weekly figures are no signal.
- **CPU hot** (1-minute load above 85% of the cores): step down.
- **CPU idle** (load under 50% of the cores): step up.
- Otherwise hold. If the quota can't be read, it scales on CPU alone.

Commands: `bb concurrency-pacer status [--json]` shows what it would do now and changes nothing. `bb concurrency-pacer tick` runs one adjustment and applies it. `bb concurrency-pacer log [--last N]` shows the recent applied decisions and Turbo events (file: `~/.bb-studio/concurrency-pacer/decisions.jsonl`).

Turbo: `bb concurrency-pacer turbo [--limit N] [--for 2h]` holds the limit at N (default maxLimit) for the time box, ignoring the CPU-hot rule. It ends early at the weekly quota reset or when the quota nears its cap. `bb concurrency-pacer turbo off` ends it. Turbo writes the limit immediately when started. A manual limit change ends Turbo (it is not overwritten), and then backs off as before. If the limit is above the overall cap, Turbo raises the cap until it ends.

Settings (`bb plugin config concurrency-pacer`): `enabled`, `host` (blank means the only connected host), `minLimit` (2), `maxLimit` (8), `overrideBackoffMinutes` (120). It also raises the global cap when that would otherwise undercut the host limit.

If the host limit changes by hand (it no longer matches the value Pacer last set), Pacer does not write for `overrideBackoffMinutes`, then resumes from the manual value. Set `enabled` to false to take manual control for good.
