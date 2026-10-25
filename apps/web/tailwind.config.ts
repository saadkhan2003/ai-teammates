import type { Config } from "tailwindcss";
import { tailwindFontSize } from "./lib/type-scale";

const config: Config = {
  darkMode: ["class"],
  content: ["./app/**/*.{ts,tsx}", "./components/**/*.{ts,tsx}"],
  theme: {
    extend: {
      transitionDuration: { fast: "var(--motion-fast)", base: "var(--motion-base)", slow: "var(--motion-slow)" },
      transitionTimingFunction: { out: "var(--ease-out)", spring: "var(--ease-spring)" },
      colors: {
        bg: "var(--background)",
        ink: "var(--foreground)",
        paper: "var(--card)",
        line: "var(--border)",
        clay: "var(--destructive)",
        bot: {
          DEFAULT: "var(--bot-accent)",
          foreground: "var(--bot-accent-fg)",
          text: "var(--bot-accent-text)",
          soft: "var(--bot-accent-soft)",
          border: "var(--bot-accent-border)",
        },
        sage: "var(--sage)",
        info: { DEFAULT: "var(--info)", soft: "var(--info-soft)" },
        success: { DEFAULT: "var(--success)", soft: "var(--success-soft)" },
        warning: { DEFAULT: "var(--warning)", soft: "var(--warning-soft)" },
        terminal: { DEFAULT: "var(--terminal)", foreground: "var(--terminal-foreground)", muted: "var(--terminal-muted)" },
        "sage-soft": "var(--sage-soft)",
        copper: "var(--brand)",
        "copper-deep": "var(--brand)",
        brand: "var(--brand)",
        background: "var(--background)",
        foreground: "var(--foreground)",
        card: {
          DEFAULT: "var(--card)",
          foreground: "var(--card-foreground)",
        },
        popover: {
          DEFAULT: "var(--popover)",
          foreground: "var(--popover-foreground)",
        },
        primary: {
          DEFAULT: "var(--primary)",
          foreground: "var(--primary-foreground)",
        },
        secondary: {
          DEFAULT: "var(--secondary)",
          foreground: "var(--secondary-foreground)",
        },
        muted: {
          DEFAULT: "var(--muted)",
          foreground: "var(--muted-foreground)",
        },
        accent: {
          DEFAULT: "var(--accent)",
          foreground: "var(--accent-foreground)",
        },
        destructive: {
          DEFAULT: "var(--destructive)",
          foreground: "var(--destructive-foreground)",
        },
        border: "var(--border)",
        input: "var(--input)",
        ring: "var(--ring)",
        "on-accent": "var(--on-accent)",
        overlay: "var(--overlay)",
        "user-bubble": {
          DEFAULT: "var(--user-bubble)",
          foreground: "var(--user-bubble-foreground)",
        },
        "assistant-bubble": {
          DEFAULT: "var(--assistant-bubble)",
          foreground: "var(--assistant-bubble-foreground)",
        },
        chart: {
          "1": "var(--chart-1)",
          "2": "var(--chart-2)",
          "3": "var(--chart-3)",
          "4": "var(--chart-4)",
          "5": "var(--chart-5)",
        },
        sidebar: {
          DEFAULT: "var(--sidebar)",
          foreground: "var(--sidebar-foreground)",
          primary: "var(--sidebar-primary)",
          "primary-foreground": "var(--sidebar-primary-foreground)",
          accent: "var(--sidebar-accent)",
          "accent-foreground": "var(--sidebar-accent-foreground)",
          border: "var(--sidebar-border)",
          ring: "var(--sidebar-ring)",
        },
      },
      fontFamily: {
        sans: ["var(--font-sans)"],
        display: ["var(--font-sans)"],
        mono: ["var(--font-mono)"],
      },
      fontWeight: {
        normal: "380",
        medium: "450",
        semibold: "600",
        bold: "600",
      },
      fontSize: tailwindFontSize(),
      borderRadius: {
        sm: "var(--radius-control)",
        md: "var(--radius-control)",
        lg: "var(--radius-card)",
        xl: "var(--radius-card)",
        "2xl": "var(--radius-bubble-user)",
        "3xl": "var(--radius-dialog)",
        card: "var(--radius-card)",
        menu: "var(--radius-menu)",
        dialog: "var(--radius-dialog)",
        control: "var(--radius-control)",
        pill: "var(--radius-pill)",
        chip: "var(--radius-chip)",
        bubble: "var(--radius-bubble)",
        avatar: "var(--radius-avatar)",
        full: "var(--radius-pill)",
      },
    },
  },
  plugins: [require("tailwindcss-animate")],
};

export default config;
