const COMPARISON_ROWS = [
  {
    criterion: "Pricing",
    gathergate: "Free & MIT open source (self-hosted)",
    contentSnare: "Paid monthly request & team tiers",
    fileInvite: "Paid per-seat & enterprise tiers",
  },
  {
    criterion: "Data residency & encryption",
    gathergate:
      "Your host or S3 bucket, per-record AES-256-GCM with auto-purge",
    contentSnare: "Vendor-managed SaaS infrastructure",
    fileInvite: "Vendor-managed SaaS infrastructure",
  },
  {
    criterion: "Deterministic checksums & magic-bytes",
    gathergate:
      "Built-in AU, UK, US, EU & IBAN checksum packs plus binary signature inspection",
    contentSnare: "Basic field formatting & extension rules",
    fileInvite: "Basic field validation & accepted file lists",
  },
  {
    criterion: "Automated follow-ups, webhooks & AI agents",
    gathergate:
      "Scheduled chasers, canonical ZIP, 6 signed webhooks with retry queue & built-in MCP 2.0",
    contentSnare: "Scheduled reminders & PDF/ZIP exports",
    fileInvite: "Scheduled reminders & portal downloads",
  },
  {
    criterion: "Source & lock-in",
    gathergate: "Full source on GitHub, portable SQLite & encrypted blobs",
    contentSnare: "Closed-source SaaS",
    fileInvite: "Closed-source SaaS",
  },
] as const;

export function CompareSection() {
  return (
    <section
      id="compare"
      className="border-t border-[var(--border)] py-16 lg:py-24"
    >
      <div className="mx-auto max-w-[1280px] px-4 sm:px-6 lg:px-8">
        <div className="max-w-[65ch]">
          <h2 className="font-display text-3xl font-semibold tracking-[-0.025em] text-[var(--ink)] sm:text-[2.125rem]">
            How GatherGate compares
          </h2>
          <p className="mt-3 text-base leading-relaxed text-[var(--ink-muted)]">
            A direct look at how self-hosted GatherGate stacks up against
            hosted document-collection SaaS products.
          </p>
        </div>

        <div
          tabIndex={0}
          role="region"
          aria-label="GatherGate feature comparison table"
          className="mt-10 overflow-x-auto rounded-xl border border-[var(--border)] bg-[var(--surface)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--accent)]"
        >
          <table className="w-full min-w-[680px] border-collapse text-left text-sm">
            <thead>
              <tr className="border-b border-[var(--border)] bg-[var(--surface-muted)]">
                <th
                  scope="col"
                  className="w-[24%] px-5 py-4 font-display text-xs font-semibold text-[var(--ink-muted)]"
                >
                  Capability
                </th>
                <th
                  scope="col"
                  className="w-[28%] bg-[var(--accent-soft)] px-5 py-4 font-display text-sm font-semibold text-[var(--accent)]"
                >
                  GatherGate (Self-Hosted)
                </th>
                <th
                  scope="col"
                  className="w-[24%] px-5 py-4 font-display text-sm font-semibold text-[var(--ink)]"
                >
                  Content Snare
                </th>
                <th
                  scope="col"
                  className="w-[24%] px-5 py-4 font-display text-sm font-semibold text-[var(--ink)]"
                >
                  FileInvite
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[var(--border)]">
              {COMPARISON_ROWS.map((row) => (
                <tr key={row.criterion}>
                  <th
                    scope="row"
                    className="px-5 py-4 align-top font-medium text-[var(--ink)]"
                  >
                    {row.criterion}
                  </th>
                  <td className="bg-[var(--accent-soft)]/50 px-5 py-4 align-top font-medium text-[var(--ink)]">
                    {row.gathergate}
                  </td>
                  <td className="px-5 py-4 align-top text-[var(--ink-muted)]">
                    {row.contentSnare}
                  </td>
                  <td className="px-5 py-4 align-top text-[var(--ink-muted)]">
                    {row.fileInvite}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </section>
  );
}
