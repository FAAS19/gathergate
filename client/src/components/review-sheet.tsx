import { useEffect, useState } from "react";
import {
  CaretLeft as ChevronLeft,
  CaretRight as ChevronRight,
  Check,
  DownloadSimple as Download,
  Lock,
  MagnifyingGlassMinus as ZoomOut,
  MagnifyingGlassPlus as ZoomIn,
  XCircle,
} from "@phosphor-icons/react";
import { toast } from "sonner";
import { StatusBadge } from "@/components/status-badge";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import {
  apiFetchBlob,
  formatBytes,
  IS_DEMO,
  triggerDemoDownload,
  type RequestDetailResponse,
  type RequestItemDto,
  type UploadDto,
} from "@/lib/api";
import { cn } from "@/lib/utils";

export interface ReviewDoc {
  item: RequestItemDto;
  upload: UploadDto;
}

const ZOOM_LEVELS = [0.75, 1, 1.25, 1.5, 2] as const;

export function findNextReviewUploadId(docs: ReviewDoc[], currentIndex: number): string | null {
  if (currentIndex < 0 || currentIndex >= docs.length) return null;
  const currentItemId = docs[currentIndex].item.id;

  for (let offset = 1; offset < docs.length; offset += 1) {
    const candidate = docs[(currentIndex + offset) % docs.length];
    if (candidate.item.id !== currentItemId && candidate.item.status === "submitted") {
      return candidate.upload.id;
    }
  }
  return docs[currentIndex + 1]?.upload.id ?? null;
}

export function ReviewSheet({
  docs,
  activeUploadId,
  requestStatus,
  overlayOpen = false,
  onSelectUpload,
  onApproveAndNext,
  onRequestRevision,
}: {
  docs: ReviewDoc[];
  activeUploadId: string | null;
  requestStatus: RequestDetailResponse["request"]["status"];
  overlayOpen?: boolean;
  onSelectUpload: (uploadId: string | null) => void;
  onApproveAndNext: (item: RequestItemDto, nextUploadId: string | null) => void;
  onRequestRevision: (item: RequestItemDto) => void;
}) {
  const currentIndex = activeUploadId ? docs.findIndex((d) => d.upload.id === activeUploadId) : -1;
  const current = currentIndex >= 0 ? docs[currentIndex] : null;

  const [zoomIdx, setZoomIdx] = useState(1);
  const [preview, setPreview] = useState<{
    uploadId: string;
    url: string | null;
    text: string | null;
  } | null>(null);

  const zoom = ZOOM_LEVELS[zoomIdx];
  const zoomPct = Math.round(zoom * 100);

  useEffect(() => {
    setZoomIdx(1);
  }, [activeUploadId]);

  useEffect(() => {
    if (!current) {
      setPreview(null);
      return;
    }

    const uploadId = current.upload.id;
    const mime = current.upload.detected_mime;
    let cancelled = false;
    let objectUrl: string | null = null;
    setPreview(null);

    apiFetchBlob(`/api/uploads/${uploadId}/preview`)
      .then(async (blob) => {
        if (cancelled) return;
        if (mime.startsWith("text/")) {
          setPreview({ uploadId, url: null, text: await blob.text() });
        } else {
          objectUrl = URL.createObjectURL(blob);
          setPreview({ uploadId, url: objectUrl, text: null });
        }
      })
      .catch(() => {
        if (!cancelled) {
          setPreview({ uploadId, url: null, text: null });
          toast.error("Could not decrypt preview.");
        }
      });

    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [current?.upload.id, current?.upload.detected_mime]);

  const previewLoading = Boolean(current && preview?.uploadId !== current.upload.id);
  const previewUrl = !previewLoading ? (preview?.url ?? null) : null;
  const previewText = !previewLoading ? (preview?.text ?? null) : null;

  const nextUploadId = current ? findNextReviewUploadId(docs, currentIndex) : null;
  const canStepPrev = currentIndex > 0;
  const canStepNext = currentIndex >= 0 && currentIndex < docs.length - 1;

  return (
    <Sheet open={Boolean(current)} onOpenChange={(open) => !open && onSelectUpload(null)}>
      <SheetContent side="right" className="flex w-full flex-col gap-0 p-0 sm:max-w-3xl">
        {current && (
          <>
            <SheetHeader className="space-y-2.5 border-b border-border bg-card px-5 py-3.5 pr-12">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex flex-wrap items-center gap-2">
                  <div className="flex items-center gap-1">
                    <Button
                      type="button"
                      size="icon-sm"
                      variant="outline"
                      aria-label="Previous document"
                      disabled={!canStepPrev}
                      onClick={() => canStepPrev && onSelectUpload(docs[currentIndex - 1].upload.id)}
                    >
                      <ChevronLeft className="size-4" />
                    </Button>
                    <span className="min-w-[4rem] text-center font-mono text-xs text-muted-foreground tabular-nums">
                      {currentIndex + 1} of {docs.length}
                    </span>
                    <Button
                      type="button"
                      size="icon-sm"
                      variant="outline"
                      aria-label="Next document"
                      disabled={!canStepNext}
                      onClick={() => canStepNext && onSelectUpload(docs[currentIndex + 1].upload.id)}
                    >
                      <ChevronRight className="size-4" />
                    </Button>
                  </div>

                  <div className="h-4 w-px bg-border" aria-hidden="true" />

                  <div className="flex items-center gap-0.5 rounded-md border border-border bg-muted/40 p-0.5">
                    <Button
                      type="button"
                      size="icon-xs"
                      variant="ghost"
                      aria-label="Zoom out"
                      disabled={zoomIdx <= 0}
                      onClick={() => setZoomIdx((i) => Math.max(0, i - 1))}
                    >
                      <ZoomOut className="size-3.5" />
                    </Button>
                    <Button
                      type="button"
                      size="xs"
                      variant="ghost"
                      aria-label="Reset zoom"
                      onClick={() => setZoomIdx(1)}
                      className="h-6 min-w-[3.25rem] px-1.5 font-mono text-[11px] tabular-nums"
                    >
                      {zoomPct}%
                    </Button>
                    <Button
                      type="button"
                      size="icon-xs"
                      variant="ghost"
                      aria-label="Zoom in"
                      disabled={zoomIdx >= ZOOM_LEVELS.length - 1}
                      onClick={() => setZoomIdx((i) => Math.min(ZOOM_LEVELS.length - 1, i + 1))}
                    >
                      <ZoomIn className="size-3.5" />
                    </Button>
                  </div>
                </div>

                <StatusBadge status={current.item.status} />
              </div>

              <div className="min-w-0">
                <SheetTitle className="truncate font-mono text-sm font-medium text-foreground">
                  {current.upload.canonical_name}
                </SheetTitle>
                <SheetDescription className="truncate text-xs text-muted-foreground">
                  {current.item.label} · {current.upload.original_name} ({formatBytes(current.upload.size_bytes)})
                </SheetDescription>
              </div>
            </SheetHeader>

            {(current.item.client_na || current.item.client_note) && (
              <div className="border-b border-border bg-muted/40 px-5 py-2 text-xs">
                <span className="font-medium text-foreground">
                  {current.item.client_na ? "Client marked as not applicable:" : "Client note:"}
                </span>{" "}
                <span className="text-muted-foreground">{current.item.client_note}</span>
              </div>
            )}

            <div className="min-h-0 flex-1 overflow-auto bg-muted/50 p-4 sm:p-5">
              {previewLoading ? (
                <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
                  Decrypting file stream...
                </div>
              ) : previewText !== null ? (
                <div className="min-h-full overflow-auto rounded-lg border border-border bg-card shadow-xs">
                  <pre
                    style={{ fontSize: `${Math.round(12 * zoom)}px` }}
                    className="p-5 font-mono leading-relaxed text-foreground"
                  >
                    {previewText}
                  </pre>
                </div>
              ) : previewUrl && current.upload.detected_mime === "application/pdf" ? (
                <div className="relative isolate h-full overflow-hidden rounded-lg border border-border bg-card shadow-xs">
                  <iframe
                    key={`${current.upload.id}-${zoomPct}`}
                    src={`${previewUrl}#zoom=${zoomPct}`}
                    title={current.upload.canonical_name}
                    className={cn("h-full w-full bg-white", overlayOpen && "invisible")}
                  />
                </div>
              ) : previewUrl && current.upload.detected_mime.startsWith("image/") ? (
                <div className="flex min-h-full items-start justify-center rounded-lg border border-border bg-card p-5 shadow-xs">
                  <img
                    src={previewUrl}
                    alt={current.upload.canonical_name}
                    data-zoom={zoomPct}
                    style={{ transform: `scale(${zoom})`, transformOrigin: "center top" }}
                    className="max-h-full max-w-full rounded object-contain transition-transform duration-150"
                  />
                </div>
              ) : (
                <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
                  Could not decrypt preview.
                </div>
              )}
            </div>

            <SheetFooter className="mt-0 shrink-0 flex-row flex-wrap items-center justify-between gap-2 border-t border-border bg-card px-4 py-3 sm:gap-3 sm:px-5">
              <div className="flex items-center gap-3">
                {IS_DEMO ? (
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => void triggerDemoDownload("upload", current.upload.id)}
                  >
                    <Download className="mr-1.5 size-3.5" />
                    Download
                  </Button>
                ) : (
                  <Button asChild variant="outline" size="sm">
                    <a href={`/api/uploads/${current.upload.id}/download`}>
                      <Download className="mr-1.5 size-3.5" />
                      Download
                    </a>
                  </Button>
                )}
                <span className="hidden font-mono text-[11px] text-muted-foreground md:inline">
                  J/K · A · R
                </span>
              </div>
              {requestStatus !== "purged" && requestStatus !== "expired" && (
                <div className="flex items-center gap-2">
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => onRequestRevision(current.item)}
                  >
                    <XCircle className="mr-1.5 size-3.5" />
                    Request revision
                  </Button>
                  {current.item.status === "approved" ? (
                    <Badge variant="outline" className="gap-1 px-2.5 py-1 text-xs">
                      <Lock className="size-3" />
                      Approved & locked
                    </Badge>
                  ) : (
                    <Button
                      type="button"
                      size="sm"
                      onClick={() => onApproveAndNext(current.item, nextUploadId)}
                    >
                      <Check className="mr-1.5 size-3.5" />
                      {nextUploadId ? "Approve & next" : "Approve & lock"}
                    </Button>
                  )}
                </div>
              )}
            </SheetFooter>
          </>
        )}
      </SheetContent>
    </Sheet>
  );
}
