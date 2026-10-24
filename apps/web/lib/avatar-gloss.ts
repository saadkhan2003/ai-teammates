function channel(hex: string, index: number) {
  return Number.parseInt(hex.slice(1 + index * 2, 3 + index * 2), 16);
}

export function mixHex(from: string, to: string, amount: number) {
  const t = Math.min(1, Math.max(0, amount));
  const mixed = [0, 1, 2].map((index) => Math.round(channel(from, index) + (channel(to, index) - channel(from, index)) * t));
  return `#${mixed.map((value) => value.toString(16).padStart(2, "0")).join("")}`;
}

function luminance(hex: string) {
  const channels = [0, 1, 2].map((index) => channel(hex, index) / 255);
  return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
}

export type AvatarShades = {
  highlight: string;
  lift: string;
  core: string;
  rim: string;
};

/** Volume colours for one bot fill. Light mascots shade toward warm grey; saturated ones lift toward white. */
export function avatarShades(fill: string): AvatarShades {
  const light = luminance(fill) > 0.72;
  return {
    highlight: mixHex(fill, "#ffffff", light ? 0.25 : 0.62),
    lift: mixHex(fill, "#ffffff", light ? 0.08 : 0.3),
    core: mixHex(fill, light ? "#6a615b" : "#12080c", light ? 0.58 : 0.5),
    rim: mixHex(fill, "#ffffff", light ? 0.4 : 0.78),
  };
}
