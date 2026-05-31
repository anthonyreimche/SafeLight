// Zoom controls for the image viewports, rendered in the status bar (off the
// image). `null` is fit-to-frame; numbers are scale factors of the buffer.
const STOPS: { label: string; value: number }[] = [
  { label: "25%", value: 0.25 },
  { label: "50%", value: 0.5 },
  { label: "100%", value: 1 },
  { label: "150%", value: 1.5 },
  { label: "200%", value: 2 },
];

export function ZoomControls({
  zoom,
  onChange,
}: {
  zoom: number | null;
  onChange: (zoom: number | null) => void;
}) {
  const btn = (active: boolean) =>
    `text-[10px] ${active ? "text-text-primary" : "text-text-muted hover:text-text-primary"}`;

  return (
    <div className="flex gap-2">
      <button onClick={() => onChange(null)} className={btn(zoom == null)}>
        Fit
      </button>
      {STOPS.map((s) => (
        <button
          key={s.label}
          onClick={() => onChange(s.value)}
          className={btn(zoom === s.value)}
        >
          {s.label}
        </button>
      ))}
    </div>
  );
}
