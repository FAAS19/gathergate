import { useRef, useState, type KeyboardEvent } from "react";
import {
  ArrowRight,
  CheckCircle,
  DeviceMobileCamera,
  ListChecks,
  LockSimple,
} from "@phosphor-icons/react";

type WalkthroughTabId = "operator" | "portal" | "mobile";

interface TabMeta {
  id: WalkthroughTabId;
  label: string;
}

const TABS: readonly TabMeta[] = [
  { id: "operator", label: "Operator review" },
  { id: "portal", label: "Client portal" },
  { id: "mobile", label: "Mobile intake" },
];

export function WalkthroughSection() {
  const [activeTab, setActiveTab] = useState<WalkthroughTabId>("operator");
  const tabRefs = useRef<Array<HTMLButtonElement | null>>([]);

  function handleKeyDown(e: KeyboardEvent<HTMLButtonElement>, index: number) {
    let nextIndex = index;
    if (e.key === "ArrowRight") {
      nextIndex = (index + 1) % TABS.length;
    } else if (e.key === "ArrowLeft") {
      nextIndex = (index - 1 + TABS.length) % TABS.length;
    } else if (e.key === "Home") {
      nextIndex = 0;
    } else if (e.key === "End") {
      nextIndex = TABS.length - 1;
    } else {
      return;
    }

    e.preventDefault();
    setActiveTab(TABS[nextIndex].id);
    tabRefs.current[nextIndex]?.focus();
  }

  return (
    <section
      id="walkthrough"
      className="border-t border-[var(--border)] py-16 lg:py-24"
    >
      <div className="mx-auto max-w-[1280px] px-4 sm:px-6 lg:px-8">
        <div className="max-w-[65ch]">
          <h2 className="font-display text-3xl font-semibold tracking-[-0.025em] text-[var(--ink)] sm:text-[2.125rem]">
            Built for fast reviews and calm client handoffs
          </h2>
          <p className="mt-3 text-base leading-relaxed text-[var(--ink-muted)]">
            Switch between the operator review sheet, desktop magic-link
            portal, and mobile receipt intake.
          </p>
        </div>

        <div className="mt-8">
          <div
            role="tablist"
            aria-label="Product walkthrough views"
            className="inline-flex max-w-full flex-wrap gap-1 rounded-lg border border-[var(--border)] bg-[var(--surface-muted)] p-1"
          >
            {TABS.map((tab, index) => {
              const selected = activeTab === tab.id;
              return (
                <button
                  key={tab.id}
                  ref={(el) => {
                    tabRefs.current[index] = el;
                  }}
                  type="button"
                  role="tab"
                  id={`tab-${tab.id}`}
                  aria-selected={selected}
                  aria-controls={`panel-${tab.id}`}
                  tabIndex={selected ? 0 : -1}
                  onClick={() => setActiveTab(tab.id)}
                  onKeyDown={(e) => handleKeyDown(e, index)}
                  className={`whitespace-nowrap rounded-md px-3.5 py-2 text-sm font-medium transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--accent)] ${
                    selected
                      ? "bg-[var(--surface)] text-[var(--ink)] shadow-xs"
                      : "text-[var(--ink-muted)] hover:text-[var(--ink)]"
                  }`}
                >
                  {tab.label}
                </button>
              );
            })}
          </div>
        </div>

        <div className="mt-6">
          {activeTab === "operator" && (
            <div
              role="tabpanel"
              id="panel-operator"
              aria-labelledby="tab-operator"
              tabIndex={0}
              className="animate-in fade-in duration-200 focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-[var(--accent)] rounded-xl"
            >
              <div className="frame-shadow overflow-hidden rounded-xl border border-[var(--border)] bg-[var(--surface)]">
                <div className="flex h-8 items-center gap-2 border-b border-[var(--border)] bg-[var(--surface-muted)] px-3.5">
                  <LockSimple
                    className="size-3.5 text-[var(--accent)]"
                    aria-hidden="true"
                  />
                  <span className="truncate font-mono text-xs text-[var(--ink-muted)]">
                    gathergate.local/requests/req_demo_tax
                  </span>
                </div>
                <img
                  src="./screenshots/operator-review.png"
                  alt="GatherGate inline review sheet displaying a decrypted client PDF alongside approve and revision controls"
                  width={1280}
                  height={800}
                  className="block aspect-[16/10] w-full bg-[var(--surface-muted)] object-cover object-top"
                />
              </div>

              <div className="mt-4 flex flex-col justify-between gap-3 sm:flex-row sm:items-center">
                <p className="max-w-[65ch] text-sm leading-relaxed text-[var(--ink-muted)]">
                  Inspect decrypted PDFs and scans inline, lock approved items
                  with one keystroke, or return a clear revision note.
                </p>
                <a
                  href="./demo/#/requests/req_demo_tax"
                  className="inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap text-sm font-medium text-[var(--accent)] transition-colors hover:text-[var(--accent-hover)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--accent)] rounded-md"
                >
                  <span>Open review queue</span>
                  <ArrowRight className="size-4" aria-hidden="true" />
                </a>
              </div>
            </div>
          )}

          {activeTab === "portal" && (
            <div
              role="tabpanel"
              id="panel-portal"
              aria-labelledby="tab-portal"
              tabIndex={0}
              className="animate-in fade-in duration-200 focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-[var(--accent)] rounded-xl"
            >
              <div className="frame-shadow overflow-hidden rounded-xl border border-[var(--border)] bg-[var(--surface)]">
                <div className="flex h-8 items-center gap-2 border-b border-[var(--border)] bg-[var(--surface-muted)] px-3.5">
                  <LockSimple
                    className="size-3.5 text-[var(--accent)]"
                    aria-hidden="true"
                  />
                  <span className="truncate font-mono text-xs text-[var(--ink-muted)]">
                    portal.practice.com.au/c/demo-bas
                  </span>
                </div>
                <img
                  src="./screenshots/client-portal-desktop.png"
                  alt="GatherGate desktop client portal showing checklist sections, drag-and-drop uploads, and live validation feedback"
                  width={1280}
                  height={800}
                  className="block aspect-[16/10] w-full bg-[var(--surface-muted)] object-cover object-top"
                />
              </div>

              <div className="mt-4 flex flex-col justify-between gap-3 sm:flex-row sm:items-center">
                <p className="max-w-[65ch] text-sm leading-relaxed text-[var(--ink-muted)]">
                  Passwordless links let clients drag files into checklist
                  slots, auto-save progress, and see requested revisions pinned
                  first.
                </p>
                <a
                  href="./demo/#/c/demo-bas"
                  className="inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap text-sm font-medium text-[var(--accent)] transition-colors hover:text-[var(--accent-hover)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--accent)] rounded-md"
                >
                  <span>Open client portal</span>
                  <ArrowRight className="size-4" aria-hidden="true" />
                </a>
              </div>
            </div>
          )}

          {activeTab === "mobile" && (
            <div
              role="tabpanel"
              id="panel-mobile"
              aria-labelledby="tab-mobile"
              tabIndex={0}
              className="animate-in fade-in duration-200 rounded-xl border border-[var(--border)] bg-[var(--surface)] p-6 sm:p-10 focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-[var(--accent)]"
            >
              <div className="grid grid-cols-1 items-center gap-8 md:grid-cols-12">
                <div className="flex justify-center md:col-span-5">
                  <div className="frame-shadow w-full max-w-[270px] overflow-hidden rounded-xl border border-[var(--border)] bg-[var(--bg)] p-2">
                    <img
                      src="./screenshots/client-portal-mobile.png"
                      alt="GatherGate mobile client portal showing sticky progress bar and single-column document upload"
                      width={390}
                      height={844}
                      className="block aspect-[390/844] w-full rounded-lg bg-[var(--surface-muted)] object-cover object-top"
                    />
                  </div>
                </div>

                <div className="md:col-span-7">
                  <h3 className="font-display text-2xl font-semibold tracking-[-0.02em] text-[var(--ink)]">
                    Single-column intake designed for phone browsers
                  </h3>

                  <div className="mt-6 space-y-5">
                    <div className="flex items-start gap-3.5">
                      <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-[var(--accent-soft)] text-[var(--accent)]">
                        <ListChecks className="size-5" aria-hidden="true" />
                      </div>
                      <div>
                        <p className="text-sm font-semibold text-[var(--ink)]">
                          Sticky progress bar
                        </p>
                        <p className="mt-1 text-sm leading-relaxed text-[var(--ink-muted)]">
                          Completion counts and debounced auto-save status stay
                          visible while scrolling on narrow screens.
                        </p>
                      </div>
                    </div>

                    <div className="flex items-start gap-3.5">
                      <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-[var(--accent-soft)] text-[var(--accent)]">
                        <DeviceMobileCamera
                          className="size-5"
                          aria-hidden="true"
                        />
                      </div>
                      <div>
                        <p className="text-sm font-semibold text-[var(--ink)]">
                          Phone camera receipt scan
                        </p>
                        <p className="mt-1 text-sm leading-relaxed text-[var(--ink-muted)]">
                          Clients snap and upload PDFs or receipt photos
                          straight from mobile browsers with live XHR progress.
                        </p>
                      </div>
                    </div>

                    <div className="flex items-start gap-3.5">
                      <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-[var(--accent-soft)] text-[var(--accent)]">
                        <CheckCircle className="size-5" aria-hidden="true" />
                      </div>
                      <div>
                        <p className="text-sm font-semibold text-[var(--ink)]">
                          Live inline checksum hints
                        </p>
                        <p className="mt-1 text-sm leading-relaxed text-[var(--ink-muted)]">
                          Instant feedback flags mistyped ABNs, BSBs, and
                          Medicare card digits before submission.
                        </p>
                      </div>
                    </div>
                  </div>

                  <div className="mt-7">
                    <a
                      href="./demo/#/c/demo-tax"
                      className="inline-flex items-center gap-1.5 whitespace-nowrap text-sm font-medium text-[var(--accent)] transition-colors hover:text-[var(--accent-hover)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--accent)] rounded-md"
                    >
                      <span>Open OTP portal</span>
                      <ArrowRight className="size-4" aria-hidden="true" />
                    </a>
                  </div>
                </div>
              </div>
            </div>
          )}
        </div>
      </div>
    </section>
  );
}
