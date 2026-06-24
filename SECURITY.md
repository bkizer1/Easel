# Security Policy

## Reporting Vulnerabilities

If you discover a security vulnerability in Easel, please report it responsibly:

1. **Do NOT open a public GitHub issue** for security vulnerabilities.
2. **Email** blake.kizer@gmail.com with:
   - A description of the vulnerability
   - Steps to reproduce the issue
   - Potential impact or severity
   - Any suggested fixes (optional)

Please include as much detail as possible to help us understand and address the issue quickly.

## Security Guidelines

### Application Security

- **Credential Management**: Easel never implements its own OAuth flows for Claude authentication. It relies on existing Claude Code installations or configured API keys, respecting Anthropic's Terms of Service.
- **Environment Variables**: Sensitive credentials are managed through environment variables only and are never persisted in Easel's configuration.
- **Sandbox Isolation**: The main process maintains strict isolation between the renderer process and backend agent interactions.
- **IPC Validation**: All inter-process communication is validated against typed contracts defined in `src/shared/ipc.ts`.

### Dependency Security

- **Dependency Updates**: We monitor dependencies for security updates and apply patches promptly.
- **Supply Chain**: Binary artifacts are built reproducibly with pinned Node versions and npm lockfiles.
- **SBOM**: Each release includes a CycloneDX Software Bill of Materials (SBOM) for transparency.
- **Attestations**: Build provenance is attested using GitHub's build-provenance action.

### File System Access

- **Project Scope**: The agent backend operates within a sandboxed filesystem facade (`ProjectFs` interface) that enforces:
  - All paths are validated relative to the project root
  - Directory traversal attempts (e.g., `../..`) are rejected
  - Only files within the project can be read or modified

### Git Integration

- **Checkpoints**: Every edit operation creates a git checkpoint for undo/auditability.
- **Verification**: Git operations preserve commit history and enable full audit trails.

## Supported Versions

| Version | Status          | Security Updates |
|---------|-----------------|------------------|
| 0.1.x   | Current         | Yes              |

Versions older than 0.1.0 are not officially supported. Users on unsupported versions should upgrade to receive security updates.

## Known Limitations

1. **Local OpenAI Backend**: When using the `local-openai` backend (e.g., Ollama, LM Studio), agentic reliability is marked as `variable`. Only use trusted local model servers.
2. **API Key Handling**: The `anthropic-api` backend requires an active API key. Keep your key secure and rotate it if compromised.
3. **Electron Security**: Easel runs on Electron with `contextIsolation` enabled and `nodeIntegration` disabled. The preload script carefully controls what APIs are exposed to the renderer.

## Privacy

Easel does not collect telemetry or usage data. All operations are local to your machine. When using a backend that connects to Anthropic's API or a remote model server, please review that service's privacy policy.

## Release Signing

Starting with version 0.1.0, releases may be signed or notarized depending on the OS:

- **macOS**: Releases are code-signed with a developer certificate and notarized by Apple.
- **Windows**: Installers are signed with an Authenticode certificate.
- **Linux**: Releases are provided as AppImage and .deb packages without signing; verify checksums.

Signing/notarization credentials are optional and configured via GitHub secrets. Releases proceed without them if not configured.

## Contact

For security-related inquiries, contact blake.kizer@gmail.com.

For general support or feature requests, use GitHub Issues.
