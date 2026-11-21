/**
 * @fileoverview The kind each chart's window draws through.
 */

import type { Kinds } from "../kind.ts";
import { bars } from "./bars.ts";
import { box } from "./box.ts";
import { dots } from "./dots.ts";
import { slope } from "./slope.ts";
import { histogram } from "./histogram.ts";
import { pie } from "./pie.ts";
import { scatter } from "./scatter.ts";
import { stack } from "./stack.ts";
import { time } from "./time.ts";
import { heat } from "./heat.ts";
import { week } from "./week.ts";

/** Each plot's kind. */
export const KINDS: Kinds = {
  bars,
  pie,
  scatter,
  time,
  stack,
  histogram,
  box,
  dots,
  slope,
  week,
  heat,
};
