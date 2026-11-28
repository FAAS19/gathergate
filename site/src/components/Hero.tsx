import dashboard1280 from "../assets/screenshots/operator-dashboard-1280.webp";
import dashboard720 from "../assets/screenshots/operator-dashboard-720.webp";
import dashboardDark1280 from "../assets/screenshots/operator-dashboard-dark-1280.webp";
import dashboardDark720 from "../assets/screenshots/operator-dashboard-dark-720.webp";
import { ArrowRight, LockSimple } from "./Icons";

interface HeroProps {
  isDark: boolean;
}

export function Hero({ isDark }: HeroProps) {
  const heroSrc = isDark ? dashboardDark1280 : dashboard1280;
  const heroSrcSet = isDark
    ? `${dashboardDark720} 720w, ${dashboardDark1280} 1280w`
    : `${dashboard720} 720w, ${dashboard1280} 1280w`;
  const heroAlt = isDark
    ? "GatherGate operator dashboard in dark mode showing active client document requests, status filters, and review queue metrics"
    : "GatherGate operator dashboard showing active client document requests, status filters, and review queue metrics";

  return (
    <section className="pt-10 pb-10 lg:pt-14 lg:pb-12">
      <div className="mx-auto max-w-[1280px] px-4 sm:px-6 lg:px-8">
        <div className="grid grid-cols-1 items-center gap-10 lg:grid-cols-12 lg:gap-12">
          <div className="lg:col-span-5">
            <h1 className="font-display text-[2.375rem] leading-[1.08] font-semibold tracking-[-0.03em] text-[var(--ink)] sm:text-[2.75rem] lg:text-[2.625rem] xl:text-[3rem]">
              Stop chasing clients for documents.
            </h1>

            <p className="mt-5 max-w-[46ch] text-base leading-relaxed text-[var(--ink-muted)] sm:text-[1.0625rem]">
              Open-source, self-hosted alternative to Content Snare &amp;
              FileInvite. Magic links, deterministic validation, and AES-256-GCM
              encryption in one container.
            </p>

            <div className="mt-7 flex flex-wrap items-center gap-3">
              <a
                href="./demo/#/"
                className="inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-lg bg-[var(--accent)] px-5 py-2.5 text-sm font-medium text-[var(--accent-ink)] transition-colors hover:bg-[var(--accent-hover)] active:scale-[0.98] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--accent)]"
              >
                <span>Try live demo</span>
                <ArrowRight className="size-4" aria-hidden="true" />
              </a>

              <a
                href="./demo/#/c/demo-bas"
                className="inline-flex items-center justify-center whitespace-nowrap rounded-lg border border-[var(--border)] bg-[var(--surface)] px-5 py-2.5 text-sm font-medium text-[var(--ink)] transition-colors hover:bg-[var(--surface-muted)] active:scale-[0.98] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--accent)]"
              >
                Try client portal
              </a>
            </div>
          </div>

          <div className="lg:col-span-7">
            <div className="frame-shadow overflow-hidden rounded-xl border border-[var(--border)] bg-[var(--surface)]">
              <div className="flex h-8 items-center gap-2 border-b border-[var(--border)] bg-[var(--surface-muted)] px-3.5">
                <LockSimple
                  className="size-3.5 text-[var(--accent)]"
                  aria-hidden="true"
                />
                <span className="truncate font-mono text-xs text-[var(--ink-muted)]">
                  gathergate.local/requests
                </span>
              </div>
              <img
                src={heroSrc}
                srcSet={heroSrcSet}
                sizes="(min-width: 1280px) 680px, (min-width: 1024px) 53vw, 94vw"
                alt={heroAlt}
                width={1280}
                height={800}
                loading="eager"
                decoding="async"
                fetchPriority="high"
                className="block aspect-[16/10] w-full bg-[var(--surface-muted)] object-cover object-top"
              />
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
