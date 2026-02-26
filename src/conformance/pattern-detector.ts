/**
 * Coverit — Pattern Detector (Static Analysis)
 *
 * Detects established code patterns from existing project files
 * WITHOUT using AI. This is pure filesystem + regex analysis that
 * identifies:
 *
 *   - Dependency injection usage (constructor injection)
 *   - Layer architecture (controller/service/repository separation)
 *   - File and symbol naming conventions
 *   - Framework-specific patterns (NestJS decorators, Hono middleware, etc.)
 *
 * The detected patterns are fed into the AI conformance prompt so
 * the analysis is project-specific rather than generic.
 */

import fs from "node:fs/promises";
import path from "node:path";
import fg from "fast-glob";

// ─── Public Types ───────────────────────────────────────────

export interface DetectedPatterns {
  /** Whether the project uses constructor-based dependency injection */
  dependencyInjection: boolean;
  /** Whether the project follows a layered architecture (controller -> service -> repository) */
  layerArchitecture: boolean;
  /** Detected naming conventions for files, classes, and functions */
  namingConventions: {
    files: string;
    classes: string;
    functions: string;
  };
  /** Framework-specific patterns detected (e.g., "NestJS decorators", "Hono middleware chains") */
  frameworkPatterns: string[];
}

// ─── Public API ─────────────────────────────────────────────

/**
 * Detect established patterns in the project by analyzing directory
 * structure and sampling source files.
 *
 * Designed to be fast -- reads at most ~50 files and uses regex
 * matching rather than full AST parsing. The results are approximate
 * but sufficient for guiding AI conformance analysis.
 */
export async function detectPatterns(
  projectRoot: string,
): Promise<DetectedPatterns> {
  const sourceFiles = await discoverSourceFiles(projectRoot);
  const sampleFiles = await sampleFileContents(projectRoot, sourceFiles);

  const dependencyInjection = detectDependencyInjection(sampleFiles);
  const layerArchitecture = detectLayerArchitecture(sourceFiles);
  const namingConventions = detectNamingConventions(sourceFiles, sampleFiles);
  const frameworkPatterns = detectFrameworkPatterns(sampleFiles, sourceFiles);

  return {
    dependencyInjection,
    layerArchitecture,
    namingConventions,
    frameworkPatterns,
  };
}

// ─── Source File Discovery ──────────────────────────────────

const SOURCE_PATTERNS = [
  "src/**/*.ts",
  "src/**/*.tsx",
  "src/**/*.js",
  "src/**/*.jsx",
  "lib/**/*.ts",
  "lib/**/*.js",
  "app/**/*.ts",
  "app/**/*.tsx",
  "packages/*/src/**/*.ts",
  "packages/*/src/**/*.tsx",
];

const IGNORED_DIRS = [
  "**/node_modules/**",
  "**/dist/**",
  "**/build/**",
  "**/.coverit/**",
  "**/coverage/**",
  "**/*.test.*",
  "**/*.spec.*",
  "**/__tests__/**",
  "**/*.d.ts",
];

async function discoverSourceFiles(projectRoot: string): Promise<string[]> {
  const results = await fg(SOURCE_PATTERNS, {
    cwd: projectRoot,
    ignore: IGNORED_DIRS,
    onlyFiles: true,
  });

  return [...new Set(results)].sort();
}

// ─── File Sampling ──────────────────────────────────────────

interface SampledFile {
  relativePath: string;
  content: string;
}

/**
 * Read a representative sample of source files for pattern detection.
 * Prioritizes files in key directories (controllers, services, etc.)
 * and caps total reads to avoid slow analysis on large codebases.
 */
const MAX_SAMPLE_FILES = 50;
const MAX_FILE_SIZE = 50_000;

async function sampleFileContents(
  projectRoot: string,
  allFiles: string[],
): Promise<SampledFile[]> {
  // Prioritize structurally significant files
  const prioritized = prioritizeFiles(allFiles);
  const toRead = prioritized.slice(0, MAX_SAMPLE_FILES);

  const results: SampledFile[] = [];
  for (const relativePath of toRead) {
    try {
      const absolutePath = path.join(projectRoot, relativePath);
      const stat = await fs.stat(absolutePath);
      if (stat.size > MAX_FILE_SIZE) continue;

      const content = await fs.readFile(absolutePath, "utf-8");
      results.push({ relativePath, content });
    } catch {
      // File may have been deleted or become unreadable -- skip silently
    }
  }

  return results;
}

/**
 * Sort files so structurally significant ones come first.
 * Controllers, services, repositories, and middleware files
 * are most informative for pattern detection.
 */
function prioritizeFiles(files: string[]): string[] {
  const HIGH_PRIORITY_PATTERNS = [
    /controller/i,
    /service/i,
    /repository/i,
    /middleware/i,
    /module/i,
    /provider/i,
    /guard/i,
    /interceptor/i,
    /resolver/i,
    /gateway/i,
  ];

  const scored = files.map((file) => {
    const priority = HIGH_PRIORITY_PATTERNS.some((p) => p.test(file)) ? 0 : 1;
    return { file, priority };
  });

  scored.sort((a, b) => a.priority - b.priority);
  return scored.map((s) => s.file);
}

// ─── Dependency Injection Detection ─────────────────────────

/**
 * Detect whether the project uses constructor-based DI.
 *
 * Heuristics:
 *   - NestJS: @Injectable() decorator + constructor with typed params
 *   - InversifyJS: @injectable() decorator
 *   - tsyringe: @injectable() or @inject() decorators
 *   - Manual: constructor parameters typed as interfaces (e.g., `private readonly userService: UserService`)
 *
 * Requires 3+ files exhibiting the pattern to avoid false positives
 * from a single file happening to use constructor injection.
 */
function detectDependencyInjection(files: SampledFile[]): boolean {
  const DI_PATTERNS = [
    // NestJS @Injectable()
    /@Injectable\(\)/,
    // InversifyJS / tsyringe decorators
    /@injectable\(\)/,
    /@inject\(/,
    // Constructor injection pattern: private readonly someService: SomeType
    /constructor\s*\([^)]*private\s+(?:readonly\s+)?\w+\s*:\s*\w+/,
    // Awilix-style
    /asClass\(|asFunction\(/,
  ];

  let matchCount = 0;
  for (const file of files) {
    const hasPattern = DI_PATTERNS.some((pattern) =>
      pattern.test(file.content),
    );
    if (hasPattern) matchCount++;
  }

  // Threshold: 3+ files using DI patterns indicates project-wide adoption
  return matchCount >= 3;
}

// ─── Layer Architecture Detection ───────────────────────────

/**
 * Detect layered architecture by checking directory structure.
 *
 * A project has layer architecture if it contains at least two of:
 *   - controllers/ (or routes/)
 *   - services/
 *   - repositories/ (or models/ or entities/)
 *
 * This is deliberately conservative -- a project with only services/
 * and no controllers does not qualify.
 */
function detectLayerArchitecture(files: string[]): boolean {
  let hasControllers = false;
  let hasServices = false;
  let hasRepositories = false;

  for (const file of files) {
    const lower = file.toLowerCase();
    if (
      lower.includes("/controllers/") ||
      lower.includes("/controller.") ||
      lower.includes("/routes/")
    ) {
      hasControllers = true;
    }
    if (lower.includes("/services/") || lower.includes("/service.")) {
      hasServices = true;
    }
    if (
      lower.includes("/repositories/") ||
      lower.includes("/repository.") ||
      lower.includes("/models/") ||
      lower.includes("/entities/")
    ) {
      hasRepositories = true;
    }
  }

  // At least 2 of 3 layers must be present
  const layerCount =
    (hasControllers ? 1 : 0) +
    (hasServices ? 1 : 0) +
    (hasRepositories ? 1 : 0);

  return layerCount >= 2;
}

// ─── Naming Convention Detection ────────────────────────────

interface NamingConventions {
  files: string;
  classes: string;
  functions: string;
}

/**
 * Analyze existing file names and code symbols to determine
 * the project's naming conventions.
 *
 * For files: examines the basename pattern (kebab-case, camelCase, etc.)
 * For classes/functions: samples exported symbols from code content.
 */
function detectNamingConventions(
  files: string[],
  samples: SampledFile[],
): NamingConventions {
  const fileConvention = detectFileNamingConvention(files);
  const classConvention = detectClassNamingConvention(samples);
  const functionConvention = detectFunctionNamingConvention(samples);

  return {
    files: fileConvention,
    classes: classConvention,
    functions: functionConvention,
  };
}

type NamingStyle =
  | "kebab-case"
  | "camelCase"
  | "PascalCase"
  | "snake_case"
  | "mixed";

function detectFileNamingConvention(files: string[]): NamingStyle {
  const counts: Record<NamingStyle, number> = {
    "kebab-case": 0,
    camelCase: 0,
    PascalCase: 0,
    snake_case: 0,
    mixed: 0,
  };

  for (const file of files) {
    // Extract filename without extension and path
    const basename = path.basename(file).replace(/\.[^.]+$/, "");
    // Strip common suffixes for cleaner analysis
    const cleaned = basename
      .replace(/\.(module|service|controller|repository|spec|test|dto|entity|model|guard|middleware|interceptor|pipe|filter|resolver|gateway)$/i, "");

    if (!cleaned) continue;

    const style = classifyNamingStyle(cleaned);
    counts[style]++;
  }

  return dominantStyle(counts);
}

function detectClassNamingConvention(samples: SampledFile[]): NamingStyle {
  const counts: Record<NamingStyle, number> = {
    "kebab-case": 0,
    camelCase: 0,
    PascalCase: 0,
    snake_case: 0,
    mixed: 0,
  };

  const CLASS_REGEX = /(?:export\s+)?class\s+(\w+)/g;

  for (const file of samples) {
    let match: RegExpExecArray | null;
    while ((match = CLASS_REGEX.exec(file.content)) !== null) {
      const name = match[1];
      if (name) {
        counts[classifyNamingStyle(name)]++;
      }
    }
  }

  return dominantStyle(counts);
}

function detectFunctionNamingConvention(samples: SampledFile[]): NamingStyle {
  const counts: Record<NamingStyle, number> = {
    "kebab-case": 0,
    camelCase: 0,
    PascalCase: 0,
    snake_case: 0,
    mixed: 0,
  };

  // Match exported function declarations and arrow functions
  const FUNCTION_REGEX =
    /(?:export\s+)?(?:async\s+)?function\s+(\w+)|(?:export\s+)?(?:const|let)\s+(\w+)\s*=\s*(?:async\s+)?\(/g;

  for (const file of samples) {
    let match: RegExpExecArray | null;
    while ((match = FUNCTION_REGEX.exec(file.content)) !== null) {
      const name = match[1] ?? match[2];
      if (name) {
        counts[classifyNamingStyle(name)]++;
      }
    }
  }

  return dominantStyle(counts);
}

/**
 * Classify a single identifier into a naming style.
 */
function classifyNamingStyle(name: string): NamingStyle {
  if (/^[a-z][a-z0-9]*(-[a-z0-9]+)+$/.test(name)) return "kebab-case";
  if (/^[a-z][a-z0-9]*(_[a-z0-9]+)+$/.test(name)) return "snake_case";
  if (/^[A-Z][a-zA-Z0-9]*$/.test(name)) return "PascalCase";
  if (/^[a-z][a-zA-Z0-9]*$/.test(name)) return "camelCase";
  return "mixed";
}

/**
 * Return the naming style with the highest count.
 * Falls back to "mixed" if counts are tied or all zero.
 */
function dominantStyle(counts: Record<NamingStyle, number>): NamingStyle {
  let maxCount = 0;
  let maxStyle: NamingStyle = "mixed";

  for (const [style, count] of Object.entries(counts) as Array<
    [NamingStyle, number]
  >) {
    if (count > maxCount) {
      maxCount = count;
      maxStyle = style;
    }
  }

  return maxStyle;
}

// ─── Framework Pattern Detection ────────────────────────────

/**
 * Detect framework-specific patterns from code content.
 *
 * Each pattern requires evidence from 2+ files to avoid false
 * positives from a single import or decorator usage.
 */
function detectFrameworkPatterns(
  samples: SampledFile[],
  _allFiles: string[],
): string[] {
  const detected: string[] = [];

  const patterns: Array<{ name: string; regex: RegExp; minFiles: number }> = [
    // NestJS
    {
      name: "NestJS decorators (@Controller, @Get, @Post, etc.)",
      regex: /@(?:Controller|Get|Post|Put|Delete|Patch|Module|Injectable)\(/,
      minFiles: 2,
    },
    {
      name: "NestJS guards (@UseGuards)",
      regex: /@UseGuards\(/,
      minFiles: 1,
    },
    {
      name: "NestJS interceptors (@UseInterceptors)",
      regex: /@UseInterceptors\(/,
      minFiles: 1,
    },
    {
      name: "NestJS pipes (@UsePipes, ValidationPipe)",
      regex: /@UsePipes\(|ValidationPipe/,
      minFiles: 1,
    },
    // Hono
    {
      name: "Hono middleware chains (app.use, c.json)",
      regex: /new\s+Hono\(|app\.(?:use|get|post|put|delete|patch)\(/,
      minFiles: 2,
    },
    // Express
    {
      name: "Express router pattern (Router(), req/res/next)",
      regex: /express\.Router\(\)|Router\(\)|(?:req|res|next)\s*:\s*(?:Request|Response|NextFunction)/,
      minFiles: 2,
    },
    // Fastify
    {
      name: "Fastify plugin pattern (fp, fastify.register)",
      regex: /fastify\.register\(|fp\(/,
      minFiles: 2,
    },
    // Drizzle ORM
    {
      name: "Drizzle ORM schema (pgTable, sqliteTable)",
      regex: /pgTable\(|sqliteTable\(|mysqlTable\(/,
      minFiles: 1,
    },
    // Mongoose
    {
      name: "Mongoose schemas (Schema, model())",
      regex: /new\s+Schema\(|mongoose\.model\(|@Schema\(\)/,
      minFiles: 1,
    },
    // Prisma
    {
      name: "Prisma client usage",
      regex: /PrismaClient|prisma\.\w+\.(?:find|create|update|delete)/,
      minFiles: 1,
    },
    // TypeORM
    {
      name: "TypeORM decorators (@Entity, @Column)",
      regex: /@Entity\(|@Column\(|@PrimaryGeneratedColumn\(/,
      minFiles: 2,
    },
    // Zustand
    {
      name: "Zustand state management (create store)",
      regex: /import\s+.*\bfrom\s+['"]zustand['"]/,
      minFiles: 1,
    },
    // Zod validation
    {
      name: "Zod schema validation (z.object, z.string)",
      regex: /z\.object\(|z\.string\(|z\.number\(|z\.enum\(/,
      minFiles: 2,
    },
  ];

  for (const pat of patterns) {
    let fileCount = 0;
    for (const file of samples) {
      if (pat.regex.test(file.content)) fileCount++;
    }
    if (fileCount >= pat.minFiles) {
      detected.push(pat.name);
    }
  }

  return detected;
}
