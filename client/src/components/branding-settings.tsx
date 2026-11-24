import { useEffect, useRef, useState, type FormEvent } from "react";
import { CircleNotch, ImageSquare, X } from "@phosphor-icons/react";
import { toast } from "sonner";
import { ColorPicker } from "@/components/color-picker";
import { PortalPreview } from "@/components/portal-preview";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { apiJson, ApiError, type BrandingDto } from "@/lib/api";
import { contrastRatio, isHexColor, MIN_BRAND_CONTRAST } from "@/lib/brand";

const DEFAULT_COLOR = "#0F5243";
const MAX_LOGO_BYTES = 200 * 1024;

export function BrandingSettings({ branding, onSaved }: { branding: BrandingDto; onSaved: () => Promise<void> }) {
  const [color, setColor] = useState(branding.brandColor ?? DEFAULT_COLOR);
  const [logo, setLogo] = useState<string | null>(branding.logoDataUrl);
  const [supportEmail, setSupportEmail] = useState(branding.supportEmail ?? "");
  const [supportPhone, setSupportPhone] = useState(branding.supportPhone ?? "");
  const [saving, setSaving] = useState(false);
  const [logoError, setLogoError] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  useEffect(() => {
    setColor(branding.brandColor ?? DEFAULT_COLOR);
    setLogo(branding.logoDataUrl);
    setSupportEmail(branding.supportEmail ?? "");
    setSupportPhone(branding.supportPhone ?? "");
  }, [branding]);

  const validHex = isHexColor(color);
  const lowContrast = validHex && contrastRatio(color, "#FFFFFF") < MIN_BRAND_CONTRAST;

  function pickLogo(file: File | undefined) {
    setLogoError(null);
    if (!file) return;
    if (!["image/png", "image/jpeg", "image/webp"].includes(file.type)) {
      setLogoError("Use a PNG, JPEG or WebP image.");
      return;
    }
    if (file.size > MAX_LOGO_BYTES) {
      setLogoError("Logo must be 200 KB or smaller.");
      return;
    }
    const reader = new FileReader();
    reader.onload = () => setLogo(String(reader.result));
    reader.readAsDataURL(file);
  }

  async function save(e: FormEvent) {
    e.preventDefault();
    setSaving(true);
    try {
      await apiJson("/api/settings/branding", {
        method: "PUT",
        body: JSON.stringify({
          brandColor: color.toUpperCase() === DEFAULT_COLOR ? null : color,
          supportEmail: supportEmail.trim() || null,
          supportPhone: supportPhone.trim() || null,
          // Only send the logo when it changed, so an unchanged logo is not re-uploaded.
          ...(logo !== branding.logoDataUrl ? { logoDataUrl: logo } : {}),
        }),
      });
      toast.success("Branding saved");
      await onSaved();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Could not save branding.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="grid gap-10 lg:grid-cols-[minmax(0,1fr)_400px]">
      <form onSubmit={save} className="max-w-lg space-y-7">
        <div className="space-y-2">
          <Label>Logo</Label>
          <div className="flex items-center gap-4">
            <div className="flex h-14 w-28 items-center justify-center rounded-lg border border-dashed border-input bg-muted/40">
              {logo ? (
                <img src={logo} alt="Current logo" className="max-h-10 max-w-24 object-contain" />
              ) : (
                <ImageSquare className="size-5 text-muted-foreground" />
              )}
            </div>
            <div className="flex gap-2">
              <Button type="button" variant="outline" size="sm" onClick={() => fileInput.current?.click()}>
                {logo ? "Replace" : "Upload logo"}
              </Button>
              {logo && (
                <Button type="button" variant="ghost" size="sm" onClick={() => setLogo(null)}>
                  <X className="size-3.5" /> Remove
                </Button>
              )}
            </div>
            <input
              ref={fileInput}
              type="file"
              accept="image/png,image/jpeg,image/webp"
              className="sr-only"
              aria-label="Upload logo"
              onChange={(e) => {
                pickLogo(e.target.files?.[0]);
                e.target.value = "";
              }}
            />
          </div>
          <p className={logoError ? "text-xs font-medium text-destructive" : "text-xs text-muted-foreground"} role={logoError ? "alert" : undefined}>
            {logoError ?? "PNG, JPEG or WebP, up to 200 KB. Shown to clients and in emails."}
          </p>
        </div>

        <div className="space-y-2">
          <Label htmlFor="brand-hex">Accent colour</Label>
          <ColorPicker
            id="brand-hex"
            value={color}
            defaultColor={DEFAULT_COLOR}
            onChange={setColor}
            invalid={!validHex || lowContrast}
          />
          <p className={!validHex || lowContrast ? "text-xs font-medium text-destructive" : "text-xs text-muted-foreground"}>
            {!validHex
              ? "Use a hex value like #0F5243."
              : lowContrast
                ? "This colour is too light to read on white. Pick a darker shade."
                : "Used for buttons, progress and highlights in the client portal and emails."}
          </p>
        </div>

        <div className="grid gap-5 sm:grid-cols-2">
          <div className="space-y-2">
            <Label htmlFor="support-email">Support email</Label>
            <Input
              id="support-email"
              type="email"
              placeholder="hello@practice.com"
              value={supportEmail}
              onChange={(e) => setSupportEmail(e.target.value)}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="support-phone">Support phone</Label>
            <Input
              id="support-phone"
              type="tel"
              placeholder="+61 3 9000 0000"
              value={supportPhone}
              onChange={(e) => setSupportPhone(e.target.value)}
            />
          </div>
        </div>
        <p className="-mt-4 text-xs text-muted-foreground">Clients see these if they get stuck.</p>

        <Button type="submit" disabled={saving || !validHex || lowContrast}>
          {saving && <CircleNotch className="size-4 animate-spin" />}
          Save branding
        </Button>
      </form>

      <div className="hidden lg:block">
        <p className="mb-3 text-xs font-medium text-muted-foreground">Client preview</p>
        <PortalPreview name={branding.name} brandColor={validHex && !lowContrast ? color : null} logoDataUrl={logo} />
      </div>
    </div>
  );
}
