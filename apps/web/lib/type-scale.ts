/** Grok-style type scale. Sizes are the Tailwind `text-*` utilities. */
export type TypeToken = {
  fontSize: string;
  lineHeight: string;
  letterSpacing: string;
  /** 380 body, 450 labels, 600 headings. Nothing uses 500 or 700. */
  fontWeight: 380 | 450 | 600;
};

export const typeScale = {
  micro: { fontSize: "11px", lineHeight: "14px", letterSpacing: "0.03em", fontWeight: 380 },
  meta: { fontSize: "12px", lineHeight: "16px", letterSpacing: "0.02em", fontWeight: 380 },
  ui: { fontSize: "13px", lineHeight: "18px", letterSpacing: "-0.08px", fontWeight: 380 },
  bodySm: { fontSize: "14px", lineHeight: "20px", letterSpacing: "-0.08px", fontWeight: 380 },
  body: { fontSize: "15px", lineHeight: "22px", letterSpacing: "-0.08px", fontWeight: 380 },
  lead: { fontSize: "16px", lineHeight: "24px", letterSpacing: "-0.08px", fontWeight: 380 },
  title: { fontSize: "18px", lineHeight: "24px", letterSpacing: "-0.08px", fontWeight: 600 },
  h2: { fontSize: "22px", lineHeight: "28px", letterSpacing: "-0.44px", fontWeight: 600 },
  h1: { fontSize: "28px", lineHeight: "36px", letterSpacing: "-0.44px", fontWeight: 600 },
  h1Large: { fontSize: "30px", lineHeight: "36px", letterSpacing: "-0.44px", fontWeight: 600 },
  display: { fontSize: "36px", lineHeight: "40px", letterSpacing: "-0.44px", fontWeight: 600 },
} as const satisfies Record<string, TypeToken>;

export type TypeScaleName = keyof typeof typeScale;

/** Tailwind `fontSize` keys. `text-body` is the chat size. */
export const typeScaleUtilities = {
  micro: "micro",
  meta: "meta",
  ui: "ui",
  "body-sm": "bodySm",
  body: "body",
  lead: "lead",
  title: "title",
  h2: "h2",
  h1: "h1",
  "h1-lg": "h1Large",
  display: "display",
} as const satisfies Record<string, TypeScaleName>;

export function tailwindFontSize(): Record<string, [string, { lineHeight: string; letterSpacing: string; fontWeight: string }]> {
  const scale: Record<string, [string, { lineHeight: string; letterSpacing: string; fontWeight: string }]> = {};
  for (const [utility, token] of Object.entries(typeScaleUtilities)) {
    const face = typeScale[token];
    scale[utility] = [face.fontSize, { lineHeight: face.lineHeight, letterSpacing: face.letterSpacing, fontWeight: String(face.fontWeight) }];
  }
  scale.xs = scale.meta;
  scale.sm = scale["body-sm"];
  scale.base = scale.lead;
  scale.lg = scale.title;
  scale.xl = scale.h2;
  scale["2xl"] = scale.h1;
  scale["3xl"] = scale.display;
  scale["4xl"] = scale.display;
  return scale;
}
