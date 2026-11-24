import { CheckCircle2, Clock, Eye, Lock, AlertTriangle, Trash2 } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

type AnyStatus = "pending" | "submitted" | "rejected" | "approved" | "open" | "in_review" | "completed" | "expired" | "purged";

const CONFIG: Record<
  AnyStatus,
  { label: string; className: string; icon: typeof Clock }
> = {
  pending: {
    label: "Pending",
    className: "border-slate-200 bg-slate-100 text-slate-700 dark:border-slate-700 dark:bg-slate-800/70 dark:text-slate-300",
    icon: Clock,
  },
  open: {
    label: "Open",
    className: "border-slate-200 bg-slate-100 text-slate-700 dark:border-slate-700 dark:bg-slate-800/70 dark:text-slate-300",
    icon: Clock,
  },
  submitted: {
    label: "Submitted",
    className: "border-blue-200 bg-blue-50 text-blue-700 dark:border-blue-800/60 dark:bg-blue-950/60 dark:text-blue-300",
    icon: Eye,
  },
  in_review: {
    label: "Awaiting review",
    className: "border-blue-200 bg-blue-50 text-blue-700 dark:border-blue-800/60 dark:bg-blue-950/60 dark:text-blue-300",
    icon: Eye,
  },
  rejected: {
    label: "Revision needed",
    className: "border-amber-300 bg-amber-50 text-amber-800 dark:border-amber-700/60 dark:bg-amber-950/60 dark:text-amber-300",
    icon: AlertTriangle,
  },
  approved: {
    label: "Locked",
    className: "border-emerald-200 bg-emerald-50 text-emerald-800 dark:border-emerald-800/60 dark:bg-emerald-950/60 dark:text-emerald-300",
    icon: Lock,
  },
  completed: {
    label: "Completed",
    className: "border-emerald-200 bg-emerald-50 text-emerald-800 dark:border-emerald-800/60 dark:bg-emerald-950/60 dark:text-emerald-300",
    icon: CheckCircle2,
  },
  expired: {
    label: "Expired",
    className: "border-red-200 bg-red-50 text-red-700 dark:border-red-900/60 dark:bg-red-950/60 dark:text-red-300",
    icon: AlertTriangle,
  },
  purged: {
    label: "Purged",
    className: "border-border bg-muted text-muted-foreground",
    icon: Trash2,
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
  const Icon = cfg.icon;
  return (
    <Badge
      variant="outline"
      className={cn("gap-1 rounded-md px-2 py-0.5 text-[11px] font-medium", cfg.className, className)}
    >
      <Icon className="size-3" />
      {cfg.label}
    </Badge>
  );
}
