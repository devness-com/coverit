# Implementation Plan: Coverit v1.0

> From test generator to quality confidence platform.

*Date: 2026-02-26*

---

## Guiding Principles

1. **Painkillers first.** Build what solves real pain before what's nice-to-have.
2. **Score is the product.** Every feature must contribute to a trustworthy quality score.
3. **One command.** The developer experience never gets more complex than `coverit`.
4. **Persistent standard.** `coverit.json` is the foundation — everything measures against it.
5. **Honest output.** If coverit can't assess something, it says so. Never fake confidence.

---

## Architecture Overview

### Current Architecture (v0.3.x)

```
git diff → AI triage → AI generate tests → run → retry → report → forget
```

Every run re-discovers the codebase. No memory. No standard. No multi-dimensional quality.

### Target Architecture (v1.0)

```
coverit.json (persistent standard, git-tracked)
       │
       ├── /coverit:scale    → Generate/regenerate the standard
       ├── /coverit:measure   → Score against the standard (no AI needed)
       ├── /coverit:full      → Detect → Measure → Generate → Run → Fix → Update
       ├── /coverit:fix       → Fix failing tests from last run
       └── /coverit:status    → Show score, gaps, dimensions
```

### Key Architectural Changes

| Component | v0.3.x (current) | v1.0 (target) |
|---|---|---|
| **Source of truth** | AI re-discovers each run | `coverit.json` persistent manifest |
| **Quality model** | Tests pass/fail only | Multi-dimensional (functionality, security, stability, conformance, regression) |
| **Test strategy** | AI decides (mostly unit) | Diamond strategy (integration-heavy), guided by standard |
| **Output** | Test files + run report | Score + gap analysis + test files + security findings |
| **Persistence** | `.coverit/runs/` (ephemeral) | `coverit.json` (git-tracked) + `.coverit/runs/` (ephemeral) |
| **Scoring** | None | 0-100 weighted across dimensions |
| **Security** | None | AI security review + OWASP-mapped checks |
| **CI integration** | None | Score-based merge gates |

---

## Distribution Model

Coverit ships as **two things simultaneously**:

### 1. Claude Code Plugin (Primary Experience)

When installed as a Claude Code plugin, coverit runs as an **MCP server** inside Claude Code. The user interacts via slash commands (`/coverit:full`, `/coverit:scale`, etc.) which are defined in skill files (`.md` files in `plugins/coverit/commands/`).

**Key detail:** In plugin mode, **Claude Code IS the AI provider**. No external API key or CLI binary needed. The MCP tools call back into Claude Code's context. This is the zero-friction experience.

### 2. CLI Tool (CI, Automation, Non-Claude Users)

When installed via `npm install -g @devness/coverit` or `npx @devness/coverit`, it runs as a standalone CLI. This mode **requires its own AI provider** since there's no Claude Code context.

**Entry point logic** (`src/entry.ts`):
```
npx @devness/coverit              → MCP server (stdio transport)
npx @devness/coverit mcp          → Setup wizard for AI config
npx @devness/coverit scan/run/…   → CLI commands
```

### AI Providers (CLI Mode Only)

| Provider | Detection | Cost | Notes |
|---|---|---|---|
| **Claude CLI** | Auto-detects `claude` binary | $0 (uses subscription) | Primary. Spawns local process. |
| **Anthropic API** | `ANTHROPIC_API_KEY` env var | Pay-per-token | Direct API, no SDK. |
| **OpenAI Compatible** | `OPENAI_API_KEY` env var | Pay-per-token | Works with OpenAI, Azure, Groq, Together. |
| **Ollama** | Local `localhost:11434` | $0 | Fully offline. |

**Auto-detection priority:** Claude CLI → Anthropic → OpenAI → Ollama. Override with `COVERIT_AI_PROVIDER`.

**Not yet supported (v1.0 additions):**
- [ ] **Gemini CLI** — New provider, same pattern as Claude CLI (spawn binary, parse output)
- [ ] **Codex CLI** (OpenAI) — New provider for the `codex` CLI binary
- [ ] **Google Gemini API** — Direct API provider

---

## Scope Modes

Coverit operates on different scopes depending on context. The scope determines **what code is analyzed**, **how deep the analysis goes**, and **whether `coverit.json` is updated**.

### All Supported Scopes

| Scope | Trigger | What's Analyzed | Speed |
|---|---|---|---|
| **First time** | No `coverit.json` exists | Full codebase | Minutes (one-time) |
| **Unstaged** | Auto-detect: dirty working tree | Unstaged changes only | Seconds |
| **Staged** | `--staged` flag or auto-detect | Staged changes | Under a minute |
| **Branch** | `--branch` or auto-detect (not on main) | Branch diff vs main | Minutes |
| **PR** | `--pr <number>` or CI env vars | PR diff vs base | Minutes |
| **Full** | `--full` flag | Entire codebase | Several minutes |
| **Rescale** | `--rescale` or `/coverit:scale` | Full codebase (regenerate manifest) | Minutes |
| **Specific files** | File paths as arguments | Only named files | Seconds |
| **CI** | `--ci` flag (auto-detects PR context) | PR diff (machine-readable output) | Minutes |

### Auto-Detection Logic

When the user runs `coverit` with no flags:

```
Has coverit.json?
  ├── NO → First time. Run scale. Create coverit.json.
  │
  └── YES → Check git state:
        ├── Has staged changes? → Scope: staged
        ├── Has unstaged changes? → Scope: unstaged
        ├── On a branch (not main)? → Scope: branch diff vs main
        ├── In a PR context (CI env)? → Scope: PR diff
        └── Nothing changed? → Scope: measure-only (rescore, no generation)
```

### Depth Per Scope

Not every run needs every dimension. Match depth to context:

| Dimension | Unstaged (quick) | Staged | Branch/PR | Full/Rescale |
|---|---|---|---|---|
| **Functionality gaps** | Show gaps only | Show + generate | Show + generate + run | Show + generate + run |
| **Security** | Scan changed code | Scan changed code | Scan all branch changes | Scan full codebase |
| **Stability** | Skip | Flag obvious gaps | Analyze + generate | Full analysis |
| **Conformance** | Skip | Skip | Analyze | Full analysis |
| **Regression** | Skip | Skip | Run all existing tests | Run all existing tests |
| **Score update** | Estimate impact | Estimate impact | Full recalculate | Full recalculate |

### `coverit.json` Update Rules

| Scope | Reads manifest? | Writes manifest? | Why |
|---|---|---|---|
| First time | No (doesn't exist) | Yes (creates it) | Onboarding |
| Unstaged | Yes (gap context) | **No** | Changes are transient |
| Staged | Yes | **No** | Changes aren't committed yet |
| Branch/PR | Yes | **Yes** | Changes are committed, meaningful |
| Full | Yes | **Yes** | Complete reassessment |
| Rescale | Overwrites | **Yes** | Regeneration |
| Specific files | Yes | **Yes** (relevant modules only) | Targeted update |

---

## Tracking & Analytics

### What We Track Today (v0.3.x)

Per-run tracking via `.coverit/runs/{runId}/`:
- `meta.json` — Status, scope, timestamps, summary (pass/fail/skip counts)
- `strategy.json` — What was planned (triage plans)
- `report.json` — Full execution results
- `progress/{planId}.json` — Real-time per-plan progress

### What We Need to Add (v1.0)

| Tracking Need | Where It Lives | Why |
|---|---|---|
| **Score history** | `coverit.json` → `score.history[]` | Track score trend over time via git |
| **Generation quality** | `.coverit/analytics.json` | "72% of tests pass on first try" |
| **Failure patterns** | `.coverit/analytics.json` | "booking.service tests fail 40% of the time" |
| **Aggregate stats** | `.coverit/analytics.json` | "Coverit has generated 847 tests across 42 runs" |
| **Dimension trends** | `coverit.json` → `score.history[]` | Security score improving? Stability declining? |

**Score history in `coverit.json`** (lightweight, git-trackable):
```jsonc
"score": {
  "overall": 74,
  "breakdown": { ... },
  "history": [
    { "date": "2026-02-20", "score": 45, "scope": "scale" },
    { "date": "2026-02-22", "score": 58, "scope": "branch" },
    { "date": "2026-02-26", "score": 74, "scope": "full" }
  ]
}
```

This gives trend visibility via `git log` AND in the manifest itself, without needing a separate database.

**`.coverit/analytics.json`** (local, not git-tracked):
```jsonc
{
  "totalRuns": 42,
  "totalTestsGenerated": 847,
  "firstRunPassRate": 0.72,
  "avgScoreImprovement": 8.3,
  "commonFailures": [
    { "pattern": "import resolution", "count": 23 },
    { "pattern": "mock setup", "count": 18 }
  ]
}
```

---

## UI Strategy

### v1.0: Terminal Only (No Web Dashboard)

| Output | Format | When |
|---|---|---|
| **Score dashboard** | Terminal (chalk, ASCII tables) | Every run |
| **Gap report** | Terminal + Markdown | Every run |
| **Security findings** | Terminal (color-coded severity) | When issues found |
| **CI output** | JSON + exit code + PR comment (Markdown) | CI mode |

### Future: Renderers (Not v1.0)

`coverit.json` is a standard JSON file. Any tool can render it:

| Renderer | When | Who builds it |
|---|---|---|
| **VS Code extension** | Post-v1.0 | Reads `coverit.json`, shows score in status bar, inline warnings |
| **Web dashboard** | Post-v1.0 | Score trends, team analytics, cross-project comparison |
| **Slack/Discord bot** | Post-v1.0 | Post score changes to channels |
| **GitHub App** | Post-v1.0 | Score badge on repos, check runs |

The decision to keep the data in a JSON file means **we never need to build a UI to deliver value**. The terminal dashboard is enough for v1.0. Anyone (including us, later) can build richer renderers on top.

---

## Phase 1: The Foundation — `coverit.json` + Scale + Measure

**Pain addressed:** "I have no idea if my codebase is healthy or rotting."

**Estimated scope:** Core schema, scale command, measure command, scoring engine.

### 1.0 Add Missing AI Providers

**What:** Add Gemini CLI and Codex CLI as AI providers, same pattern as existing Claude CLI provider.

**Deliverables:**
- [ ] `src/ai/gemini-cli-provider.ts` — Gemini CLI binary integration
- [ ] `src/ai/codex-cli-provider.ts` — OpenAI Codex CLI binary integration
- [ ] Update `src/ai/provider-factory.ts` — Add to auto-detection chain
- [ ] Update auto-detection priority: Claude CLI → Gemini CLI → Codex CLI → Anthropic → OpenAI → Ollama

### 1.1 Define the `coverit.json` Schema

**What:** TypeScript types + JSON schema for the manifest.

**Key types to define:**

```typescript
interface CoveritManifest {
  version: number;
  createdAt: string;
  updatedAt: string;
  dimensions: DimensionConfig;      // What quality means for this project
  modules: ModuleEntry[];           // What the codebase contains
  journeys: JourneyEntry[];         // Critical user flows (E2E)
  contracts: ContractEntry[];       // Public API schemas
  score: ScoreResult;               // Current quality score
}

interface DimensionConfig {
  functionality: FunctionalityConfig;
  security: SecurityConfig;
  stability: StabilityConfig;
  conformance: ConformanceConfig;
  regression: RegressionConfig;
}

interface ModuleEntry {
  path: string;                     // Directory path (e.g., "src/services")
  files: number;                    // File count
  complexity: "low" | "medium" | "high";
  functionality: TestCoverage;      // Expected vs current by test type
  security: SecurityStatus;
  stability: StabilityStatus;
  conformance: ConformanceStatus;
  critical?: CriticalFileEntry[];   // Per-file breakdown for complex modules
}

interface ScoreResult {
  overall: number;                  // 0-100
  breakdown: Record<Dimension, number>;
  gaps: GapSummary;
}
```

**Deliverables:**
- [ ] `src/schema/coverit-manifest.ts` — TypeScript interfaces
- [ ] `src/schema/coverit-manifest.schema.json` — JSON Schema for validation
- [ ] `src/schema/defaults.ts` — Default dimension configs and weights
- [ ] `src/schema/validation.ts` — Runtime validation of manifest files

### 1.2 Build the Scale Command (`/coverit:scale`)

**What:** AI analyzes the full codebase and generates `coverit.json`.

**Flow:**
1. Scan all source files (not just diff — the entire project)
2. Identify modules (directory-level grouping)
3. Analyze complexity per module (file count, line count, public API surface)
4. Find all existing test files and map them to source modules
5. Count existing tests by type (unit, integration, API, E2E, contract)
6. Calculate expected test counts using diamond weights and complexity
7. Detect API endpoints, critical paths, schemas
8. Write `coverit.json`

**AI's role:** Analyze module boundaries, classify complexity, identify critical paths, detect API endpoints. This is a triage-like operation but on the full codebase.

**Deliverables:**
- [ ] `src/scale/analyzer.ts` — Full codebase analysis engine
- [ ] `src/scale/module-detector.ts` — Identify module boundaries
- [ ] `src/scale/test-mapper.ts` — Map existing tests to source modules
- [ ] `src/scale/complexity.ts` — Complexity classification
- [ ] `src/scale/expected-counts.ts` — Calculate expected test counts per diamond strategy
- [ ] `src/scale/writer.ts` — Write `coverit.json`
- [ ] `src/skills/scale.md` — Skill file for `/coverit:scale`
- [ ] `src/tools/scale.ts` — MCP tool handler

### 1.3 Build the Measure Command (`/coverit:measure`)

**What:** Read `coverit.json`, scan current test files, update counts, recalculate score. **No AI needed** — this is pure filesystem analysis + math.

**Flow:**
1. Read `coverit.json`
2. Scan all test files in the project
3. Count tests by type per module
4. Update `current` counts in each module
5. Recalculate dimension scores
6. Recalculate overall score
7. Update `coverit.json`
8. Display dashboard

**Why this is fast:** No AI calls. Just file reading, pattern matching, and arithmetic. Can run in <5 seconds on any project.

**Deliverables:**
- [ ] `src/measure/scanner.ts` — Scan and count existing tests
- [ ] `src/measure/scorer.ts` — Calculate dimension and overall scores
- [ ] `src/measure/dashboard.ts` — Terminal output (score, gaps, dimensions)
- [ ] `src/skills/measure.md` — Skill file for `/coverit:measure`
- [ ] `src/tools/measure.ts` — MCP tool handler

### 1.4 Build the Scoring Engine

**What:** The math that turns raw data into a 0-100 score.

**Calculation:**

```
overall = Σ (dimension_score × dimension_weight)

functionality_score = weighted_coverage across test types
security_score = 100 - (issues × severity_weights)
stability_score = error_path_coverage
conformance_score = 100 - (violations × severity_weights)
regression_score = passing_existing / total_existing × 100
```

**Deliverables:**
- [ ] `src/scoring/engine.ts` — Core scoring logic
- [ ] `src/scoring/weights.ts` — Default weights and configurability
- [ ] `src/scoring/thresholds.ts` — Score interpretation (healthy/needs-attention/at-risk)

---

## Phase 2: Security Dimension

**Pain addressed:** "Our AI-generated code might have security vulnerabilities."

### 2.1 Security Scanner

**What:** AI reviews changed code for security issues, mapped to OWASP Top 10.

**Flow:**
1. Read changed files
2. AI analyzes each file for security patterns:
   - Injection vectors (SQL, NoSQL, command)
   - Missing auth guards
   - Hardcoded secrets
   - XSS vectors
   - Insecure configurations
   - Data exposure risks
3. Classify findings by OWASP category and severity
4. Update `coverit.json` security section per module
5. Generate security-focused tests where applicable

**Deliverables:**
- [ ] `src/security/scanner.ts` — AI-powered security review
- [ ] `src/security/owasp-mapping.ts` — Map findings to OWASP Top 10
- [ ] `src/security/severity.ts` — Severity classification (critical/high/medium/low)
- [ ] `src/security/test-generator.ts` — Generate security-specific tests
- [ ] `src/ai/security-prompts.ts` — Prompts for security analysis

### 2.2 Security Reporting

**What:** Clear output distinguishing test issues from real code vulnerabilities.

**Key distinction:** When a security test fails, it means the CODE has a vulnerability, not that the test is wrong. The reporting must make this clear:

```
SECURITY: booking.controller.ts:45
POST /bookings endpoint has no @UseGuards decorator.
Unauthenticated users can create bookings.
This is a CODE issue, not a test issue.
```

**Deliverables:**
- [ ] `src/security/reporter.ts` — Security-specific reporting
- [ ] Update `src/measure/dashboard.ts` — Add security dimension to dashboard

---

## Phase 3: Enhanced Test Generation (Diamond Strategy)

**Pain addressed:** "I don't know what tests are missing, and I can't fill the gaps efficiently."

### 3.1 Gap-Driven Generation

**What:** Instead of AI deciding what to test from scratch, read the standard and target specific gaps.

**Change from current approach:**

| Current (v0.3.x) | Target (v1.0) |
|---|---|
| AI triage decides what to test | `coverit.json` knows what's missing |
| AI picks test types | Diamond strategy determines types |
| Re-discovers on every run | Incremental — only fills new gaps |
| All test types weighted equally | Integration tests prioritized |

**Flow:**
1. Read `coverit.json` → identify gaps per module per test type
2. Prioritize: security gaps first, then integration, then API, then unit, then E2E
3. For each gap: generate targeted tests
4. Run tests
5. Update `coverit.json` with results

**Deliverables:**
- [ ] `src/generators/gap-analyzer.ts` — Identify and prioritize gaps from manifest
- [ ] `src/generators/targeted-generator.ts` — Generate tests for specific gap types
- [ ] Refactor `src/ai/triage-prompts.ts` — Triage reads from manifest, not from scratch
- [ ] Update `src/agents/orchestrator.ts` — Orchestrator reads manifest, uses gap-driven flow

### 3.2 Integration Test Focus

**What:** Improve integration test generation quality. Fewer mocks, more real dependencies.

**Deliverables:**
- [ ] `src/ai/integration-prompts.ts` — Specialized prompts for integration tests
- [ ] `src/ai/api-prompts.ts` — Specialized prompts for API endpoint tests
- [ ] `src/ai/contract-prompts.ts` — Specialized prompts for contract/schema tests

---

## Phase 4: Regression Dimension + CI Integration

**Pain addressed:** "Did my change break something?" + "How do I gate PRs on quality?"

### 4.1 Regression Detection

**What:** Run all existing tests, compare against previous results, flag new failures.

**Flow:**
1. Discover all existing test files
2. Run them all
3. Compare results with previous run (or manifest's regression baseline)
4. Flag newly failing tests as regressions
5. Distinguish "already failing" from "this change broke it"

**Deliverables:**
- [ ] `src/regression/runner.ts` — Run all existing tests
- [ ] `src/regression/comparator.ts` — Compare against baseline
- [ ] `src/regression/reporter.ts` — Regression-specific reporting

### 4.2 CI Integration

**What:** Output that CI pipelines can consume. Score as a merge gate.

**Deliverables:**
- [ ] `src/ci/output.ts` — Machine-readable output (JSON, exit codes)
- [ ] `src/ci/github-action.ts` — GitHub Actions integration (PR comment with score)
- [ ] Documentation for CI setup (GitHub Actions, GitLab CI)

---

## Phase 5: Stability Dimension

**Pain addressed:** "Does my code handle errors properly?"

### 5.1 Stability Analysis

**What:** AI reviews code for error handling gaps, edge cases, resource cleanup.

**Checks:**
- Uncaught exceptions at service boundaries
- Missing error handling for external calls (DB, HTTP, file I/O)
- Resource cleanup (connections, handles, listeners)
- Edge cases: null, empty, overflow, unicode, concurrent access

**Deliverables:**
- [ ] `src/stability/analyzer.ts` — AI-powered stability review
- [ ] `src/stability/test-generator.ts` — Generate edge case and error path tests
- [ ] `src/ai/stability-prompts.ts` — Prompts for stability analysis

---

## Phase 6: Conformance Dimension

**Pain addressed:** "Is my code following established patterns?"

### 6.1 Conformance Analysis

**What:** AI reviews code for pattern compliance, layer violations, naming conventions.

**Checks:**
- Pattern compliance (DI, repository pattern, service pattern)
- Layer violations (controller → DB directly)
- Naming conventions
- Dead code (unused exports)
- Architectural drift

**Deliverables:**
- [ ] `src/conformance/analyzer.ts` — AI-powered conformance review
- [ ] `src/conformance/pattern-detector.ts` — Detect project patterns from existing code
- [ ] `src/ai/conformance-prompts.ts` — Prompts for conformance analysis

---

## Phase 7: Performance Dimension (Future)

**Pain addressed:** "Is my code fast enough?"

Not in v1.0 scope. Architecture supports adding this later.

---

## Updated Command Structure

### Commands After v1.0

| Command | What it does | AI needed? | Cost |
|---|---|---|---|
| `coverit` / `/coverit:full` | Full pipeline: measure → detect → generate → run → fix → update | Yes | High |
| `/coverit:scale` | Generate or regenerate `coverit.json` from full codebase | Yes | High (run rarely) |
| `/coverit:measure` | Score against standard, show dashboard | **No** | Free, fast |
| `/coverit:status` | Show current score and gaps from `coverit.json` | **No** | Free, instant |
| `/coverit:fix` | Fix failing tests from last run | Yes | Medium |
| `/coverit:scan` | Analyze changes, show what would be generated (dry run) | Yes | Medium |
| `/coverit:generate` | Generate tests without running them | Yes | Medium |
| `/coverit:run` | Run generated tests from a prior generate | No | Low |

### Removed/Renamed Commands

| Old command | Disposition |
|---|---|
| `/coverit:check` | Merged into `/coverit:measure` |
| `/coverit:clear` | Kept (cleanup utility) |
| `/coverit:list` | Kept (list runs) |

---

## File Structure Changes

### New files (by phase)

```
src/
├── schema/                          # Phase 1
│   ├── coverit-manifest.ts          # TypeScript interfaces
│   ├── coverit-manifest.schema.json # JSON Schema
│   ├── defaults.ts                  # Default configs
│   └── validation.ts                # Runtime validation
├── scale/                           # Phase 1
│   ├── analyzer.ts                  # Full codebase analysis
│   ├── module-detector.ts           # Module boundary detection
│   ├── test-mapper.ts               # Map tests to source
│   ├── complexity.ts                # Complexity classification
│   ├── expected-counts.ts           # Diamond-based expected counts
│   └── writer.ts                    # Write coverit.json
├── measure/                         # Phase 1
│   ├── scanner.ts                   # Scan and count tests
│   ├── scorer.ts                    # Calculate scores
│   └── dashboard.ts                 # Terminal output
├── scoring/                         # Phase 1
│   ├── engine.ts                    # Core scoring logic
│   ├── weights.ts                   # Weights and config
│   └── thresholds.ts                # Score interpretation
├── security/                        # Phase 2
│   ├── scanner.ts                   # Security review
│   ├── owasp-mapping.ts             # OWASP classification
│   ├── severity.ts                  # Severity levels
│   ├── test-generator.ts            # Security test generation
│   └── reporter.ts                  # Security reporting
├── generators/                      # Phase 3 (new files alongside existing)
│   ├── gap-analyzer.ts              # Gap identification
│   └── targeted-generator.ts        # Gap-targeted generation
├── regression/                      # Phase 4
│   ├── runner.ts                    # Run existing tests
│   ├── comparator.ts                # Baseline comparison
│   └── reporter.ts                  # Regression reporting
├── ci/                              # Phase 4
│   ├── output.ts                    # Machine-readable output
│   └── github-action.ts             # GitHub Actions integration
├── stability/                       # Phase 5
│   ├── analyzer.ts                  # Stability review
│   └── test-generator.ts            # Edge case test generation
├── conformance/                     # Phase 6
│   ├── analyzer.ts                  # Conformance review
│   └── pattern-detector.ts          # Pattern detection
└── ai/                              # Across phases (new prompts)
    ├── security-prompts.ts          # Phase 2
    ├── integration-prompts.ts       # Phase 3
    ├── api-prompts.ts               # Phase 3
    ├── contract-prompts.ts          # Phase 3
    ├── stability-prompts.ts         # Phase 5
    └── conformance-prompts.ts       # Phase 6
```

### Modified files

```
src/agents/orchestrator.ts           # Read manifest, gap-driven flow
src/ai/triage-prompts.ts             # Triage reads from manifest
src/tools/                           # New tool handlers for scale, measure, status
src/skills/                          # New skill files for new commands
```

---

## What Gets Thrown Out

The user stated: *"Every line of code, every command, every past decision can be thrown out and rewritten from scratch."*

However, significant parts of the current codebase remain valuable:

### Keep (solid foundation)

| Component | Why |
|---|---|
| AI provider abstraction | Works, supports multiple providers |
| Test execution engine (local-runner) | Reliable, framework-agnostic |
| Retry/refinement loop | Proven pattern for fixing AI-generated tests |
| Run isolation (`.coverit/runs/`) | Clean separation, good for debugging |
| Framework detection | Monorepo-aware, battle-tested |
| `looksLikeTestCode` guard | Prevents garbage output |
| Large file truncation | Handles real-world codebases |

### Rewrite

| Component | Why |
|---|---|
| Triage/scan flow | Must read from manifest instead of rediscovering |
| Report format | Must include multi-dimensional scoring |
| CLI output | Must show dashboard with score and dimensions |

### Add (entirely new)

| Component | Why |
|---|---|
| `coverit.json` manifest | The core innovation |
| Scale command | Creates the standard |
| Measure command | Cheap scoring without AI |
| Security dimension | Key painkiller |
| Scoring engine | The product's value output |
| CI integration | Enterprise adoption enabler |

---

## Success Criteria

### Phase 1 is successful when:
- [ ] Running `/coverit:scale` on a real project produces a `coverit.json` that accurately reflects the codebase
- [ ] Running `/coverit:measure` produces a score that makes intuitive sense
- [ ] The score changes meaningfully when tests are added or removed
- [ ] `coverit.json` is small enough to commit to git (<200KB for a large project)
- [ ] A developer can look at the dashboard and understand what's missing

### Phase 2 is successful when:
- [ ] Coverit catches at least one real security issue in an AI-generated codebase
- [ ] Security findings are mapped to OWASP categories
- [ ] The output clearly distinguishes "test bug" from "code vulnerability"

### Phase 3 is successful when:
- [ ] Generated tests target specific gaps identified by the manifest
- [ ] Integration tests outnumber unit tests in the output (diamond shape)
- [ ] Score increases after running coverit (gaps get filled)

### Phase 4 is successful when:
- [ ] Coverit detects a regression (newly failing test) that was caused by a code change
- [ ] CI pipeline can use coverit score as a merge gate
- [ ] PR comments show score change

### The whole thing is successful when:
- [ ] A developer runs `coverit` after making changes and trusts the output enough to ship
- [ ] A team uses the score in CI and it catches real issues before merge
- [ ] Someone says: "We don't need a separate QA engineer — coverit catches what they would."

---

## Open Questions

### Schema & Data

1. **Should `coverit.json` include the full module inventory, or just modules with gaps?** Full inventory is more complete but larger. Gap-only is smaller but doesn't show "everything is covered."

2. **How does the scale command handle monorepos?** One `coverit.json` per sub-project? One for the whole repo? Need to decide.

3. **Should the measure command update `coverit.json` in place, or create a separate report?** Updating in place means `git diff coverit.json` shows the delta. Separate report means the manifest stays stable until explicitly regenerated.

4. **How to handle projects with zero existing tests?** The score would be 0-10. Is that useful, or does it just feel demoralizing? Maybe a "getting started" mode that's more encouraging.

### Security

5. **Should security findings block the score entirely (score = 0 if critical security issue) or just reduce it?** A critical SQL injection arguably means the code should never ship, regardless of other dimensions.

6. **What's the minimum viable "security scan"?** Full OWASP coverage is ambitious. Maybe start with the top 3-4 most common issues in AI-generated code (injection, auth bypass, secrets, XSS).

### Scope & Behavior

7. **Should unstaged scope generate tests or only show gaps?** Generating tests for uncommitted code means the test files exist before the source is committed. This could confuse git state.

8. **Should auto-detection prefer staged over unstaged when both exist?** A developer might have staged some files and be editing others. Which scope wins?

9. **For branch scope, what's the base branch?** Default to `main`? Auto-detect from git config? Allow override? Monorepos may have different conventions.

### Distribution

10. **Should the CLI experience mirror the plugin experience exactly?** The plugin uses Claude Code as the AI provider (free, powerful). The CLI needs an external provider. Should the CLI show a "for best results, use inside Claude Code" message?

11. **Should the CLI auto-configure providers via a setup wizard?** Currently `npx @devness/coverit mcp` runs a setup wizard. Should `npx @devness/coverit run` also prompt for provider setup on first use?

### Tracking

12. **How much score history should live in `coverit.json`?** Last 10 entries? Last 30 days? Unbounded? Too much history bloats the file. Too little loses trend visibility.

13. **Should `.coverit/analytics.json` be git-tracked?** It contains aggregate stats that could be useful for the team, but it also grows continuously.
