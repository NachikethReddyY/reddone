import Link from "next/link";

export function BrandMark({ size = 38 }: { size?: number }) {
  return (
    <svg aria-hidden="true" className="brand-mark" height={size} viewBox="0 0 64 64" width={size}>
      <rect className="brand-mark-surface" height="62" rx="17" width="62" x="1" y="1" />
      <path className="brand-mark-orbit" d="M17 31.5c0-8.3 6.7-15 15-15 5.5 0 10.3 3 12.9 7.4l6.2-1.6" />
      <path className="brand-mark-smile-ring" d="M19.2 42.7c3 3.2 7.3 5.2 12.1 5.2 7.2 0 13.3-4.6 15.6-11" />
      <circle className="brand-mark-face" cx="27" cy="31" r="2.7" />
      <circle className="brand-mark-face" cx="38" cy="31" r="2.7" />
      <path className="brand-mark-face-line" d="M26 39c3.5 2.2 8.6 2.2 12.1 0" />
      <path className="brand-mark-antenna" d="M45 24l5.9-1.7 1.8-5.9" />
      <circle className="brand-mark-antenna-dot" cx="53.2" cy="15.5" r="3.2" />
      <path className="brand-mark-build" d="M13.5 47.5h10.8M13.5 53.5h24M43 52l7.5-7.5M50.5 44.5v6.7h-6.7" />
    </svg>
  );
}

export function Brand({ compact = false }: { compact?: boolean }) {
  return (
    <Link className="brand" href="/projects" aria-label="ReDDone projects">
      <span className="brand-mark-wrap"><BrandMark size={38} /></span>
      {!compact && (
        <span className="brand-type">
          <strong>ReDDone</strong>
          <small>EVIDENCE TO SOFTWARE</small>
        </span>
      )}
    </Link>
  );
}
