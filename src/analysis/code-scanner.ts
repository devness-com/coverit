import { Project, SyntaxKind, type SourceFile, type Node } from "ts-morph";
import { resolve, relative, extname } from "path";
import type {
  CodeScanResult,
  ExportedSymbol,
  ImportedModule,
  FunctionInfo,
  ParamInfo,
  ClassInfo,
  PropertyInfo,
  EndpointInfo,
  ComponentInfo,
  Language,
  FileType,
} from "../types/index.js";

const EXTENSION_TO_LANGUAGE: Record<string, Language> = {
  ".ts": "typescript",
  ".tsx": "typescript",
  ".js": "javascript",
  ".jsx": "javascript",
  ".mjs": "javascript",
  ".cjs": "javascript",
};

const FILE_TYPE_RULES: Array<[RegExp, FileType]> = [
  [/\.(test|spec)\.[^/]+$/, "test"],
  [/\/src-tauri\//, "desktop-window"],
  [/\/desktop\/.*components?\//, "desktop-component"],
  [/\/desktop\//, "desktop-window"],
  [/\/mobile\/.*screens?\//, "mobile-screen"],
  [/\/mobile\/.*components?\//, "mobile-component"],
  [/\/expo\/.*screens?\//, "mobile-screen"],
  [/\/expo\/.*components?\//, "mobile-component"],
  [/\/routes?\//, "api-route"],
  [/\/api\//, "api-route"],
  [/\/controllers?\//, "api-controller"],
  [/\/middleware\//, "middleware"],
  [/\/pages?\//, "react-page"],
  [/\/screens?\//, "react-page"],
  [/\/hooks?\//, "react-hook"],
  [/\/components?\//, "react-component"],
  [/\/services?\//, "service"],
  [/\/utils?\//, "utility"],
  [/\/helpers?\//, "utility"],
  [/\/models?\//, "model"],
  [/\/entities\//, "model"],
  [/\/schemas?\//, "schema"],
  [/\/migrations?\//, "migration"],
  [/\.(config|rc)\.[^/]+$/, "config"],
  [/\/config\//, "config"],
  [/\.(css|scss|sass|less|styl)$/, "style"],
];

function detectLanguage(filePath: string): Language {
  const ext = extname(filePath).toLowerCase();
  return EXTENSION_TO_LANGUAGE[ext] ?? "unknown";
}

function detectFileType(filePath: string): FileType {
  const normalized = filePath.replace(/\\/g, "/");
  for (const [pattern, fileType] of FILE_TYPE_RULES) {
    if (pattern.test(normalized)) return fileType;
  }
  if (normalized.endsWith(".tsx")) return "react-component";
  return "unknown";
}

/**
 * Count branching/logical operators in a function body for cyclomatic complexity.
 * Base complexity is 1 (single path). Each branch point adds 1.
 */
function calculateComplexity(node: Node): number {
  let complexity = 1;

  node.forEachDescendant((descendant) => {
    switch (descendant.getKind()) {
      case SyntaxKind.IfStatement:
      case SyntaxKind.ForStatement:
      case SyntaxKind.ForInStatement:
      case SyntaxKind.ForOfStatement:
      case SyntaxKind.WhileStatement:
      case SyntaxKind.DoStatement:
      case SyntaxKind.CatchClause:
      case SyntaxKind.ConditionalExpression: // ternary
      case SyntaxKind.CaseClause:
        complexity++;
        break;
      case SyntaxKind.BinaryExpression: {
        const opToken = descendant.getChildAtIndex(1);
        if (opToken) {
          const opKind = opToken.getKind();
          if (
            opKind === SyntaxKind.AmpersandAmpersandToken ||
            opKind === SyntaxKind.BarBarToken ||
            opKind === SyntaxKind.QuestionQuestionToken
          ) {
            complexity++;
          }
        }
        break;
      }
    }
  });

  return complexity;
}

function extractParams(
  params: { getName(): string; getType(): { getText(): string }; isOptional(): boolean; getInitializer(): Node | undefined }[]
): ParamInfo[] {
  return params.map((p) => ({
    name: p.getName(),
    type: p.getType().getText() ?? null,
    isOptional: p.isOptional(),
    defaultValue: p.getInitializer()?.getText() ?? null,
  }));
}

function extractExports(sourceFile: SourceFile): ExportedSymbol[] {
  const symbols: ExportedSymbol[] = [];

  for (const decl of sourceFile.getExportedDeclarations()) {
    const [name, declarations] = decl;
    for (const d of declarations) {
      let kind: ExportedSymbol["kind"] = "variable";
      const nodeKind = d.getKind();

      if (nodeKind === SyntaxKind.FunctionDeclaration) kind = "function";
      else if (nodeKind === SyntaxKind.ClassDeclaration) kind = "class";
      else if (nodeKind === SyntaxKind.TypeAliasDeclaration) kind = "type";
      else if (nodeKind === SyntaxKind.InterfaceDeclaration) kind = "interface";
      else if (nodeKind === SyntaxKind.EnumDeclaration) kind = "enum";

      // Check if this is the default export
      const isDefault = name === "default";

      symbols.push({
        name: isDefault ? (d.getSymbol()?.getName() ?? "default") : name,
        kind,
        isDefault,
        line: d.getStartLineNumber(),
      });
    }
  }

  return symbols;
}

function extractImports(sourceFile: SourceFile): ImportedModule[] {
  return sourceFile.getImportDeclarations().map((decl) => {
    const source = decl.getModuleSpecifierValue();
    const specifiers: string[] = [];

    const defaultImport = decl.getDefaultImport();
    if (defaultImport) {
      specifiers.push(defaultImport.getText());
    }

    for (const named of decl.getNamedImports()) {
      specifiers.push(named.getName());
    }

    const namespaceImport = decl.getNamespaceImport();
    if (namespaceImport) {
      specifiers.push(`* as ${namespaceImport.getText()}`);
    }

    // External = not starting with . or /
    const isExternal = !source.startsWith(".") && !source.startsWith("/");

    return { source, specifiers, isExternal };
  });
}

function extractFunctions(sourceFile: SourceFile): FunctionInfo[] {
  const functions: FunctionInfo[] = [];

  // Top-level function declarations
  for (const fn of sourceFile.getFunctions()) {
    functions.push({
      name: fn.getName() ?? "(anonymous)",
      params: extractParams(fn.getParameters()),
      returnType: fn.getReturnTypeNode()?.getText() ?? null,
      isAsync: fn.isAsync(),
      isExported: fn.isExported(),
      line: fn.getStartLineNumber(),
      complexity: calculateComplexity(fn),
    });
  }

  // Top-level variable declarations with arrow functions
  for (const stmt of sourceFile.getVariableStatements()) {
    const isExported = stmt.isExported();
    for (const decl of stmt.getDeclarations()) {
      const initializer = decl.getInitializer();
      if (!initializer) continue;

      const isArrow = initializer.getKind() === SyntaxKind.ArrowFunction;
      const isFnExpr = initializer.getKind() === SyntaxKind.FunctionExpression;

      if (isArrow || isFnExpr) {
        const fn = initializer as unknown as {
          getParameters(): Parameters<typeof extractParams>[0];
          getReturnTypeNode(): { getText(): string } | undefined;
          isAsync(): boolean;
        };

        functions.push({
          name: decl.getName(),
          params: extractParams(fn.getParameters()),
          returnType: fn.getReturnTypeNode()?.getText() ?? null,
          isAsync: fn.isAsync(),
          isExported,
          line: decl.getStartLineNumber(),
          complexity: calculateComplexity(initializer),
        });
      }
    }
  }

  return functions;
}

function extractClasses(sourceFile: SourceFile): ClassInfo[] {
  return sourceFile.getClasses().map((cls) => {
    const methods: FunctionInfo[] = cls.getMethods().map((m) => ({
      name: m.getName(),
      params: extractParams(m.getParameters()),
      returnType: m.getReturnTypeNode()?.getText() ?? null,
      isAsync: m.isAsync(),
      isExported: false,
      line: m.getStartLineNumber(),
      complexity: calculateComplexity(m),
    }));

    const properties: PropertyInfo[] = cls.getProperties().map((p) => ({
      name: p.getName(),
      type: p.getTypeNode()?.getText() ?? null,
      isPublic:
        p.getScope() === undefined ||
        p.getScope() === "public" ||
        // ts-morph returns undefined for implicit public
        !["private", "protected"].includes(p.getScope() ?? ""),
    }));

    return {
      name: cls.getName() ?? "(anonymous)",
      methods,
      properties,
      isExported: cls.isExported(),
      line: cls.getStartLineNumber(),
    };
  });
}

/**
 * Detect HTTP endpoint registrations:
 * - Hono: app.get('/path', handler), app.post(...)
 * - Express: router.get('/path', handler), app.post(...)
 * - NestJS: @Get('/path'), @Post('/path') decorators
 */
function extractEndpoints(sourceFile: SourceFile): EndpointInfo[] {
  const endpoints: EndpointInfo[] = [];
  const httpMethods = ["get", "post", "put", "patch", "delete"] as const;
  type HttpMethodLower = (typeof httpMethods)[number];

  const toUpper = (m: HttpMethodLower): EndpointInfo["method"] =>
    m.toUpperCase() as EndpointInfo["method"];

  // Hono / Express style: app.get('/path', handler) or router.post(...)
  for (const callExpr of sourceFile.getDescendantsOfKind(SyntaxKind.CallExpression)) {
    const expr = callExpr.getExpression();
    if (expr.getKind() !== SyntaxKind.PropertyAccessExpression) continue;

    const propAccess = expr.asKind(SyntaxKind.PropertyAccessExpression);
    if (!propAccess) continue;

    // Skip config/env lookups that happen to use .get()
    const objText = propAccess.getExpression().getText();
    if (
      objText.includes("process.env") ||
      objText.includes("configService") ||
      objText.includes("ConfigService") ||
      objText.includes("config.")
    ) continue;

    const methodName = propAccess.getName().toLowerCase();
    if (!httpMethods.includes(methodName as HttpMethodLower)) continue;

    const args = callExpr.getArguments();
    if (args.length === 0) continue;

    const firstArg = args[0]!;
    // First argument should be a string literal (the path)
    if (firstArg.getKind() !== SyntaxKind.StringLiteral) continue;

    const path = firstArg.getText().replace(/['"]/g, "");
    const middleware: string[] = [];
    let handler = "(anonymous)";

    // Last argument is the handler, middle arguments are middleware
    for (let i = 1; i < args.length; i++) {
      const arg = args[i]!;
      const text = arg.getText();
      if (i === args.length - 1) {
        handler = text.includes("=>") || text.includes("function") ? "(inline)" : text;
      } else {
        middleware.push(text);
      }
    }

    endpoints.push({
      method: toUpper(methodName as HttpMethodLower),
      path,
      handler,
      middleware,
      line: callExpr.getStartLineNumber(),
    });
  }

  // NestJS decorators: @Get('/path'), @Post('/path')
  const decoratorMethods: Record<string, EndpointInfo["method"]> = {
    Get: "GET",
    Post: "POST",
    Put: "PUT",
    Patch: "PATCH",
    Delete: "DELETE",
  };

  for (const cls of sourceFile.getClasses()) {
    for (const method of cls.getMethods()) {
      for (const decorator of method.getDecorators()) {
        const decoratorName = decorator.getName();
        const httpMethod = decoratorMethods[decoratorName];
        if (!httpMethod) continue;

        const decoratorArgs = decorator.getArguments();
        const path =
          decoratorArgs.length > 0
            ? decoratorArgs[0]!.getText().replace(/['"]/g, "")
            : "/";

        // Collect middleware decorators like @UseGuards, @UseInterceptors
        const middleware = method
          .getDecorators()
          .filter((d) => d.getName() !== decoratorName)
          .map((d) => d.getName());

        endpoints.push({
          method: httpMethod,
          path,
          handler: method.getName(),
          middleware,
          line: decorator.getStartLineNumber(),
        });
      }
    }
  }

  return endpoints;
}

/**
 * Detect React function components that return JSX.
 * Identifies props interface and hook usage.
 */
function extractComponents(sourceFile: SourceFile): ComponentInfo[] {
  const components: ComponentInfo[] = [];
  const filePath = sourceFile.getFilePath();

  // Only check tsx/jsx files (or files already identified as component types)
  if (!filePath.endsWith(".tsx") && !filePath.endsWith(".jsx")) {
    return components;
  }

  // Check exported function declarations returning JSX
  for (const fn of sourceFile.getFunctions()) {
    if (!fn.isExported()) continue;
    const name = fn.getName();
    if (!name || !/^[A-Z]/.test(name)) continue; // React components are PascalCase

    if (containsJsx(fn)) {
      components.push({
        name,
        props: extractParams(fn.getParameters()),
        hooks: extractHooks(fn),
        isPage: isPageComponent(filePath),
        line: fn.getStartLineNumber(),
      });
    }
  }

  // Check exported arrow functions returning JSX
  for (const stmt of sourceFile.getVariableStatements()) {
    if (!stmt.isExported()) continue;
    for (const decl of stmt.getDeclarations()) {
      const name = decl.getName();
      if (!/^[A-Z]/.test(name)) continue;

      const initializer = decl.getInitializer();
      if (!initializer) continue;

      if (
        initializer.getKind() === SyntaxKind.ArrowFunction ||
        initializer.getKind() === SyntaxKind.FunctionExpression
      ) {
        if (containsJsx(initializer)) {
          const fn = initializer as unknown as {
            getParameters(): Parameters<typeof extractParams>[0];
          };

          components.push({
            name,
            props: extractParams(fn.getParameters()),
            hooks: extractHooks(initializer),
            isPage: isPageComponent(filePath),
            line: decl.getStartLineNumber(),
          });
        }
      }
    }
  }

  return components;
}

function containsJsx(node: Node): boolean {
  return (
    node.getDescendantsOfKind(SyntaxKind.JsxElement).length > 0 ||
    node.getDescendantsOfKind(SyntaxKind.JsxSelfClosingElement).length > 0 ||
    node.getDescendantsOfKind(SyntaxKind.JsxFragment).length > 0
  );
}

/**
 * Extract React hook calls (useXxx pattern) from a function body.
 */
function extractHooks(node: Node): string[] {
  const hooks = new Set<string>();

  for (const call of node.getDescendantsOfKind(SyntaxKind.CallExpression)) {
    const expr = call.getExpression();
    const text = expr.getText();
    // Match useXxx pattern (built-in and custom hooks)
    if (/^use[A-Z]/.test(text)) {
      hooks.add(text);
    }
  }

  return Array.from(hooks);
}

function isPageComponent(filePath: string): boolean {
  const normalized = filePath.replace(/\\/g, "/");
  return /\/(pages?|screens?)\//.test(normalized);
}

/**
 * Perform AST-level code analysis on a TypeScript/JavaScript file.
 *
 * @param filePath - Absolute path to the source file
 * @param projectRoot - Absolute path to the project root (for relative path computation)
 */
export async function scanCode(
  filePath: string,
  projectRoot: string
): Promise<CodeScanResult> {
  const absolutePath = resolve(filePath);
  const relPath = relative(resolve(projectRoot), absolutePath);

  const project = new Project({
    compilerOptions: {
      allowJs: true,
      jsx: 2, // React
      noEmit: true,
      strict: false, // Lenient for scanning; we're reading structure, not type-checking
    },
    skipAddingFilesFromTsConfig: true,
  });

  const sourceFile = project.addSourceFileAtPath(absolutePath);

  return {
    file: relPath,
    language: detectLanguage(absolutePath),
    fileType: detectFileType(relPath),
    exports: extractExports(sourceFile),
    imports: extractImports(sourceFile),
    functions: extractFunctions(sourceFile),
    classes: extractClasses(sourceFile),
    endpoints: extractEndpoints(sourceFile),
    components: extractComponents(sourceFile),
  };
}
