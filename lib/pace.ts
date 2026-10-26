// Pace colour for the sidebar footer window. Pure and browser-safe (no node imports), so the page bundle can use it.
export type PaceState = "ahead" | "behind" | "unknown";
export interface PaceInputs { fiveHour: { state: PaceState }; week: { state: PaceState }; memory: { hot: boolean } }
/**
 * The footer window's colour and its words. Red when quota is ahead of pace or memory is under pressure; the theme primary when within pace;
 * muted when there is no quota reading yet. Memory pressure is named first, because it is why the limit is being held down.
 */
export function paceTone(i: PaceInputs): { tone: "ahead" | "within" | "unknown"; label: string } {
  if (i.memory.hot) return { tone: "ahead", label: "memory pressure" };
  if (i.fiveHour.state === "ahead" || i.week.state === "ahead") return { tone: "ahead", label: "ahead of pace" };
  if (i.fiveHour.state === "behind" || i.week.state === "behind") return { tone: "within", label: "within pace" };
  return { tone: "unknown", label: "no quota reading" };
}
