# Repository Rules for Agents & Contributors

## Do Not Commit Prompt Attachments or Temporary Screenshots

- **Never commit, copy, or upload prompt screenshots, pasted images, or temporary AI Studio attachment dumps** to `public/assets/aistudio/` or anywhere else in this repository.
- Keep `public/assets/aistudio/` ignored in `.gitignore` and absent from the local workspace.
- Never reference `assets/aistudio` from `src/`, `public/`, or `index.html`.
- Only intentional, production application assets belong in `public/`.

## Branch & Deployment Safety

- **Work strictly on the `dev` branch.** Never commit or push directly to `main`.
- Every push to `dev` deploys to `https://dev.hkway.pages.dev` via Cloudflare Preview Deployments; run `npm run build` and `npx tsc --noEmit` to confirm zero build errors before finishing a task.

## Tool & Layer Boundaries (Dual-Tool Workflow)

- **Backend / Transit Telemetry (`public/busspeed.js`, `public/hardcode.js`, `public/sw.js`, `functions/api/`, `scripts/`, data/polyline logic in `public/map.js`):** Owned by Antigravity Web (`Orchestrator (Neon)`). Do not alter frontend layout or CSS classes unless explicitly instructed.
- **Frontend / Map & Bus Card UI (`index.html`, `src/`, visual styling/modals/toasts):** Owned by Google AI Studio Web. Do not alter backend telemetry engines (`public/busspeed.js`, `public/hardcode.js`, `functions/api/`, `scripts/`) when making UI or screenshot-driven visual fixes.
