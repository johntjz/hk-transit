import express from 'express';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { onRequest as workerOnRequest } from './functions/api/worker.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function startServer() {
  const app = express();
  const PORT = Number(process.env.PORT || 3000);

  // Unified Edge Worker API (/api/worker & /api/hk-holidays) — delegates directly to functions/api/worker.js
  app.all(['/api/worker', '/api/hk-holidays'], async (req, res) => {
    try {
      const origin = `${req.protocol}://${req.get('host') || `localhost:${PORT}`}`;
      const fullUrl = new URL(req.originalUrl, origin).toString();
      const headers = new Headers();
      for (const [k, v] of Object.entries(req.headers)) {
        if (typeof v === 'string') headers.set(k, v);
        else if (Array.isArray(v)) headers.set(k, v.join(', '));
      }
      const webReq = new Request(fullUrl, {
        method: req.method,
        headers,
      });
      const webRes = await workerOnRequest({ request: webReq });
      res.status(webRes.status);
      webRes.headers.forEach((val, key) => {
        res.setHeader(key, val);
      });
      const bodyBuf = Buffer.from(await webRes.arrayBuffer());
      res.send(bodyBuf);
    } catch (err) {
      res.status(500).json({ ok: false, error: 'Worker proxy error' });
    }
  });

  if (process.env.NODE_ENV !== 'production') {
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'mpa',
    });
    app.use(vite.middlewares);

    app.get('/', async (req, res, next) => {
      try {
        const htmlPath = path.resolve(__dirname, 'index.html');
        let html = fs.readFileSync(htmlPath, 'utf-8');
        html = await vite.transformIndexHtml(req.originalUrl, html);
        res.status(200).set({ 'Content-Type': 'text/html; charset=utf-8' }).end(html);
      } catch (e) {
        next(e);
      }
    });
  } else {
    const distDir = path.resolve(__dirname, 'dist');
    app.use(express.static(distDir));
    app.get('*', (_req, res) => {
      res.sendFile(path.join(distDir, 'index.html'));
    });
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`Transit HK server listening on http://0.0.0.0:${PORT}`);
  });
}

startServer();
