import type { ReactNode } from 'react';

// Inline SVG icons on a 16px grid, drawn in the text colour (no icon font, nothing fetched). Decorative: the
// control that holds one carries the name.

export interface IconProps {
  /** Width and height, px. */
  size?: number;
  className?: string;
}

function Svg({ size = 16, className, children }: IconProps & { children: ReactNode }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.6}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      className={className}
    >
      {children}
    </svg>
  );
}

export const CheckIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M3.5 8.5l3 3 6-7" />
  </Svg>
);

export const XIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M4.5 4.5l7 7M11.5 4.5l-7 7" />
  </Svg>
);

/** Jump to the text. */
export const TargetIcon = (p: IconProps) => (
  <Svg {...p}>
    <circle cx="8" cy="8" r="4.5" />
    <circle cx="8" cy="8" r="1.25" fill="currentColor" stroke="none" />
    <path d="M8 1.5v2M8 12.5v2M1.5 8h2M12.5 8h2" />
  </Svg>
);

/** More actions (⋯). */
export const DotsIcon = (p: IconProps) => (
  <Svg {...p}>
    <circle cx="3.5" cy="8" r="1.3" fill="currentColor" stroke="none" />
    <circle cx="8" cy="8" r="1.3" fill="currentColor" stroke="none" />
    <circle cx="12.5" cy="8" r="1.3" fill="currentColor" stroke="none" />
  </Svg>
);

export const ChevronDownIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M4.5 6.5L8 10l3.5-3.5" />
  </Svg>
);

/** An AI rewrite. */
export const SparkleIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M6.5 2.5c.45 2.6 1.4 3.55 4 4-2.6.45-3.55 1.4-4 4-.45-2.6-1.4-3.55-4-4 2.6-.45 3.55-1.4 4-4z" />
    <path d="M12.25 10.25v3.5M10.5 12h3.5" />
  </Svg>
);

export const CopyIcon = (p: IconProps) => (
  <Svg {...p}>
    <rect x="5.5" y="5.5" width="8" height="8" rx="1.75" />
    <path d="M10.5 3.25A1.75 1.75 0 0 0 8.75 2.5h-4.5A1.75 1.75 0 0 0 2.5 4.25v4.5c0 .8.55 1.5 1.25 1.7" />
  </Svg>
);

/** Swap, or other versions. */
export const ArrowLeftRightIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M2.5 5.5h11M10.5 2.5l3 3-3 3M13.5 10.5h-11M5.5 7.5l-3 3 3 3" />
  </Svg>
);
