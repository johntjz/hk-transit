# Repository Rules for Agents & Contributors

## Do Not Commit Prompt Attachments or Temporary Screenshots

- **Never commit, copy, or upload prompt screenshots, pasted images, or temporary AI Studio attachment dumps** to `public/assets/aistudio/` or anywhere else in this repository.
- Keep `public/assets/aistudio/` ignored in `.gitignore` and absent from the local workspace.
- Never reference `assets/aistudio` from `src/`, `public/`, or `index.html`.
- Only intentional, production application assets belong in `public/`.
