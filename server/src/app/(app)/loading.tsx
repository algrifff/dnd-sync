export default function AppLoading(): React.JSX.Element {
  return (
    <div className="relative flex min-w-0 flex-1 flex-col">
      <div className="absolute inset-0 z-40 flex items-center justify-center">
        <div className="absolute inset-0 bg-[#F4EDE0]/60 backdrop-blur-[1px]" />
        <div className="relative rounded-[12px] border border-[#D4C7AE] bg-[#FBF5E8]/95 px-4 py-2 shadow-[0_8px_24px_rgba(42,36,30,0.15)]">
          <div className="flex items-center gap-2 text-sm text-[#5A4F42]">
            <span className="h-3 w-3 animate-spin rounded-full border-2 border-[#D4A85A] border-t-transparent" />
            <span style={{ fontFamily: '"Fraunces", Georgia, serif' }}>Loading world…</span>
          </div>
        </div>
      </div>
    </div>
  );
}
