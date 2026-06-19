// Bundle the extension to a single ESM file (dist/index.js). Uses rolldown
// (SafeLight's bundler, a transitive dep at the repo root), so no separate
// install is needed. rolldown transpiles TypeScript natively and drops the
// type-only ./safelight import.

import path from "node:path";
import { fileURLToPath } from "node:url";
import { rolldown } from "rolldown";

const extDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

const bundle = await rolldown({
  input: path.join(extDir, "src", "index.ts"),
  // No externals: the extension has no npm deps; it's fully self-contained.
});
await bundle.write({
  file: path.join(extDir, "dist", "index.js"),
  format: "esm",
});
await bundle.close();

console.log("[xmp-tools] built dist/index.js");
