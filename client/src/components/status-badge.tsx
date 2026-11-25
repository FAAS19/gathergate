import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

type AnyStatus =
  | "pending"
  | "submitted"
  | "rejected"
  | "approved"
  | "open"
  | "in_review"
  | "completed"
  | "expired"
  | "purged";

const CONFIG: Record<AnyStatus, { label: string; badge: string; dot: string }> = {
  pending: {
    label: "Pending",
    badge: "border-border bg-muted/60 text-foreground/80",
    dot: "bg-slate-400 dark:bg-slate-400",
  },
  open: {
    label: "Open",
    badge: "border-border bg-muted/60 text-foreground/80",
    dot: "bg-slate-400 dark:bg-slate-400",
  },
  submitted: {
    label: "Submitted",
    badge:
      "border-blue-200/80 bg-blue-50/80 text-blue-800 dark:border-blue-800/60 dark:bg-blue-950/60 dark:text-blue-200",
    dot: "bg-blue-600 dark:bg-blue-400",
  },
  in_review: {
    label: "Awaiting review",
    badge:
      "border-blue-200/80 bg-blue-50/80 text-blue-800 dark:border-blue-800/60 dark:bg-blue-950/60 dark:text-blue-200",
    dot: "bg-blue-600 dark:bg-blue-400",
  },
  rejected: {
    label: "Revision needed",
    badge:
      "border-amber-200/90 bg-amber-50/90 text-amber-900 dark:border-amber-800/60 dark:bg-amber-950/60 dark:text-amber-200",
    dot: "bg-amber-600 dark:bg-amber-400",
  },
  approved: {
    label: "Locked",
    badge:
      "border-emerald-200/80 bg-emerald-50/80 text-emerald-900 dark:border-emerald-800/60 dark:bg-emerald-950/60 dark:text-emerald-200",
    dot: "bg-emerald-600 dark:bg-emerald-400",
  },
  completed: {
    label: "Completed",
    badge:
      "border-emerald-200/80 bg-emerald-50/80 text-emerald-900 dark:border-emerald-800/60 dark:bg-emerald-950/60 dark:text-emerald-200",
    dot: "bg-emerald-600 dark:bg-emerald-400",
  },
  expired: {
    label: "Expired",
    badge:
      "border-red-200/80 bg-red-50/80 text-red-800 dark:border-red-900/60 dark:bg-red-950/60 dark:text-red-200",
    dot: "bg-red-600 dark:bg-red-400",
  },
  purged: {
    label: "Purged",
    badge: "border-border bg-muted text-muted-foreground",
    dot: "bg-muted-foreground/60",
  },
};

export function StatusBadge({
  status,
  className,
}: {
  status: AnyStatus;
  className?: string;
}) {
  const cfg = CONFIG[status] ?? CONFIG.pending;
  return (
    <Badge
      variant="outline"
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-xs font-medium",
        cfg.badge,
        className
      )}
    >
      <span aria-hidden="true" className={cn("size-1.5 shrink-0 rounded-full", cfg.dot)} />
      {cfg.label}
    </Badge>
  );
}
