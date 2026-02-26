/**
 * Security Analysis Prompts — AI-driven vulnerability detection
 *
 * Builds structured prompts that instruct the AI to scan source code
 * for OWASP Top 10 (2021) security vulnerabilities and return findings
 * as parseable JSON. Designed to be provider-agnostic — works identically
 * across Claude, GPT, Gemini, or local models.
 */

import type { AIMessage } from "./types.js";

/**
 * Build a self-contained security analysis prompt for a single file.
 * The AI is instructed to return a JSON array of findings, or an empty
 * array when no issues are detected — never prose.
 */
export function buildSecurityPrompt(
  fileContent: string,
  filePath: string,
): AIMessage[] {
  const systemPrompt = `You are a senior application security engineer performing a code review.
Your job is to identify real, exploitable vulnerabilities — not theoretical style issues.

HARD RULES:
1. Output ONLY a valid JSON array. No markdown fences, no explanations, no commentary outside the JSON.
2. Each finding must be a JSON object with these exact keys:
   { "line": <number>, "type": <string>, "severity": <string>, "description": <string>, "recommendation": <string> }
3. "type" must be one of: "injection", "auth-bypass", "secrets-exposure", "xss", "insecure-config", "data-exposure", "ssrf", "cryptographic-failures", "insecure-deserialization"
4. "severity" must be one of: "critical", "high", "medium", "low"
5. "line" must be the 1-based line number where the vulnerability exists.
6. Return an empty array [] if no real security issues are found. Do NOT invent issues.
7. Focus on REAL vulnerabilities, not code style. A missing type annotation is not a security finding.

WHAT TO LOOK FOR:

1. SQL/NoSQL Injection (type: "injection", severity: "critical")
   - String concatenation or template literals in SQL/NoSQL queries
   - User input passed directly into queries without parameterization
   - Dynamic query construction from request parameters
   Example: \`db.query("SELECT * FROM users WHERE id = " + req.params.id)\`

2. Missing Authentication/Authorization (type: "auth-bypass", severity: "critical")
   - Route handlers or endpoints without auth middleware/guards
   - Missing permission checks before sensitive operations
   - Broken access control allowing horizontal/vertical privilege escalation
   Example: \`router.post("/admin/delete-user", handler)\` with no auth guard

3. Hardcoded Secrets (type: "secrets-exposure", severity: "high")
   - API keys, passwords, tokens, or connection strings in source code
   - Default credentials that are not clearly test-only
   - Private keys or certificates embedded in code
   Example: \`const API_KEY = "sk-live-abc123def456"\`

4. XSS Vectors (type: "xss", severity: "high")
   - Unescaped user input rendered in HTML responses
   - innerHTML assignment with user-controlled data
   - Missing output encoding in template engines
   Example: \`res.send("<div>" + req.query.name + "</div>")\`

5. Insecure Configuration (type: "insecure-config", severity: "medium")
   - Debug mode enabled in production code paths
   - Permissive CORS (origin: "*" without justification)
   - Disabled security headers, CSRF protection off
   - Default or weak cryptographic settings
   Example: \`cors({ origin: "*", credentials: true })\`

6. Data Exposure (type: "data-exposure", severity: "medium")
   - PII (emails, SSNs, credit cards) logged to console/files
   - Stack traces or internal error details returned to clients
   - Sensitive fields not stripped from API responses
   - Verbose error messages revealing system internals
   Example: \`console.log("User data:", { password: user.password, ssn: user.ssn })\`

7. SSRF (type: "ssrf", severity: "high")
   - User-controlled URLs passed to HTTP clients without validation
   - Internal service URLs constructable from user input
   Example: \`fetch(req.body.url)\`

8. Cryptographic Failures (type: "cryptographic-failures", severity: "high")
   - Use of deprecated algorithms (MD5, SHA1 for security, DES)
   - Hardcoded initialization vectors or salts
   - Missing encryption for sensitive data at rest
   Example: \`crypto.createHash("md5").update(password)\`

9. Insecure Deserialization (type: "insecure-deserialization", severity: "high")
   - Deserializing untrusted data without validation (eval, Function constructor)
   - YAML.load / pickle.loads on user input
   Example: \`const obj = eval("(" + userInput + ")")\``;

  const userPrompt = `Analyze this file for security vulnerabilities.

File: ${filePath}

\`\`\`
${fileContent}
\`\`\`

Return ONLY a JSON array of findings, or [] if no issues found.`;

  return [
    { role: "system", content: systemPrompt },
    { role: "user", content: userPrompt },
  ];
}

/**
 * Build a batch security prompt for multiple small files.
 * More token-efficient than individual prompts when files are under ~2KB each.
 */
export function buildBatchSecurityPrompt(
  files: Array<{ path: string; content: string }>,
): AIMessage[] {
  const systemPrompt = `You are a senior application security engineer reviewing multiple files for vulnerabilities.

HARD RULES:
1. Output ONLY a valid JSON object. No markdown fences, no explanations.
2. The JSON must have this shape: { "<file_path>": [<findings>], ... }
3. Each finding: { "line": <number>, "type": <string>, "severity": <string>, "description": <string>, "recommendation": <string> }
4. "type" must be one of: "injection", "auth-bypass", "secrets-exposure", "xss", "insecure-config", "data-exposure", "ssrf", "cryptographic-failures", "insecure-deserialization"
5. "severity" must be one of: "critical", "high", "medium", "low"
6. Use empty array [] for files with no issues.
7. Only report REAL vulnerabilities, not code style concerns.

Focus on: SQL/NoSQL injection, missing auth, hardcoded secrets, XSS, insecure config, data exposure, SSRF, crypto failures, insecure deserialization.`;

  const fileSections = files
    .map((f) => `### ${f.path}\n\`\`\`\n${f.content}\n\`\`\``)
    .join("\n\n");

  const userPrompt = `Analyze these files for security vulnerabilities:\n\n${fileSections}\n\nReturn ONLY a JSON object mapping file paths to arrays of findings.`;

  return [
    { role: "system", content: systemPrompt },
    { role: "user", content: userPrompt },
  ];
}
