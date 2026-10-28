// For tests written before Nate's reserve: the shipped tuning with the reserve off, so their quota figures test the pace rules alone.
import { DEFAULT_TUNING, type Tuning } from "./tuning.ts";

export const NO_RESERVE: Tuning = { ...DEFAULT_TUNING, reserveFiveHour: 0, reserveWeek: 0 };
