import { cn } from "../lib/utils";

export function LogoMark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 64 64" aria-hidden="true" className={cn("size-5 shrink-0", className)}>
      <path d="M15 6h21.6L55 24.4V52a6 6 0 0 1-6 6H15a6 6 0 0 1-6-6V12a6 6 0 0 1 6-6Z" className="fill-[#1F5F4E] dark:fill-[#8CC2AE]" />
      <path
        d="M36.6 6 55 24.4V31c0-1.7-1.3-3-3-3H31v5.5L19 23l12-10.5V18h3.6c1.1 0 2-.9 2-2Z"
        className="fill-[#9CC5B4] dark:fill-[#E7F1EC]"
      />
    </svg>
  );
}

export function Wordmark({ className }: { className?: string }) {
  return (
    <span className={cn("flex items-center gap-2 font-semibold tracking-[-0.01em]", className)}>
      <LogoMark />
      replyfold
    </span>
  );
}
