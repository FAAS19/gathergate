import { useEffect, useRef, useState } from "react";
import poster480 from "../assets/media/gathergate-demo-poster-480.webp";
import poster768 from "../assets/media/gathergate-demo-poster-768.webp";
import { ArrowRight, PlayFill, X } from "./Icons";

export function ProductFilmSection() {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const closeButtonRef = useRef<HTMLButtonElement | null>(null);
  const dialogRef = useRef<HTMLDialogElement | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!open || !dialog) return;

    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";

    if (!dialog.open) {
      dialog.showModal();
    }
    void videoRef.current?.play().catch(() => {});

    return () => {
      document.body.style.overflow = prevOverflow;
      if (dialog.open) {
        dialog.close();
      }
    };
  }, [open]);

  function closeModal() {
    videoRef.current?.pause();
    setOpen(false);
    requestAnimationFrame(() => {
      triggerRef.current?.focus();
    });
  }

  return (
    <section
      id="watch"
      aria-labelledby="watch-heading"
      className="pb-14 lg:pb-20"
    >
      <div className="mx-auto max-w-[1280px] px-4 sm:px-6 lg:px-8">
        <div className="rounded-2xl border border-[var(--border)] bg-[var(--surface-muted)]/75 p-1.5 dark:bg-[var(--surface)]">
          <div className="stage-dot-grid group relative flex w-full flex-col items-stretch gap-5 overflow-hidden rounded-xl border border-[var(--stage-border)] bg-[var(--stage-bg)] p-4 text-left transition-colors duration-200 hover:border-[var(--stage-accent)]/50 has-[button:focus-visible]:outline-2 has-[button:focus-visible]:outline-offset-2 has-[button:focus-visible]:outline-[var(--accent)] sm:flex-row sm:items-center sm:gap-7 sm:p-5 lg:gap-10 lg:p-6">
            <div className="relative aspect-video w-full shrink-0 overflow-hidden rounded-lg border border-[var(--stage-border)] bg-[var(--stage-bg)] sm:w-[272px] md:w-[320px] lg:w-[368px]">
              <img
                src={poster768}
                srcSet={`${poster480} 480w, ${poster768} 768w`}
                sizes="(min-width: 1024px) 368px, (min-width: 768px) 320px, (min-width: 640px) 272px, 92vw"
                alt=""
                width={768}
                height={432}
                loading="eager"
                decoding="async"
                className="block h-full w-full object-cover transition-transform duration-500 motion-safe:group-hover:scale-[1.03]"
              />
              <span
                aria-hidden="true"
                className="pointer-events-none absolute inset-0 bg-black/25 transition-colors duration-300 group-hover:bg-black/15"
              />
              <span
                aria-hidden="true"
                className="pointer-events-none absolute top-1/2 left-1/2 flex h-12 w-12 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full border border-white/25 bg-[var(--stage-bg)]/85 text-[var(--stage-ink)] shadow-xl backdrop-blur-md transition-all duration-200 motion-safe:group-hover:scale-110 group-hover:border-[var(--stage-accent)] group-hover:bg-[var(--stage-accent)] group-hover:text-[var(--stage-accent-ink)]"
              >
                <PlayFill
                  className="size-5 translate-x-[1px]"
                  aria-hidden="true"
                />
              </span>
            </div>

            <div className="flex min-w-0 flex-1 flex-col justify-center py-0.5">
              <span className="font-mono text-xs tracking-[0.08em] text-[var(--stage-accent)]">
                PRODUCT WALKTHROUGH · 0:51
              </span>
              <h2
                id="watch-heading"
                className="mt-2 font-display text-xl font-semibold tracking-[-0.02em] text-[var(--stage-ink)] sm:text-2xl lg:text-[1.625rem]"
              >
                See GatherGate in action
              </h2>
              <p className="mt-2 max-w-[54ch] text-sm leading-relaxed text-[var(--stage-ink-muted)] sm:text-[0.9375rem]">
                Passwordless magic link, live ATO ABN checksums, per-record
                AES-256-GCM encryption, and keyboard-first review in one
                container.
              </p>
              <div className="mt-4">
                <button
                  ref={triggerRef}
                  type="button"
                  onClick={() => setOpen(true)}
                  aria-haspopup="dialog"
                  className="inline-flex cursor-pointer items-center gap-2 rounded-md text-sm font-medium text-[var(--stage-ink)] transition-colors after:absolute after:inset-0 after:content-[''] group-hover:text-[var(--stage-accent)] focus-visible:outline-none"
                >
                  <span>Watch demo</span>
                  <ArrowRight
                    className="size-4 transition-transform duration-200 motion-safe:group-hover:translate-x-1"
                    aria-hidden="true"
                  />
                </button>
              </div>
            </div>
          </div>
        </div>
      </div>

      {open && (
        <dialog
          ref={dialogRef}
          aria-labelledby="video-modal-title"
          onKeyDown={(e) => {
            if (
              e.key === "Tab" &&
              e.shiftKey &&
              document.activeElement === closeButtonRef.current
            ) {
              e.preventDefault();
              videoRef.current?.focus();
            }
          }}
          onCancel={(e) => {
            e.preventDefault();
            if (document.fullscreenElement) return;
            closeModal();
          }}
          onClick={(e) => {
            if (e.target === dialogRef.current) closeModal();
          }}
          className="m-auto flex max-h-[calc(100dvh-2rem)] w-[min(1040px,calc(100vw-2rem))] flex-col overflow-hidden rounded-2xl border border-[var(--stage-border)] bg-[var(--stage-bg)] p-0 text-[var(--stage-ink)] shadow-2xl backdrop:bg-black/80 backdrop:backdrop-blur-md"
        >
          <div className="flex shrink-0 items-center justify-between gap-4 border-b border-[var(--stage-border)] px-4 py-3 sm:px-5">
            <div className="flex items-center gap-2.5">
              <h3
                id="video-modal-title"
                className="font-display text-sm font-semibold text-[var(--stage-ink)]"
              >
                GatherGate product demo
              </h3>
              <span className="font-mono text-xs text-[var(--stage-ink-muted)]">
                0:51
              </span>
            </div>

            <button
              ref={closeButtonRef}
              type="button"
              onClick={closeModal}
              aria-label="Close video"
              className="inline-flex h-8 w-8 cursor-pointer items-center justify-center rounded-full border border-[var(--stage-border)] bg-[var(--stage-surface)] text-[var(--stage-ink)] transition-colors hover:bg-white/15 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--stage-accent)]"
            >
              <X className="size-4" aria-hidden="true" />
            </button>
          </div>

          <video
            ref={videoRef}
            controls
            autoPlay
            playsInline
            preload="auto"
            poster="./media/gathergate-demo-poster.webp"
            aria-label="GatherGate 51-second product walkthrough"
            className="block aspect-video min-h-0 w-full max-h-[calc(100dvh-5.75rem)] bg-[var(--stage-bg)] object-contain"
          >
            <source
              src="./media/gathergate-demo.mp4"
              type="video/mp4"
            />
            <track
              kind="captions"
              src="./media/gathergate-demo.vtt"
              srcLang="en"
              label="English captions"
              default
            />
          </video>
        </dialog>
      )}
    </section>
  );
}
