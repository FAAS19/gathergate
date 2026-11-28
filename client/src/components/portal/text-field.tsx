import { useEffect, useId, useRef, useState } from "react";
import { Check, CircleNotch, Lock } from "@phosphor-icons/react";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { apiJson, ApiError, VALIDATOR_OPTIONS, type RequestItemDto } from "@/lib/api";
import { cn } from "@/lib/utils";

// Numeric identifiers get a number pad on phones.
const NUMERIC_VALIDATORS = new Set([
  "au_abn_mod89",
  "au_bsb",
  "au_tfn_mod11",
  "au_medicare_mod10",
  "uk_utr_mod11",
  "uk_sort_code",
  "us_ein",
  "us_routing_aba",
  "us_ssn",
]);
const TEL_VALIDATORS = new Set(["au_phone_e164", "phone_e164"]);

export function TextField({
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
  const saved = item.isSensitiveMasked ? "" : item.currentValue || "";
  const [value, setValue] = useState(saved);
  const [state, setState] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const [error, setError] = useState<string | null>(null);
  const lastSaved = useRef(saved);
  const savingRef = useRef(false);
  const hintId = useId();
  const hint = item.validator_hint ?? VALIDATOR_OPTIONS.find((v) => v.value === item.validator)?.hint;

  useEffect(() => {
    setValue(saved);
    lastSaved.current = saved;
  }, [saved]);

  async function save() {
    const trimmed = value.trim();
    if (savingRef.current || !trimmed || trimmed === lastSaved.current.trim()) return;
    savingRef.current = true;
    setState("saving");
    setError(null);
    try {
      const res = await apiJson<{ item?: { isSensitiveMasked?: boolean } }>(`/api/client/${token}/items/${item.id}`, {
        method: "POST",
        body: JSON.stringify({ value: trimmed }),
      });
      // Never leave a sensitive identifier sitting in the field once it is stored masked.
      if (res.item?.isSensitiveMasked) {
        setValue("");
        lastSaved.current = "";
      } else {
        lastSaved.current = trimmed;
      }
      setState("saved");
      await onChanged();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not save. Try again.");
      setState("error");
    } finally {
      savingRef.current = false;
    }
  }

  if (locked) {
    return item.currentValue ? (
      <p className="flex items-center gap-2 font-mono text-sm tabular-nums text-muted-foreground">
        <Lock className="size-3.5" /> {item.currentValue}
      </p>
    ) : null;
  }

  const common = {
    value,
    "aria-labelledby": `label-${item.id}`,
    "aria-describedby": hintId,
    "aria-invalid": state === "error" || undefined,
    onChange: (e: { target: { value: string } }) => {
      setValue(e.target.value);
      if (state !== "saving") setState("idle");
    },
    onBlur: save,
    className: cn("bg-card", state === "error" && "border-destructive focus-visible:ring-destructive/20"),
  };

  return (
    <div className="space-y-2">
      {item.isSensitiveMasked && item.currentValue && (
        <p className="flex items-center gap-2 text-sm text-muted-foreground">
          <Lock className="size-3.5 text-primary" />
          Saved as <span className="font-mono tabular-nums text-foreground">{item.currentValue}</span>
        </p>
      )}
      {item.kind === "textarea" ? (
        <Textarea rows={3} placeholder={hint || "Type your answer"} {...common} />
      ) : (
        <Input
          {...common}
          className={cn("h-10", common.className)}
          placeholder={item.isSensitiveMasked && item.currentValue ? "Enter a new value to replace it" : hint || "Type your answer"}
          inputMode={NUMERIC_VALIDATORS.has(item.validator) ? "numeric" : TEL_VALIDATORS.has(item.validator) ? "tel" : undefined}
          autoComplete="off"
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              void save();
            }
          }}
        />
      )}
      <p id={hintId} className="flex min-h-5 items-center gap-1.5 text-xs" aria-live="polite">
        {state === "saving" ? (
          <span className="flex items-center gap-1.5 text-muted-foreground">
            <CircleNotch className="size-3.5 animate-spin" /> Checking
          </span>
        ) : state === "error" ? (
          <span className="font-medium text-destructive">{error}</span>
        ) : state === "saved" ? (
          <span className="flex items-center gap-1.5 font-medium text-primary animate-in fade-in duration-200">
            <Check className="size-3.5" /> Verified and saved
          </span>
        ) : item.status === "submitted" ? (
          <span className="flex items-center gap-1.5 text-muted-foreground">
            <Check className="size-3.5 text-primary" /> Saved
          </span>
        ) : (
          <span className="text-muted-foreground">Saves automatically when you finish typing</span>
        )}
      </p>
    </div>
  );
}
