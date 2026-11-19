// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// Installs the `safelight` command as three shims (cmd, PowerShell, sh) in npm's
// global prefix folder, which terminals that are already open have on PATH.
// Usage: node install-safelight-command.mjs [repoRoot]

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const MARKER = "safelight-unplugged-shim";
export const MIN_NODE_MAJOR = 22;

const quoteSh = (text) => text.replace(/[\\"$`]/g, "\\$&");
const quotePs = (text) => text.replace(/'/g, "''");

/** The three shim files, name to content, running `node <repo>/dist-cli/slu.mjs`. */
export function shimFiles(repo) {
  const entry = path.resolve(repo, "dist-cli", "slu.mjs");
  const forward = entry.replace(/\\/g, "/");
  return {
    "safelight.cmd": [
      "@ECHO off",
      `REM ${MARKER}`,
      `node "${entry.replace(/%/g, "%%")}" %*`,
      "",
    ].join("\r\n"),
    "safelight.ps1": [
      "#!/usr/bin/env pwsh",
      `# ${MARKER}`,
      "if ($MyInvocation.ExpectingInput) {",
      `  $input | & node '${quotePs(entry)}' $args`,
      "} else {",
      `  & node '${quotePs(entry)}' $args`,
      "}",
      "exit $LASTEXITCODE",
      "",
    ].join("\n"),
    safelight: [
      "#!/bin/sh",
      `# ${MARKER}`,
      `exec node "${quoteSh(forward)}" "$@"`,
      "",
    ].join("\n"),
  };
}

function isOurs(file) {
  return readFileSync(file, "utf8").includes(MARKER);
}

/** Writes the shims into `prefix`. Touches nothing when a `safelight*` file there
 *  isn't ours. Returns the files written, or the file it refused to replace. */
export function installShims({ prefix, repo }) {
  const files = shimFiles(repo);
  for (const name of Object.keys(files)) {
    const target = path.join(prefix, name);
    if (existsSync(target) && !isOurs(target)) return { written: [], refused: target };
  }
  mkdirSync(prefix, { recursive: true });
  const written = [];
  for (const [name, content] of Object.entries(files)) {
    const target = path.join(prefix, name);
    writeFileSync(target, content);
    written.push(target);
  }
  return { written, refused: null };
}

function globalPrefix() {
  const npm = process.platform === "win32" ? "npm.cmd" : "npm";
  return execFileSync(npm, ["prefix", "-g"], { encoding: "utf8", shell: process.platform === "win32" }).trim();
}

function main(argv) {
  const major = Number(process.versions.node.split(".")[0]);
  if (major < MIN_NODE_MAJOR) {
    console.log(`    Node ${MIN_NODE_MAJOR} or newer is needed (this is ${process.versions.node}).`);
    return 1;
  }
  const repo = path.resolve(argv[0] ?? path.join(path.dirname(fileURLToPath(import.meta.url)), ".."));
  const prefix = globalPrefix();
  const { written, refused } = installShims({ prefix, repo });
  if (refused) {
    console.log(`    ${refused} isn't from Safelight, so it was left alone.`);
    return 1;
  }
  console.log(`    Installed safelight in ${prefix}.`);
  return written.length > 0 ? 0 : 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2));
}
