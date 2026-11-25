import { useState } from "react";
import {
  NotePencil,
  Palette,
  Password,
  UploadSimple,
} from "@phosphor-icons/react";

type PlaygroundCheck = {
  valid: boolean;
  detail: string;
};

type ValidatorRule = {
  id: string;
  label: string;
  algorithm: string;
  validSample: string;
  invalidSample: string;
  validate: (raw: string) => PlaygroundCheck;
};

const VALIDATOR_RULES: readonly ValidatorRule[] = [
  {
    id: "au_abn",
    label: "AU ABN",
    algorithm: "mod-89",
    validSample: "51 824 753 556",
    invalidSample: "51 824 753 557",
    validate(raw) {
      const d = raw.replace(/[\s-]+/g, "");
      if (!/^[1-9]\d{10}$/.test(d)) {
        return { valid: false, detail: "Expected 11 digits (non-zero start)" };
      }
      const w = [10, 1, 3, 5, 7, 9, 11, 13, 15, 17, 19];
      const nums = d.split("").map(Number);
      nums[0] -= 1;
      const sum = nums.reduce((acc, n, i) => acc + n * w[i], 0);
      if (sum % 89 !== 0) {
        return { valid: false, detail: "ATO mod-89 failed" };
      }
      return {
        valid: true,
        detail: `${d.slice(0, 2)} ${d.slice(2, 5)} ${d.slice(5, 8)} ${d.slice(8, 11)}`,
      };
    },
  },
  {
    id: "uk_utr",
    label: "UK UTR",
    algorithm: "mod-11",
    validSample: "19558 39661",
    invalidSample: "19558 39662",
    validate(raw) {
      const d = raw.replace(/[\s-]+/g, "");
      if (!/^\d{10}$/.test(d)) {
        return { valid: false, detail: "Expected 10 digits" };
      }
      const w = [6, 7, 8, 9, 10, 5, 4, 3, 2];
      const sum = w.reduce(
        (acc, weight, i) => acc + Number(d[i + 1]) * weight,
        0
      );
      const expected = [2, 1, 9, 8, 7, 6, 5, 4, 3, 2, 1][sum % 11];
      if (Number(d[0]) !== expected) {
        return { valid: false, detail: "HMRC mod-11 failed" };
      }
      return { valid: true, detail: `${d.slice(0, 5)} ${d.slice(5, 10)}` };
    },
  },
  {
    id: "us_aba",
    label: "US ABA",
    algorithm: "mod-10",
    validSample: "021000021",
    invalidSample: "021000022",
    validate(raw) {
      const d = raw.replace(/[\s-]+/g, "");
      if (!/^\d{9}$/.test(d)) {
        return { valid: false, detail: "Expected 9 digits" };
      }
      const prefix = Number(d.slice(0, 2));
      const validPrefix =
        (prefix >= 0 && prefix <= 12) ||
        (prefix >= 21 && prefix <= 32) ||
        (prefix >= 61 && prefix <= 72) ||
        prefix === 80;
      if (!validPrefix) {
        return { valid: false, detail: "Invalid Federal Reserve prefix" };
      }
      const n = d.split("").map(Number);
      const sum =
        3 * (n[0] + n[3] + n[6]) +
        7 * (n[1] + n[4] + n[7]) +
        (n[2] + n[5] + n[8]);
      if (sum % 10 !== 0) {
        return { valid: false, detail: "Fed mod-10 failed" };
      }
      return { valid: true, detail: d };
    },
  },
  {
    id: "iban",
    label: "IBAN",
    algorithm: "mod-97",
    validSample: "GB82 WEST 1234 5698 7654 32",
    invalidSample: "GB82 WEST 1234 5698 7654 33",
    validate(raw) {
      const s = raw.replace(/\s+/g, "").toUpperCase();
      if (!/^[A-Z]{2}\d{2}[A-Z0-9]{11,30}$/.test(s)) {
        return { valid: false, detail: "Expected country + check digits" };
      }
      const rearranged = s.slice(4) + s.slice(0, 4);
      let rem = 0;
      for (const ch of rearranged) {
        const num = ch >= "A" ? String(ch.charCodeAt(0) - 55) : ch;
        for (const digit of num) rem = (rem * 10 + Number(digit)) % 97;
      }
      if (rem !== 1) {
        return { valid: false, detail: "ISO 13616 mod-97 failed" };
      }
      return { valid: true, detail: s.replace(/(.{4})/g, "$1 ").trim() };
    },
  },
  {
    id: "au_tfn",
    label: "AU TFN",
    algorithm: "mod-11 masked",
    validSample: "876 543 210",
    invalidSample: "876 543 211",
    validate(raw) {
      const d = raw.replace(/[\s-]+/g, "");
      if (!/^\d{8,9}$/.test(d) || /^0+$/.test(d)) {
        return { valid: false, detail: "Expected 8 or 9 digits" };
      }
      const w =
        d.length === 9
          ? [1, 4, 3, 7, 5, 8, 6, 9, 10]
          : [10, 7, 8, 4, 6, 3, 5, 1];
      const sum = d.split("").reduce((acc, ch, i) => acc + Number(ch) * w[i], 0);
      if (sum % 11 !== 0) {
        return { valid: false, detail: "ATO mod-11 failed" };
      }
      return {
        valid: true,
        detail: `${"*".repeat(d.length - 3)} ${d.slice(-3)}`,
      };
    },
  },
];

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
  const [selectedRuleId, setSelectedRuleId] = useState<string>(
    VALIDATOR_RULES[0].id
  );
  const [inputValue, setInputValue] = useState<string>(
    VALIDATOR_RULES[0].validSample
  );

  const activeRule =
    VALIDATOR_RULES.find((rule) => rule.id === selectedRuleId) ??
    VALIDATOR_RULES[0];
  const result = activeRule.validate(inputValue);

  function selectRule(rule: ValidatorRule) {
    setSelectedRuleId(rule.id);
    setInputValue(rule.validSample);
  }

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
          <article className="flex flex-col justify-between gap-5 rounded-xl border border-[var(--border)] bg-[var(--accent-soft)] p-6 sm:p-8 lg:col-span-7">
            <div>
              <h3 className="font-display text-xl font-semibold tracking-[-0.02em] text-[var(--ink)]">
                Pluggable Validator Packs
              </h3>
              <p className="mt-2.5 max-w-[58ch] text-sm leading-relaxed text-[var(--ink-muted)]">
                Ships with 5 packs (Generic, Australia, UK, US, and EU) covering
                ABN mod-89, masked TFN mod-11, UK UTR mod-11, US ABA mod-10, and
                IBAN mod-97. Test the live checksums below.
              </p>
            </div>

            <div className="space-y-3 rounded-lg border border-[var(--border)] bg-[var(--surface)] p-4">
              <div
                role="group"
                aria-label="Select validator rule"
                className="flex flex-wrap gap-1.5"
              >
                {VALIDATOR_RULES.map((rule) => {
                  const active = rule.id === activeRule.id;
                  return (
                    <button
                      key={rule.id}
                      type="button"
                      aria-pressed={active}
                      onClick={() => selectRule(rule)}
                      className={`inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1 text-xs font-medium transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--accent)] ${
                        active
                          ? "border-[var(--accent)] bg-[var(--accent)] text-[var(--accent-ink)]"
                          : "border-[var(--border)] bg-[var(--surface-muted)] text-[var(--ink)] hover:bg-[var(--bg)]"
                      }`}
                    >
                      <span>{rule.label}</span>
                      <span
                        className={`font-mono text-[10px] ${
                          active ? "text-[var(--accent-ink)]" : "text-[var(--ink-muted)]"
                        }`}
                      >
                        {rule.algorithm}
                      </span>
                    </button>
                  );
                })}
              </div>

              <div className="space-y-1.5">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <label
                    htmlFor="validator-playground-input"
                    className="text-xs font-medium text-[var(--ink)]"
                  >
                    {activeRule.label} ({activeRule.algorithm})
                  </label>
                  <div className="flex items-center gap-1.5">
                    <button
                      type="button"
                      onClick={() => setInputValue(activeRule.validSample)}
                      className="rounded border border-[var(--border)] bg-[var(--surface-muted)] px-2 py-0.5 text-[11px] font-medium text-[var(--ink)] transition-colors hover:bg-[var(--bg)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--accent)]"
                    >
                      Valid sample
                    </button>
                    <button
                      type="button"
                      onClick={() => setInputValue(activeRule.invalidSample)}
                      className="rounded border border-[var(--border)] bg-[var(--surface-muted)] px-2 py-0.5 text-[11px] font-medium text-[var(--ink)] transition-colors hover:bg-[var(--bg)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--accent)]"
                    >
                      Broken digit
                    </button>
                  </div>
                </div>

                <input
                  id="validator-playground-input"
                  type="text"
                  value={inputValue}
                  onChange={(e) => setInputValue(e.target.value)}
                  spellCheck={false}
                  autoComplete="off"
                  className="w-full rounded-md border border-[var(--border)] bg-[var(--surface-muted)] px-3 py-2 font-mono text-sm text-[var(--ink)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--accent)]"
                />
              </div>

              <div
                aria-live="polite"
                className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-[var(--border)] bg-[var(--surface-muted)] px-3 py-2 font-mono text-xs"
              >
                <span
                  className="truncate text-[var(--ink)]"
                  title={result.detail}
                >
                  {result.valid ? `Normalised: ${result.detail}` : result.detail}
                </span>
                <span
                  className="shrink-0 rounded-md px-2 py-0.5 text-[11px] font-semibold"
                  style={{
                    backgroundColor: result.valid
                      ? "var(--pass-bg)"
                      : "var(--fail-bg)",
                    color: result.valid ? "var(--pass-ink)" : "var(--fail-ink)",
                  }}
                >
                  {result.valid ? "PASS" : "FAIL"}
                </span>
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
                inline previews run in a strict CSP sandbox, and sensitive ID
                packs (TFN, Medicare, UK NINO, US SSN) purge after 14 days by
                default.
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
