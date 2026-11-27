import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import {
  Check,
  Copy,
  Database,
  EnvelopeSimple,
  ShieldCheck,
} from "@phosphor-icons/react";

type DeployTabId = "npx" | "run" | "compose" | "agent";

const COMMANDS: Record<
  DeployTabId,
  { label: string; command: string; isPrompt?: boolean }
> = {
  npx: {
    label: "npx",
    command: "npx gathergate",
  },
  run: {
    label: "docker run",
    command: [
      "docker run -d \\",
      "  --name gathergate \\",
      "  -p 127.0.0.1:3080:3080 \\",
      "  -v gathergate_data:/data \\",
      "  ghcr.io/faas19/gathergate:latest",
    ].join("\n"),
  },
  compose: {
    label: "docker compose",
    command: [
      "git clone https://github.com/FAAS19/gathergate.git \\",
      "  && cd gathergate \\",
      "  && docker compose up -d --build",
    ].join("\n"),
  },
  agent: {
    label: "AI agent",
    isPrompt: true,
    command: [
      "Read https://gathergate.tensorforge.dev/llms.txt and help me install GatherGate.",
      "Check whether Docker or Node.js >= 22.13 is installed, ask my preferred port and storage path before making changes, start GatherGate, and verify GET /healthz returns 200.",
    ].join("\n"),
  },
};

const HIGHLIGHTS = [
  {
    icon: Database,
    title: "SQLite WAL + local or S3 blobs",
    description:
      "Store structured metadata in SQLite WAL alongside local encrypted volumes or any SigV4 S3/R2 object bucket.",
  },
  {
    icon: EnvelopeSimple,
    title: "Local Outbox, SMTP, or Resend",
    description:
      "Inspect invites, 6-digit OTPs, and reminders inside the built-in Local Outbox before connecting production mail.",
  },
  {
    icon: ShieldCheck,
    title: "Zero telemetry under MIT licence",
    description:
      "Zero analytics, zero crash reports, and zero outbound requests unless you configure SMTP, Resend, S3, or webhooks.",
  },
] as const;

const DEPLOY_TAB_ORDER: readonly DeployTabId[] = [
  "npx",
  "run",
  "compose",
  "agent",
];

export function SelfHostSection() {
  const [activeTab, setActiveTab] = useState<DeployTabId>("npx");
  const [copied, setCopied] = useState(false);
  const tabRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const timeoutRef = useRef<number | null>(null);

  useEffect(() => {
    return () => {
      if (timeoutRef.current !== null) {
        window.clearTimeout(timeoutRef.current);
      }
    };
  }, []);

  function handleTabKeyDown(e: KeyboardEvent<HTMLButtonElement>, index: number) {
    let nextIndex = index;
    if (e.key === "ArrowRight") {
      nextIndex = (index + 1) % DEPLOY_TAB_ORDER.length;
    } else if (e.key === "ArrowLeft") {
      nextIndex =
        (index - 1 + DEPLOY_TAB_ORDER.length) % DEPLOY_TAB_ORDER.length;
    } else if (e.key === "Home") {
      nextIndex = 0;
    } else if (e.key === "End") {
      nextIndex = DEPLOY_TAB_ORDER.length - 1;
    } else {
      return;
    }

    e.preventDefault();
    setActiveTab(DEPLOY_TAB_ORDER[nextIndex]);
    setCopied(false);
    tabRefs.current[nextIndex]?.focus();
  }

  async function handleCopy() {
    const text = COMMANDS[activeTab].command;
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      if (timeoutRef.current !== null) {
        window.clearTimeout(timeoutRef.current);
      }
      timeoutRef.current = window.setTimeout(() => setCopied(false), 2000);
    } catch {
      setCopied(false);
    }
  }

  return (
    <section
      id="self-host"
      className="border-t border-[var(--border)] py-16 lg:py-24"
    >
      <div className="mx-auto max-w-[1280px] px-4 sm:px-6 lg:px-8">
        <div className="max-w-[65ch]">
          <h2 className="font-display text-3xl font-semibold tracking-[-0.025em] text-[var(--ink)] sm:text-[2.125rem]">
            Self-host in one command
          </h2>
          <p className="mt-3 text-base leading-relaxed text-[var(--ink-muted)]">
            Run directly with Node.js or boot the hardened container on your own
            server or laptop with zero external database dependencies.
          </p>
        </div>

        <div className="mt-10 grid grid-cols-1 gap-8 lg:grid-cols-12 lg:items-start">
          <div className="lg:col-span-7">
            <div className="overflow-hidden rounded-xl border border-[var(--border)] bg-[var(--surface)]">
              <div className="flex flex-wrap items-center justify-between gap-2 border-b border-[var(--border)] bg-[var(--surface-muted)] px-3 py-2">
                <div
                  role="tablist"
                  aria-label="Self-hosting command options"
                  className="inline-flex gap-1"
                >
                  {DEPLOY_TAB_ORDER.map((tabId, index) => {
                    const selected = activeTab === tabId;
                    return (
                      <button
                        key={tabId}
                        ref={(el) => {
                          tabRefs.current[index] = el;
                        }}
                        type="button"
                        role="tab"
                        id={`deploy-tab-${tabId}`}
                        aria-selected={selected}
                        aria-controls={`deploy-panel-${tabId}`}
                        tabIndex={selected ? 0 : -1}
                        onClick={() => {
                          setActiveTab(tabId);
                          setCopied(false);
                        }}
                        onKeyDown={(e) => handleTabKeyDown(e, index)}
                        className={`whitespace-nowrap rounded-md px-3 py-1.5 font-mono text-xs font-medium transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--accent)] ${
                          selected
                            ? "bg-[var(--surface)] text-[var(--ink)] shadow-xs"
                            : "text-[var(--ink-muted)] hover:text-[var(--ink)]"
                        }`}
                      >
                        {COMMANDS[tabId].label}
                      </button>
                    );
                  })}
                </div>

                <div className="flex items-center gap-2">
                  <span
                    aria-live="polite"
                    className="font-mono text-xs text-[var(--accent)]"
                  >
                    {copied ? "Copied" : ""}
                  </span>
                  <button
                    type="button"
                    onClick={handleCopy}
                    className="inline-flex items-center gap-1.5 whitespace-nowrap rounded-md border border-[var(--border)] bg-[var(--surface)] px-2.5 py-1 text-xs font-medium text-[var(--ink)] transition-colors hover:bg-[var(--bg)] active:scale-[0.98] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--accent)]"
                  >
                    {copied ? (
                      <Check
                        className="size-3.5 text-[var(--accent)]"
                        aria-hidden="true"
                      />
                    ) : (
                      <Copy className="size-3.5" aria-hidden="true" />
                    )}
                    <span>{copied ? "Copied" : "Copy"}</span>
                  </button>
                </div>
              </div>

              <div
                role="tabpanel"
                id={`deploy-panel-${activeTab}`}
                aria-labelledby={`deploy-tab-${activeTab}`}
                className="bg-[#11181C] p-5 text-[#EDF2EF] [color-scheme:dark]"
              >
                <pre
                  tabIndex={0}
                  aria-label={`${COMMANDS[activeTab].label} ${COMMANDS[activeTab].isPrompt ? "prompt" : "command"}`}
                  className={`rounded font-mono text-[13px] leading-relaxed focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#6EE7B7] ${
                    COMMANDS[activeTab].isPrompt
                      ? "whitespace-pre-wrap break-words"
                      : "overflow-x-auto [scrollbar-color:#334155_transparent] [scrollbar-width:thin]"
                  }`}
                >
                  <code>
                    {!COMMANDS[activeTab].isPrompt && (
                      <span className="select-none text-[#6EE7B7]">$ </span>
                    )}
                    {COMMANDS[activeTab].command}
                  </code>
                </pre>
              </div>
            </div>

            {COMMANDS[activeTab].isPrompt ? (
              <p className="mt-3.5 text-sm leading-relaxed text-[var(--ink-muted)]">
                Paste into Antigravity, Claude Code, Codex, or Cursor. Uses{" "}
                <a
                  href="./llms.txt"
                  className="font-mono text-xs text-[var(--ink)] underline underline-offset-2 hover:text-[var(--accent)]"
                >
                  /llms.txt
                </a>{" "}
                with safe prerequisite checks.
              </p>
            ) : (
              <p className="mt-3.5 text-sm leading-relaxed text-[var(--ink-muted)]">
                First boot automatically generates{" "}
                <code className="rounded bg-[var(--surface-muted)] px-1.5 py-0.5 text-xs text-[var(--ink)]">
                  MASTER_KEY
                </code>{" "}
                at{" "}
                <code className="rounded bg-[var(--surface-muted)] px-1.5 py-0.5 text-xs text-[var(--ink)]">
                  DATA_DIR/.master.key
                </code>{" "}
                and reminds operators to move it into environment variables for
                production.
              </p>
            )}
          </div>

          <div className="space-y-6 lg:col-span-5">
            {HIGHLIGHTS.map((item) => {
              const Icon = item.icon;
              return (
                <div key={item.title} className="flex items-start gap-4">
                  <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg border border-[var(--border)] bg-[var(--surface)] text-[var(--accent)]">
                    <Icon className="size-5" aria-hidden="true" />
                  </div>
                  <div>
                    <h3 className="font-display text-base font-semibold text-[var(--ink)]">
                      {item.title}
                    </h3>
                    <p className="mt-1 text-sm leading-relaxed text-[var(--ink-muted)]">
                      {item.description}
                    </p>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      </div>
    </section>
  );
}
