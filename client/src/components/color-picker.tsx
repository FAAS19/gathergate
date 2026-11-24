import { Check } from "@phosphor-icons/react";
import { HexColorPicker } from "react-colorful";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import {
  BRAND_PRESETS,
  contrastRatio,
  hexToRgb,
  isHexColor,
  MIN_BRAND_CONTRAST,
  readableTextOn,
  rgbToHex,
} from "@/lib/brand";
import { cn } from "@/lib/utils";

export function ColorPicker({
  id,
  value,
  defaultColor,
  onChange,
  invalid,
}: {
  id: string;
  value: string;
  defaultColor: string;
  onChange: (nextHex: string) => void;
  invalid?: boolean;
}) {
  const validHex = isHexColor(value);
  const safeHex = (validHex ? value : defaultColor).toUpperCase();
  const rgb = hexToRgb(safeHex) ?? { r: 15, g: 82, b: 67 };
  const ratio = contrastRatio(safeHex, "#FFFFFF");
  const passesContrast = ratio >= MIN_BRAND_CONTRAST;

  function updateChannel(channel: "r" | "g" | "b", raw: string) {
    const parsed = Number.parseInt(raw === "" ? "0" : raw, 10);
    if (Number.isNaN(parsed)) return;
    const next = { ...rgb, [channel]: Math.max(0, Math.min(255, parsed)) };
    onChange(rgbToHex(next.r, next.g, next.b));
  }

  return (
    <div className="flex flex-wrap items-center gap-2">
      <Popover>
        <PopoverTrigger asChild>
          <button
            type="button"
            aria-label="Open colour palette"
            className="flex size-10 shrink-0 cursor-pointer items-center justify-center rounded-md border border-input bg-background p-1 shadow-xs transition-colors hover:border-ring focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <span
              className="block size-full rounded-[4px] border border-black/10 dark:border-white/15"
              style={{ backgroundColor: safeHex }}
            />
          </button>
        </PopoverTrigger>
        <PopoverContent align="start" className="w-72 space-y-3 p-3">
          <HexColorPicker
            color={safeHex}
            onChange={(next) => onChange(next.toUpperCase())}
          />

          <div className="grid grid-cols-[minmax(0,1.4fr)_1fr_1fr_1fr] gap-1.5">
            <div className="space-y-1">
              <Label htmlFor={`${id}-popover-hex`} className="text-[11px] text-muted-foreground">
                HEX
              </Label>
              <Input
                id={`${id}-popover-hex`}
                aria-label="HEX"
                value={value}
                onChange={(e) => onChange(e.target.value.trim().toUpperCase())}
                maxLength={7}
                className="h-8 px-2 font-mono text-xs uppercase"
              />
            </div>
            {(
              [
                ["r", "Red"],
                ["g", "Green"],
                ["b", "Blue"],
              ] as const
            ).map(([key, label]) => (
              <div key={key} className="space-y-1">
                <Label htmlFor={`${id}-rgb-${key}`} className="text-[11px] text-muted-foreground uppercase">
                  {key}
                </Label>
                <Input
                  id={`${id}-rgb-${key}`}
                  type="number"
                  min={0}
                  max={255}
                  aria-label={label}
                  value={rgb[key]}
                  onChange={(e) => updateChannel(key, e.target.value)}
                  className="h-8 px-1.5 font-mono text-xs tabular-nums"
                />
              </div>
            ))}
          </div>

          <div className="space-y-1.5">
            <div className="flex items-center justify-between text-[11px] text-muted-foreground">
              <span>Presets</span>
              <Badge
                variant="outline"
                className={cn(
                  "h-5 px-1.5 font-mono text-[10px] tabular-nums",
                  passesContrast
                    ? "border-emerald-200 bg-emerald-50 text-emerald-800 dark:border-emerald-800/60 dark:bg-emerald-950/50 dark:text-emerald-300"
                    : "border-destructive/40 bg-destructive/10 text-destructive"
                )}
              >
                {ratio.toFixed(1)}:1 {passesContrast ? "AA" : "Low contrast"}
              </Badge>
            </div>
            <div className="grid grid-cols-5 gap-1.5">
              {BRAND_PRESETS.map((preset) => {
                const selected = safeHex === preset.hex;
                return (
                  <button
                    key={preset.hex}
                    type="button"
                    title={`${preset.name} (${preset.hex})`}
                    aria-label={`${preset.name} ${preset.hex}`}
                    onClick={() => onChange(preset.hex)}
                    className={cn(
                      "flex h-7 cursor-pointer items-center justify-center rounded-md border transition-transform hover:scale-105 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                      selected ? "border-foreground ring-1 ring-foreground" : "border-black/10 dark:border-white/15"
                    )}
                    style={{ backgroundColor: preset.hex, color: readableTextOn(preset.hex) }}
                  >
                    {selected && <Check className="size-3.5" weight="bold" />}
                  </button>
                );
              })}
            </div>
          </div>
        </PopoverContent>
      </Popover>

      <Input
        id={id}
        value={value}
        onChange={(e) => onChange(e.target.value.trim().toUpperCase())}
        className="h-10 w-28 font-mono uppercase"
        maxLength={7}
        aria-invalid={invalid || undefined}
      />

      <span className="rounded-md border border-border bg-muted/50 px-2.5 py-2 font-mono text-xs text-muted-foreground tabular-nums">
        rgb({rgb.r}, {rgb.g}, {rgb.b})
      </span>

      {safeHex !== defaultColor && (
        <Button type="button" variant="ghost" size="sm" onClick={() => onChange(defaultColor)}>
          Reset
        </Button>
      )}
    </div>
  );
}
