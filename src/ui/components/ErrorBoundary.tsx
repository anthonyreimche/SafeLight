// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

import { Component, type ErrorInfo, type ReactNode } from "react";
import { recordError } from "@/diagnostics/error-log";
import type { ReportCrash } from "@/diagnostics/report-sections";
import { openReportIssue } from "./report-issue-store";

interface ErrorBoundaryProps {
  /** Names what crashed in the notice, e.g. `Panel "core.histogram"`. */
  what: string;
  /** Classes for the notice that replaces the crashed subtree. */
  className: string;
  children: ReactNode;
}

// The error log keeps ten stack lines: half for where it threw, the rest for
// which components it was in.
const STACK_FRAMES = 5;
const COMPONENT_FRAMES = 4;

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));
const linesOf = (text: string | null | undefined): string[] =>
  (text ?? "").split("\n").filter((l) => l.trim() !== "");

// Contains a render error in extension-supplied UI, which would otherwise
// unmount the whole window: the subtree is replaced by "<what> crashed:
// <message>" and a Report this link. A new `key` gives the subtree a fresh start.
export class ErrorBoundary extends Component<ErrorBoundaryProps, { error: unknown }> {
  private crash: ReportCrash | null = null;

  constructor(props: ErrorBoundaryProps) {
    super(props);
    this.state = { error: null };
  }
  static getDerivedStateFromError(error: unknown) {
    return { error };
  }
  componentDidCatch(error: unknown, info: ErrorInfo) {
    const message = messageOf(error);
    const stack = error instanceof Error ? error.stack : undefined;
    const componentStack = info.componentStack ?? undefined;
    this.crash = {
      what: this.props.what,
      message,
      ...(stack ? { stack } : {}),
      ...(componentStack ? { componentStack } : {}),
    };
    recordError(
      "exception",
      `${this.props.what} crashed: ${message}`,
      [
        ...linesOf(stack).slice(0, STACK_FRAMES),
        "Component stack:",
        ...linesOf(componentStack).slice(0, COMPONENT_FRAMES),
      ].join("\n"),
    );
  }
  private report = () => {
    const message = messageOf(this.state.error);
    void openReportIssue({
      title: `${this.props.what} crashed: ${message}`.slice(0, 200),
      crash: this.crash ?? { what: this.props.what, message },
    });
  };
  render() {
    if (this.state.error) {
      return (
        <div className={this.props.className}>
          {this.props.what} crashed: {messageOf(this.state.error)}{" "}
          <button type="button" onClick={this.report} className="underline hover:text-text-primary">
            Report this
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}
