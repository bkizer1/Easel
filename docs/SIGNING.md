# Code signing & notarization

Easel's release builds are **unsigned by default** — they work, but users see a
Gatekeeper (macOS) / SmartScreen (Windows) warning on first launch. To remove
those warnings, add code-signing certificates as GitHub repository secrets; the
release workflow detects them and signs automatically — **no code changes
needed**. Until you add the secrets, nothing changes and builds stay unsigned.

## macOS (Developer ID + notarization)

Requires an Apple Developer account ($99/yr).

1. Create a **Developer ID Application** certificate (Xcode → Settings →
   Accounts → Manage Certificates, or the Apple Developer portal) and export it
   as a password-protected `.p12`.
2. Base64-encode it: `base64 -i cert.p12 | pbcopy`
3. Create an **app-specific password** for your Apple ID at
   <https://appleid.apple.com> → Sign-In and Security → App-Specific Passwords.
4. Add these repo secrets (**Settings → Secrets and variables → Actions**):

   | Secret | Value |
   | --- | --- |
   | `MAC_CSC_LINK` | base64 of the `.p12` |
   | `MAC_CSC_KEY_PASSWORD` | the `.p12` password |
   | `APPLE_ID` | your Apple ID email |
   | `APPLE_APP_SPECIFIC_PASSWORD` | the app-specific password |
   | `APPLE_TEAM_ID` | your 10-character Apple Team ID |

The build signs with the Developer ID and notarizes via Apple. Hardened runtime
is already enabled in `package.json` (`mac.hardenedRuntime: true`).

## Windows (code signing)

Requires a code-signing certificate (OV works; **EV** avoids SmartScreen
entirely). Cloud options like Azure Trusted Signing or SSL.com eSigner can be
wired in later.

1. Export your cert as a password-protected `.pfx` and base64-encode it.
2. Add repo secrets:

   | Secret | Value |
   | --- | --- |
   | `WIN_CSC_LINK` | base64 of the `.pfx` |
   | `WIN_CSC_KEY_PASSWORD` | the `.pfx` password |

## How it's wired

`.github/workflows/release.yml` passes these as env vars to electron-builder,
which signs automatically when they're present. `CSC_IDENTITY_AUTO_DISCOVERY` is
set to `true` only when a macOS cert exists, so the unsigned path never attempts
to sign.

> ⚠️ Never commit certificates or passwords. Keep them only in GitHub Actions
> secrets (or a local secret manager).
