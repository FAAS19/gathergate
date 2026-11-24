import {
  NotePencil,
  Palette,
  Password,
  UploadSimple,
} from "@phosphor-icons/react";

const VALIDATOR_EXAMPLES = [
  {
    field: "ABN",
    sample: "51 824 753 556",
    pass: true,
    detail: "ATO mod-89",
  },
  {
    field: "TFN",
    sample: "876 543 210",
    pass: true,
    detail: "masked *** *** 210",
  },
  {
    field: "ABN",
    sample: "51 824 753 557",
    pass: false,
    detail: "ATO mod-89 failed",
  },
  {
    field: "IBAN",
    sample: "GB82 WEST 1234 5698 7654 32",
    pass: true,
    detail: "ISO 13616 mod-97",
  },
] as const;

const KEYBOARD_SHORTCUTS = [
  { keys: ["J", "K"], action: "Step next or previous file in preview" },
  { keys: ["Space"], action: "Open inline preview for selected item" },
  { keys: ["A"], action: "Approve and lock verified item" },
  { keys: ["R"], action: "Request revision with feedback note" },
] as const;

const CLIENT_FEATURES = [
  {
    icon: Palette,
    label: "Practice logo & WCAG-checked accent colour",
  },
  {
    icon: Password,
    label: "Optional 6-digit email OTP verification",
  },
  {
    icon: UploadSimple,
    label: "Real-time XHR upload progress bar",
  },
  {
    icon: NotePencil,
    label: "Client notes & N/A escape hatch",
  },
] as const;

export function FeatureBento() {
  return (
    <section className="border-t border-[var(--border)] py-16 lg:py-24">
      <div className="mx-auto max-w-[1280px] px-4 sm:px-6 lg:px-8">
        <div className="max-w-[65ch]">
          <h2 className="font-display text-3xl font-semibold tracking-[-0.025em] text-[var(--ink)] sm:text-[2.125rem]">
            Deterministic checks, encrypted storage, zero noise
          </h2>
          <p className="mt-3 text-base leading-relaxed text-[var(--ink-muted)]">
            Every upload, statutory checksum, and retention schedule runs on
            predictable code paths you can inspect.
          </p>
        </div>

        <div className="mt-10 grid grid-cols-1 gap-5 lg:grid-cols-12">
          <article className="flex flex-col justify-between gap-6 rounded-xl border border-[var(--border)] bg-[var(--accent-soft)] p-6 sm:p-8 lg:col-span-7">
            <div>
              <h3 className="font-display text-xl font-semibold tracking-[-0.02em] text-[var(--ink)]">
                Pluggable Validator Packs
              </h3>
              <p className="mt-2.5 max-w-[58ch] text-sm leading-relaxed text-[var(--ink-muted)]">
                Ships with the Generic pack (Email, URL, E.164, IBAN mod-97)
                plus the Australia pack (ABN mod-89, BSB, masked TFN mod-11, and
                Medicare with IRN mod-10).
              </p>
            </div>

            <div className="overflow-hidden rounded-lg border border-[var(--border)] bg-[var(--surface)]">
              <div className="divide-y divide-[var(--border)] font-mono text-xs">
                {VALIDATOR_EXAMPLES.map((row) => (
                  <div
                    key={`${row.field}-${row.sample}`}
                    className="flex flex-wrap items-center justify-between gap-2 px-3.5 py-2.5"
                  >
                    <div className="flex min-w-0 items-center gap-2.5">
                      <span className="w-9 shrink-0 font-semibold text-[var(--ink)]">
                        {row.field}
                      </span>
                      <span className="truncate text-[var(--ink-muted)]">
                        {row.sample}
                      </span>
                    </div>
                    <div className="flex items-center gap-2">
                      <span className="text-[11px] text-[var(--ink-muted)]">
                        {row.detail}
                      </span>
                      <span
                        className={`rounded-md px-2 py-0.5 text-[11px] font-semibold ${
                          row.pass
                            ? "bg-[var(--accent-soft)] text-[var(--accent)]"
                            : "bg-[#FEE2E2] text-[#991B1B]"
                        }`}
                      >
                        {row.pass ? "PASS" : "FAIL"}
                      </span>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </article>

          <article className="flex flex-col justify-between gap-6 rounded-xl border border-[var(--border)] bg-[var(--surface)] p-6 sm:p-8 lg:col-span-5">
            <div>
              <h3 className="font-display text-xl font-semibold tracking-[-0.02em] text-[var(--ink)]">
                AES-256-GCM Vault &amp; Auto-Purge
              </h3>
              <p className="mt-2.5 text-sm leading-relaxed text-[var(--ink-muted)]">
                Per-record HKDF keys (v1 metadata) encrypt every file and field
                at rest. Magic-byte binary sniffing blocks spoofed executables,
                inline previews run in a strict CSP sandbox, and TFN or Medicare
                packs purge after 14 days by default.
              </p>
            </div>

            <div className="grid grid-cols-3 divide-x divide-[var(--border)] rounded-lg border border-[var(--border)] bg-[var(--surface-muted)] text-center font-mono text-xs">
              <div className="px-2.5 py-3">
                <div className="font-semibold text-[var(--ink)]">HKDF v1</div>
                <div className="mt-0.5 text-[11px] text-[var(--ink-muted)]">
                  per record
                </div>
              </div>
              <div className="px-2.5 py-3">
                <div className="font-semibold text-[var(--ink)]">Magic-byte</div>
                <div className="mt-0.5 text-[11px] text-[var(--ink-muted)]">
                  CSP sandbox
                </div>
              </div>
              <div className="px-2.5 py-3">
                <div className="font-semibold text-[var(--ink)]">14 days</div>
                <div className="mt-0.5 text-[11px] text-[var(--ink-muted)]">
                  auto-purge
                </div>
              </div>
            </div>
          </article>

          <article className="flex flex-col justify-between gap-6 rounded-xl border border-[var(--border)] bg-[var(--surface)] p-6 sm:p-8 lg:col-span-5">
            <div>
              <h3 className="font-display text-xl font-semibold tracking-[-0.02em] text-[var(--ink)]">
                Keyboard-First Triage
              </h3>
              <p className="mt-2.5 text-sm leading-relaxed text-[var(--ink-muted)]">
                Review uploads without lifting your hands, then export a
                canonical ZIP (<code className="text-xs text-[var(--ink)]">
                  {"{client}_{item}_{seq}.{ext}"}
                </code>
                ) when ready.
              </p>
            </div>

            <div className="space-y-2.5">
              {KEYBOARD_SHORTCUTS.map((shortcut) => (
                <div
                  key={shortcut.action}
                  className="flex items-center justify-between gap-3 rounded-lg border border-[var(--border)] bg-[var(--surface-muted)] px-3 py-2"
                >
                  <span className="text-xs text-[var(--ink)]">
                    {shortcut.action}
                  </span>
                  <span className="flex shrink-0 items-center gap-1">
                    {shortcut.keys.map((keyLabel) => (
                      <kbd
                        key={keyLabel}
                        className="inline-flex min-w-[1.625rem] items-center justify-center rounded-md border border-[var(--border)] bg-[var(--surface)] px-1.5 py-0.5 font-mono text-[11px] font-semibold text-[var(--ink)] shadow-[0_1px_0_var(--border)]"
                      >
                        {keyLabel}
                      </kbd>
                    ))}
                  </span>
                </div>
              ))}
            </div>
          </article>

          <article className="flex flex-col justify-between gap-6 rounded-xl border border-[var(--border)] bg-[var(--surface-muted)] p-6 sm:p-8 lg:col-span-7">
            <div>
              <h3 className="font-display text-xl font-semibold tracking-[-0.02em] text-[var(--ink)]">
                White-Label Client Experience
              </h3>
              <p className="mt-2.5 max-w-[58ch] text-sm leading-relaxed text-[var(--ink-muted)]">
                Present clients with your practice logo and a WCAG-checked
                accent colour. Enforce optional 6-digit email OTP, show XHR
                upload progress bars, and let clients leave notes or mark
                items N/A.
              </p>
            </div>

            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              {CLIENT_FEATURES.map((item) => {
                const Icon = item.icon;
                return (
                  <div
                    key={item.label}
                    className="flex items-center gap-3 rounded-lg border border-[var(--border)] bg-[var(--surface)] px-4 py-3"
                  >
                    <Icon
                      className="size-4 shrink-0 text-[var(--accent)]"
                      aria-hidden="true"
                    />
                    <span className="text-sm font-medium text-[var(--ink)]">
                      {item.label}
                    </span>
                  </div>
                );
              })}
            </div>
          </article>
        </div>
      </div>
    </section>
  );
}
