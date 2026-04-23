// Layout-shaped skeleton shown while the (app) segment streams its
// RSC payload. Used by Next.js automatically during navigation —
// crucially, this is what the user sees during a world switch
// (`router.replace('/')` fires the segment loading boundary). Mimicking
// the real layout shape (sidebars + main column) avoids the modal-flash
// that a centred spinner produces, so the switch feels like a paint
// repaint rather than a blocking dialog.

export default function AppLoading(): React.JSX.Element {
  return (
    <div
      className="flex min-w-0 flex-1 flex-col"
      role="status"
      aria-label="Loading world"
    >
      {/* Header strip */}
      <div className="h-14 shrink-0 border-b border-[#D4C7AE] bg-[#F4EDE0]" />
      <div className="flex min-h-0 flex-1">
        {/* Sidebar skeleton */}
        <div className="hidden h-full w-[260px] shrink-0 flex-col gap-2 border-r border-[#D4C7AE] bg-[#EAE1CF]/60 p-3 md:flex">
          <div className="h-6 w-32 animate-pulse rounded bg-[#D4C7AE]/70" />
          <div className="h-4 w-full animate-pulse rounded bg-[#D4C7AE]/50" />
          <div className="h-4 w-5/6 animate-pulse rounded bg-[#D4C7AE]/50" />
          <div className="h-4 w-3/4 animate-pulse rounded bg-[#D4C7AE]/50" />
          <div className="h-4 w-2/3 animate-pulse rounded bg-[#D4C7AE]/50" />
          <div className="h-4 w-5/6 animate-pulse rounded bg-[#D4C7AE]/50" />
        </div>
        {/* Main column skeleton */}
        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
          <div className="h-9 shrink-0 border-b border-[#D4C7AE] bg-[#F4EDE0]" />
          <div className="surface-paper mx-auto w-full max-w-4xl px-6 py-10">
            <div className="h-10 w-1/2 animate-pulse rounded bg-[#D4C7AE]/60" />
            <div className="mt-3 h-4 w-1/3 animate-pulse rounded bg-[#D4C7AE]/40" />
            <div className="mt-10 h-32 w-full animate-pulse rounded-[12px] bg-[#D4C7AE]/30" />
            <div className="mt-8 grid gap-3 sm:grid-cols-2 md:grid-cols-3">
              <div className="h-20 animate-pulse rounded-[12px] bg-[#D4C7AE]/30" />
              <div className="h-20 animate-pulse rounded-[12px] bg-[#D4C7AE]/30" />
              <div className="h-20 animate-pulse rounded-[12px] bg-[#D4C7AE]/30" />
            </div>
          </div>
        </div>
      </div>
      <span className="sr-only">Loading world…</span>
    </div>
  );
}
