// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

import { useRegistry } from "@/extensions/registry";
import { applyPipeline, DEFAULT_PIPELINE, usePipelineStore } from "@/extensions/pipelines";
import { displayProfileSupported } from "@/rendering/display-profile-store";
import { Select } from "@/ui/components/Select";
import { Field } from "@/ui/preferences/fields";
import { settings, type PrefSection } from "@/ui/preferences/section-model";
import { DisplayProfileField } from "./DisplayProfileField";
import { SoftwareRenderingField, SOFTWARE_RENDERING, softwareRenderingListed } from "./SoftwareRenderingField";

export function RenderingSection() {
  const pipelines = useRegistry((s) => s.pipelines);
  const activeId = usePipelineStore((s) => s.activeId);
  const active = pipelines[activeId];

  return (
    <div className="flex flex-col gap-4">
      <Field
        label="Default display transform"
        hint="The tone mapper for photos without their own pick. Pick one per photo from the display transform menu in Develop's bottom bar; a photo's transform applies everywhere it renders: develop, thumbnails and export. Transforms from extensions appear here too."
      >
        <Select
          value={active ? activeId : DEFAULT_PIPELINE}
          onChange={applyPipeline}
          ariaLabel="Default display transform"
          className="w-full"
          options={Object.values(pipelines).map((p) => ({ value: p.id, label: p.name }))}
        />
      </Field>
      {active?.description && (
        <p className="text-[10px] leading-relaxed text-text-muted">
          {active.description}
        </p>
      )}
      <p className="text-[10px] leading-relaxed text-text-muted">
        Replacement transforms disable the default RAW base curve and interpret
        the tone sliders through their own response — the same edit will read
        differently between transforms by design.
      </p>
      <DisplayProfileField />
      <SoftwareRenderingField />
    </div>
  );
}

export const renderingSection: PrefSection = {
  id: "Rendering",
  label: "Rendering",
  group: "General",
  items: settings(
    "Default display transform",
    ...(displayProfileSupported() ? ["Display profile"] : []),
    ...(softwareRenderingListed() ? [SOFTWARE_RENDERING] : []),
  ),
  keywords: [
    "tone map",
    "pipeline",
    "display transform",
    "icc",
    "monitor",
    "wayland",
    "wide gamut",
    "color management",
    "gpu",
    "graphics card",
    "webgl",
    "virtual machine",
  ],
  render: () => <RenderingSection />,
};
