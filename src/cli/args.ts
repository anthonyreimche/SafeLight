// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// The `slu <verb> [photos…] [key=value…] [--options]` grammar (cli-commands §1).

import { CliError, type Assignment, type CommandSpec, type OptionSpec, type ParsedArgs } from "./types";

/** The verb a word names, by verb or alias; null when none. */
export function findCommand(commands: readonly CommandSpec[], word: string): CommandSpec | null {
  return commands.find((c) => c.verb === word || c.aliases?.includes(word)) ?? null;
}

/** Options every verb takes. */
export const GLOBAL_OPTIONS: readonly OptionSpec[] = [
  { name: "json", kind: "flag", summary: "Print one JSON document for scripts." },
  { name: "quiet", alias: "q", kind: "flag", summary: "Print errors only." },
  { name: "verbose", alias: "v", kind: "flag", summary: "Say what slu did; -vv adds the engine's log." },
  { name: "help", alias: "h", kind: "flag", summary: "Show this verb's usage." },
  { name: "version", kind: "flag", summary: "Print the version." },
  { name: "yes", alias: "y", kind: "flag", summary: "Answer yes to the install question." },
  { name: "strict", kind: "flag", summary: "Make a value past its limit an error instead of clamping it." },
  { name: "wait", kind: "flag", summary: "Wait for Safelight to let go of the project (--wait=seconds for a limit)." },
];

/** Options of every verb that chooses photos. */
export const PHOTO_OPTIONS: readonly OptionSpec[] = [
  { name: "project", kind: "string", summary: "Use this project instead of the one the photos sit in." },
  { name: "all", kind: "flag", summary: "Every photo in the project." },
  { name: "recursive", alias: "r", kind: "flag", summary: "Go into subfolders." },
  { name: "rating", kind: "string", summary: "Only photos with this rating: 3, 3+, 2-4." },
  { name: "flag", kind: "string", summary: "Only photos with this flag: pick, reject or none." },
  { name: "label", kind: "string", summary: "Only photos with this label: red, yellow, green, blue, purple or none." },
  { name: "edited", kind: "flag", summary: "Only edited photos." },
  { name: "unedited", kind: "flag", summary: "Only photos never edited." },
];

/** Switches that may also carry a value (`--wait=30`). */
const OPTIONAL_VALUE = new Set(["wait"]);

// A key starts with a letter, so drive paths (C:\a=b) and ./a=b stay photos.
const ASSIGNMENT = /^([A-Za-z][\w.-]*?)(\+=|-=|=)(.*)$/s;

function parseAssignment(token: string): Assignment | null {
  const m = ASSIGNMENT.exec(token);
  if (!m) return null;
  return { raw: token, key: m[1], op: m[2] as Assignment["op"], value: m[3] };
}

function optionError(verb: string | null, flag: string, problem: string): CliError {
  return new CliError(1, `${flag} ${problem}`, verb ? `slu help ${verb} lists its options.` : "slu help lists the options.");
}

/** Parses one command line. With `spec` null it only knows the global and
 *  photo options and lets other options pass as switches, so main can find the
 *  verb before it knows the verb's own options. */
export function parseArgs(argv: string[], spec: CommandSpec | null): ParsedArgs {
  const known = [...GLOBAL_OPTIONS, ...(spec ? spec.options : PHOTO_OPTIONS)];
  const byName = new Map<string, OptionSpec>();
  const byAlias = new Map<string, OptionSpec>();
  for (const o of known) {
    byName.set(o.name, o);
    if (o.alias) byAlias.set(o.alias, o);
  }

  const out: ParsedArgs = { verb: null, positionals: [], assignments: [], afterDashDash: [], stdinList: false, options: {} };
  const verbName = () => spec?.verb ?? out.verb;

  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];

    if (token === "--") {
      out.afterDashDash.push(...argv.slice(i + 1));
      break;
    }
    if (token === "-") {
      out.stdinList = true;
      continue;
    }
    if (token === "-vv") {
      out.options.verbose = 2;
      continue;
    }

    if (token.startsWith("-")) {
      const long = token.startsWith("--");
      const eq = long ? token.indexOf("=") : -1;
      const name = long ? token.slice(2, eq < 0 ? undefined : eq) : token.slice(1);
      const inline = eq < 0 ? undefined : token.slice(eq + 1);
      const flagText = long ? `--${name}` : token;
      const option = long ? byName.get(name) : byAlias.get(name);

      if (!option) {
        if (spec) throw optionError(verbName(), flagText, `isn't an option of slu ${spec.verb}.`);
        if (name) out.options[name] = inline ?? true;
        continue;
      }

      if (option.kind === "flag") {
        if (inline !== undefined && !OPTIONAL_VALUE.has(option.name)) {
          throw optionError(verbName(), flagText, "takes no value.");
        }
        if (option.name === "verbose") {
          const before = out.options.verbose;
          out.options.verbose = typeof before === "number" ? Math.min(2, before + 1) : 1;
        } else {
          out.options[option.name] = inline ?? true;
        }
        continue;
      }

      let value = inline;
      if (value === undefined) {
        if (i + 1 >= argv.length) throw optionError(verbName(), flagText, "needs a value.");
        value = argv[++i];
      }
      if (option.kind === "number") {
        const n = Number(value);
        if (value.trim() === "" || !Number.isFinite(n)) throw optionError(verbName(), flagText, `needs a number, not "${value}".`);
        out.options[option.name] = n;
      } else if (option.kind === "list") {
        const before = out.options[option.name];
        const items = value.split(",").map((s) => s.trim()).filter((s) => s.length > 0);
        out.options[option.name] = [...(Array.isArray(before) ? before : []), ...items];
      } else {
        out.options[option.name] = value;
      }
      continue;
    }

    if (out.verb === null) {
      out.verb = token;
      continue;
    }
    const assignment = parseAssignment(token);
    if (assignment) out.assignments.push(assignment);
    else out.positionals.push(token);
  }

  return out;
}
