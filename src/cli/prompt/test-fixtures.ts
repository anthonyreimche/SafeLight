// Shared fakes for the prompt's tests: a few verbs, values and photos.

import type { CommandSpec, ToolRef, ValueInfo } from "../types";
import { createPromptContext, type DirEntry, type PhotoFact, type PhotoLook, type PromptContext, type PromptContextInput } from "./context";
import { BUILTIN_SPECS } from "./grammar";

const spec = (verb: string, usage: string, summary = "", options: CommandSpec["options"] = []): CommandSpec => ({
  verb, group: "More", summary, usage, examples: [], options, writes: false, run: async () => ({ code: 0 }),
});

export const COMMANDS: CommandSpec[] = [
  spec("photos", "photos [photos…] [filters]", "Lists photos."),
  spec("tools", "tools [photo] [--all]", "Lists the tools.", [{ name: "all", kind: "flag", summary: "Also list idle tools." }]),
  spec("get", "get <photo> [key…]", "Prints values."),
  spec("set", "set <photos> key=value…", "Sets values.", [{ name: "all", kind: "flag", summary: "Every photo." }]),
  spec("reset", "reset <photos> [key…]", "Resets values."),
  spec("rate", "rate <photos> <0-5>", "Sets stars."),
  spec("flag", "flag <photos> pick|reject|none", "Sets the flag."),
  spec("label", "label <photos> red|yellow|green|blue|purple|none", "Sets the colour label."),
  spec("export", "export <photos> [-o dir|file|-] [options]", "Renders photos.", [{ name: "output", alias: "o", kind: "string", summary: "Where to." }]),
  spec("search", "search <words…>", "Searches extensions."),
  spec("uninstall", "uninstall <name>…", "Removes extensions."),
  spec("help", "help [verb]", "Lists verbs."),
];

const BASIC: ToolRef = { id: "safelight.basic", name: "Basic", kind: "core", installed: true, enabled: true, settable: true, order: 0, hasCommitHooks: false };
const WB: ToolRef = { ...BASIC, id: "safelight.white-balance", name: "White Balance", order: 1 };
const TRANSFORM: ToolRef = { ...BASIC, id: "safelight.transform", name: "Transform", order: 2 };

export const EXPOSURE: ValueInfo = { key: "exposure", label: "Exposure", tool: BASIC, kind: "number", min: -5, max: 5, step: 0.01, unit: "EV", decimals: 2, settable: true, default: 0 };
export const CONTRAST: ValueInfo = { key: "contrast", label: "Contrast", tool: BASIC, kind: "number", min: -100, max: 100, decimals: 0, settable: true, default: 0 };
export const TEMPERATURE: ValueInfo = { key: "temperature", label: "Temperature", tool: WB, kind: "number", min: 2000, max: 50000, unit: "K", decimals: 0, settable: true };
export const UPRIGHT: ValueInfo = {
  key: "uprightMode", label: "Upright", tool: TRANSFORM, kind: "choice", settable: true,
  choices: [{ value: "off", label: "Off" }, { value: "level", label: "Level" }, { value: "auto", label: "Auto" }],
};
export const VALUES: ValueInfo[] = [EXPOSURE, CONTRAST, TEMPERATURE, UPRIGHT];

export const PHOTOS: PhotoFact[] = [
  { rel: "DSC_0412.NEF", rating: 4, flag: "pick", label: "blue" },
  { rel: "DSC_0413.NEF", rating: 2, flag: "none", label: "none" },
  { rel: "DSC_0419.NEF", rating: 0, flag: "reject", label: "none" },
  { rel: "Italy/IMG_1.ARW", rating: 0, flag: "none", label: "none" },
  { rel: "My Shoot/A 1.NEF", rating: 0, flag: "none", label: "none" },
];

/** The library verbs, for the tests of the open set and the disk listing. */
export const LIBRARY: CommandSpec[] = [
  ...COMMANDS,
  spec("open", "open [photos…] [filters]", "Opens photos."),
  spec("ls", "ls [photos…] [options]", "Lists what is here."),
  spec("import", "import [photos…] [options]", "Imports photos."),
];

/** The folder on disk: DSC_0500.NEF and Italy/IMG_2.ARW aren't imported, DSC_0413 and DSC_0419 are gone. */
export const DISK: Record<string, DirEntry[]> = {
  "/work": [
    { name: "Italy", dir: true }, { name: "My Shoot", dir: true }, { name: "Empty", dir: true },
    { name: "DSC_0412.NEF", dir: false }, { name: "DSC_0500.NEF", dir: false }, { name: "notes.txt", dir: false },
  ],
  "/work/Italy": [{ name: "IMG_1.ARW", dir: false }, { name: "IMG_2.ARW", dir: false }],
};

export const LOOKS: Record<string, PhotoLook> = {
  "DSC_0412.NEF": { values: new Map<string, unknown>([["exposure", 0.5], ["contrast", 0], ["temperature", 5150], ["uprightMode", "off"]]), step: { at: 4, of: 6 } },
};

export function context(over: Partial<PromptContextInput> = {}): PromptContext {
  return createPromptContext({
    platform: "linux",
    cwd: "/work",
    commands: COMMANDS,
    builtins: BUILTIN_SPECS,
    history: [],
    projectName: "Iceland 2026",
    photos: PHOTOS,
    values: VALUES,
    extensionNames: ["local-contrast", "paint-layers"],
    look: (rel) => LOOKS[rel],
    dir: (abs) => (abs === "/work" ? [{ name: "Italy", dir: true }, { name: "My Shoot", dir: true }, { name: "DSC_0412.NEF", dir: false }, { name: "notes.txt", dir: false }] : []),
    ...over,
  });
}
