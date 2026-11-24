import { useCallback, useEffect, useRef, useState } from "react";
import { useDropzone } from "react-dropzone";
import { ArrowsClockwise, Camera, CircleNotch, CloudArrowUp, FileText, Trash } from "@phosphor-icons/react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { apiJson, apiUploadWithProgress, ApiError, formatBytes, type RequestItemDto } from "@/lib/api";
import { cn } from "@/lib/utils";

const GROUP_ACCEPT: Record<string, Record<string, string[]>> = {
  pdf: { "application/pdf": [".pdf"] },
  image: { "image/png": [".png"], "image/jpeg": [".jpg", ".jpeg"], "image/webp": [".webp"] },
  spreadsheet: {
    "text/csv": [".csv"],
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": [".xlsx"],
  },
  document: {
    "application/pdf": [".pdf"],
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document": [".docx"],
    "text/plain": [".txt"],
  },
};

function acceptFor(groups?: string[]) {
  if (!groups?.length) return undefined;
  return Object.assign({}, ...groups.map((g) => GROUP_ACCEPT[g] ?? {})) as Record<string, string[]>;
}

function typeLabel(groups?: string[]) {
  if (!groups?.length) return "PDF, images, Word, Excel or CSV";
  const names: Record<string, string> = { pdf: "PDF", image: "JPG, PNG", spreadsheet: "Excel, CSV", document: "Word, TXT" };
  return groups.map((g) => names[g] ?? g.toUpperCase()).join(", ");
}

function useCoarsePointer() {
  const [coarse] = useState(() => typeof window !== "undefined" && window.matchMedia?.("(pointer: coarse)").matches);
  return Boolean(coarse);
}

export function FileField({
  item,
  token,
  locked,
  onChanged,
}: {
  item: RequestItemDto;
  token: string;
  locked: boolean;
  onChanged: () => Promise<void>;
}) {
  const [progress, setProgress] = useState<{ pct: number; label: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [removingId, setRemovingId] = useState<string | null>(null);
  // Thumbnails for images picked in this session; server copies stay encrypted and are never sent back.
  const [thumbs, setThumbs] = useState<Record<string, string>>({});
  const replaceTarget = useRef<string | null>(null);
  const cameraInput = useRef<HTMLInputElement>(null);
  const coarse = useCoarsePointer();
  const allowsImages = !item.config.allowedGroups?.length || item.config.allowedGroups.includes("image");
  const maxMb = item.config.maxFileMb ?? 20;
  const busy = progress !== null;

  const thumbsRef = useRef(thumbs);
  thumbsRef.current = thumbs;
  useEffect(() => () => Object.values(thumbsRef.current).forEach((url) => URL.revokeObjectURL(url)), []);

  const upload = useCallback(
    async (files: File[]) => {
      if (!files.length || locked) return;
      setError(null);
      const tooBig = files.find((f) => f.size > maxMb * 1024 * 1024);
      if (tooBig) {
        setError(`"${tooBig.name}" is larger than ${maxMb} MB.`);
        return;
      }
      const label = files.length === 1 ? files[0].name : `${files.length} files`;
      setProgress({ pct: 0, label });
      try {
        const fd = new FormData();
        files.forEach((f) => fd.append("file", f));
        const res = await apiUploadWithProgress<{ uploads: Array<{ id: string }> }>(
          `/api/client/${token}/items/${item.id}`,
          fd,
          (loaded, total) => setProgress({ pct: Math.round((loaded / total) * 100), label })
        );
        const next: Record<string, string> = {};
        res.uploads.forEach((u, i) => {
          if (files[i]?.type.startsWith("image/")) next[u.id] = URL.createObjectURL(files[i]);
        });
        setThumbs((t) => ({ ...t, ...next }));
        // Replace = upload first, then remove the old file, so the item never drops back to pending.
        if (replaceTarget.current) {
          await apiJson(`/api/client/${token}/uploads/${replaceTarget.current}`, { method: "DELETE" }).catch(() => {});
          replaceTarget.current = null;
        }
        await onChanged();
      } catch (err) {
        setError(err instanceof ApiError ? err.message : "Upload failed. Try again.");
      } finally {
        setProgress(null);
        replaceTarget.current = null;
      }
    },
    [item.id, locked, maxMb, onChanged, token]
  );

  const { getRootProps, getInputProps, isDragActive, open } = useDropzone({
    onDrop: (accepted, rejected) => {
      if (rejected.length && !accepted.length) {
        setError(`That file type is not accepted here. Use ${typeLabel(item.config.allowedGroups)}.`);
        return;
      }
      void upload(accepted);
    },
    disabled: locked || busy,
    multiple: Boolean(item.config.multiple),
    accept: acceptFor(item.config.allowedGroups),
  });

  async function remove(uploadId: string, name: string) {
    setRemovingId(uploadId);
    setError(null);
    try {
      await apiJson(`/api/client/${token}/uploads/${uploadId}`, { method: "DELETE" });
      toast.success(`Removed ${name}`);
      await onChanged();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not remove the file.");
    } finally {
      setRemovingId(null);
    }
  }

  function replace(uploadId: string) {
    replaceTarget.current = uploadId;
    open();
  }

  const showDropzone = !locked && (item.config.multiple || item.uploads.length === 0);

  return (
    <div className="space-y-3">
      {item.uploads.length > 0 && (
        <ul className="space-y-2" aria-label="Uploaded files">
          {item.uploads.map((u) => (
            <li
              key={u.id}
              className="flex items-center gap-3 rounded-lg border border-border bg-background px-3 py-2 animate-in fade-in duration-300 motion-reduce:animate-none"
            >
              {thumbs[u.id] ? (
                <img src={thumbs[u.id]} alt="" className="size-9 shrink-0 rounded object-cover" />
              ) : (
                <span className="flex size-9 shrink-0 items-center justify-center rounded bg-accent text-accent-foreground">
                  <FileText className="size-4" />
                </span>
              )}
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium">{u.original_name}</p>
                <p className="text-xs tabular-nums text-muted-foreground">{formatBytes(u.size_bytes)}</p>
              </div>
              {!locked && (
                <div className="flex shrink-0 items-center gap-1">
                    {!item.config.multiple && (
                    <Button type="button" variant="ghost" size="sm" onClick={() => replace(u.id)} disabled={busy}>
                      <ArrowsClockwise className="size-3.5" /> Replace
                    </Button>
                  )}
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    className="size-8 text-muted-foreground hover:text-destructive"
                    aria-label={`Remove ${u.original_name}`}
                    onClick={() => remove(u.id, u.original_name)}
                    disabled={busy || removingId === u.id}
                  >
                    {removingId === u.id ? <CircleNotch className="size-4 animate-spin" /> : <Trash className="size-4" />}
                  </Button>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}

      {progress && (
        <div className="rounded-lg border border-border bg-background px-3 py-2.5" role="status" aria-live="polite">
          <div className="flex items-center justify-between gap-3 text-sm">
            <span className="truncate font-medium">{progress.label}</span>
            <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
              {progress.pct < 100 ? `${progress.pct}%` : "Encrypting"}
            </span>
          </div>
          <div
            className="mt-2 h-1.5 overflow-hidden rounded-full bg-muted"
            role="progressbar"
            aria-label={`Uploading ${progress.label}`}
            aria-valuenow={progress.pct}
            aria-valuemin={0}
            aria-valuemax={100}
          >
            <div
              className="h-full rounded-full bg-primary transition-[width] duration-200 ease-out"
              style={{ width: `${progress.pct}%` }}
            />
          </div>
        </div>
      )}

      {/* Kept mounted (hidden) so Replace can open the picker even when the dropzone is not shown. */}
      <div
        {...getRootProps({
          className: cn(
            "group flex flex-col items-center justify-center rounded-lg border border-dashed px-4 py-7 text-center outline-none transition-colors duration-200",
            "focus-visible:border-primary focus-visible:ring-[3px] focus-visible:ring-ring/30",
            isDragActive ? "border-primary bg-accent" : "border-input bg-background hover:border-primary/60 hover:bg-accent/60",
            busy ? "pointer-events-none opacity-60" : "cursor-pointer",
            !showDropzone && "hidden"
          ),
          "aria-label": `Upload ${item.label}`,
        })}
      >
        <input {...getInputProps({ "aria-label": `Choose files for ${item.label}` })} data-testid={`file-input-${item.id}`} />
        <CloudArrowUp
          className={cn("size-6 text-primary transition-transform duration-200", isDragActive && "-translate-y-0.5")}
        />
        <p className="mt-2 text-sm font-medium">
          {isDragActive ? "Drop to upload" : coarse ? "Tap to choose a file" : "Drop files here or click to browse"}
        </p>
        <p className="mt-1 text-xs text-muted-foreground">
          {typeLabel(item.config.allowedGroups)} up to {maxMb} MB
        </p>
      </div>

      {showDropzone && coarse && allowsImages && (
        <>
          <Button type="button" variant="outline" className="w-full" onClick={() => cameraInput.current?.click()} disabled={busy}>
            <Camera className="size-4" /> Take a photo
          </Button>
          <input
            ref={cameraInput}
            type="file"
            accept="image/*"
            capture="environment"
            className="sr-only"
            tabIndex={-1}
            aria-hidden="true"
            onChange={(e) => {
              void upload(Array.from(e.target.files ?? []));
              e.target.value = "";
            }}
          />
        </>
      )}

      {error && (
        <p className="text-sm font-medium text-destructive" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
