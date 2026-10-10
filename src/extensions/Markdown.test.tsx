// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// The README renderer turns UNTRUSTED third-party markdown (the Extensions
// store) into React elements. These specs pin the shapes it must produce and
// the things it must never produce: unsafe links and images, raw HTML.

import { afterEach, describe, expect, it, vi } from "vitest";
import { render } from "@testing-library/react";
import { Markdown } from "./Markdown";

function renderMarkdown(
  source: string,
  repo?: string,
  branch?: string,
): HTMLElement {
  return render(<Markdown source={source} repo={repo} branch={branch} />).container;
}

afterEach(() => {
  vi.restoreAllMocks();
});

const EXEC_BUDGET = 5000;

/** Runs `fn`, throwing from inside it once regexes have run EXEC_BUDGET times. */
function withExecBudget<T>(fn: () => T): T {
  const exec = RegExp.prototype.exec;
  let calls = 0;
  const spy = vi
    .spyOn(RegExp.prototype, "exec")
    .mockImplementation(function (this: RegExp, input: string) {
      calls += 1;
      if (calls > EXEC_BUDGET) throw new Error(`over ${EXEC_BUDGET} regex runs`);
      return exec.call(this, input);
    });
  try {
    return fn();
  } finally {
    spy.mockRestore();
  }
}

describe("links", () => {
  // A nested inline rule once rewound the scan position through the shared
  // sticky regexes, so this input looped forever. A synchronous loop can't be
  // stopped by a test timeout, so the render runs on a regex budget instead: a
  // parser that stops advancing spends it and throws.
  it("renders one link wrapping bold text", () => {
    const container = withExecBudget(() => renderMarkdown("[**bold** text](https://x)"));

    const links = container.querySelectorAll("a");
    expect(links).toHaveLength(1);
    expect(links[0].getAttribute("href")).toBe("https://x");
    expect(links[0].textContent).toBe("bold text");
    const bold = links[0].querySelectorAll("strong");
    expect(bold).toHaveLength(1);
    expect(bold[0].textContent).toBe("bold");
  });

  it.each(["javascript:alert", "JavaScript:alert", "vbscript:run", "data:text/html,x"])(
    "drops the link but keeps its text for %s",
    (target) => {
      const container = renderMarkdown(`[click me](${target})`);
      expect(container.querySelector("a")).toBeNull();
      expect(container.textContent).toBe("click me");
    },
  );

  it("resolves a relative link against the repo's blob page", () => {
    const container = renderMarkdown("[guide](docs/guide.md)", "o/r", "main");
    expect(container.querySelector("a")?.getAttribute("href")).toBe(
      "https://github.com/o/r/blob/main/docs/guide.md",
    );
  });

  it("opens the URL in a new window and prevents in-app navigation on click", () => {
    const open = vi.spyOn(window, "open").mockImplementation(() => null);
    const container = renderMarkdown("[docs](https://example.com/docs)");
    const link = container.querySelector("a");
    if (!link) throw new Error("no link rendered");

    const click = new MouseEvent("click", { bubbles: true, cancelable: true });
    link.dispatchEvent(click);

    expect(click.defaultPrevented).toBe(true);
    expect(open).toHaveBeenCalledTimes(1);
    expect(open).toHaveBeenCalledWith(
      "https://example.com/docs",
      "_blank",
      expect.stringContaining("noopener"),
    );
  });
});

describe("images", () => {
  it("keeps only the alt text of a data: image", () => {
    const container = renderMarkdown("![pixel](data:image/png;base64,AAAA)");
    expect(container.querySelector("img")).toBeNull();
    expect(container.textContent).toBe("pixel");
  });

  it("drops a data: image with no alt text entirely", () => {
    const container = renderMarkdown("![](data:image/png;base64,AAAA)");
    expect(container.querySelector("img")).toBeNull();
    expect(container.textContent).toBe("");
  });

  it("resolves a relative image to raw.githubusercontent for the repo and branch", () => {
    const container = renderMarkdown("![shot](img/shot.png)", "o/r", "main");
    const image = container.querySelector("img");
    expect(image?.getAttribute("src")).toBe(
      "https://raw.githubusercontent.com/o/r/main/img/shot.png",
    );
    expect(image?.getAttribute("alt")).toBe("shot");
  });

  it("keeps only the alt text of a relative image when the repo is unknown", () => {
    const container = renderMarkdown("![shot](img/shot.png)");
    expect(container.querySelector("img")).toBeNull();
    expect(container.textContent).toBe("shot");
  });
});

describe("inline code", () => {
  it("is not parsed any further", () => {
    const container = renderMarkdown("`**not bold** [x](https://y)`");
    const code = container.querySelectorAll("code");
    expect(code).toHaveLength(1);
    expect(code[0].textContent).toBe("**not bold** [x](https://y)");
    expect(container.querySelector("strong")).toBeNull();
    expect(container.querySelector("a")).toBeNull();
  });
});

describe("tables", () => {
  const rows = ["| Name | Value |", "| --- | --- |", "| a | **1** |"].join("\n");

  it("builds a table from a header row followed by a separator row", () => {
    const container = renderMarkdown(rows);
    const headers = [...container.querySelectorAll("th")].map((c) => c.textContent);
    expect(headers).toEqual(["Name", "Value"]);
    const cells = [...container.querySelectorAll("td")];
    expect(cells.map((c) => c.textContent)).toEqual(["a", "1"]);
    expect(cells[1].querySelector("strong")?.textContent).toBe("1");
  });

  it("renders the same lines as a paragraph when the separator row is missing", () => {
    const container = renderMarkdown(["| Name | Value |", "| a | 1 |"].join("\n"));
    expect(container.querySelector("table")).toBeNull();
    expect(container.querySelectorAll("p")).toHaveLength(1);
  });
});

describe("raw HTML", () => {
  it("is shown as text, never as elements", () => {
    const container = renderMarkdown(
      "<script>alert(1)</script>\n\n<img src=x onerror=alert(1)>",
    );
    expect(container.querySelector("script")).toBeNull();
    expect(container.querySelector("img")).toBeNull();
    expect(container.textContent).toContain("<script>alert(1)</script>");
    expect(container.textContent).toContain("<img src=x onerror=alert(1)>");
  });
});
