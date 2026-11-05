// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

import type { PrefSection } from "@/ui/preferences/section-model";
import { aboutSection } from "./About";
import { exportSection } from "./Export";
import { extensionsSection } from "./Extensions";
import { interfaceSection } from "./Interface";
import { librarySection } from "./Library";
import { performanceSection } from "./Performance";
import { previewsSection } from "./Previews";
import { renderingSection } from "./Rendering";
import { shortcutsSection } from "./Shortcuts";
import { updatesSection } from "./Updates";

// Accessibility lives in the safelight.accessibility extension (so the whole
// opt-in stack can be removed): it registers its own settings section via
// api.registerSettings.
export const CORE_SECTIONS: PrefSection[] = [
  interfaceSection,
  librarySection,
  previewsSection,
  renderingSection,
  performanceSection,
  exportSection,
  shortcutsSection,
  extensionsSection,
  updatesSection,
  aboutSection,
];
