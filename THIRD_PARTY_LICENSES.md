# Third-Party Licenses and Attestation

## Overview

Easel includes several open-source third-party dependencies. This document explains how we track, generate, and verify third-party licenses and build provenance.

## Software Bill of Materials (SBOM)

Each release includes a **CycloneDX SBOM** (`sbom.cdx.json`) that provides a machine-readable inventory of all dependencies:

- **Component**: Package name and version
- **License**: SPDX identifier or declared license
- **Repository**: Link to the source repository
- **Transitive Dependencies**: Complete dependency tree

### Accessing the SBOM

1. Download `sbom.cdx.json` from the GitHub Release page
2. Parse it using CycloneDX-compatible tools (e.g., Dependabot, Cyclonedx Maven Plugin, or any JSON parser)

### Generating the SBOM Locally

```bash
npm run sbom
```

This generates `sbom.cdx.json` in the project root using `@cyclonedx/cyclonedx-npm`.

## NOTICE File

The `NOTICE` file (`NOTICE`) is a human-readable summary of third-party licenses:

```bash
npm run notice
```

This generates `NOTICE` listing all dependencies with:
- Package name
- Version
- License
- Repository URL

## Build Provenance and Attestations

Each release is attested using GitHub's **build-provenance** action, which creates cryptographically signed attestations for:

1. **Built Artifacts** (installers, .zip files, etc.)
2. **SBOM** (sbom.cdx.json)

Attestations are pushed to GitHub and can be verified with:

```bash
gh attestation verify <artifact-path> --owner bkizer1 --repo Easel
```

### Verifying Artifacts

To verify build provenance for a downloaded artifact:

1. Install GitHub CLI: https://cli.github.com/
2. Run:
   ```bash
   gh attestation verify dist/Easel-0.1.0-x64.dmg --owner bkizer1 --repo Easel
   ```
3. The command returns the provenance details and confirms the artifact was built by this GitHub Actions workflow.

### Trust Model

- **GitHub-Hosted Runners**: Artifacts are built on GitHub-managed Ubuntu, macOS, and Windows runners.
- **OIDC Token**: The build process obtains an OIDC token from GitHub's identity provider, proving the build ran in this repository at a specific commit.
- **Attestation**: The provenance is signed and uploaded to GitHub's attestation storage, making it verifiable by anyone with GitHub CLI.

## License Compliance

### Key Licenses in Easel

Easel and its dependencies are primarily under:

- **Easel**: AGPL-3.0-or-later (see `LICENSE`)
- **React**: MIT License
- **Vite**: MIT License
- **Electron**: MIT License
- **Zustand**: MIT License
- **TailwindCSS**: MIT License
- **@anthropic-ai/sdk**: MIT License
- **@anthropic-ai/claude-agent-sdk**: Proprietary — **not bundled** in Easel installers; resolved at runtime from the user's own Claude Code install (see below)

For a complete list, see the `NOTICE` file.

### Compliance Checks

Before each release, we:

1. Run `npm ci` with a clean `package-lock.json` to ensure reproducibility
2. Generate a fresh SBOM
3. Validate all licenses comply with Easel's AGPL-3.0 license
4. Attest build artifacts and SBOM

## Dependencies of Interest

### @anthropic-ai/claude-agent-sdk

This is Anthropic's official, proprietary SDK for building agentic applications. It
powers Easel's default backend (authentication, tool-use, extended thinking).

**It is NOT bundled or redistributed in Easel's installers.** It is a
`devDependency` (electron-builder never bundles those), and resolved at runtime
from the user's own Claude Code install —
locally when running Easel from source, or from a global
`npm install -g @anthropic-ai/claude-agent-sdk` for downloaded builds. If it isn't
installed, Easel surfaces a clear prompt to install it, and the API-key / local-model
backends remain available. This keeps Easel's redistributed binaries free of
proprietary third-party code.

## Contributing & License Compliance

When adding dependencies to Easel:

1. Ensure the license is compatible with AGPL-3.0 redistribution (permissive licenses like MIT, Apache 2.0, ISC are fine; copyleft requires consideration)
2. After adding the dependency, regenerate the SBOM and NOTICE:
   ```bash
   npm run sbom
   npm run notice
   ```
3. Include these files in your pull request

## Questions?

For questions about third-party licenses or compliance, please open an issue on GitHub or contact blake.kizer@gmail.com.
