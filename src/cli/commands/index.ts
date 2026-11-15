// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// Every `slu` verb, in help-screen order.

import type { CommandSpec } from "../types";
import { photosCommand } from "./photos";
import { toolsCommand } from "./tools";
import { getCommand } from "./get";
import { historyCommand } from "./history";
import { previewCommand } from "./preview";
import { setCommand } from "./set";
import { addCommand } from "./add";
import { removeCommand } from "./remove";
import { resetCommand } from "./reset";
import { autoCommand } from "./auto";
import { undoCommand } from "./undo";
import { redoCommand } from "./redo";
import { copyCommand } from "./copy";
import { pasteCommand } from "./paste";
import { presetsCommand } from "./presets";
import { applyCommand } from "./apply";
import { savePresetCommand } from "./save-preset";
import { rateCommand } from "./rate";
import { flagCommand } from "./flag";
import { labelCommand } from "./label";
import { exportPhotosCommand } from "./export";
import { searchCommand } from "./search";
import { installCommand } from "./install";
import { uninstallCommand } from "./uninstall";
import { updateCommand } from "./update";
import { extensionsCommand } from "./extensions";
import { enableCommand } from "./enable";
import { disableCommand } from "./disable";
import { doctorCommand } from "./doctor";
import { versionCommand } from "./version";
import { helpCommand } from "./help";

export const COMMANDS: CommandSpec[] = [
  photosCommand, toolsCommand, getCommand, historyCommand, previewCommand,
  setCommand, addCommand, removeCommand, resetCommand, autoCommand, undoCommand, redoCommand,
  copyCommand, pasteCommand, presetsCommand, applyCommand, savePresetCommand,
  rateCommand, flagCommand, labelCommand,
  exportPhotosCommand,
  searchCommand, installCommand, uninstallCommand, updateCommand, extensionsCommand, enableCommand, disableCommand,
  doctorCommand, versionCommand, helpCommand,
];

/** Verbs kept in the registry but left off the help screen: they only say they aren't in this release. */
export const NOT_IN_THIS_RELEASE: ReadonlySet<string> = new Set([autoCommand.verb, savePresetCommand.verb]);

export { findCommand } from "../args";
