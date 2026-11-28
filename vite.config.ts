import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import {execSync} from 'child_process';
import fs from 'fs';
import path from 'path';
import {defineConfig} from 'vite';

function formatHktBuildStamp(date: Date): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Hong_Kong',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(date);
  const get = (type: string) => parts.find((p) => p.type === type)?.value || '00';
  const hour = get('hour') === '24' ? '00' : get('hour');
  return `${get('year')}-${get('month')}-${get('day')} ${hour}:${get('minute')} HKT`;
}

function resolveBuildCommitSha(fallback = ''): string {
  const cfSha = process.env.CF_PAGES_COMMIT_SHA?.trim();
  if (cfSha) {
    return cfSha.slice(0, 7);
  }
  try {
    const gitSha = execSync('git rev-parse --short HEAD', {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    if (gitSha) {
      return gitSha.slice(0, 7);
    }
  } catch {
    // Ignore git errors in environments without git metadata
  }
  return fallback;
}

function walkDistFiles(dir: string, out: string[] = []): string[] {
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, {withFileTypes: true})) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walkDistFiles(full, out);
    } else if (entry.isFile()) {
      out.push(full);
    }
  }
  return out;
}

export default defineConfig(() => {
  return {
    plugins: [
      react(),
      tailwindcss(),
      // Copies src/assets into dist/ so root-relative URLs like
      // "/src/assets/images/..." (e.g. generate_image output) still resolve
      // in production builds. Do not remove.
      {
        name: 'copy-unbundled-src-assets',
        apply: 'build',
        closeBundle(error?: Error): void {
          if (error) {
            return;
          }
          const distDir = path.resolve(__dirname, 'dist');
          const srcAssets = path.resolve(__dirname, 'src/assets');
          const distAssets = path.resolve(distDir, 'src/assets');
          if (fs.existsSync(distDir) && fs.existsSync(srcAssets)) {
            fs.cpSync(srcAssets, distAssets, {recursive: true, force: true});
          }
        },
      },
      // Stamps generated dist/ artifacts and dist/version.json with a fresh
      // Asia/Hong_Kong build timestamp without touching tracked source files.
      {
        name: 'stamp-hkt-build-version',
        apply: 'build',
        closeBundle(error?: Error): void {
          if (error) {
            return;
          }
          const distDir = path.resolve(__dirname, 'dist');
          if (!fs.existsSync(distDir)) {
            return;
          }

          const now = new Date();
          const hktStamp = formatHktBuildStamp(now);
          const isoNow = now.toISOString();
          const hktRegex = /\d{4}-\d{2}-\d{2} \d{2}:\d{2} HKT/g;
          const stampableExts = new Set(['.html', '.js', '.mjs', '.cjs', '.css', '.webmanifest']);

          for (const filePath of walkDistFiles(distDir)) {
            const base = path.basename(filePath);
            if (base === 'version.json' || base === 'bus_index.min.json') {
              continue;
            }
            const ext = path.extname(filePath).toLowerCase();
            if (!stampableExts.has(ext)) {
              continue;
            }
            const raw = fs.readFileSync(filePath, 'utf8');
            if (hktRegex.test(raw)) {
              const updated = raw.replace(hktRegex, hktStamp);
              if (updated !== raw) {
                fs.writeFileSync(filePath, updated, 'utf8');
              }
            }
            hktRegex.lastIndex = 0;
          }

          const distVersionPath = path.join(distDir, 'version.json');
          if (fs.existsSync(distVersionPath)) {
            try {
              const existing = JSON.parse(fs.readFileSync(distVersionPath, 'utf8'));
              const shortSha = resolveBuildCommitSha(typeof existing.commit === 'string' ? existing.commit : '');
              const nextVersion = {
                ...existing,
                version: hktStamp,
                appUpdated: isoNow,
                commit: shortSha,
              };
              fs.writeFileSync(distVersionPath, `${JSON.stringify(nextVersion, null, 2)}\n`, 'utf8');
            } catch {
              // Preserve existing dist/version.json if unreadable
            }
          }
        },
      },
    ],
    resolve: {
      alias: {
        '@': path.resolve(__dirname, '.'),
      },
    },
    server: {
      host: '0.0.0.0',
      port: 3000,
      allowedHosts: true as const,
      // HMR is disabled in AI Studio via DISABLE_HMR env var.
      // Do not modify—file watching is disabled to prevent flickering during agent edits.
      hmr: process.env.DISABLE_HMR !== 'true',
      // Disable file watching when DISABLE_HMR is true to save CPU during agent edits.
      watch: process.env.DISABLE_HMR === 'true' ? null : {},
    },
  };
});
