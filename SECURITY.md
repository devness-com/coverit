# Security

## Vulnerability Reporting

If you discover a security vulnerability in coverit, please report it responsibly:

- **Email:** hello@devness.dev
- **GitHub:** Open a private security advisory at [github.com/devness-com/coverit/security](https://github.com/devness-com/coverit/security)

Please do not file public issues for security vulnerabilities. We aim to acknowledge reports within 48 hours and provide a fix timeline within 7 days.

## How coverit Handles Security

### No Data Collection

coverit runs entirely locally. It does not:

- Send your code to any server (AI calls go directly to the AI provider you configure)
- Store API keys or credentials (uses environment variables or CLI tools you already have installed)
- Phone home or track usage

### AI Provider Communication

When coverit invokes an AI provider (Claude CLI, Gemini, OpenAI, etc.), it sends:

- Source code snippets and project structure information to the configured AI provider
- This communication happens directly between your machine and the AI provider — coverit has no intermediary server

### coverit.json

The `coverit.json` manifest contains:

- Project metadata (framework, language, file counts)
- Module names and directory paths
- Test coverage counts and quality scores
- No source code, credentials, or personally identifiable information

We recommend committing `coverit.json` to your repository. Review it before committing if your project structure is sensitive.

### File System Access

coverit reads and writes files in your project directory:

- **Reads:** Source files, test files, package.json, config files (for analysis)
- **Writes:** `coverit.json` (manifest), test files in `.coverit/` or your test directories (during `cover`)
- coverit never modifies your source code — only test files

## Dependencies

coverit has minimal dependencies. We review dependencies for known vulnerabilities using `npm audit` and update them regularly.
