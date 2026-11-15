// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// The files the command-line tool shares with the app, kept in userData:
// which extensions are turned off, the settings the app mirrors for it, and
// what each installed extension declares. The app writes them; `slu` reads them.

const fs = require("node:fs/promises");
const path = require("node:path");
const { compareSemver, isSemver } = require("./plugin-releases.cjs");

const EXTENSION_STATE_FILE = "extension-state.json";
const SHARED_SETTINGS_FILE = "shared-settings.json";
const GUI_HEARTBEAT_FILE = "gui-heartbeat.json";
const DESCRIPTORS_DIR = "extension-descriptors";

// An id or version ends up in a file name, so it may not climb out of the folder.
const SAFE_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._+-]*$/;

function safeSegment(value, what) {
  if (typeof value !== "string" || !SAFE_SEGMENT.test(value) || value.includes(".."))
    throw new Error(`Not a safe ${what} for a file name: ${JSON.stringify(value)}`);
  return value;
}

const encode = (doc) => new TextEncoder().encode(JSON.stringify(doc));

/** The ids turned off, or null when no list has been written yet (or it can't be read). */
async function readDisabled(userData) {
  let doc;
  try {
    doc = JSON.parse(await fs.readFile(path.join(userData, EXTENSION_STATE_FILE), "utf8"));
  } catch {
    return null;
  }
  if (!doc || doc.version !== 1 || !Array.isArray(doc.disabled)) return null;
  return doc.disabled.filter((id) => typeof id === "string");
}

async function writeDisabled(userData, ids, writer) {
  if (!Array.isArray(ids)) throw new Error("The disabled list must be an array of ids.");
  const disabled = ids.filter((id) => typeof id === "string");
  await writer.write(path.join(userData, EXTENSION_STATE_FILE), encode({ version: 1, disabled }));
}

/** The app sends its settings every minute. They are rewritten only when they
 *  changed, and the minute is marked in a small heartbeat file instead, which
 *  `slu` reads as the app being open. */
async function writeSharedSettings(userData, doc, writer) {
  if (!doc || typeof doc !== "object") throw new Error("Shared settings must be an object.");
  const file = path.join(userData, SHARED_SETTINGS_FILE);
  const withoutTime = (d) => JSON.stringify({ ...d, writtenAt: 0 });
  let current = null;
  try {
    current = JSON.parse(await fs.readFile(file, "utf8"));
  } catch {
    /* none yet, or unreadable: written below */
  }
  if (!current || typeof current !== "object" || withoutTime(current) !== withoutTime(doc))
    await writer.write(file, encode(doc));
  await writer.write(path.join(userData, GUI_HEARTBEAT_FILE), encode({ version: 1, writtenAt: Date.now() }));
}

/** Delete the descriptors of `id` older than `version`; one that isn't a version is kept. */
async function pruneDescriptors(dir, id, version) {
  if (!isSemver(version)) return;
  const prefix = `${id}@`;
  let names;
  try {
    names = await fs.readdir(dir);
  } catch {
    return;
  }
  const older = names.filter((name) => {
    if (!name.startsWith(prefix) || !name.endsWith(".json")) return false;
    const other = name.slice(prefix.length, -".json".length);
    return isSemver(other) && compareSemver(other, version) < 0;
  });
  await Promise.all(older.map((name) => fs.rm(path.join(dir, name), { force: true })));
}

async function writeDescriptors(userData, doc, writer) {
  if (!doc || typeof doc !== "object") throw new Error("Descriptors must be an object.");
  const id = safeSegment(doc.id, "extension id");
  const version = safeSegment(doc.extVersion, "extension version");
  const dir = path.join(userData, DESCRIPTORS_DIR);
  await writer.write(path.join(dir, `${id}@${version}.json`), encode(doc));
  await pruneDescriptors(dir, id, version);
}

module.exports = { readDisabled, writeDisabled, writeSharedSettings, writeDescriptors };
