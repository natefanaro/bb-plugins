// bb-plugin-concurrency-coach — read-only panel. Compiled by `bb plugin build` into dist/app.js + dist/app.css.
// React and @get-bb/plugin-sdk/app come from the BB app at load time. Colours come from the host theme tokens, so light and dark both follow the app.
import { useCallback, useEffect, useState, type ReactNode } from "react";
import { definePluginApp, useRpc } from "@get-bb/plugin-sdk/app";
import type { PanelView } from "./lib/contract.ts";
import { paceTone } from "./lib/pace.ts";
import type { coachRpcContract } from "./lib/contract.ts";

/** The panel refreshes at most every five minutes (the scheduler tick), plus the Refresh link. */
const REFRESH_MS = 5 * 60_000;
/** The Turbo countdown re-renders locally every 15 s while Turbo is on. It reads no data. */
const COUNTDOWN_MS = 15_000;

function usePanel() {
  const rpc = useRpc<typeof coachRpcContract>();
  const [view, setView] = useState<PanelView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const refresh = useCallback(() => {
    rpc.call("panel").then(
      (result) => {
        setView(result);
        setError(null);
      },
      (cause: unknown) => setError(cause instanceof Error ? cause.message : String(cause)),
    );
  }, [rpc]);
  useEffect(() => {
    refresh();
    const id = window.setInterval(() => {
      if (document.visibilityState === "visible") refresh();
    }, REFRESH_MS);
    return () => window.clearInterval(id);
  }, [refresh]);
  return { view, error, refresh };
}

function clock(ms: number): string {
  return new Date(ms).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-2">
      <div className="text-xs uppercase tracking-wide text-muted-foreground">{title}</div>
      {children}
    </section>
  );
}

/** A bar from 0 to `max`, with optional tick marks (fractions of max) and a marker at `markAt`. */
function Bar({ value, max, ticks = [], markAt, tone }: { value: number; max: number; ticks?: number[]; markAt?: number; tone: string }) {
  const pct = (v: number) => `${Math.min(100, Math.max(0, (v / max) * 100))}%`;
  return (
    <div className="relative h-2 w-full overflow-hidden rounded bg-muted">
      <div className={`absolute left-0 top-0 h-full ${tone}`} style={{ width: pct(value) }} />
      {ticks.map((t) => (
        <div key={t} className="absolute top-0 h-full w-px bg-foreground/40" style={{ left: pct(t) }} />
      ))}
      {markAt !== undefined && <div className="absolute top-[-2px] h-[12px] w-[2px] bg-foreground" style={{ left: pct(markAt) }} />}
    </div>
  );
}

function Quota({ label, used, elapsed, projected, state }: { label: string; used: number | null; elapsed: number | null; projected: number | null; state: PanelView["inputs"]["fiveHour"]["state"] }) {
  const word = state === "ahead" ? "using quota faster than time passes" : state === "behind" ? "within limits" : "no reading";
  return (
    <div className="flex flex-col gap-1">
      <div className="flex justify-between text-sm">
        <span>{label}</span>
        <span className="text-muted-foreground">
          {used === null ? "?" : `${used}% used`}
          {elapsed !== null && ` · ${elapsed}% of window elapsed`}
          {projected !== null && ` · about ${Math.round(projected)}% by reset`}
        </span>
      </div>
      {used !== null && <Bar value={used} max={100} markAt={elapsed ?? undefined} tone={state === "ahead" ? "bg-destructive" : "bg-primary"} />}
      <div className="text-xs text-muted-foreground">{word}</div>
    </div>
  );
}

/** The limit as a line over the 24 h window, with a dot per change. The axis spans the data we have, so a young log is not squashed at the right edge. Hover a dot for its reason. Compact is the footer window: shorter, with a shaded area and one caption line. */
function HistoryStrip({ view, compact = false }: { view: PanelView; compact?: boolean }) {
  const { points, changes } = view.history;
  if (points.length < 2) return <div className="text-xs text-muted-foreground">Collecting history…</div>;
  const width = 480;
  const height = compact ? 110 : 60;
  const limits = points.map((p) => p.limit);
  const lo = Math.min(...limits, view.limit.min);
  const hi = Math.max(...limits, view.limit.max);
  const span = hi - lo || 1;
  const oldestSec = Math.max(...points.map((p) => p.ageSec), 60);
  const x = (ageSec: number) => ((oldestSec - ageSec) / oldestSec) * width;
  const since = new Date(view.generatedAt - oldestSec * 1000).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  const y = (v: number) => height - ((v - lo) / span) * (height - 6) - 3;
  const path = points.map((p, i) => `${i === 0 ? "M" : "L"}${x(p.ageSec).toFixed(1)},${y(p.limit).toFixed(1)}`).join(" ");
  const first = points[0];
  const lastPoint = points[points.length - 1];
  const area = `${path} L${x(lastPoint.ageSec).toFixed(1)},${height} L${x(first.ageSec).toFixed(1)},${height} Z`;
  return (
    <div className="flex flex-col gap-1">
      <svg viewBox={`0 0 ${width} ${height}`} width="100%" height={compact ? undefined : height} role="img" aria-label={`Thread limit since ${since}`}>
        {compact && <title>{`Limit since ${since} · ${changes.length} change${changes.length === 1 ? "" : "s"}`}</title>}
        {compact && <path d={area} fill="currentColor" opacity={0.1} />}
        <path d={path} fill="none" stroke="currentColor" strokeWidth={1.5} />
        {changes.map((c) => (
          <circle key={`${c.ageSec}-${c.to}`} cx={x(c.ageSec)} cy={y(c.to)} r={compact ? 2.5 : 3} fill="currentColor">
            <title>{`${c.from} → ${c.to}: ${c.why}`}</title>
          </circle>
        ))}
      </svg>
      {!compact && <div className="text-xs text-muted-foreground">Since {since}</div>}
    </div>
  );
}

/** The one control on the panel: Turbo on or off. Shows the countdown while it runs, and the suggestion when weekly quota is behind pace near the reset. */
function TurboControl({ view, onChanged }: { view: PanelView; onChanged: () => void }) {
  const rpc = useRpc<typeof coachRpcContract>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const { turbo } = view;
  useEffect(() => {
    if (!turbo.active) return;
    const id = window.setInterval(() => setNow(Date.now()), COUNTDOWN_MS);
    return () => window.clearInterval(id);
  }, [turbo.active]);
  function act(method: "turboStart" | "turboStop") {
    setBusy(true);
    setError(null);
    const call = method === "turboStart" ? rpc.call("turboStart", { limit: null, minutes: null }) : rpc.call("turboStop", null);
    call.then(
      () => {
        setBusy(false);
        onChanged();
      },
      (cause: unknown) => {
        setBusy(false);
        setError(cause instanceof Error ? cause.message : String(cause));
      },
    );
  }
  const leftMin = turbo.until === null ? 0 : Math.max(0, Math.ceil((Date.parse(turbo.until) - now) / 60_000));
  return (
    <Section title="Turbo">
      {turbo.active ? (
        <div className="flex items-center justify-between gap-2 text-sm">
          <span>
            On · limit {turbo.limit} · {leftMin} min left · started by {turbo.startedBy}
          </span>
          <button type="button" className="rounded border px-2 py-1 text-xs" disabled={busy} onClick={() => act("turboStop")}>
            Turn off
          </button>
        </div>
      ) : (
        <div className="flex items-center justify-between gap-2 text-sm">
          <span className="text-muted-foreground">
            {turbo.suggested ? "Weekly quota is well under its time share with 3 h or less to the reset." : "Off."}
          </span>
          <button type="button" className="rounded border px-2 py-1 text-xs" disabled={busy} onClick={() => act("turboStart")}>
            Turbo to {view.limit.max} for 2 h
          </button>
        </div>
      )}
      {error !== null && <div className="text-xs text-destructive">{error}</div>}
    </Section>
  );
}

function ConcurrencyCoachPage() {
  const { view, error, refresh } = usePanel();
  // The scroll container is the same one the other plugin pages use. Without it the page did not scroll on mobile.
  if (error !== null) return <div className="h-full min-h-0 flex-1 overflow-y-auto p-4 text-sm">Could not read the panel: {error}</div>;
  if (view === null) return <div className="h-full min-h-0 flex-1 overflow-y-auto p-4 text-sm text-muted-foreground">Loading…</div>;

  const { limit, threads, why, inputs } = view;
  return (
    <div className="h-full min-h-0 flex-1 overflow-y-auto">
    <div className="flex flex-col gap-5 p-4">
      <header className="flex items-baseline justify-between">
        <div>
          <div className="text-xs text-muted-foreground">{view.host ?? "No connected host"}</div>
          <div className="text-3xl font-medium">
            {limit.current ?? "?"}
            <span className="ml-2 text-sm font-normal text-muted-foreground">
              threads · range {limit.min}–{limit.max}
              {limit.globalLimit !== null && ` · overall cap ${limit.globalLimit}`}
            </span>
          </div>
          {(limit.opencode.headroom > 0 || (limit.opencode.running ?? 0) > 0) && (
            <div className="text-xs text-muted-foreground">
              Claude {limit.claude ?? "?"} + opencode {limit.opencode.headroom}
              {limit.opencode.countsAgainstLimit && " (counts against the limit)"}
            </div>
          )}
          {limit.opencode.warning !== null && <div className="text-xs text-destructive">{limit.opencode.warning}</div>}
        </div>
        <div className="text-right text-sm">
          <div>{threads.running ?? "?"} running</div>
          <div className="text-muted-foreground">{threads.queued ?? "?"} queued for a slot</div>
          {threads.gaveUp !== null && threads.gaveUp > 0 && (
            <div className="text-xs text-destructive">{threads.gaveUp} failed after retries</div>
          )}
        </div>
      </header>

      {view.error !== null && <div className="text-xs text-destructive">Limit plugin unavailable: {view.error}</div>}

      <TurboControl view={view} onChanged={refresh} />

      <Section title="Last decision">
        <div className="text-sm">{why.sentence}</div>
        <div className="text-xs text-muted-foreground">
          {why.decidedAt === null
            ? "Nothing logged yet"
            : `Decided ${new Date(why.decidedAt).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}`}
        </div>
      </Section>

      <Section title="Inputs">
        <div className="flex flex-col gap-1">
          <div className="flex justify-between text-sm">
            <span>CPU load per core</span>
            <span className="text-muted-foreground">
              {inputs.load.ratio === null ? "?" : inputs.load.ratio.toFixed(2)} · {inputs.load.level ?? "?"}
            </span>
          </div>
          {inputs.load.ratio !== null && (
            <Bar value={inputs.load.ratio} max={Math.max(1.5, inputs.load.hot * 1.5)} ticks={[inputs.load.idle, inputs.load.hot]} tone={inputs.load.level === "hot" ? "bg-destructive" : "bg-primary"} />
          )}
          <div className="text-xs text-muted-foreground">Ticks at {inputs.load.idle} (idle) and {inputs.load.hot} (hot).</div>
        </div>
        <div className="flex flex-col gap-1">
          <div className="flex justify-between text-sm">
            <span>Free memory</span>
            <span className="text-muted-foreground">
              {inputs.memory.freePct === null ? "?" : `${inputs.memory.freePct}%`} · swap {inputs.memory.swapUsedPct === null ? "?" : `${inputs.memory.swapUsedPct}%`} · paging out {inputs.memory.pageoutsPerSec === null ? "?" : `${Math.round(inputs.memory.pageoutsPerSec)}/s`}
            </span>
          </div>
          {inputs.memory.freePct !== null && (
            <Bar value={inputs.memory.freePct} max={100} ticks={[inputs.memory.memFreeMinPercent]} tone={inputs.memory.hot ? "bg-destructive" : "bg-primary"} />
          )}
          <div className="text-xs text-muted-foreground">
            Pressure when free memory is under {inputs.memory.memFreeMinPercent}%, or swap is at {inputs.memory.swapHotPercent}% or more while paging out. It lowers the limit one step per tick and blocks raising it.
          </div>
        </div>
        <Quota label="5-hour window" used={inputs.fiveHour.used} elapsed={inputs.fiveHour.elapsed} projected={inputs.fiveHour.projected} state={inputs.fiveHour.state} />
        <Quota label="Weekly window" used={inputs.week.used} elapsed={inputs.week.elapsed} projected={inputs.week.projected} state={inputs.week.state} />
      </Section>

      <Section title="Last 24 hours">
        <HistoryStrip view={view} />
        <div className="text-xs text-muted-foreground">
          {view.history.changes.length} change{view.history.changes.length === 1 ? "" : "s"} · hover a dot for its reason
        </div>
      </Section>

      <Section title="Top CPU">
        <div className="text-sm">
          {view.topCpu === null ? "Not available" : `${view.topCpu.name} · ${view.topCpu.cpuPct.toFixed(1)}%`}
        </div>
      </Section>

      <footer className="flex justify-between text-xs text-muted-foreground">
        <span>Updated {clock(view.generatedAt)}</span>
        <button type="button" className="underline" onClick={refresh}>
          Refresh
        </button>
      </footer>
    </div>
    </div>
  );
}

/** The Coach mark as inline SVG, the same geometry as icons/coach.svg. */
function CoachIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={className} fill="none" stroke="currentColor" strokeWidth={2.2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <g transform="rotate(-45 12 12) translate(12 12) scale(0.8) translate(-12 -12)">
        <line x1="5" y1="12" x2="19" y2="12" />
        <rect x="1.5" y="6.5" width="3.5" height="11" rx="1.2" />
        <rect x="19" y="6.5" width="3.5" height="11" rx="1.2" />
        <rect x="4.5" y="8.5" width="2.5" height="7" rx="0.6" />
        <rect x="17" y="8.5" width="2.5" height="7" rx="0.6" />
      </g>
    </svg>
  );
}

/** One labelled gauge row: a short label, a bar, and the reading. A null value draws an empty bar and a question mark. */
function GaugeRow({ label, value, max, ticks, markAt, tone, text, hint }: { label: string; value: number | null; max: number; ticks?: number[]; markAt?: number | null; tone: string; text: string; hint: string }) {
  return (
    <div className="grid grid-cols-[2.75rem_1fr_3rem] items-center gap-2 text-xs" title={hint}>
      <span className="text-muted-foreground">{label}</span>
      <Bar value={value ?? 0} max={max} ticks={ticks} markAt={markAt ?? undefined} tone={tone} />
      <span className="text-right tabular-nums">{text}</span>
    </div>
  );
}

/** One cell per slot of the host limit: filled while a thread runs in it. The last cells are the opencode headroom, outlined. */
function Slots({ view }: { view: PanelView }) {
  const current = view.limit.current;
  if (current === null) return null;
  const cells = Math.min(current, 16);
  const running = view.threads.running ?? 0;
  const headroom = Math.min(view.limit.opencode.headroom, cells);
  const queued = view.threads.queued ?? 0;
  return (
    <div className="flex items-center gap-2">
      <div className="flex flex-1 flex-wrap gap-1" role="img" aria-label={`${running} of ${current} slots running`}>
        {Array.from({ length: cells }, (_, i) => (
          <div key={i} className={`h-3 w-3 rounded-sm ${i < running ? "bg-primary" : "bg-muted"} ${i >= cells - headroom ? "ring-1 ring-foreground/50" : ""}`} />
        ))}
      </div>
      <div className="text-xs tabular-nums text-muted-foreground">
        {view.threads.running ?? "?"}/{current}
        {queued > 0 && <span className="ml-1 text-foreground">+{queued} waiting</span>}
      </div>
    </div>
  );
}

/** The footer window: charts first. The limit and its slots, the 24 h line, both quota windows, CPU and memory, and the last decision in a line. Read-only; it fetches when opened. */
function CoachWindow() {
  const { view, error } = usePanel();
  if (error !== null) return <div className="p-3 text-xs text-destructive">Concurrency Coach unavailable: {error}</div>;
  if (view === null) return <div className="p-3 text-xs text-muted-foreground">Loading…</div>;
  const { tone, label } = paceTone(view.inputs);
  const colour = tone === "ahead" ? "text-destructive" : tone === "within" ? "text-primary" : "text-muted-foreground";
  const { fiveHour, week, load, memory } = view.inputs;
  const d = view.why.detail;
  const pct = (v: number | null) => (v === null ? "?" : `${Math.round(v)}%`);
  const quotaTone = (state: typeof fiveHour.state) => (state === "ahead" ? "bg-destructive" : "bg-primary");
  return (
    <div className="flex w-[22rem] max-w-full flex-col gap-2 p-3">
      <div className="flex items-center gap-2">
        <CoachIcon className="h-5 w-5 text-foreground" />
        <div className="text-sm font-medium">Concurrency Coach</div>
        <div className={`ml-auto text-2xl font-medium tabular-nums ${colour}`} title={label}>
          {view.limit.current ?? "?"}
        </div>
      </div>
      {(view.limit.opencode.headroom > 0 || (view.limit.opencode.running ?? 0) > 0) && (
        <div className="-mt-2 text-right text-xs text-muted-foreground">
          Claude {view.limit.claude ?? "?"} + opencode {view.limit.opencode.headroom}
        </div>
      )}
      {view.limit.opencode.warning !== null && <div className="text-xs text-destructive">{view.limit.opencode.warning}</div>}

      <Slots view={view} />
      <HistoryStrip view={view} compact />

      <div className="flex flex-col gap-2 border-t pt-2">
        <GaugeRow label="5 h" value={fiveHour.used} max={100} markAt={fiveHour.elapsed} tone={quotaTone(fiveHour.state)} text={pct(fiveHour.used)} hint="5-hour quota used. The marker is time elapsed in the window; red when use runs ahead of it." />
        <GaugeRow label="Week" value={week.used} max={100} markAt={week.elapsed} tone={quotaTone(week.state)} text={pct(week.used)} hint="Weekly quota used. The marker is time elapsed in the week; red when use runs ahead of it." />
        <GaugeRow
          label="CPU"
          value={load.ratio}
          max={Math.max(1.5, load.hot * 1.5)}
          ticks={[load.idle, load.hot]}
          tone={load.level === "hot" ? "bg-destructive" : "bg-primary"}
          text={load.ratio === null ? "?" : load.ratio.toFixed(2)}
          hint={`CPU load per core. Ticks at ${load.idle} (idle) and ${load.hot} (hot).`}
        />
        <GaugeRow label="Memory" value={memory.freePct} max={100} ticks={[memory.memFreeMinPercent]} tone={memory.hot ? "bg-destructive" : "bg-primary"} text={pct(memory.freePct)} hint={`Free memory. The tick is the ${memory.memFreeMinPercent}% pressure line.`} />
      </div>

      <div className="flex flex-col gap-0.5 border-t pt-2">
        <div className="truncate text-sm" title={view.why.sentence}>
          {view.why.sentence}
        </div>
        <div className="text-xs text-muted-foreground">
          {d !== null && `${d.applied ? "Applied" : "Held"} ${d.cur} → ${d.next} · `}
          {view.why.decidedAt === null ? "Nothing logged yet" : clock(Date.parse(view.why.decidedAt))}
        </div>
      </div>
    </div>
  );
}

export default definePluginApp((app) => {
  app.experimental_sidebarFooter.register({
    kind: "disclosure",
    id: "concurrency-coach-window",
    label: "Concurrency Coach",
    icon: "concurrency-coach/coach",
    component: CoachWindow,
  });
  app.slots.navPanel({
    id: "concurrency-coach",
    title: "Concurrency Coach",
    icon: "concurrency-coach/coach",
    path: "concurrency-coach",
    component: ConcurrencyCoachPage,
  });
});
