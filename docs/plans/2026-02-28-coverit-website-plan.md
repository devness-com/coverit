# Coverit Website Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Build a warm-editorial multi-page marketing website for coverit.dev using Astro 5 + Tailwind CSS 4, living in `website/` inside the coverit repo.

**Architecture:** Static-first Astro site with Tailwind for styling. Warm editorial aesthetic — serif fonts (Fraunces/Source Serif 4), cream backgrounds, terracotta/amber accents. Pages: Landing, Docs (5 sub-pages), Changelog, About. Zero JS shipped by default.

**Tech Stack:** Astro 5, Tailwind CSS 4, Google Fonts (Fraunces, Source Serif 4, Fira Code), CSS animations

**Design doc:** `docs/plans/2026-02-28-coverit-website-design.md`

---

### Task 1: Scaffold Astro project

**Files:**
- Create: `website/package.json`
- Create: `website/astro.config.mjs`
- Create: `website/tsconfig.json`
- Create: `website/src/styles/global.css`
- Create: `website/src/layouts/BaseLayout.astro`
- Create: `website/src/pages/index.astro`
- Create: `website/public/favicon.svg`

**Step 1: Create the Astro project**

```bash
cd /Users/apple/Code/devness/coverit
mkdir -p website
cd website
bun create astro@latest . -- --template minimal --no-install --typescript strict
```

If the interactive prompt blocks, create manually:

`website/package.json`:
```json
{
  "name": "coverit-website",
  "type": "module",
  "version": "0.0.1",
  "scripts": {
    "dev": "astro dev",
    "build": "astro build",
    "preview": "astro preview"
  },
  "dependencies": {
    "astro": "^5.0.0",
    "@astrojs/tailwind": "^6.0.0",
    "tailwindcss": "^4.0.0"
  }
}
```

`website/astro.config.mjs`:
```js
import { defineConfig } from 'astro/config';

export default defineConfig({
  site: 'https://coverit.dev',
});
```

`website/tsconfig.json`:
```json
{
  "extends": "astro/tsconfigs/strict",
  "compilerOptions": {
    "baseUrl": ".",
    "paths": {
      "@/*": ["src/*"]
    }
  }
}
```

**Step 2: Install dependencies**

```bash
cd /Users/apple/Code/devness/coverit/website
bun install
```

**Step 3: Set up global CSS with design tokens**

`website/src/styles/global.css`:
```css
@import "tailwindcss";

@theme {
  --color-bg: #faf7f2;
  --color-bg-warm: #f5f0e8;
  --color-bg-code: #1e1a14;
  --color-text: #2c2418;
  --color-text-muted: #7a6e5f;
  --color-accent: #c4623a;
  --color-accent-hover: #a8502e;
  --color-amber: #d4a047;
  --color-amber-dim: #b8862e;
  --color-border: #e6dfd4;
  --color-border-strong: #c9bfaf;

  --font-heading: 'Fraunces', Georgia, serif;
  --font-body: 'Source Serif 4', Georgia, serif;
  --font-mono: 'Fira Code', monospace;
}

html {
  scroll-behavior: smooth;
}

body {
  font-family: var(--font-body);
  color: var(--color-text);
  background-color: var(--color-bg);
}

/* Subtle grain texture overlay */
body::before {
  content: '';
  position: fixed;
  inset: 0;
  opacity: 0.03;
  background-image: url("data:image/svg+xml,%3Csvg viewBox='0 0 256 256' xmlns='http://www.w3.org/2000/svg'%3E%3Cfilter id='noise'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.9' numOctaves='4' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23noise)'/%3E%3C/svg%3E");
  pointer-events: none;
  z-index: 9999;
}

/* Fade-in-up animation for scroll reveals */
@keyframes fade-in-up {
  from {
    opacity: 0;
    transform: translateY(24px);
  }
  to {
    opacity: 1;
    transform: translateY(0);
  }
}

.animate-on-scroll {
  opacity: 0;
  animation: fade-in-up 0.6s ease-out forwards;
}
```

**Step 4: Create BaseLayout**

`website/src/layouts/BaseLayout.astro`:
```astro
---
interface Props {
  title: string;
  description?: string;
}

const { title, description = 'AI-powered test quality for Claude Code' } = Astro.props;
---

<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <meta name="description" content={description} />
    <link rel="icon" type="image/svg+xml" href="/favicon.svg" />
    <link rel="preconnect" href="https://fonts.googleapis.com" />
    <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
    <link
      href="https://fonts.googleapis.com/css2?family=Fraunces:ital,opsz,wght@0,9..144,300..900;1,9..144,300..900&family=Source+Serif+4:ital,opsz,wght@0,8..60,400..700;1,8..60,400..700&family=Fira+Code:wght@400;500&display=swap"
      rel="stylesheet"
    />
    <title>{title} | coverit</title>
  </head>
  <body>
    <slot />
  </body>
</html>
```

**Step 5: Create minimal index page placeholder**

`website/src/pages/index.astro`:
```astro
---
import BaseLayout from '../layouts/BaseLayout.astro';
import '../styles/global.css';
---

<BaseLayout title="Home">
  <main class="min-h-screen flex items-center justify-center">
    <h1 class="font-heading text-5xl font-bold text-accent">coverit</h1>
  </main>
</BaseLayout>
```

**Step 6: Create favicon**

`website/public/favicon.svg` — simple terracotta checkmark in a circle:
```svg
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32">
  <circle cx="16" cy="16" r="14" fill="#c4623a"/>
  <path d="M10 16l4 4 8-8" stroke="#faf7f2" stroke-width="2.5" fill="none" stroke-linecap="round" stroke-linejoin="round"/>
</svg>
```

**Step 7: Verify dev server runs**

```bash
cd /Users/apple/Code/devness/coverit/website
bun run dev
```

Expected: Astro dev server starts, page shows "coverit" in terracotta on cream background.

**Step 8: Commit**

```bash
git add website/
git commit -m "feat(website): scaffold Astro project with design tokens"
```

---

### Task 2: Navigation and Footer components

**Files:**
- Create: `website/src/components/Nav.astro`
- Create: `website/src/components/Footer.astro`
- Create: `website/src/layouts/PageLayout.astro`
- Modify: `website/src/pages/index.astro`

**Step 1: Create Nav component**

`website/src/components/Nav.astro`:
- Fixed top nav, cream background with subtle border-bottom
- Left: "coverit" logo text in Fraunces bold
- Right: [Docs] [Changelog] [About] links + GitHub icon/link
- Mobile: hamburger menu with slide-down
- Active page highlight with terracotta underline

**Step 2: Create Footer component**

`website/src/components/Footer.astro`:
- 3-column layout: Product (Docs, Changelog, GitHub), Resources (npm, Getting Started, CLI Reference), Legal (License, Security Policy)
- Bottom bar: "Built by Devness" + AGPL-3.0 badge
- Warm background `bg-warm`, muted text

**Step 3: Create PageLayout**

`website/src/layouts/PageLayout.astro` — wraps content with Nav + Footer:
```astro
---
import BaseLayout from './BaseLayout.astro';
import Nav from '../components/Nav.astro';
import Footer from '../components/Footer.astro';

interface Props {
  title: string;
  description?: string;
}

const { title, description } = Astro.props;
---

<BaseLayout title={title} description={description}>
  <Nav />
  <main class="pt-16">
    <slot />
  </main>
  <Footer />
</BaseLayout>
```

**Step 4: Update index.astro to use PageLayout**

**Step 5: Verify**

```bash
cd /Users/apple/Code/devness/coverit/website && bun run dev
```

Expected: Nav and footer visible, links work, responsive hamburger on mobile.

**Step 6: Commit**

```bash
git add website/src/components/ website/src/layouts/ website/src/pages/
git commit -m "feat(website): add Nav and Footer with PageLayout"
```

---

### Task 3: Hero section

**Files:**
- Create: `website/src/components/Hero.astro`
- Create: `website/src/components/ScoreGauge.astro`
- Modify: `website/src/pages/index.astro`

**Step 1: Create ScoreGauge component**

`website/src/components/ScoreGauge.astro`:
- SVG circular gauge, animated from 0 to 82 (example score)
- Uses `stroke-dasharray` + `stroke-dashoffset` with CSS animation
- Terracotta ring on cream, score number in center in Fraunces
- Below gauge: "Quality Score" label

**Step 2: Create Hero component**

`website/src/components/Hero.astro`:
- Two-column layout: left text, right gauge
- Headline: "Know Your Code's True Strength" in Fraunces, 4xl-6xl
- Subtitle: "AI-powered test quality for Claude Code. Scan, generate, fix — four commands." in Source Serif 4
- Install command box: `npx @devness/coverit` with copy button, dark code background
- CTA button: "Get Started" → /docs (terracotta bg, cream text)
- Mobile: stacked (text on top, gauge below)

**Step 3: Add Hero to index.astro**

**Step 4: Verify**

```bash
cd /Users/apple/Code/devness/coverit/website && bun run dev
```

Expected: Hero renders with headline, gauge animates on page load, install command is copyable.

**Step 5: Commit**

```bash
git add website/src/components/Hero.astro website/src/components/ScoreGauge.astro website/src/pages/index.astro
git commit -m "feat(website): add Hero section with animated score gauge"
```

---

### Task 4: Problem statement + How It Works pipeline

**Files:**
- Create: `website/src/components/Problem.astro`
- Create: `website/src/components/Pipeline.astro`
- Modify: `website/src/pages/index.astro`

**Step 1: Create Problem section**

`website/src/components/Problem.astro`:
- Centered editorial block with large serif text
- "Most teams think they're covered. Their test suite says 80%."
- "But coverage isn't quality."
- "Your tests might pass, but are they testing the right things?"
- Brief intro to what Coverit does differently
- Fade-in-up scroll animation

**Step 2: Create Pipeline component**

`website/src/components/Pipeline.astro`:
- Section heading: "Four Commands. That's It."
- Horizontal pipeline (vertical on mobile): Scan → Cover → Run → Status
- Each step: icon (SVG), command name, one-line description
- Connected with a flowing line/arrow between steps
- Scan: "AI explores your codebase"
- Cover: "AI writes tests for gaps"
- Run: "Runs tests, AI fixes failures"
- Status: "See your quality dashboard"
- Warm card backgrounds with amber accents for icons

**Step 3: Add both to index.astro**

**Step 4: Verify with dev server**

**Step 5: Commit**

```bash
git add website/src/components/Problem.astro website/src/components/Pipeline.astro website/src/pages/index.astro
git commit -m "feat(website): add Problem and Pipeline sections"
```

---

### Task 5: Features grid

**Files:**
- Create: `website/src/components/FeatureCard.astro`
- Create: `website/src/components/Features.astro`
- Modify: `website/src/pages/index.astro`

**Step 1: Create FeatureCard component**

`website/src/components/FeatureCard.astro`:
- Props: `icon` (SVG string), `title`, `description`
- Card with `bg-warm` background, soft shadow, border
- Icon in amber circle at top
- Title in Fraunces semibold
- Description in Source Serif 4 muted text
- Hover: slight lift with shadow increase

**Step 2: Create Features section**

`website/src/components/Features.astro`:
- Section heading: "Built for Real Quality"
- 2×3 responsive grid (3 cols desktop, 2 tablet, 1 mobile)
- Six feature cards with inline SVG icons:
  1. AI-Driven Analysis — magnifying glass icon
  2. 5 Quality Dimensions — pentagon/shield icon
  3. Smart Test Generation — code brackets icon
  4. Testing Diamond — diamond shape icon
  5. Persistent Manifest — file/document icon
  6. Multiple Providers — grid/blocks icon
- Staggered fade-in animation using `animation-delay`

**Step 3: Add to index.astro**

**Step 4: Verify**

**Step 5: Commit**

```bash
git add website/src/components/FeatureCard.astro website/src/components/Features.astro website/src/pages/index.astro
git commit -m "feat(website): add features grid with 6 cards"
```

---

### Task 6: Terminal mockup + Installation section

**Files:**
- Create: `website/src/components/TerminalMockup.astro`
- Create: `website/src/components/InstallSteps.astro`
- Modify: `website/src/pages/index.astro`

**Step 1: Create TerminalMockup component**

`website/src/components/TerminalMockup.astro`:
- Props: `title` (optional window title), `content` (pre-formatted terminal output)
- macOS-style terminal chrome: 3 dots (red/yellow/green), title bar
- Dark background (`bg-code`), Fira Code font
- Content: realistic `coverit status` output showing quality dashboard with score, dimensions, modules

**Step 2: Create InstallSteps component**

`website/src/components/InstallSteps.astro`:
- Section heading: "Get Started in 30 Seconds"
- Three numbered steps, each with a code block:
  1. "Install" — `npx @devness/coverit`
  2. "Scan your codebase" — `npx @devness/coverit scan`
  3. "See your score" — `npx @devness/coverit status`
- Each step: number badge (terracotta circle), title, code block
- Terminal mockup below showing example output

**Step 3: Add to index.astro**

**Step 4: Verify**

**Step 5: Commit**

```bash
git add website/src/components/TerminalMockup.astro website/src/components/InstallSteps.astro website/src/pages/index.astro
git commit -m "feat(website): add terminal mockup and installation steps"
```

---

### Task 7: Open source callout + finalize landing page

**Files:**
- Create: `website/src/components/OpenSource.astro`
- Modify: `website/src/pages/index.astro`

**Step 1: Create OpenSource component**

`website/src/components/OpenSource.astro`:
- Warm background section
- Heading: "Open Source, Open Quality"
- AGPL-3.0 license badge
- GitHub star button/link
- npm package link
- "Contribute" CTA button
- Brief text about the project philosophy

**Step 2: Finalize landing page order**

Update `index.astro` to include all sections in order:
1. Hero
2. Problem
3. Pipeline
4. Features
5. TerminalMockup (Dashboard Preview)
6. InstallSteps
7. OpenSource

**Step 3: Add scroll animations**

Add intersection observer script (inline `<script>` in BaseLayout) to trigger `.animate-on-scroll` classes as sections enter viewport.

**Step 4: Verify full landing page**

```bash
cd /Users/apple/Code/devness/coverit/website && bun run dev
```

Expected: Full landing page scrolls through all sections with animations.

**Step 5: Commit**

```bash
git add website/
git commit -m "feat(website): complete landing page with all sections"
```

---

### Task 8: Docs pages with sidebar

**Files:**
- Create: `website/src/layouts/DocsLayout.astro`
- Create: `website/src/components/DocsSidebar.astro`
- Create: `website/src/pages/docs/index.astro` (Getting Started)
- Create: `website/src/pages/docs/commands.astro`
- Create: `website/src/pages/docs/config.astro`
- Create: `website/src/pages/docs/providers.astro`
- Create: `website/src/pages/docs/mcp.astro`

**Step 1: Create DocsSidebar**

`website/src/components/DocsSidebar.astro`:
- Props: `currentPath` (string)
- Vertical sidebar with links: Getting Started, Commands, Configuration, AI Providers, MCP Setup
- Active link highlighted with terracotta left border + bold
- Mobile: collapsible, hamburger toggle

**Step 2: Create DocsLayout**

`website/src/layouts/DocsLayout.astro`:
- Uses PageLayout
- Two-column: sidebar (240px fixed) + content area
- Content area has max-width for readability (~720px)
- Mobile: sidebar collapses above content

**Step 3: Create Getting Started page**

Content from README.md Quick Start section. Include:
- What is coverit
- Prerequisites (Node 18+, Claude Code recommended)
- Installation: `npx @devness/coverit`
- First scan: `npx @devness/coverit scan`
- View results: `npx @devness/coverit status`
- Generate tests: `npx @devness/coverit cover`

**Step 4: Create Commands page**

Full CLI reference from README. Each command gets:
- Name, syntax, description
- Options table
- Example usage with terminal mockup

**Step 5: Create Configuration page**

- `coverit.config.ts` format and options
- Example config file
- AI provider selection

**Step 6: Create Providers page**

- Claude CLI (default), Gemini CLI, Codex CLI
- Anthropic API, OpenAI API, Ollama
- How to configure each

**Step 7: Create MCP page**

- What is MCP
- Auto-setup via `npx @devness/coverit`
- Manual MCP configuration
- 7 MCP tools reference
- Claude Code plugin setup with slash commands

**Step 8: Verify all docs pages**

```bash
cd /Users/apple/Code/devness/coverit/website && bun run dev
```

Navigate through all docs pages. Verify sidebar highlights correctly, content renders, code blocks are styled.

**Step 9: Commit**

```bash
git add website/src/layouts/DocsLayout.astro website/src/components/DocsSidebar.astro website/src/pages/docs/
git commit -m "feat(website): add docs pages with sidebar navigation"
```

---

### Task 9: Changelog page

**Files:**
- Create: `website/src/pages/changelog.astro`

**Step 1: Create changelog page**

`website/src/pages/changelog.astro`:
- Uses PageLayout
- Reads content from CHANGELOG.md (hardcoded for now — can automate later)
- Version entries with dates as headings
- Tags: green "Added", blue "Changed", red "Removed" badges
- Timeline visual: vertical line on left with version dots
- Each version entry is a card with soft shadow

**Step 2: Verify**

**Step 3: Commit**

```bash
git add website/src/pages/changelog.astro
git commit -m "feat(website): add changelog page"
```

---

### Task 10: About page

**Files:**
- Create: `website/src/pages/about.astro`

**Step 1: Create about page**

`website/src/pages/about.astro`:
- Uses PageLayout
- Sections:
  - What is Coverit — brief mission statement
  - Philosophy — AI-driven quality, not just coverage metrics. Testing Diamond over Testing Pyramid. ISO 25010 dimensions.
  - Open Source — AGPL-3.0, community contributions welcome
  - Built by Devness — brief about the team/org, link to devness.com
  - Links — GitHub, npm, Documentation

**Step 2: Verify**

**Step 3: Commit**

```bash
git add website/src/pages/about.astro
git commit -m "feat(website): add about page"
```

---

### Task 11: SEO, OG image, final polish

**Files:**
- Create: `website/public/og-image.png` (or generate as SVG)
- Modify: `website/src/layouts/BaseLayout.astro` (add OG meta tags)
- Modify: All pages (verify titles/descriptions)

**Step 1: Add Open Graph meta tags to BaseLayout**

Add to `<head>`:
- `og:title`, `og:description`, `og:image`, `og:url`, `og:type`
- `twitter:card`, `twitter:title`, `twitter:description`, `twitter:image`
- Canonical URL

**Step 2: Create OG image**

Simple SVG-based image: "coverit" in Fraunces on cream background with terracotta accent. Export or use as SVG.

**Step 3: Verify build**

```bash
cd /Users/apple/Code/devness/coverit/website
bun run build
bun run preview
```

Expected: Static build succeeds. All pages render. No console errors.

**Step 4: Commit**

```bash
git add website/
git commit -m "feat(website): add SEO meta tags and OG image"
```

---

### Task 12: Final review and cleanup

**Step 1: Run Astro build and check for warnings**

```bash
cd /Users/apple/Code/devness/coverit/website
bun run build 2>&1
```

Fix any warnings.

**Step 2: Test all pages at different viewport sizes**

Open dev server at localhost:4321. Check:
- Desktop (1280px)
- Tablet (768px)
- Mobile (375px)

**Step 3: Verify all links work**

Check every nav link, footer link, docs sidebar link, and external link (GitHub, npm).

**Step 4: Final commit**

```bash
git add website/
git commit -m "chore(website): final polish and cleanup"
```
