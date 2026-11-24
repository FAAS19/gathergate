import { Check, FileText, UploadCloud } from "lucide-react";
import { brandStyle } from "@/lib/brand";
import { cn } from "@/lib/utils";

/** Decorative miniature of the client portal, used where operators need to picture what clients see. */
export function PortalPreview({
  name,
  brandColor,
  logoDataUrl,
  className,
}: {
  name: string;
  brandColor?: string | null;
  logoDataUrl?: string | null;
  className?: string;
}) {
  const displayName = name.trim() || "Your practice";
  return (
    <div
      aria-hidden="true"
      style={brandStyle(brandColor)}
      className={cn(
        "light w-full max-w-[380px] select-none overflow-hidden rounded-xl border border-border bg-background text-foreground shadow-[0_1px_2px_rgba(17,24,28,0.04),0_12px_32px_-12px_rgba(17,24,28,0.18)]",
        className
      )}
    >
      <div className="flex items-center gap-2.5 border-b border-border bg-card px-4 py-3">
        {logoDataUrl ? (
          <img src={logoDataUrl} alt="" className="h-6 max-w-[120px] object-contain" />
        ) : (
          <span className="flex size-6 items-center justify-center rounded-md bg-primary text-[11px] font-semibold text-primary-foreground transition-colors duration-200">
            {displayName.charAt(0).toUpperCase()}
          </span>
        )}
        <span className="truncate text-[13px] font-semibold tracking-tight">{displayName}</span>
      </div>

      <div className="space-y-3 p-4">
        <div>
          <p className="font-display text-[15px] font-semibold tracking-tight">FY26 tax return</p>
          <div className="mt-2 flex items-center gap-2">
            <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-muted">
              <div className="h-full w-2/5 rounded-full bg-primary transition-colors duration-200" />
            </div>
            <span className="text-[11px] tabular-nums text-muted-foreground">2 of 5</span>
          </div>
        </div>

        <div className="flex items-center gap-3 rounded-lg border border-border bg-card px-3 py-2.5">
          <span className="flex size-5 items-center justify-center rounded-full bg-primary text-primary-foreground">
            <Check className="size-3" strokeWidth={3} />
          </span>
          <div className="min-w-0 flex-1">
            <p className="text-[12px] font-medium">Driver licence</p>
            <p className="flex items-center gap-1 text-[11px] text-muted-foreground">
              <FileText className="size-3" /> licence-front.jpg
            </p>
          </div>
        </div>

        <div className="flex items-center gap-3 rounded-lg border border-border bg-card px-3 py-2.5">
          <span className="flex size-5 items-center justify-center rounded-full bg-primary text-primary-foreground">
            <Check className="size-3" strokeWidth={3} />
          </span>
          <div className="min-w-0 flex-1">
            <p className="text-[12px] font-medium">ABN</p>
            <p className="font-mono text-[11px] tabular-nums text-muted-foreground">51 824 753 556</p>
          </div>
        </div>

        <div className="rounded-lg border border-border bg-card px-3 py-2.5">
          <p className="text-[12px] font-medium">Bank statements</p>
          <div className="mt-2 flex items-center justify-center gap-1.5 rounded-md border border-dashed border-input bg-accent/50 py-3 text-[11px] text-muted-foreground">
            <UploadCloud className="size-3.5 text-primary" />
            Drop files or take a photo
          </div>
        </div>
      </div>
    </div>
  );
}
