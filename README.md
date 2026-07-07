# HWP Collaboration Platform

Public portfolio export of a Docker-based HWP/HWPX collaborative document web
platform. The project combines a React client, an Express API, WebSocket
presence/operation relays, HWPX text parsing with JSZip, revision checkpoint
endpoints, and operational scripts for stress and content-at-rest checks.

This repository contains only the application code written around the document
engine. The upstream HWP rendering/editing engine, wasm binaries, vendored
engine JavaScript, fonts, bundled blank documents, screenshots, internal
deployment notes, source `.git` metadata, runtime data, and environment files
are intentionally not included.

## Problem

HWP/HWPX documents are common in Korean document workflows, but browser-based
review and collaborative editing need more than a file parser. The platform
adds a web shell, document metadata API, revision checkpoints, collaboration
presence, WebSocket message throttling, and Docker deployment around a separate
HWP editor engine.

## Architecture

- `src/`: React application shell for opening local HWP/HWPX files, validating
  file headers before loading, tracking dirty state, exporting through the
  editor adapter, and calling the API.
- `server/`: Express API with local-session mode, document metadata, upload and
  preview endpoints, revision checkpoint APIs, search/text extraction helpers,
  WebSocket presence, operation relay, lock state, and rate limiting.
- `server/hwp-text.js`: bounded HWP/HWPX text extraction. HWPX packages are
  parsed with JSZip and size/time limits before XML traversal.
- `scripts/stress-test.mjs`: HTTP stress harness. It can be run with
  `--clients=100` for the 100-user profile once the server is running.
- `scripts/no-content-at-rest.mjs` and `scripts/purge-content-at-rest.mjs`:
  guards for deployments that must avoid retaining uploaded document payloads.
- `docker-compose.yml` and `Dockerfile`: local container deployment skeleton.

## Engine Boundary

The browser editor depends on a compatible HWP rendering/editing engine mounted
at `/rhwp-studio/` or supplied through `RHWP_STUDIO_URL`. That engine is
vendored separately and is not part of this public export.

Without the engine assets, the API, WebSocket, parsing, and testable utility
code can still be reviewed, but the full browser editor will not render a
working HWP editing surface.

## Run Locally

Install dependencies:

```bash
npm install
```

Run the API:

```bash
npm start
```

Run the Vite client in another shell:

```bash
npm run dev
```

For Compose:

```bash
docker compose up --build
```

To use the full editor, provide a separately licensed/approved engine URL:

```bash
HWP_COLLAB_ENGINE_URL=http://127.0.0.1:9000/rhwp-studio/ docker compose up --build
```

## Tests And Checks

```bash
npm run check
npm test
node scripts/stress-test.mjs --clients=100 --messages=8 --concurrency=20
node scripts/no-content-at-rest.mjs
```

The stress script expects the API to be listening on `http://127.0.0.1:8170`
unless `STRESS_BASE_URL` is set.

## Sanitization Notes

This export omits company data, local JSON runtime state, databases, CSVs,
screenshots, deployment receipts, agent instructions, vendored engine assets,
build outputs, `node_modules`, and any `.env` files. Generated document payloads
belong under `data/`, which is ignored by git.
