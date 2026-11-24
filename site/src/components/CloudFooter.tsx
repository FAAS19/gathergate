import { ArrowRight } from "@phosphor-icons/react";
import { BrandMark } from "./BrandMark";

const FOOTER_LINKS = [
  { label: "GitHub", href: "https://github.com/FAAS19/gathergate" },
  {
    label: "Security",
    href: "https://github.com/FAAS19/gathergate/blob/main/SECURITY.md",
  },
  {
    label: "Contributing",
    href: "https://github.com/FAAS19/gathergate/blob/main/CONTRIBUTING.md",
  },
  { label: "TensorForge", href: "https://tensorforge.dev" },
] as const;

export function CloudFooter() {
  return (
    <>
      <section className="border-t border-[var(--border)] py-16 lg:py-20">
        <div className="mx-auto max-w-[1280px] px-4 sm:px-6 lg:px-8">
          <div className="flex flex-col justify-between gap-6 rounded-xl border border-[var(--border)] bg-[var(--accent-soft)] p-7 sm:p-10 md:flex-row md:items-center">
            <div className="max-w-[58ch]">
              <h2 className="font-display text-2xl font-semibold tracking-[-0.02em] text-[var(--ink)] sm:text-[1.75rem]">
                Managed Cloud (Coming Soon)
              </h2>
              <p className="mt-2.5 text-base leading-relaxed text-[var(--ink-muted)]">
                Australian-hosted tier in Sydney (ap-southeast-2) with managed
                backups, dedicated sending domain, and zero server upkeep.
              </p>
            </div>

            <div className="shrink-0">
              <a
                href="mailto:contact@tensorforge.dev?subject=GatherGate%20Managed%20Cloud%20Early%20Access"
                className="inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-lg bg-[var(--accent)] px-5 py-2.5 text-sm font-medium text-white transition-colors hover:bg-[var(--accent-hover)] active:scale-[0.98] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--accent)]"
              >
                <span>Register early interest</span>
                <ArrowRight className="size-4" aria-hidden="true" />
              </a>
            </div>
          </div>
        </div>
      </section>

      <footer className="border-t border-[var(--border)] bg-[var(--bg)] py-8">
        <div className="mx-auto flex max-w-[1280px] flex-col justify-between gap-4 px-4 sm:flex-row sm:items-center sm:px-6 lg:px-8">
          <div className="flex flex-wrap items-center gap-3 text-sm text-[var(--ink-muted)]">
            <span className="inline-flex items-center gap-2 font-display font-semibold text-[var(--ink)]">
              <BrandMark size="sm" />
              GatherGate
            </span>
            <span aria-hidden="true">/</span>
            <span>MIT Licence</span>
          </div>

          <div className="flex flex-wrap items-center gap-x-6 gap-y-2 text-sm text-[var(--ink-muted)]">
            {FOOTER_LINKS.map((link) => (
              <a
                key={link.label}
                href={link.href}
                target="_blank"
                rel="noreferrer"
                className="rounded-md transition-colors hover:text-[var(--ink)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--accent)]"
              >
                {link.label}
              </a>
            ))}
            <a
              href="mailto:contact@tensorforge.dev"
              className="rounded-md font-mono text-xs transition-colors hover:text-[var(--ink)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--accent)]"
            >
              contact@tensorforge.dev
            </a>
          </div>
        </div>
      </footer>
    </>
  );
}
