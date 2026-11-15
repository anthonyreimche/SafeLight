import { afterEach, describe, expect, it } from "vitest";
import type { NativeFsBridge } from "@/extensions/api/native-bridge";
import { installNodeHost } from "./host";

const bridge = { exists: async () => true } as unknown as NativeFsBridge;

afterEach(() => {
  Reflect.deleteProperty(globalThis, "window");
  Reflect.deleteProperty(globalThis, "localStorage");
});

describe("installNodeHost", () => {
  it("gives localStorage seeded from the mirror, in memory", () => {
    installNodeHost({ bridge, platform: "win32", storage: { a: "1" } });
    expect(localStorage.getItem("a")).toBe("1");
    expect(localStorage.getItem("b")).toBeNull();
    localStorage.setItem("b", "2");
    expect(localStorage.getItem("b")).toBe("2");
    localStorage.removeItem("a");
    expect(localStorage.length).toBe(1);
  });

  it("hands the bridge to claimPrivileged and reports the platform", () => {
    installNodeHost({ bridge, platform: "linux", storage: {} });
    expect(window.safelightNative?.platform).toBe("linux");
    expect(window.safelightNative?.claimPrivileged?.()?.fs?.exists).toBeTypeOf("function");
  });

  it("keeps a bridge claimed once pointing at the latest install's", async () => {
    installNodeHost({ bridge, platform: "linux", storage: {} });
    const claimed = window.safelightNative?.claimPrivileged?.()?.fs;
    const later = { exists: async () => false } as unknown as NativeFsBridge;
    installNodeHost({ bridge: later, platform: "linux", storage: {} });
    expect(await claimed?.exists("x")).toBe(false);
  });
});
