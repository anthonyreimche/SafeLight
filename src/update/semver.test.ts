// Tests for the shared semver helper.
// Run with: node --experimental-strip-types src/update/semver.test.ts

import { parseSemver, compareSemver, isNewer } from "./semver.ts";

let passed = 0;
let failed = 0;
function check(name: string, cond: boolean) {
  if (cond) {
    passed++;
  } else {
    failed++;
    console.error(`  ✗ ${name}`);
  }
}
function eq(name: string, a: unknown, b: unknown) {
  check(`${name} (got ${JSON.stringify(a)}, want ${JSON.stringify(b)})`, JSON.stringify(a) === JSON.stringify(b));
}

// parseSemver: v-prefix, missing components, garbage.
eq("v-prefix", parseSemver("v1.2.3"), [1, 2, 3]);
eq("no prefix", parseSemver("1.2.3"), [1, 2, 3]);
eq("missing patch", parseSemver("1.2"), [1, 2, 0]);
eq("major only", parseSemver("3"), [3, 0, 0]);
eq("suffix ignored", parseSemver("v1.2.3-beta.1"), [1, 2, 3]);
eq("garbage → zeros", parseSemver("not-a-version"), [0, 0, 0]);

// compareSemver: ordering across major/minor/patch.
eq("equal", compareSemver("1.2.3", "v1.2.3"), 0);
eq("patch newer", compareSemver("1.2.4", "1.2.3"), 1);
eq("minor older", compareSemver("1.1.9", "1.2.0"), -1);
eq("major dominates", compareSemver("2.0.0", "1.9.9"), 1);

// isNewer: strict "candidate newer than current".
check("0.9.0 → 1.0.0 is newer", isNewer("0.9.0", "1.0.0"));
check("equal is not newer", !isNewer("1.0.0", "1.0.0"));
check("older is not newer", !isNewer("1.2.0", "1.1.0"));
check("tag forms compare", isNewer("v1.0.0", "v1.0.1"));

console.log(`semver: ${passed} passed, ${failed} failed`);
if (failed) throw new Error(`${failed} semver test(s) failed`);
