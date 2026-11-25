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
        viewBox="0 0 32 32"
        fill="none"
        className="size-6 shrink-0"
        aria-hidden="true"
      >
        <path
          className="fill-foreground"
          d="M4 6H12V10H8V22H12V26H4V6ZM28 6H20V10H24V22H20V26H28V6Z"
        />
        <rect className="fill-primary" x="14" y="10" width="4" height="12" rx="1" />
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
