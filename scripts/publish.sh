#!/bin/bash
# Coverit Publish Script
# Handles version bumping, building, npm publishing, and plugin repo sync

set -e

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

log_info() { echo -e "${BLUE}[INFO]${NC} $1"; }
log_success() { echo -e "${GREEN}[SUCCESS]${NC} $1"; }
log_warn() { echo -e "${YELLOW}[WARN]${NC} $1"; }
log_error() { echo -e "${RED}[ERROR]${NC} $1"; }

# Get script directory
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
PLUGIN_REPO="devness-com/coverit"

cd "$PROJECT_DIR"

# Check if we're logged into npm
if ! npm whoami &> /dev/null; then
    log_error "Not logged into npm. Run 'npm login' first."
    exit 1
fi

# Get current version
CURRENT_VERSION=$(node -p "require('./package.json').version")
log_info "Current version: $CURRENT_VERSION"

# Determine version bump type
VERSION_TYPE="${1:-patch}"

if [[ ! "$VERSION_TYPE" =~ ^(patch|minor|major)$ ]]; then
    log_error "Invalid version type: $VERSION_TYPE"
    echo "Usage: $0 [patch|minor|major]"
    echo "  patch - Bug fixes (0.1.0 -> 0.1.1)"
    echo "  minor - New features (0.1.0 -> 0.2.0)"
    echo "  major - Breaking changes (0.1.0 -> 1.0.0)"
    exit 1
fi

# Check for uncommitted changes
if [[ -n $(git status --porcelain) ]]; then
    log_warn "You have uncommitted changes:"
    git status --short
    echo ""
    read -p "Continue anyway? (y/N) " -n 1 -r
    echo
    if [[ ! $REPLY =~ ^[Yy]$ ]]; then
        log_info "Aborting publish."
        exit 0
    fi
fi

# Bump version
log_info "Bumping version ($VERSION_TYPE)..."
NEW_VERSION=$(npm version "$VERSION_TYPE" --no-git-tag-version)
# Strip the leading 'v' from npm version output
VERSION_NUMBER="${NEW_VERSION#v}"
log_success "New version: $VERSION_NUMBER"

# Update marketplace.json version fields
log_info "Updating marketplace.json..."
MARKETPLACE_FILE="$PROJECT_DIR/.claude-plugin/marketplace.json"
if [ -f "$MARKETPLACE_FILE" ]; then
    # Use node to update both version fields reliably
    node -e "
const fs = require('fs');
const m = JSON.parse(fs.readFileSync('$MARKETPLACE_FILE', 'utf-8'));
m.metadata.version = '$VERSION_NUMBER';
m.plugins.forEach(p => { p.version = '$VERSION_NUMBER'; });
fs.writeFileSync('$MARKETPLACE_FILE', JSON.stringify(m, null, 2) + '\n');
"
    log_success "marketplace.json updated to $VERSION_NUMBER"
else
    log_warn "marketplace.json not found, skipping"
fi

# Build
log_info "Building..."
npm run build

# Ensure bin file is executable
chmod +x dist/cli/index.js

# Verify build
if [ ! -f "dist/cli/index.js" ]; then
    log_error "Build failed - dist/cli/index.js not found"
    exit 1
fi

# Show what will be published
log_info "Files to be published:"
npm pack --dry-run 2>&1 | grep -E '^\d|npm notice' | head -20

echo ""
read -p "Publish $VERSION_NUMBER to npm? (y/N) " -n 1 -r
echo

if [[ ! $REPLY =~ ^[Yy]$ ]]; then
    log_warn "Aborting. Rolling back version..."
    git checkout package.json .claude-plugin/marketplace.json
    exit 0
fi

# Publish
log_info "Publishing to npm..."
npm publish --access public

log_success "Published @devness/coverit@$VERSION_NUMBER to npm!"

# Create git tag and commit
log_info "Creating git tag..."
git add package.json .claude-plugin/marketplace.json
git commit -m "chore: release v$VERSION_NUMBER"
git tag -a "v$VERSION_NUMBER" -m "Coverit v$VERSION_NUMBER"

log_success "Created tag: v$VERSION_NUMBER"

# ─── Sync plugin files to public repo ───────────────────────

log_info "Syncing plugin files to $PLUGIN_REPO..."

SYNC_DIR=$(mktemp -d)
trap 'rm -rf "$SYNC_DIR"' EXIT

if gh repo clone "$PLUGIN_REPO" "$SYNC_DIR" -- --depth 1 2>/dev/null; then
    # Remove old plugin files (preserve .git)
    find "$SYNC_DIR" -maxdepth 1 -not -name '.git' -not -name '.' -exec rm -rf {} +

    # Copy fresh plugin files
    cp -r "$PROJECT_DIR/.claude-plugin" "$SYNC_DIR/"
    cp -r "$PROJECT_DIR/plugins" "$SYNC_DIR/"
    cp "$PROJECT_DIR/README.md" "$SYNC_DIR/"
    cp "$PROJECT_DIR/LICENSE" "$SYNC_DIR/"

    cd "$SYNC_DIR"

    # Check if anything changed
    if [[ -n $(git status --porcelain) ]]; then
        git add -A
        git commit -m "Sync plugin v$VERSION_NUMBER"
        git push origin main
        log_success "Plugin repo synced to v$VERSION_NUMBER"
    else
        log_info "Plugin repo already up to date"
    fi

    cd "$PROJECT_DIR"
else
    log_warn "Could not clone $PLUGIN_REPO — skipping plugin sync"
    log_warn "Sync manually: run 'scripts/sync-plugin.sh'"
fi

log_info "Run 'git push && git push --tags' to push changes"

echo ""
log_success "Done! Users can now install with: npm install -g @devness/coverit"
