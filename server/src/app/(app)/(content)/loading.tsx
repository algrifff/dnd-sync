// Suspense fallback for navigation between content pages. Because
// the shell (header, sidebar, tab bar) lives in the parent layout
// and doesn't re-render on page change, this only fills the central
// column — sidebar and tabs stay visible and keep their state. The
// skeleton is intentionally subtle: a single thin progress strip
// across the top of the content column rather than a full blanking
// scrim that would cause the very flicker we're here to prevent.

export default function ContentLoading(): React.JSX.Element {
  return (
    <div
      className="relative flex min-h-0 flex-1 flex-col"
      role="status"
      aria-label="Loading page"
    >
      <div className="relative h-0.5 w-full overflow-hidden bg-[#EAE1CF]">
        <span
          className="absolute inset-y-0 left-0 w-1/3 animate-[contentload_1.1s_ease-in-out_infinite] bg-[#D4A85A]"
          style={{
            animationName: 'contentload',
          }}
        />
      </div>
      <style>{`
        @keyframes contentload {
          0%   { transform: translateX(-100%); }
          50%  { transform: translateX(200%); }
          100% { transform: translateX(300%); }
        }
      `}</style>
      <span className="sr-only">Loading…</span>
    </div>
  );
}
