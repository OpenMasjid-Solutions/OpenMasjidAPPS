# OpenMasjidOS — App Design Language

> **Every OpenMasjidOS app should look and feel like part of the dashboard.** This is the full UI/UX
> spec: the **Sakīna Glass** material, color tokens, motion, the dock, components, voice, and
> accessibility. The polish target is umbrelOS; the visual language is masjid — calm, dignified,
> modern, never gaudy.
>
> **Source of truth:** the platform repo's
> [`packages/ui/src/styles/tokens.css`](https://github.com/hasan-ismail/OpenMasjidOS/blob/master/packages/ui/src/styles/tokens.css),
> [`glass.css`](https://github.com/hasan-ismail/OpenMasjidOS/blob/master/packages/ui/src/styles/glass.css),
> [`app.css`](https://github.com/hasan-ismail/OpenMasjidOS/blob/master/packages/ui/src/styles/app.css),
> and [`lib/motion.ts`](https://github.com/hasan-ismail/OpenMasjidOS/blob/master/packages/ui/src/lib/motion.ts).
> This doc mirrors them — if they change there, update here. Apps are **separate containers in any
> stack**, so everything below is plain CSS/values you can drop into a static site or any framework.

---

## 0. The fastest way to match: inherit appearance from the Fabric

Before hardcoding anything, consume the platform's live appearance (see
[BUILDING_AN_APP.md §7](./BUILDING_AN_APP.md)). The dashboard hands your app the viewer's prefs:

- **On open** — a URL fragment `#omos=<base64url JSON>` with `{ v, theme, wallpaper, wallpaperImage?, accent, lang }`.
- **Live** — `GET ${OPENMASJID_BASE_URL}/api/public/appearance` returns the same.

Apply them to the document and the tokens below render your app identically to the dashboard:

```js
// pseudo: after reading the omos prefs
document.documentElement.dataset.theme = prefs.theme === 'system'
  ? (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light')
  : prefs.theme;                       // 'dark' | 'light'
document.documentElement.dataset.wallpaper = prefs.wallpaper;   // e.g. 'aurora'
document.documentElement.dataset.accent = prefs.accent;         // e.g. 'cyan'
document.documentElement.lang = prefs.lang;                     // 'en' | 'ar' | …
document.documentElement.dir = ['ar', 'ur', 'fa'].includes(prefs.lang) ? 'rtl' : 'ltr';
```

Inheriting beats hardcoding: when the masjid recolors the dashboard, your app follows automatically.
**Dark is the default.** Always handle `theme: 'system'`.

---

## 1. Identity & principles

- **Calm, dignified, modern.** Inspired by Islamic geometric art (girih/khatam tessellations) and
  masjid architecture (domes, arches/mihrab, minarets, the crescent). Respectful and serene.
- **Dark is default**; light is first-class.
- **Meet WCAG AA** contrast in both themes.
- **RTL first-class** — Arabic/Urdu must render correctly (use logical CSS properties everywhere).
- **Always honor `prefers-reduced-motion`** — collapse to instant/opacity-only. Non-negotiable.
- **No hardcoded hex/px where a token exists.** Theme = one attribute swap (`data-theme`).
- **No sacred text as decoration.** Never place Quranic verses or sacred Arabic in spinners, loaders,
  or throwaway chrome. Keep decoration to geometric/architectural motifs.

---

## 2. Color tokens

Define as CSS custom properties; switch theme by toggling `data-theme` on `<html>`. Drop these in
verbatim.

```css
:root,
[data-theme="dark"] {
  color-scheme: dark;

  --color-surface: #030D1A;
  --color-surface-raised: #0A1828;
  --color-surface-overlay: #0F2040;
  --color-surface-hover: rgba(34, 211, 238, 0.07);
  --color-surface-shimmer: #0D2035;

  --color-primary: #22D3EE;            /* accent — swappable, see §2.1 */
  --color-primary-hover: #67E8F9;
  --color-primary-muted: #155E75;
  --color-primary-subtle: rgba(34, 211, 238, 0.12);

  --color-accent: #F59E0B;             /* warm gold, used sparingly for highlights */
  --color-gold: #F59E0B;
  --color-gold-subtle: rgba(245, 158, 11, 0.1);

  --color-ink: #F4F7FB;                /* near-white text */
  --color-ink-muted: #9FACC2;
  --color-ink-faint: #5C6B83;
  --color-border: rgba(148, 175, 210, 0.14);

  --color-success: #34D399;
  --color-warning: #FBBF24;
  --color-danger: #F87171;

  --shadow-card: 0 4px 24px rgba(0, 0, 0, 0.5);
  --shadow-modal: 0 8px 40px rgba(0, 0, 0, 0.7);
  --radius-card: 1rem;
  --radius-button: 0.625rem;

  --color-on-primary: #00131c;         /* text on a primary fill */
}

[data-theme="light"] {
  color-scheme: light;

  --color-surface: #F0F9FF;
  --color-surface-raised: #FFFFFF;
  --color-surface-overlay: #E0F2FE;
  --color-surface-hover: rgba(2, 132, 199, 0.06);
  --color-surface-shimmer: #BAE6FD;

  --color-primary: #0284C7;
  --color-primary-hover: #0369A1;
  --color-primary-muted: #BAE6FD;
  --color-primary-subtle: rgba(2, 132, 199, 0.1);

  --color-accent: #D97706;
  --color-gold: #D97706;
  --color-gold-subtle: rgba(217, 119, 6, 0.08);

  --color-ink: #0C4A6E;
  --color-ink-muted: #475569;
  --color-ink-faint: #94A3B8;
  --color-border: rgba(2, 132, 199, 0.12);

  --color-success: #16A34A;
  --color-warning: #D97706;
  --color-danger: #DC2626;

  --shadow-card: 0 4px 24px rgba(0, 0, 0, 0.08);
  --shadow-modal: 0 8px 40px rgba(0, 0, 0, 0.15);
  --radius-card: 1rem;
  --radius-button: 0.625rem;

  --color-on-primary: #FFFFFF;
}
```

### 2.1 Accent

`--color-primary` is the **accent** and is user-swappable on the platform (cyan is the default;
emerald and gold are offered). If you read `accent` from the Fabric, map it to the matching primary
hue; otherwise the cyan/blue defaults above are correct. Use **gold (`--color-accent`) sparingly** —
for active/important highlights only.

---

## 3. Sakīna Glass (the signature material)

Frosted, translucent panels over the ambient scene, with a faint specular edge. Three depths +
the dock. Token block first, then the recipes.

```css
:root, [data-theme="dark"] {
  --glass-blur: 16px;
  --glass-blur-inset: 9px;
  --glass-blur-strong: 28px;
  --glass-saturate: 165%;
  --glass-saturate-strong: 200%;
  --glass-bg: rgba(10, 24, 40, 0.55);
  --glass-bg-raised: rgba(15, 32, 64, 0.68);
  --glass-bg-inset: rgba(3, 13, 26, 0.45);
  --glass-tint: rgba(34, 211, 238, 0.06);
  --glass-highlight: rgba(186, 230, 253, 0.22);
  --glass-border: rgba(125, 200, 232, 0.14);
  --glass-glow: rgba(34, 211, 238, 0.10);
  --glint: rgba(255, 255, 255, 0.10);
  --glint-strong: rgba(255, 255, 255, 0.20);
  --glass-shadow:
    inset 0 1px 0 0 var(--glass-highlight),
    0 8px 28px -8px rgba(0, 0, 0, 0.6),
    0 0 0 1px var(--glass-border);
  --glass-shadow-raised:
    inset 0 1px 0 0 var(--glass-highlight),
    0 16px 48px -12px rgba(0, 0, 0, 0.7),
    0 0 28px -6px var(--glass-glow),
    0 0 0 1px var(--glass-border);
}
[data-theme="light"] {
  --glass-saturate: 140%;
  --glass-saturate-strong: 175%;
  --glass-bg: rgba(255, 255, 255, 0.55);
  --glass-bg-raised: rgba(255, 255, 255, 0.72);
  --glass-bg-inset: rgba(240, 249, 255, 0.60);
  --glass-tint: rgba(2, 132, 199, 0.04);
  --glass-highlight: rgba(255, 255, 255, 0.90);
  --glass-border: rgba(2, 132, 199, 0.16);
  --glass-glow: rgba(2, 132, 199, 0.08);
  --glint: rgba(255, 255, 255, 0.32);
  --glint-strong: rgba(255, 255, 255, 0.55);
}
```

```css
/* Raised panels/cards. --mx/--my are the cursor position (see §3.1); default off-screen. */
.glass-raised {
  position: relative;
  border-radius: var(--radius-card);
  background-image:
    radial-gradient(7rem at var(--mx, -200%) var(--my, -200%), var(--glint), transparent 55%),
    linear-gradient(var(--glass-tint), var(--glass-tint));
  background-color: var(--glass-bg-raised);
  -webkit-backdrop-filter: blur(var(--glass-blur)) saturate(var(--glass-saturate));
  backdrop-filter: blur(var(--glass-blur)) saturate(var(--glass-saturate));
  box-shadow: var(--glass-shadow-raised);
}
/* .glass — one step flatter: same recipe with --glass-bg + --glass-shadow. */
/* Inputs / wells: */
.glass-inset {
  border-radius: var(--radius-button);
  background-color: var(--glass-bg-inset);
  backdrop-filter: blur(var(--glass-blur-inset)) saturate(var(--glass-saturate));
  box-shadow: inset 0 1px 2px rgba(0, 0, 0, 0.25), 0 0 0 1px var(--glass-border);
}

/* The liquid-glass refractive edge: a 1px light-catching ring (bright top-left → faint). */
.glass-raised::after {
  content: ""; position: absolute; inset: 0; border-radius: inherit; padding: 1px;
  pointer-events: none;
  background: linear-gradient(135deg, rgba(255,255,255,.55), rgba(255,255,255,.05) 32%, transparent 52%, rgba(255,255,255,.12));
  -webkit-mask: linear-gradient(#000 0 0) content-box, linear-gradient(#000 0 0);
  -webkit-mask-composite: xor;
  mask: linear-gradient(#000 0 0) content-box, linear-gradient(#000 0 0);
  mask-composite: exclude;
  opacity: 0.65;
}

/* Fallback when backdrop-filter is unsupported — go opaque so text stays legible. */
@supports not ((backdrop-filter: blur(1px)) or (-webkit-backdrop-filter: blur(1px))) {
  .glass-raised { background-color: var(--color-surface-overlay); }
  .glass-inset  { background-color: var(--color-surface); }
}
```

### 3.1 Cursor refraction (optional, tasteful)

A small specular highlight that follows the pointer, painted **below** content so text never washes
out. Set `--mx/--my` from a rAF-throttled `pointermove`, **only on small panes** (cards, dock) — never
on large flat panels (it repaints the whole surface). Gate it behind `prefers-reduced-motion`.

### 3.2 Performance rules (important)

- **Never nest `backdrop-filter`** — a glass pane inside a glass pane must not re-blur. Strip the
  inner one's filter; opt back in only where truly needed.
- Animate **only** `transform` / `opacity` / `filter` (compositor-cheap). Never animate layout.

---

## 4. The ambient scene (wallpaper)

Glass needs something rich to sit over. The platform paints a fixed full-screen scene: a gradient,
slow-drifting "aurora" light pools, a low-opacity geometric khatam pattern, and a vignette. Apps that
fill the viewport (display/TV apps especially) should match it. The wallpaper id arrives via the
Fabric; expose it as `data-wallpaper` and override the gradient per preset.

```css
.scene { position: fixed; inset: 0; z-index: -1; background: var(--scene-gradient); overflow: hidden; }
.scene::before {                       /* aurora — transform-only, disabled under reduced-motion */
  content: ""; position: absolute; inset: -30%;
  background:
    radial-gradient(40% 50% at 20% 25%, var(--aurora-cyan), transparent 70%),
    radial-gradient(45% 55% at 80% 20%, var(--aurora-navy), transparent 70%),
    radial-gradient(50% 50% at 60% 85%, var(--aurora-gold), transparent 75%);
  filter: blur(var(--aurora-blur)); will-change: transform;
  animation: auroraDrift 32s ease-in-out infinite alternate;
}
@keyframes auroraDrift {
  0% { transform: translate3d(0,0,0) scale(1); }
  50% { transform: translate3d(2.5%,-2%,0) scale(1.08) rotate(1.2deg); }
  100% { transform: translate3d(-2%,2.5%,0) scale(1.04) rotate(-1deg); }
}
@media (prefers-reduced-motion: reduce) { .scene::before { animation: none; } }
```

Dark scene tokens: `--scene-base: #020912; --scene-gradient: linear-gradient(150deg,#0c3a4d,#082230 48%,#020a12); --aurora-cyan: rgba(34,211,238,.30); --aurora-navy: rgba(15,32,64,.60); --aurora-gold: rgba(245,158,11,.14); --aurora-blur: 48px;`
Preset wallpapers (`[data-wallpaper="ocean|twilight|berry|sunset|ember|forest|night|graphite"]`) just
override `--scene-gradient` + the three aurora colors — see the platform `tokens.css` for the full set.
A **custom image** wallpaper (`wallpaperImage`) drops the aurora + pattern and uses `background-size:
cover`. Always validate a custom image URL is `http(s)` before using it.

---

## 5. Typography

```css
:root {
  --font-sans: "Inter Variable", Inter, ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
  --font-display: "Space Grotesk Variable", "Space Grotesk", var(--font-sans);
}
body { font-family: var(--font-sans); color: var(--color-ink); -webkit-font-smoothing: antialiased; }
```

- **Body/UI:** Inter (or the system stack). **Headings only:** Space Grotesk, `letter-spacing:-0.02em`,
  weight 600. Self-host fonts (no external CDN).
- **Arabic/RTL:** bundle a good Naskh face for `lang="ar"`/`ur`. Tabular numerals for stats/clocks
  (`font-variant-numeric: tabular-nums`).
- Scale (reference): page title `1.9rem/600`, section/panel title `1.05–1.15rem/600`, body `1rem`,
  hints `0.8–0.85rem` in `--color-ink-muted`.
- **RTL:** use logical properties only — `margin-inline-start`, `inset-inline-end`, `padding-block`,
  `text-align: start`. Never `left`/`right`.

---

## 6. Motion

```css
:root {
  --ease-settle: linear(0, 0.18, 0.45, 0.73, 0.92, 1.01, 1.02, 1); /* spring-like */
  --dur-micro: 140ms;
  --dur-settle: 420ms;
  --lift-y: -6px;
}
```

Spring physics, not linear easing. Reference springs (Framer/Motion): **soft** `{stiffness:320,
damping:30, mass:0.9}`, **snappy** `{stiffness:500, damping:32}`.

Signature interactions:
- **Cards** lift + subtly scale + brighten their glint on hover; gentle press on click.
  `transform: translateY(var(--lift-y)) scale(1.012); --glint: var(--glint-strong);`
- **Primary buttons** get a soft screen-blended specular sweep on hover (brightens, never washes the label).
- **Windows/modals** enter with a gentle scale + **blur-in** (`scale(.965)→1`, `filter: blur(6px)→0`).
- **Grids** of cards: staggered entrance (`staggerChildren ~0.05s`, slight rise + fade).
- **Loading:** skeleton **shimmer**, never spinners-only. Live status: a soft pulsing dot (state via
  color + label, not motion alone).
- **Splash:** a short (<1s), skippable geometric assemble on first load — once per session.
- Route transitions: gentle crossfade + slight rise.

**Reduced motion — required, keep it last in your CSS:**
```css
@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after {
    animation-duration: 0.01ms !important; animation-iteration-count: 1 !important;
    transition-duration: 0.01ms !important; scroll-behavior: auto !important;
  }
}
```

---

## 7. Iconography & motifs

- **Icons:** [lucide](https://lucide.dev) (consistent, light). Pair with a small custom **masjid glyph
  set** — dome, minaret, crescent + star, mihrab arch — for iconography and empty-state art.
- **Geometric khatam pattern** as a low-opacity background texture (`--pattern-opacity: ~0.4–0.5`,
  stroke in the accent). The exact SVG is in the platform `tokens.css` (`--geometric-pattern`).
- **Arch-topped / rounded cards** are encouraged where they read as elegant — don't overdo it.

---

## 8. Component patterns

Match these so an app feels native. Key CSS shown; full source in the platform `app.css`.

### Floating dock
A centered, bottom-floating, strongly-blurred bar of app icons. Items lift on hover; names pop up on
hover; minimized windows live here with a small dot. Reorder by drag (siblings slide). Uses
`--glass-blur-strong`.
```css
.dock { position: fixed; inset-block-end: 1.25rem; inset-inline-start: 50%; transform: translateX(-50%);
  display: flex; gap: 0.4rem; padding: 0.5rem; border-radius: 1.25rem; z-index: 50; }
.dock-item { width: 3rem; height: 3rem; border-radius: 0.85rem; display: grid; place-items: center;
  color: var(--color-ink-muted);
  transition: transform var(--dur-settle) var(--ease-settle), background-color var(--dur-micro) ease; }
.dock-item:hover { transform: translateY(var(--lift-y)) scale(1.06); background: var(--color-surface-hover); color: var(--color-ink); }
.dock-item.is-active { color: var(--color-primary); background: var(--color-primary-subtle); }
```

### App cards
Glass card: icon (gradient tile or app icon), name, a status dot + state, quick actions pinned to the
bottom. Lift + glow on hover.
```css
.app-card { padding: 1.1rem; display: flex; flex-direction: column; gap: 0.85rem; cursor: pointer;
  transition: transform var(--dur-settle) var(--ease-settle), box-shadow var(--dur-settle) var(--ease-settle); }
.app-card:hover { transform: translateY(var(--lift-y)) scale(1.012);
  box-shadow: var(--glass-shadow-raised), 0 0 30px -6px var(--glass-glow); --glint: var(--glint-strong); }
.app-icon { width: 3rem; height: 3rem; border-radius: 0.8rem; display: grid; place-items: center;
  color: var(--color-on-primary); background: linear-gradient(150deg, var(--color-primary), var(--color-primary-hover)); }
```

### Buttons
```css
.btn { display: inline-flex; align-items: center; justify-content: center; gap: 0.45rem;
  padding: 0.55rem 1rem; border: 0; border-radius: var(--radius-button); font-weight: 600;
  background: var(--color-surface-hover); color: var(--color-ink);
  transition: transform var(--dur-micro) var(--ease-settle), background-color var(--dur-micro) ease; }
.btn:active { transform: scale(0.97); }
.btn--primary { background: var(--color-primary); color: var(--color-on-primary);
  box-shadow: 0 0 0 1px var(--color-primary-subtle), 0 12px 32px -8px rgba(34,211,238,.35); }
.btn--ghost { background: transparent; box-shadow: inset 0 0 0 1px var(--color-border); }
.btn--danger { background: var(--color-danger); color: #fff; }
```

### Toggle, segmented, inputs
- **Toggle:** pill `2.7rem × 1.5rem`, `--color-primary` when on, knob slides via
  `transform` (mirror with `[dir="rtl"]`).
- **Segmented control:** `glass-inset` track; active segment `--color-primary-subtle` + `--color-primary`.
- **Inputs/textarea/select:** `glass-inset`, `--radius-button`, placeholder `--color-ink-faint`.

### Stat cards
Label (small, muted, with icon) + big tabular-num value + a tiny sparkline/gauge. Keep gauges light.
```css
.gauge-fill { background: linear-gradient(90deg, var(--color-primary), var(--color-primary-hover));
  transition: width var(--dur-settle) var(--ease-settle); }
```

### Modals & windows
- **Modal:** centered dialog, backdrop `rgba(0,0,0,.5)` + `backdrop-filter: blur(4px)`; enter with
  scale + blur-in; Esc / backdrop / corner-X to close.
- **Windows** (logs, terminals, viewers): draggable by the header, **macOS-style traffic lights**
  (red/amber/green; glyphs appear on group hover), minimizable to the dock. `.win-enter` does the
  scale + blur-in.

### Feedback
- **Toasts:** bottom-center, glass, success/error ring in the matching color.
- **Skeletons:** moving shimmer gradient (`--color-surface-raised` → `--color-surface-shimmer`).
- **Empty states:** centered masjid-glyph art + a one-line invite, in `--color-ink-muted`.

---

## 9. Voice & wording

The user is a **masjid volunteer, not a sysadmin.** Plain, warm, non-technical everywhere.

- ✅ "Install" · "Open" · "Turn off" · "Update available" · "This app is running"
- ❌ "Deploy container" · "Orchestrate stack" · "Exited (0)" · "SIGTERM"
- Errors say **what happened and what to do next** in one or two friendly sentences. Never show a raw
  stack trace — log it, show a tidy message + an optional "view technical details" expander.

---

## 10. Accessibility checklist (per the platform's Definition of Done)

- [ ] Works in **both** dark and light (`data-theme`), meeting **WCAG AA** contrast.
- [ ] Works **LTR and RTL** (logical properties; mirror directional motion).
- [ ] Honors **`prefers-reduced-motion`** (collapse to instant/opacity-only).
- [ ] Visible **focus-visible** ring (`2px solid var(--color-primary)`, `outline-offset: 2px`).
- [ ] Keyboard-operable; semantic HTML; `aria-label` on icon-only buttons.
- [ ] Display/TV apps look right full-screen; tabular numerals for clocks/stats.
- [ ] No sacred/Quranic text in decorative or throwaway UI.

---

## 11. Keeping in sync

This spec mirrors the platform's `tokens.css` / `glass.css` / `app.css` / `motion.ts`. **Prefer
inheriting appearance via the Fabric** (§0) so your app tracks the live dashboard automatically; if
you hardcode tokens, re-sync when the platform's design tokens change. When in doubt, open the
platform style files linked at the top — they are canonical.
