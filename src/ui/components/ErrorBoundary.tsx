// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

import { Component, type ReactNode } from "react";

interface ErrorBoundaryProps {
  /** Names what crashed in the notice, e.g. `Panel "core.histogram"`. */
  what: string;
  /** Classes for the notice that replaces the crashed subtree. */
  className: string;
  children: ReactNode;
}

// Contains a render error in extension-supplied UI, which would otherwise
// unmount the whole window: the subtree is replaced by "<what> crashed:
// <message>". A new `key` gives the subtree a fresh start.
export class ErrorBoundary extends Component<ErrorBoundaryProps, { error: unknown }> {
  constructor(props: ErrorBoundaryProps) {
    super(props);
    this.state = { error: null };
  }
  static getDerivedStateFromError(error: unknown) {
    return { error };
  }
  render() {
    if (this.state.error) {
      const msg =
        this.state.error instanceof Error
          ? this.state.error.message
          : String(this.state.error);
      return (
        <div className={this.props.className}>
          {this.props.what} crashed: {msg}
        </div>
      );
    }
    return this.props.children;
  }
}
