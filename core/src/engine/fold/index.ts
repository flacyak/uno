/**
 * @fileoverview The folder each kind of chart folds through.
 */

import type { Folders } from './folder.ts';
import { groupsFolder } from './groups.ts';
import { sampleFolder } from './sample.ts';
import { timeFolder } from './time.ts';

export { folderOf, markOf, placeOf } from './folder.ts';
export type { Block, Folder, Folders, MakeFolder } from './folder.ts';

/** Each kind's folder. */
export const FOLDERS: Folders = {
  bars: groupsFolder,
  pie: groupsFolder,
  scatter: sampleFolder,
  time: timeFolder,
};
