export function BrandMark({ size = "md" }: { size?: "sm" | "md" }) {
  const dimensions = size === "sm" ? "h-5 w-5" : "h-6 w-6";

  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 28 28"
      fill="none"
      className={`${dimensions} shrink-0`}
      aria-hidden="true"
    >
      <rect fill="var(--accent)" x="1" y="1" width="26" height="26" rx="7" />
      <path
        d="M9.5 8.5H8a1 1 0 0 0-1 1v9a1 1 0 0 0 1 1h1.5M18.5 8.5H20a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1h-1.5"
        stroke="#FFFFFF"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M11 14.25 13.1 16.35 17.25 11.75"
        stroke="#FFFFFF"
        strokeWidth="2.1"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
