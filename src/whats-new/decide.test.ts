import { describe, expect, test } from "vitest";
import { WHATS_NEW_KEY, decideWhatsNew, readSeenVersion, writeSeenVersion } from "./decide";

function memoryStore(initial: Record<string, string> = {}) {
  const data = new Map(Object.entries(initial));
  return {
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => void data.set(k, v),
    data,
  };
}

describe("decideWhatsNew", () => {
  test("a brand-new install gets the welcome setup, not what's new", () => {
    expect(decideWhatsNew({ seen: null, current: "3.2.7", newInstall: true })).toBe("skip");
  });

  test("the first launch of a newer version shows it", () => {
    expect(decideWhatsNew({ seen: "3.2.6", current: "3.2.7", newInstall: false })).toBe("show");
  });

  test("an existing user from before what's new existed sees this version's notes once", () => {
    expect(decideWhatsNew({ seen: null, current: "3.2.7", newInstall: false })).toBe("show");
  });

  test("the same version again, or an older one, shows nothing", () => {
    expect(decideWhatsNew({ seen: "3.2.7", current: "3.2.7", newInstall: false })).toBe("skip");
    expect(decideWhatsNew({ seen: "3.2.8", current: "3.2.7", newInstall: false })).toBe("skip");
  });
});

describe("the seen version", () => {
  test("is stored under its own key and read back", () => {
    const store = memoryStore();
    writeSeenVersion(store, "3.2.7");
    expect(store.data.get(WHATS_NEW_KEY)).toBe("3.2.7");
    expect(readSeenVersion(store)).toBe("3.2.7");
  });

  test("anything that isn't a version reads as none", () => {
    expect(readSeenVersion(memoryStore())).toBeNull();
    expect(readSeenVersion(memoryStore({ [WHATS_NEW_KEY]: "banana" }))).toBeNull();
  });

  test("storage that throws reads as none and writes nothing, without throwing", () => {
    const broken = {
      getItem: () => {
        throw new Error("denied");
      },
      setItem: () => {
        throw new Error("denied");
      },
    };
    expect(readSeenVersion(broken)).toBeNull();
    expect(() => writeSeenVersion(broken, "3.2.7")).not.toThrow();
  });
});
