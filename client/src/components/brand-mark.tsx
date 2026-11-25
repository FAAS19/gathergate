import { cn } from "@/lib/utils";

export function BrandMark({
  collapsed = false,
  subtitle,
  className,
}: {
  collapsed?: boolean;
  subtitle?: string;
  className?: string;
}) {
  return (
    <div className={cn("flex items-center gap-2.5 select-none", className)}>
      <svg
        xmlns="http://www.w3.org/2000/svg"
        viewBox="0 0 28 28"
        fill="none"
        className="size-6 shrink-0"
        aria-hidden="true"
      >
        <rect className="fill-primary" x="1" y="1" width="26" height="26" rx="7" />
        <path
          d="M9.5 8.5H8a1 1 0 0 0-1 1v9a1 1 0 0 0 1 1h1.5M18.5 8.5H20a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1h-1.5"
          stroke="#FFFFFF"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
        <path
          d="M11 14.25 13.1 16.35 17.25 11.75"
          stroke="#FFFFFF"
          strokeWidth="2.1"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
      {!collapsed && (
        <div className="flex min-w-0 flex-col leading-none">
          <span className="truncate text-[15px] font-semibold tracking-[-0.02em] text-foreground">
            GatherGate
          </span>
          {subtitle && (
            <span className="mt-0.5 truncate text-[11px] font-medium text-muted-foreground">
              {subtitle}
            </span>
          )}
        </div>
      )}
    </div>
  );
}
