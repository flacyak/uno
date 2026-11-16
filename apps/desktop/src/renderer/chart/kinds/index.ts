/**
 * @fileoverview The kind each chart's window draws through.
 */

import type { Kinds } from "../kind.ts";
import { bars } from "./bars.ts";
import { pie } from "./pie.ts";
import { scatter } from "./scatter.ts";

/** Each plot's kind. */
export const KINDS: Kinds = { bars, pie, scatter };
