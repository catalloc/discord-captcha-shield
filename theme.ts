/**
 * Branding + theme for the Discord CAPTCHA Shield.
 *
 * This is the ONE file you edit to make the template your own. It replaces the
 * site-specific `core/` dependencies the original was coupled to, so the shield
 * ships fully self-contained. Swap the colors, logo, copy, and rules below and
 * the portal page, the OG card, and every Discord embed re-skin together.
 *
 * Ships themed for `catalloc` — a warm "tabby" palette and cat-flavored copy —
 * as a worked example. Replace it with yours.
 */

// ========================================
// BRAND
// ========================================

export const brand = {
  /** Display name. The DISCORD/portal env var VERIFY_SERVER_NAME overrides this
   *  at runtime, so you can reuse one template for several servers. */
  name: "catalloc",

  /** Headline + tagline rendered onto the social (OG) card. */
  ogHeadline: "ARE YOU HUMAN?",
  ogTagline: "Solve a quick CAPTCHA to unlock the Discord",

  /** Square logo (≈300px+). Shown on the portal card, the OG card, and the
   *  rules embed thumbnail. Defaults to a placeholder cat — swap for your own. */
  logoUrl: "https://placecats.com/300/300",

  /** Accent color — drives buttons, the portal header bar, and embed stripes.
   *  `embedColor` is the same color as a Discord-friendly integer (0xRRGGBB). */
  accentColor: "#F4A340", // tabby orange
  accentColorBright: "#FFC15E",
  embedColor: 0xf4a340,

  /** Shown by crawlers before the cron first generates /og.png. */
  ogFallbackImage: "https://placecats.com/1200/630",
};

// ========================================
// RULES (posted by post-rules.ts)
// ========================================

export interface Rule {
  name: string;
  value: string;
}

/** Server rules rendered into the rules embed. Rewrite for your community. */
export const rules: Rule[] = [
  {
    name: "1. BE KIND",
    value:
      "We're here to have a good time. If you have a problem with someone, try to sort it out civilly — and if that fails, ping a mod and we'll help mediate.",
  },
  {
    name: "2. KEEP IT ON-TOPIC",
    value:
      "No politics or hot-button drama. There are plenty of places on the internet for that; this isn't one of them.",
  },
  {
    name: "3. NO HATE SPEECH",
    value:
      "Everyone is welcome here. Zero tolerance for racism, sexism, homophobia, or hate speech of any kind.",
  },
  {
    name: "4. NO NSFW / NSFL CONTENT",
    value:
      "Don't post vulgar, obscene, or explicit content. Keep it SFW (cat pictures excepted).",
  },
  {
    name: "5. NO SPAM OR SELF-PROMO",
    value:
      "Don't flood channels, mass-DM members, or drop unsolicited invite links. Ask a mod before promoting anything.",
  },
  {
    name: "6. RESPECT THE MODS",
    value:
      "Mods enforce these rules as needed. Most violations get a warning; extreme or repeat cases may result in a ban.",
  },
];

// ========================================
// ABOUT (posted by post-about.ts)
// ========================================

export interface AboutInfo {
  /** One-line hook under the title. */
  tagline: string;
  /** A paragraph (or two) describing the community. Markdown is allowed. */
  description: string;
  /** Optional bullet-style highlights rendered as embed fields. */
  highlights: Rule[];
}

/**
 * The "About" card the bot posts into a DMZ channel (one unverified members can
 * see) so newcomers know what they're joining before they verify. Rewrite for
 * your community.
 */
export const about: AboutInfo = {
  tagline: "A cozy corner of the internet for cat people. 🐾",
  description:
    "**catalloc** is a laid-back community built around good vibes, good company, and an unreasonable number of cat pictures. Whether you're here to hang out, share your projects, or just lurk with a coffee, you're welcome.\n\nVerification keeps the bots and raiders out — pass a quick CAPTCHA and the rest of the server opens up.",
  highlights: [
    { name: "💬 Active chat", value: "Always someone around to talk to." },
    { name: "🐱 Cat tax", value: "Pictures of your cat are strongly encouraged." },
    { name: "🛡️ Bot-free", value: "CAPTCHA-gated so it stays human." },
  ],
};

// ========================================
// STYLES (replaces core/styles.tsx getAllStyles)
// ========================================

/**
 * All CSS the portal needs, self-contained. Maps the brand accent onto theme
 * variables and ships the small `.btn` + portal layout the page references.
 * Soft, rounded, cat-friendly — no external stylesheet required.
 */
export function portalCss(): string {
  return `
  :root {
    --accent: ${brand.accentColor};
    --accent-bright: ${brand.accentColorBright};
    --bg: #0E0D0B;
    --surface: #1C1A17;
    --surface-2: #2A2722;
    --text: #F5F1EA;
    --muted: rgba(245,241,234,0.65);
  }

  * { margin: 0; padding: 0; box-sizing: border-box; }
  html { scroll-behavior: smooth; }
  body {
    font-family: 'Quicksand', system-ui, sans-serif;
    background-color: var(--bg);
    color: var(--text);
    -webkit-font-smoothing: antialiased;
  }

  .btn {
    font-family: 'Quicksand', sans-serif;
    font-size: 1rem;
    font-weight: 600;
    letter-spacing: 1px;
    text-decoration: none;
    padding: 0.9rem 2rem;
    border: none;
    border-radius: 14px;
    cursor: pointer;
    transition: all 0.25s ease;
  }
  .btn-primary {
    background: linear-gradient(135deg, var(--accent), var(--accent-bright));
    color: #1a1206;
  }
  .btn-primary:hover {
    transform: translateY(-2px);
    box-shadow: 0 10px 28px rgba(244,163,64,0.35);
  }
  .btn-secondary {
    background: transparent;
    color: var(--text);
    border: 2px solid var(--accent);
  }
  .btn-secondary:hover {
    background: rgba(244,163,64,0.12);
    transform: translateY(-2px);
  }

  .verify-wrap {
    min-height: 100vh;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 24px;
    background:
      radial-gradient(ellipse at 50% 0%, rgba(244,163,64,0.16) 0%, transparent 60%),
      linear-gradient(160deg, #0E0D0B 0%, #15120E 60%, #0E0D0B 100%);
  }
  .verify-card {
    width: 100%;
    max-width: 440px;
    background: linear-gradient(150deg, var(--surface-2), var(--surface));
    border: 1px solid rgba(244,163,64,0.22);
    padding: 2.5rem 2rem;
    position: relative;
    overflow: hidden;
    text-align: center;
    border-radius: 24px;
    box-shadow: 0 24px 60px rgba(0,0,0,0.55);
  }
  .verify-card::before {
    content: '';
    position: absolute;
    top: 0; left: 0; right: 0;
    height: 4px;
    background: linear-gradient(90deg, var(--accent), var(--accent-bright), var(--accent));
  }
  .verify-logo {
    width: 92px;
    height: 92px;
    object-fit: cover;
    border-radius: 50%;
    margin: 0 auto 1.25rem;
    border: 3px solid rgba(244,163,64,0.5);
    box-shadow: 0 0 26px rgba(244,163,64,0.4);
  }
  .verify-card h1 {
    font-family: 'Fredoka', sans-serif;
    font-weight: 600;
    font-size: 2.1rem;
    letter-spacing: 1px;
    line-height: 1.05;
    margin-bottom: 0.4rem;
  }
  .verify-sub {
    font-weight: 600;
    font-size: 0.8rem;
    letter-spacing: 1.5px;
    text-transform: uppercase;
    color: var(--accent);
    margin-bottom: 1.75rem;
  }
  .verify-steps {
    list-style: none;
    text-align: left;
    max-width: 300px;
    margin: 0 auto 1.75rem;
    display: grid;
    gap: 0.65rem;
  }
  .verify-steps li {
    display: flex;
    align-items: center;
    gap: 0.8rem;
    font-size: 0.92rem;
    color: var(--muted);
  }
  .verify-steps .n {
    flex: none;
    width: 28px;
    height: 28px;
    background: var(--accent);
    color: #1a1206;
    font-family: 'Fredoka', sans-serif;
    font-weight: 600;
    font-size: 0.95rem;
    display: grid;
    place-items: center;
    border-radius: 50%;
  }
  .cf-holder {
    display: flex;
    justify-content: center;
    min-height: 70px;
    margin-bottom: 1.5rem;
  }
  .btn-block { width: 100%; display: inline-flex; align-items: center; justify-content: center; gap: 0.6rem; }
  .btn-block svg { width: 20px; height: 20px; }
  .btn:disabled { opacity: 0.4; cursor: not-allowed; transform: none !important; box-shadow: none !important; }
  .verify-err {
    display: none;
    margin-top: 1.1rem;
    color: var(--text);
    background: rgba(244,163,64,0.12);
    border: 1px solid rgba(244,163,64,0.4);
    border-radius: 12px;
    padding: 0.7rem 0.9rem;
    font-size: 0.85rem;
    line-height: 1.5;
  }
  .verify-foot {
    margin-top: 1.75rem;
    color: rgba(245,241,234,0.35);
    font-size: 0.7rem;
    letter-spacing: 1px;
    text-transform: uppercase;
  }
  .result-badge {
    width: 84px;
    height: 84px;
    margin: 0 auto 1.5rem;
    display: grid;
    place-items: center;
    border-radius: 50%;
    font-size: 2.6rem;
    line-height: 1;
  }
  .result-badge.ok { background: rgba(74,176,108,0.15); color: #4ab06c; border: 2px solid #4ab06c; }
  .result-badge.bad { background: rgba(244,163,64,0.15); color: var(--accent-bright); border: 2px solid var(--accent); }
  .result-msg { color: var(--muted); line-height: 1.7; font-size: 1.05rem; }
  .result-link { margin-top: 1.5rem; }
`;
}
