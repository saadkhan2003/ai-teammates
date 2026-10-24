import { avatarShades } from "@/lib/avatar-gloss";

export function GlossyBlob({ path, fill, className, idPrefix }: { path: string; fill: string; className?: string; idPrefix: string }) {
  const shades = avatarShades(fill);
  const body = `${idPrefix}-body`;
  const rim = `${idPrefix}-rim`;
  const clip = `${idPrefix}-clip`;
  return (
    <g className={className}>
      <defs>
        <radialGradient id={body} cx="32%" cy="28%" r="76%">
          <stop offset="0%" stopColor={shades.highlight} />
          <stop offset="36%" stopColor={shades.lift} />
          <stop offset="64%" stopColor={fill} />
          <stop offset="100%" stopColor={shades.core} />
        </radialGradient>
        <radialGradient id={rim} cx="48%" cy="42%" r="58%">
          <stop offset="68%" stopColor="#ffffff" stopOpacity="0" />
          <stop offset="88%" stopColor={shades.rim} stopOpacity="0.9" />
          <stop offset="100%" stopColor={shades.core} stopOpacity="0.45" />
        </radialGradient>
        <clipPath id={clip}>
          <path d={path} />
        </clipPath>
      </defs>
      <g clipPath={`url(#${clip})`}>
        <path d={path} fill={`url(#${body})`} />
        <ellipse cx="34" cy="30" rx="20" ry="12" fill="#ffffff" fillOpacity="0.42" />
        <ellipse cx="66" cy="74" rx="26" ry="16" fill={shades.core} fillOpacity="0.32" />
        <path d={path} fill={`url(#${rim})`} />
      </g>
    </g>
  );
}

export function AvatarEyes() {
  return (
    <>
      <ellipse cx="39" cy="47" rx="5.2" ry="8.2" fill="#171717" transform="rotate(-14 39 47)" />
      <circle cx="37.2" cy="43.2" r="1.8" fill="#ffffff" fillOpacity="0.95" />
      <ellipse cx="62" cy="47" rx="5.2" ry="8.2" fill="#171717" transform="rotate(-14 62 47)" />
      <circle cx="60.2" cy="43.2" r="1.8" fill="#ffffff" fillOpacity="0.95" />
    </>
  );
}

export function ContactShadow({ idPrefix }: { idPrefix: string }) {
  return (
    <>
      <defs>
        <filter id={`${idPrefix}-ground`} x="-40%" y="-80%" width="180%" height="260%">
          <feGaussianBlur stdDeviation="1.2" />
        </filter>
      </defs>
      <ellipse data-avatar-part="shadow" cx="50" cy="90" rx="20" ry="3.6" fill="#000000" fillOpacity="0.22" filter={`url(#${idPrefix}-ground)`} />
    </>
  );
}
