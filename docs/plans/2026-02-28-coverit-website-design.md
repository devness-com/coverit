# Coverit Website Design

## Overview

A multi-page marketing and documentation website for coverit.dev — an AI-powered test quality platform for Claude Code. The site lives in `website/` within the coverit monorepo.

## Tech Stack

- **Framework:** Astro 5 (static-first, ships zero JS by default)
- **Styling:** Tailwind CSS 4
- **Animation:** CSS animations + Motion library for select interactive elements
- **Fonts:** Google Fonts (Fraunces, Source Serif 4, Fira Code)
- **Deployment:** Static build, deployable to Vercel/Netlify/Cloudflare Pages

## Design Language

### Aesthetic: Warm Editorial

A sophisticated, calm, magazine-like feel. Distinctly different from UseAI's dark/cyber/neon-lime theme.

### Typography

| Role | Font | Weight | Notes |
|------|------|--------|-------|
| Headings | Fraunces (variable serif) | 700-900 | Optical-size axis for personality |
| Body | Source Serif 4 | 400-600 | Highly readable serif |
| Code/mono | Fira Code | 400-500 | Ligatures for code snippets |

### Color Palette

| Token | Hex | Usage |
|-------|-----|-------|
| `--bg` | `#faf7f2` | Page background |
| `--bg-warm` | `#f5f0e8` | Card surfaces, sections |
| `--bg-code` | `#1e1a14` | Code blocks, terminal mockups |
| `--text` | `#2c2418` | Primary body text |
| `--text-muted` | `#7a6e5f` | Secondary/caption text |
| `--accent` | `#c4623a` | CTAs, links, highlights (terracotta) |
| `--accent-hover` | `#a8502e` | Hover state for accent |
| `--amber` | `#d4a047` | Secondary accent, badges, icons |
| `--amber-dim` | `#b8862e` | Amber hover/dim variant |
| `--border` | `#e6dfd4` | Card borders, dividers |
| `--border-strong` | `#c9bfaf` | Emphasized borders |

### Effects

- **Soft shadows:** `0 2px 12px rgba(44, 36, 24, 0.06)` on cards
- **Subtle grain texture:** CSS noise overlay at very low opacity for editorial feel
- **Smooth scroll animations:** Fade-in-up on scroll with intersection observer (CSS-only)
- **Hero animation:** Animated circular score gauge that fills from 0 to a target number
- **Terminal mockup:** Styled code blocks with realistic terminal chrome

## Pages

### 1. Landing Page (`/`)

**Sections in order:**

1. **Navigation bar** — Logo, [Docs], [Changelog], [About], [GitHub icon + star count]
2. **Hero** — Large serif headline ("Know Your Code's True Strength"), subtitle about AI-powered test quality, `npx @devness/coverit` install command, animated score gauge
3. **The Problem** — Brief editorial block: "Most teams think they're covered. Their test suite says 80%. But coverage isn't quality." Leads into what Coverit does differently.
4. **How It Works** — Horizontal pipeline: Scan → Cover → Run → Status. Each step has an icon, title, and one-line description. Visually connected with a flowing line.
5. **Features** — 2×3 grid of feature cards:
   - AI-Driven Analysis (no heuristics, AI explores with tools)
   - 5 Quality Dimensions (ISO 25010: Functionality, Security, Stability, Conformance, Regression)
   - Smart Test Generation (generates, runs, fixes tests automatically)
   - Testing Diamond (Integration 50%, Unit 20%, API 15%, E2E 10%, Contract 5%)
   - Persistent Quality Manifest (coverit.json — git-tracked, cross-session)
   - Multiple AI Providers (Claude, Gemini, Codex, Ollama, OpenAI, Anthropic API)
6. **Dashboard Preview** — Terminal mockup showing `coverit status` output with the quality dashboard, scores, and dimension breakdown
7. **Installation** — Step-by-step: npm install, add to Claude Code, run scan
8. **Open Source** — AGPL-3.0 license callout, GitHub link, star badge, "Contribute" CTA
9. **Footer** — 3-column: Product (Docs, Changelog, GitHub), Resources (npm, Getting Started), Legal (License, Security)

### 2. Docs Page (`/docs`)

- Getting started guide
- Command reference (scan, cover, run, status, clear)
- Configuration (coverit.config.ts)
- AI providers setup
- MCP server setup
- Sidebar navigation

### 3. Changelog Page (`/changelog`)

- Version history with dates
- Entries grouped by version
- Tags for: feature, fix, breaking change
- Pulls from CHANGELOG.md in the repo

### 4. About Page (`/about`)

- What is Coverit
- The philosophy (AI-driven quality, not just coverage)
- Built by Devness
- Link to GitHub, npm

## File Structure

```
website/
├── astro.config.mjs
├── package.json
├── tailwind.config.ts
├── tsconfig.json
├── public/
│   ├── favicon.svg
│   └── og-image.png
├── src/
│   ├── layouts/
│   │   ├── BaseLayout.astro      (HTML shell, fonts, meta)
│   │   ├── PageLayout.astro      (Nav + Footer wrapper)
│   │   └── DocsLayout.astro      (Sidebar + content)
│   ├── pages/
│   │   ├── index.astro           (Landing page)
│   │   ├── docs/
│   │   │   ├── index.astro       (Getting started)
│   │   │   ├── commands.astro    (Command reference)
│   │   │   ├── config.astro      (Configuration)
│   │   │   ├── providers.astro   (AI providers)
│   │   │   └── mcp.astro         (MCP setup)
│   │   ├── changelog.astro
│   │   └── about.astro
│   ├── components/
│   │   ├── Nav.astro
│   │   ├── Footer.astro
│   │   ├── Hero.astro
│   │   ├── Pipeline.astro        (Scan→Cover→Run→Status flow)
│   │   ├── FeatureCard.astro
│   │   ├── TerminalMockup.astro  (Styled terminal output)
│   │   ├── ScoreGauge.astro      (Animated circular gauge)
│   │   ├── InstallSteps.astro
│   │   └── DocsSidebar.astro
│   └── styles/
│       └── global.css            (Tailwind imports, CSS vars, custom classes)
```

## Responsive Behavior

- **Desktop (1024+):** Full layout, 3-column feature grid, side-by-side hero
- **Tablet (768-1023):** 2-column feature grid, stacked hero
- **Mobile (< 768):** Single column, hamburger nav, full-width cards

## Performance Targets

- Lighthouse 95+ on all metrics
- Zero JS shipped by default (Astro islands only where needed)
- Static HTML generation for all pages
- Optimized font loading with `font-display: swap`
