/**
 * @fileoverview The folder each kind of chart folds through.
 */

import type { Folders } from './folder.ts';
import { dotsFolder, groupsFolder } from './groups.ts';
import { sampleFolder } from './sample.ts';
import { splitFolder } from './split.ts';
import { spreadFolder } from './spread.ts';
import { boxFolder } from './spreads.ts';
import { timeFolder } from './time.ts';
import { weekFolder } from './week.ts';

export { folderOf, markOf, placeOf } from './folder.ts';
export type { Block, Folder, Folders, MakeFolder } from './folder.ts';

/** Each kind's folder. */
export const FOLDERS: Folders = {
  bars: groupsFolder,
  pie: groupsFolder,
  scatter: sampleFolder,
  time: timeFolder,
  stack: splitFolder,
  histogram: spreadFolder,
  box: boxFolder,
  dots: dotsFolder,
  slope: splitFolder,
  week: weekFolder,
};
