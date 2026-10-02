import { protocol, session } from 'electron';
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';

const DIST_DIR = path.join(__dirname, '..');

const CONTENT_TYPES: Record<string, string> = {
  html: 'text/html',
  js: 'application/javascript',
  map: 'application/json',
};

export type RendererProtocol = 'app' | 'file' | 'http';

/** Reads RENDERER_PROTOCOL (app | file | http, default app), throwing on any other value. */
export function getRendererProtocol(): RendererProtocol {
  const rendererProtocol = process.env.RENDERER_PROTOCOL ?? 'app';
  if (rendererProtocol !== 'app' && rendererProtocol !== 'file' && rendererProtocol !== 'http') {
    throw new Error(`Unknown RENDERER_PROTOCOL "${rendererProtocol}", expected app, file or http`);
  }
  return rendererProtocol;
}

/** Serves dist/ over the given protocol and returns the renderer base URL. */
export async function setupRendererProtocol(rendererProtocol: RendererProtocol): Promise<string> {
  switch (rendererProtocol) {
    case 'app':
      return serveOverAppProtocol();
    case 'file':
      return serveOverFileProtocol();
    case 'http':
      return serveOverHttp();
  }
}

function serveOverAppProtocol(): string {
  protocol.handle('app', (request) => {
    const fileName = fileNameFromPathname(new URL(request.url).pathname);
    return new Response(fs.readFileSync(path.join(DIST_DIR, fileName)), { headers: headersFor(fileName) });
  });
  return 'app://app/';
}

function fileNameFromPathname(pathname: string): string {
  return pathname === '/' ? 'index.html' : pathname.replace(/^\//, '');
}

// Only HTML documents need the policy that enables the profiler.
function headersFor(fileName: string): Record<string, string> {
  const headers: Record<string, string> = { 'Content-Type': contentTypeFor(fileName) };
  if (fileName.endsWith('.html')) {
    headers['Document-Policy'] = 'js-profiling';
  }
  return headers;
}

function contentTypeFor(fileName: string): string {
  return CONTENT_TYPES[fileName.split('.').pop() ?? ''] ?? 'application/octet-stream';
}

function serveOverFileProtocol(): string {
  const baseUrl = `${pathToFileURL(DIST_DIR).href}/`;
  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    if (details.url.startsWith(baseUrl) && details.url.endsWith('.html')) {
      callback({ responseHeaders: { ...details.responseHeaders, 'Document-Policy': ['js-profiling'] } });
    } else {
      callback({});
    }
  });
  return baseUrl;
}

function serveOverHttp(): Promise<string> {
  const port = Number.parseInt(process.env.RENDERER_HTTP_PORT ?? '8765', 10);
  const server = http.createServer((req, res) => {
    const fileName = fileNameFromPathname(new URL(req.url ?? '/', 'http://localhost').pathname);
    try {
      const body = fs.readFileSync(path.join(DIST_DIR, fileName));
      res.writeHead(200, headersFor(fileName));
      res.end(body);
    } catch {
      res.writeHead(404);
      res.end();
    }
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => resolve(`http://127.0.0.1:${port}/`));
  });
}
