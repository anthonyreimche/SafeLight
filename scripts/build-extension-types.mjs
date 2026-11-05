// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// Writes extension-types/safelight.d.ts: the extension API as one
// self-contained declaration file, for extension repos to copy (and, later, to
// publish as a types package).
//
// The API's shapes live in src/extensions/api/*.ts and reach into the rest of
// src through `@/` imports. This script emits declarations for everything
// src/extensions/types.ts reaches, in memory, then keeps only the declarations
// the API's exports actually refer to, follows imports to their declarations,
// and prints them into one module. Imports from packages (React) stay imports.
//
//   node scripts/build-extension-types.mjs           write the file
//   node scripts/build-extension-types.mjs --check   fail if it is out of date

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SRC = slash(join(ROOT, "src")) + "/";
const ENTRY = slash(join(ROOT, "src/extensions/types.ts"));
const OUT = join(ROOT, "extension-types/safelight.d.ts");
/** The packages an extension is expected to have types for. */
const ALLOWED_PACKAGES = new Set(["react", "react-dom", "zustand"]);

function slash(p) {
  return p.replace(/\\/g, "/");
}
function key(p) {
  return slash(p).toLowerCase();
}
function isSrc(fileName) {
  return key(fileName).startsWith(SRC.toLowerCase());
}
function fail(message) {
  console.error(`build-extension-types: ${message}`);
  process.exit(1);
}

// 1. Emit declarations for the API and everything it imports, in memory.

const parsed = ts.getParsedCommandLineOfConfigFile(join(ROOT, "tsconfig.json"), {}, {
  ...ts.sys,
  onUnRecoverableConfigFileDiagnostic: (d) => fail(ts.flattenDiagnosticMessageText(d.messageText, "\n")),
});
const emitOptions = {
  ...parsed.options,
  noEmit: false,
  declaration: true,
  emitDeclarationOnly: true,
  noUnusedLocals: false,
  noUnusedParameters: false,
};
const ambient = parsed.fileNames.filter((f) => f.endsWith(".d.ts") && isSrc(f));
const emitProgram = ts.createProgram([ENTRY, ...ambient], emitOptions);
const emitted = new Map();
const result = emitProgram.emit(undefined, (fileName, text) => {
  if (isSrc(fileName)) emitted.set(key(fileName), { fileName: slash(fileName), text });
});
if (result.emitSkipped) fail("declaration emit was skipped");

// 2. Load the emitted declarations as a program of their own, standing in for
//    the source files they came from.

const declOptions = { ...parsed.options, noEmit: true };
const host = ts.createCompilerHost(declOptions);
const isSourceTs = (p) => isSrc(p) && /\.tsx?$/.test(p) && !p.endsWith(".d.ts");
host.fileExists = (p) => emitted.has(key(p)) || (!isSourceTs(p) && ts.sys.fileExists(p));
host.readFile = (p) => emitted.get(key(p))?.text ?? (isSourceTs(p) ? undefined : ts.sys.readFile(p));
const baseGetSourceFile = host.getSourceFile.bind(host);
host.getSourceFile = (p, lang, onError, create) => {
  const hit = emitted.get(key(p));
  return hit ? ts.createSourceFile(p, hit.text, lang, true) : baseGetSourceFile(p, lang, onError, create);
};

const entryDecl = ENTRY.replace(/\.ts$/, ".d.ts");
if (!emitted.has(key(entryDecl))) fail(`no declarations were emitted for ${ENTRY}`);
const program = ts.createProgram([entryDecl, ...ambient], declOptions, host);
const checker = program.getTypeChecker();

// 3. Follow every name the API's declarations use to where it is declared.

/** Where an import or re-export reads from, if the node is part of one. */
function moduleSpecifierOf(decl) {
  if (ts.isImportSpecifier(decl)) return decl.parent.parent.parent.moduleSpecifier;
  if (ts.isNamespaceImport(decl)) return decl.parent.parent.moduleSpecifier;
  if (ts.isImportClause(decl)) return decl.parent.moduleSpecifier;
  if (ts.isExportSpecifier(decl)) return decl.parent.parent.moduleSpecifier;
  return undefined;
}

function isPackageModule(specifier) {
  const target = checker.getSymbolAtLocation(specifier);
  const file = target?.declarations?.[0]?.getSourceFile();
  if (!file) fail(`cannot resolve "${specifier.text}" in ${specifier.getSourceFile().fileName}`);
  return !isSrc(file.fileName);
}

/** A name resolved past its imports: a package import, or a symbol. */
function resolve(symbol) {
  let s = symbol;
  while (s.flags & ts.SymbolFlags.Alias) {
    const decl = s.declarations?.[0];
    const specifier = decl && moduleSpecifierOf(decl);
    if (specifier && isPackageModule(specifier)) {
      const imported = ts.isNamespaceImport(decl)
        ? "*"
        : ts.isImportClause(decl)
          ? "default"
          : (decl.propertyName ?? decl.name).text;
      return { external: { from: specifier.text, imported } };
    }
    const next = checker.getImmediateAliasedSymbol(s);
    if (!next) fail(`cannot follow ${s.name}`);
    s = next;
  }
  return { symbol: s };
}

function isSrcModule(file) {
  return ts.isSourceFile(file) && ts.isExternalModule(file) && isSrc(file.fileName);
}

/** The top-level statement a declaration belongs to, if it is one. */
function topStatement(decl) {
  const node = ts.isVariableDeclaration(decl) ? decl.parent.parent : decl;
  return node.parent && isSrcModule(node.parent) && !isGlobalBlock(node) ? node : undefined;
}

function isGlobalBlock(node) {
  return ts.isModuleDeclaration(node) && (node.flags & ts.NodeFlags.GlobalAugmentation) !== 0;
}

/** The `declare global { }` block a declaration sits in, if it is one. */
function globalBlock(decl) {
  const block = decl.parent && ts.isModuleBlock(decl.parent) ? decl.parent.parent : undefined;
  return block && isGlobalBlock(block) && isSrcModule(block.parent) ? block : undefined;
}

const kept = new Map(); // symbol -> output name
const statements = new Set();
const externals = new Map(); // from -> Map(imported -> local)
const strays = new Set();
const queue = [];

function addStatement(statement) {
  if (statements.has(statement)) return;
  statements.add(statement);
  queue.push(statement);
}

function keep(symbol) {
  if (kept.has(symbol)) return true;
  const decls = symbol.declarations ?? [];
  // A global Safelight augments (Window) comes along as its `declare global`
  // block. One Safelight alone declares would be missing in an extension.
  const augments = decls.map(globalBlock).filter(Boolean);
  augments.forEach(addStatement);
  const own = decls.map(topStatement).filter(Boolean);
  if (own.length === 0) {
    const onlySrc = decls.length > 0 && decls.every((d) => isSrc(d.getSourceFile().fileName));
    if (onlySrc && augments.length === 0 && decls.some((d) => d.parent && ts.isModuleBlock(d.parent))) {
      strays.add(symbol.name);
    }
    return false;
  }
  kept.set(symbol, null);
  own.forEach(addStatement);
  return true;
}

/** react -> React, react-dom -> ReactDom: the local name of a whole-package import. */
function namespaceName(from) {
  return from.replace(/(^|-)(\w)/g, (_, _dash, c) => c.toUpperCase());
}

function externalName({ from, imported }) {
  if (!ALLOWED_PACKAGES.has(from)) fail(`the API refers to "${from}", which extensions do not have types for`);
  let names = externals.get(from);
  if (!names) externals.set(from, (names = new Map()));
  if (!names.has(imported)) names.set(imported, imported === "*" || imported === "default" ? namespaceName(from) : imported);
  return names.get(imported);
}

function visitRefs(node) {
  if (ts.isImportTypeNode(node)) {
    const literal = node.argument.literal;
    if (!isPackageModule(literal)) {
      if (!node.qualifier || !ts.isIdentifier(node.qualifier)) fail(`unsupported import type in ${node.getSourceFile().fileName}`);
      const symbol = checker.getSymbolAtLocation(node.qualifier);
      const r = symbol && resolve(symbol);
      if (!r?.symbol || !keep(r.symbol)) fail(`cannot inline ${node.getText()}`);
    } else if (!ALLOWED_PACKAGES.has(literal.text)) {
      fail(`the API refers to "${literal.text}", which extensions do not have types for`);
    }
    node.typeArguments?.forEach(visitRefs);
    return;
  }
  if (ts.isIdentifier(node)) {
    const symbol = checker.getSymbolAtLocation(node);
    if (symbol) {
      const r = resolve(symbol);
      if (r.external) externalName(r.external);
      else keep(r.symbol);
    }
    return;
  }
  ts.forEachChild(node, visitRefs);
}

const entryFile = program.getSourceFile(entryDecl);
const entryExports = checker.getExportsOfModule(checker.getSymbolAtLocation(entryFile));
const reexports = [];
for (const exp of entryExports) {
  const r = resolve(exp);
  if (r.external) reexports.push({ name: exp.name, local: externalName(r.external) });
  else if (!keep(r.symbol)) fail(`the API export ${exp.name} has no declaration to copy`);
}
while (queue.length > 0) visitRefs(queue.shift());
if (strays.size > 0) fail(`the API refers to ambient declarations: ${[...strays].join(", ")}`);

// 4. Name everything once. A name two declarations share gets a suffix.

const taken = new Set([...externals.values()].flatMap((m) => [...m.values()]));
for (const symbol of kept.keys()) {
  let name = symbol.name;
  for (let n = 2; taken.has(name); n++) name = `${symbol.name}${n}`;
  taken.add(name);
  kept.set(symbol, name);
}

// 5. Print each kept statement with its names rewritten, grouped by the source
//    file it came from.

function nameFor(node) {
  const symbol = checker.getSymbolAtLocation(node);
  if (!symbol) return undefined;
  const r = resolve(symbol);
  return r.external ? externalName(r.external) : kept.get(r.symbol);
}

function printStatement(statement) {
  const file = statement.getSourceFile();
  const edits = [];
  const walk = (node) => {
    if (ts.isImportTypeNode(node) && !isPackageModule(node.argument.literal)) {
      const name = nameFor(node.qualifier);
      edits.push([node.getStart(), node.qualifier.end, (node.isTypeOf ? "typeof " : "") + name]);
      node.typeArguments?.forEach(walk);
      return;
    }
    if (ts.isIdentifier(node)) {
      const name = nameFor(node);
      if (name && name !== node.text) edits.push([node.getStart(), node.end, name]);
      return;
    }
    ts.forEachChild(node, walk);
  };
  walk(statement);

  const start = statement.getStart();
  const declaration = ts.isVariableStatement(statement) ? statement.declarationList.declarations[0] : statement;
  const exported = isGlobalBlock(statement) || ts.getCombinedModifierFlags(declaration) & ts.ModifierFlags.Export;
  let text = "";
  let at = start;
  for (const [from, to, replacement] of edits.sort((a, b) => a[0] - b[0])) {
    text += file.text.slice(at, from) + replacement;
    at = to;
  }
  text += file.text.slice(at, statement.end);
  // Values are declared for `typeof` but not exported: an extension reaches
  // the host's functions through `api`, and importing one would fail to build.
  const isValue = ts.isFunctionDeclaration(statement) || ts.isVariableStatement(statement);
  if (isValue && exported) text = text.replace(/^export\s+/, "");
  if (!isValue && !exported) text = `export ${text}`;

  const comments = ts.getLeadingCommentRanges(file.text, statement.pos) ?? [];
  const doc = comments.at(-1);
  const jsdoc = doc && file.text.startsWith("/**", doc.pos) ? file.text.slice(doc.pos, doc.end) + "\n" : "";
  return jsdoc + text;
}

const byFile = new Map();
for (const statement of statements) {
  const file = statement.getSourceFile();
  if (!byFile.has(file)) byFile.set(file, []);
  byFile.get(file).push(statement);
}

const version = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")).version;
const out = [
  "// Safelight extension API types, generated from Safelight's",
  "// src/extensions/api/*.ts by scripts/build-extension-types.mjs. Don't edit",
  "// this file: regenerate it, or copy a newer one.",
  "//",
  "// Import its types with `import type`. It declares a few of the host's",
  "// functions for their types only; reach those through `api`.",
  `// Safelight ${version}. GPL-3.0-only.`,
  "",
];
for (const [from, names] of [...externals].sort()) {
  const named = [...names].filter(([imported]) => imported !== "*" && imported !== "default");
  for (const [imported, local] of names) {
    if (imported === "*") out.push(`import type * as ${local} from "${from}";`);
    if (imported === "default") out.push(`import type ${local} from "${from}";`);
  }
  if (named.length > 0) {
    const list = named.map(([imported, local]) => (imported === local ? imported : `${imported} as ${local}`));
    out.push(`import type { ${list.sort().join(", ")} } from "${from}";`);
  }
}
for (const [file, list] of byFile) {
  const source = slash(relative(ROOT, file.fileName)).replace(/\.d\.ts$/, ".ts");
  out.push("", `// ${source}`, "");
  for (const statement of list.sort((a, b) => a.pos - b.pos)) out.push(printStatement(statement), "");
}
if (reexports.length > 0) {
  out.push(`export type { ${reexports.map((r) => (r.name === r.local ? r.name : `${r.local} as ${r.name}`)).join(", ")} };`);
}
const text = out.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd() + "\n";

// 6. Check the result stands on its own: it compiles with nothing but React's
//    types and the DOM library, with library checks on.

const checkHost = ts.createCompilerHost({});
const checkPath = slash(join(ROOT, "extension-types/__check__/safelight.d.ts"));
const checkOptions = {
  target: ts.ScriptTarget.ES2022,
  module: ts.ModuleKind.ESNext,
  moduleResolution: ts.ModuleResolutionKind.Bundler,
  lib: ["lib.es2022.d.ts", "lib.dom.d.ts", "lib.dom.iterable.d.ts"],
  types: [],
  typeRoots: [join(ROOT, "node_modules/@types")],
  strict: true,
  noEmit: true,
  skipLibCheck: false,
};
const checkBase = checkHost.getSourceFile.bind(checkHost);
checkHost.getSourceFile = (p, lang, onError, create) =>
  key(p) === key(checkPath) ? ts.createSourceFile(p, text, lang, true) : checkBase(p, lang, onError, create);
const checkFileExists = checkHost.fileExists.bind(checkHost);
checkHost.fileExists = (p) => key(p) === key(checkPath) || checkFileExists(p);
const checkProgram = ts.createProgram([checkPath], checkOptions, checkHost);
const problems = ts.getPreEmitDiagnostics(checkProgram).filter((d) => key(d.file?.fileName ?? "") === key(checkPath));
if (problems.length > 0) {
  console.error(ts.formatDiagnostics(problems, { getCanonicalFileName: (f) => f, getCurrentDirectory: () => ROOT, getNewLine: () => "\n" }));
  fail("the generated file does not compile on its own");
}

if (process.argv.includes("--check")) {
  const current = existsSync(OUT) ? readFileSync(OUT, "utf8").replace(/\r\n/g, "\n") : "";
  if (current !== text) fail(`${slash(relative(ROOT, OUT))} is out of date: run node scripts/build-extension-types.mjs`);
  console.log(`${slash(relative(ROOT, OUT))} is up to date.`);
} else {
  mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(OUT, text);
  console.log(`Wrote ${slash(relative(ROOT, OUT))}: ${kept.size} declarations from ${byFile.size} files.`);
}
