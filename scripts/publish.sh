#!/bin/bash
# Coverit Publish Script
# Handles version bumping, building, and npm publishing

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
log_success "New version: $NEW_VERSION"

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
read -p "Publish $NEW_VERSION to npm? (y/N) " -n 1 -r
echo

if [[ ! $REPLY =~ ^[Yy]$ ]]; then
    log_warn "Aborting. Rolling back version..."
    git checkout package.json
    exit 0
fi

# Publish
log_info "Publishing to npm..."
npm publish --access public

log_success "Published @devness/coverit@$NEW_VERSION to npm!"

# Create git tag and commit
log_info "Creating git tag..."
git add package.json
git commit -m "chore: release v$NEW_VERSION"
git tag -a "v$NEW_VERSION" -m "Coverit v$NEW_VERSION"

log_success "Created tag: v$NEW_VERSION"
log_info "Run 'git push && git push --tags' to push changes"

echo ""
log_success "Done! Users can now install with: npm install -g @devness/coverit"
