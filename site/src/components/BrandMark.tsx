export function BrandMark({ size = "md" }: { size?: "sm" | "md" }) {
  const dimensions = size === "sm" ? "h-5 w-5" : "h-7 w-7";

  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 32 32"
      fill="none"
      className={`${dimensions} shrink-0`}
      aria-hidden="true"
    >
      <path
        fill="var(--ink)"
        d="M4 6H12V10H8V22H12V26H4V6ZM28 6H20V10H24V22H20V26H28V6Z"
      />
      <rect fill="var(--accent)" x="14" y="10" width="4" height="12" rx="1" />
    </svg>
  );
}
