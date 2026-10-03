/** Ring and screen-reader meter shared by the Claude and Codex context indicators. */
export function ContextUsageRing({ percent }: { percent: number | null }) {
  return <svg viewBox="0 0 18 18" aria-hidden="true">
    <circle className="codex-context-track" cx="9" cy="9" r="7" />
    <circle
      className="codex-context-value"
      cx="9"
      cy="9"
      r="7"
      pathLength="100"
      strokeDasharray="100"
      strokeDashoffset={100 - (percent ?? 0)}
    />
  </svg>
}

export function ContextUsageMeter({ id, label, percent, text }: {
  id: string
  label: string
  percent: number | null
  text: string
}) {
  return <span
    id={id}
    className="sr-only"
    role="progressbar"
    aria-label={label}
    aria-valuemin={0}
    aria-valuemax={100}
    aria-valuenow={percent ?? undefined}
    aria-valuetext={text}
  >{text}</span>
}
