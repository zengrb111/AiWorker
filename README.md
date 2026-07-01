# OpenClaw Desktop

OpenClaw Desktop packages the normal OpenClaw setup flow into a Mac and Windows desktop app. The goal is to let users install, start, check, and try OpenClaw without memorizing terminal commands.

## What It Does

- Checks whether a compatible Node.js runtime is available.
- Installs or updates `openclaw@latest` through npm.
- Runs the OpenClaw onboarding daemon installer.
- Shows `openclaw gateway status`.
- Runs `openclaw doctor` for troubleshooting and risky configuration checks.
- Sends a simple instruction through `openclaw agent --message`.

## Requirements For Developers

- Node.js 24, or Node.js 22.19 and newer.
- npm.
- macOS or Windows.

## Development

```bash
npm install
npm run dev
```

## Build Installers

```bash
npm run dist:mac
npm run dist:win
```

Build outputs are written to `release/`.

## Notes

This project does not vendor OpenClaw itself. It installs the official npm package and wraps the supported CLI commands in a friendlier desktop flow. For a production release, add code signing and notarization for macOS, and Authenticode signing for Windows.
