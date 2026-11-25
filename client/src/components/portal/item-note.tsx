import { useState } from "react";
import { ArrowCounterClockwise, ChatText, CircleNotch } from "@phosphor-icons/react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { apiJson, ApiError, type RequestItemDto } from "@/lib/api";

type Editing = null | "note" | "na";

/** Lets clients explain a delay or mark an item as not applicable instead of abandoning the checklist. */
export function ItemNote({
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
  const [editing, setEditing] = useState<Editing>(null);
  const [draft, setDraft] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save(note: string, notApplicable: boolean) {
    setSaving(true);
    setError(null);
    try {
      await apiJson(`/api/client/${token}/items/${item.id}/note`, {
        method: "PUT",
        body: JSON.stringify({ note, notApplicable }),
      });
      setEditing(null);
      await onChanged();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not save. Try again.");
    } finally {
      setSaving(false);
    }
  }

  function start(mode: Exclude<Editing, null>) {
    setDraft(mode === "note" ? item.client_note ?? "" : "");
    setError(null);
    setEditing(mode);
  }

  if (editing) {
    const isNa = editing === "na";
    const fieldId = `note-${item.id}`;
    return (
      <div className="space-y-2 rounded-lg bg-muted/60 p-3 animate-in fade-in slide-in-from-top-1 duration-200 motion-reduce:animate-none">
        <label htmlFor={fieldId} className="text-sm font-medium">
          {isNa ? "Why doesn't this apply to you?" : `Note for ${item.label}`}
        </label>
        <Textarea
          id={fieldId}
          autoFocus
          rows={2}
          maxLength={1000}
          value={draft}
          placeholder={isNa ? "For example: I didn't have private health cover this year" : "For example: Waiting on my bank, will upload Friday"}
          onChange={(e) => setDraft(e.target.value)}
          className="bg-background"
        />
        {error && (
          <p className="text-sm font-medium text-destructive" role="alert">
            {error}
          </p>
        )}
        <div className="flex justify-end gap-2">
          <Button type="button" variant="ghost" size="sm" onClick={() => setEditing(null)} disabled={saving}>
            Cancel
          </Button>
          <Button type="button" size="sm" onClick={() => save(draft.trim(), isNa)} disabled={saving || (isNa && !draft.trim())}>
            {saving && <CircleNotch className="size-3.5 animate-spin" />}
            {isNa ? "Mark as not applicable" : "Save note"}
          </Button>
        </div>
      </div>
    );
  }

  if (item.client_na) {
    return (
      <div className="flex items-start justify-between gap-3 rounded-lg bg-muted/60 px-3 py-2.5 text-sm">
        <p>
          <span className="font-medium">Marked as not applicable.</span>{" "}
          <span className="text-muted-foreground">{item.client_note}</span>
        </p>
        {!locked && (
          <Button type="button" variant="ghost" size="sm" className="-my-1 shrink-0" onClick={() => save("", false)} disabled={saving}>
            {saving ? <CircleNotch className="size-3.5 animate-spin" /> : <ArrowCounterClockwise className="size-3.5" />} Undo
          </Button>
        )}
      </div>
    );
  }

  return (
    <div className="space-y-2">
      {item.client_note && (
        <p className="flex items-start gap-2 text-sm text-muted-foreground">
          <ChatText className="mt-0.5 size-3.5 shrink-0" />
          <span className="whitespace-pre-line">{item.client_note}</span>
        </p>
      )}
      {!locked && (
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs">
          <button
            type="button"
            onClick={() => start("note")}
            className="inline-flex cursor-pointer items-center gap-1.5 text-muted-foreground underline-offset-4 transition-colors hover:text-foreground hover:underline"
          >
            <ChatText className="size-3.5" aria-hidden="true" />
            {item.client_note ? "Edit note" : "Add a note"}
          </button>
          {item.status !== "submitted" && (
            <button
              type="button"
              onClick={() => start("na")}
              className="cursor-pointer text-muted-foreground underline-offset-4 transition-colors hover:text-foreground hover:underline"
            >
              This doesn't apply to me
            </button>
          )}
        </div>
      )}
    </div>
  );
}
