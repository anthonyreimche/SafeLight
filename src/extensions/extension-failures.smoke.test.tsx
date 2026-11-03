// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// Smoke: a launch with three broken extensions installed beside a working one:
// one whose activate throws, one whose activate never finishes, and one whose
// stage the render worker can't compile. The real loader, host and bridge run;
// the bundle import (an app:// URL) and the render worker are stand-ins. The app
// must keep working, and the Extensions window must say what went wrong.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import "./host";
import type { ExtensionManifest, ExtensionModule, SafelightAPI } from "./types";
import { importPluginModule } from "./plugin-module";
import { EXTENSION_TIMEOUT_MS } from "./guard";
import {
  isPluginRunning,
  loadExternalPlugins,
  uninstallPlugin,
  useDisabledExtensions,
  useExternalPluginsSettled,
} from "./loader";
import { useRegistry } from "./registry";
import { useStartFailures } from "./start-failures";
import { ExtensionManagerPanel } from "./ExtensionManagerPanel";
import { App } from "@/App";
import { RenderBridge } from "@/rendering/render-bridge";
import type { WorkerRequest, WorkerResponse } from "@/rendering/render-protocol";
import { useStageFailures } from "@/rendering/render-bridge/stage-failures";
import { stageSignature } from "@/rendering/webgl/stage-injection";
import { useProjectStore } from "@/project/project-store";
import { useUIStore } from "@/state/ui-store";
import { resetSetupForTests } from "@/modules/welcome/setup/setup-store";
import { writeSetupRecord } from "@/modules/welcome/setup/first-run";
import {
  registerEssentialModules,
  unregisterEssentialModules,
} from "@/test/essential-modules.test-support";

vi.mock("./plugin-module", () => ({ importPluginModule: vi.fn() }));

class FakeWorker {
  static last: FakeWorker | null = null;
  posted: WorkerRequest[] = [];
  onmessage: ((e: MessageEvent<WorkerResponse>) => void) | null = null;
  onerror: ((e: ErrorEvent) => void) | null = null;

  constructor() {
    FakeWorker.last = this;
  }

  postMessage(msg: WorkerRequest): void {
    this.posted.push(msg);
  }

  terminate(): void {}

  reply(msg: WorkerResponse): void {
    this.onmessage?.({ data: msg } as MessageEvent<WorkerResponse>);
  }
}

const manifest = (id: string, name: string): ExtensionManifest => ({
  id,
  name,
  version: "1.0.0",
  main: "index.js",
  repository: `acme/${id.split(".")[1]}`,
});

const THROWS = manifest("acme.throws", "Thrower");
const HANGS = manifest("acme.hangs", "Hanger");
const BAD_STAGE = manifest("acme.film", "Bad Film");
const GOOD = manifest("acme.good", "Good One");
const INSTALLED = [THROWS, HANGS, BAD_STAGE, GOOD];

const FILM_STAGE = "acme.film.grain";

// The hung start is let go after each test, so the next launch starts it afresh
// instead of being refused while it is still finishing.
let finishHang: () => void = () => {};

const bundles: Record<string, Partial<ExtensionModule>> = {
  [THROWS.id]: {
    activate: (api: SafelightAPI) => {
      api.registerStylesheet({ id: "acme.throws.css", css: ".t{}" });
      throw new Error("activate blew up");
    },
  },
  [HANGS.id]: { activate: () => new Promise<void>((resolve) => (finishHang = resolve)) },
  [BAD_STAGE.id]: {
    activate: (api: SafelightAPI) =>
      api.registerProcessingStage({
        id: FILM_STAGE,
        name: "Grain",
        phase: "effects",
        glsl: "c = c *;",
        uniforms: [],
      }),
  },
  [GOOD.id]: {
    activate: (api: SafelightAPI) => api.registerStylesheet({ id: "acme.good.css", css: ".g{}" }),
  },
};

/** Boot the installed extensions, the hanging one given its full time. */
async function boot(): Promise<void> {
  vi.useFakeTimers();
  const loading = loadExternalPlugins();
  await vi.advanceTimersByTimeAsync(EXTENSION_TIMEOUT_MS);
  await loading;
  vi.useRealTimers();
}

/** The worker builds the bad stage into its program and quarantines it. */
function quarantineFilmStage(bridge: RenderBridge): string[] {
  const errors: string[] = [];
  bridge.setOnError((message) => errors.push(message));
  bridge.init(64, 64);
  const worker = FakeWorker.last!;
  worker.reply({ type: "ready", pipelineFloat: true });
  const stage = useRegistry.getState().processingStages[FILM_STAGE];
  worker.reply({
    type: "stageQuarantined",
    stageId: FILM_STAGE,
    signature: stageSignature(stage),
    log: "Shader compile failed: ERROR: 0:812: ';' : syntax error\nERROR: 1 compilation errors.",
  });
  return errors;
}

async function installedRows() {
  const user = userEvent.setup();
  render(<ExtensionManagerPanel />);
  await user.click(screen.getByRole("button", { name: "Installed" }));
  await screen.findByText("Good One", { exact: false });
  const row = (name: string) => screen.getByText(name, { exact: false }).closest("button")!;
  return row;
}

let error: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  localStorage.clear();
  resetSetupForTests();
  writeSetupRecord(localStorage, "finished", "0.0.0");
  vi.stubGlobal("Worker", FakeWorker);
  vi.stubGlobal("safelightNative", { plugins: { list: async () => INSTALLED } });
  vi.stubGlobal("BroadcastChannel", class {
    postMessage(): void {}
    addEventListener(): void {}
    removeEventListener(): void {}
  });
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
  error = vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.mocked(importPluginModule).mockImplementation(async (url) => {
    const id = new URL(url).pathname.split("/")[2];
    const bundle = bundles[id];
    if (!bundle) throw new Error(`no bundle at ${url}`);
    return bundle;
  });
  useDisabledExtensions.setState({ ids: [] });
  useExternalPluginsSettled.setState({ settled: false });
  useStageFailures.setState({}, true);
  useStartFailures.setState({}, true);
});

afterEach(async () => {
  finishHang();
  finishHang = () => {};
  for (const m of INSTALLED) await uninstallPlugin(m.id);
  unregisterEssentialModules();
  useProjectStore.setState({ root: null });
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("smoke: broken extensions at launch", () => {
  it("starts the working one, sweeps the broken ones and keeps the app usable", async () => {
    await boot();

    expect(useExternalPluginsSettled.getState().settled).toBe(true);
    expect(isPluginRunning(GOOD.id)).toBe(true);
    expect("acme.good.css" in useRegistry.getState().stylesheets).toBe(true);
    expect(isPluginRunning(THROWS.id)).toBe(false);
    expect("acme.throws.css" in useRegistry.getState().stylesheets).toBe(false);
    expect(isPluginRunning(HANGS.id)).toBe(false);
    expect(error).toHaveBeenCalledWith(expect.stringContaining(THROWS.id), new Error("activate blew up"));
    expect(error).toHaveBeenCalledWith(
      expect.stringContaining(HANGS.id),
      expect.objectContaining({ message: expect.stringContaining("did not finish") }),
    );

    registerEssentialModules();
    useUIStore.setState({ activeModule: "library", detached: new Set() });
    useProjectStore.setState({ root: { name: "shoot" } as FileSystemDirectoryHandle });
    render(<App />);
    expect(screen.getByText("library view")).toBeTruthy();
    expect(screen.getByText("0 photos in catalogue")).toBeTruthy();
  });

  it("names the stage the render worker couldn't compile on its extension's row", async () => {
    await boot();
    expect(isPluginRunning(BAD_STAGE.id)).toBe(true);
    const bridge = new RenderBridge();
    const errors = quarantineFilmStage(bridge);

    expect(errors).toEqual([expect.stringContaining('Bad Film: stage "acme.film.grain" failed to compile')]);
    const row = await installedRows();
    expect(within(row("Bad Film")).getByText(/failed to compile and is off: ERROR: 0:812/)).toBeTruthy();
    expect(bridge.availability).toBe("ready");
    act(() => bridge.dispose());
  });

  it("says on their rows which extensions failed to start, and why", async () => {
    await boot();
    const row = await installedRows();

    expect(within(row("Thrower")).getByText(/activate blew up/)).toBeTruthy();
    expect(within(row("Hanger")).getByText(/took too long to start/)).toBeTruthy();
  });
});
