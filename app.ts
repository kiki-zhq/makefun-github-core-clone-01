// github-core-clone-01 entry: the HTTP server, routing and auth.
// One process, Node 22 standard library only. Every reply is JSON; the forge never serves HTML.

import { randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { Store } from './store.ts';
import { handleRest, type RestRequest } from './rest.ts';
import { handleGraphQL } from './graphql.ts';
import { handleMcp, handleMcpParseError } from './mcp.ts';
import { gitAdvertisement, gitPost } from './git.ts';

/** Whether the request carries a usable Bearer token. */
function authorized(req: IncomingMessage, expectedToken: string): boolean {
  const header = req.headers.authorization;
  if (typeof header !== 'string' || !header.startsWith('Bearer ')) return false;
  const token = header.slice('Bearer '.length).trim();
  if (token === '') return false;
  if (expectedToken === '') return true;
  return token === expectedToken;
}

function sendJson(res: ServerResponse, status: number, body: unknown, extraHeaders: Record<string, string> = {}): void {
  const text = body === null ? '' : JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json',
    'x-github-request-id': randomUUID(),
    ...extraHeaders,
  });
  res.end(text);
}

function sendRaw(res: ServerResponse, status: number, contentType: string, body: Buffer): void {
  res.writeHead(status, {
    'content-type': contentType,
    'x-github-request-id': randomUUID(),
    'content-length': body.length,
  });
  res.end(body);
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function parseJsonBody(raw: Buffer): { ok: true; value: unknown } | { ok: false } {
  if (raw.length === 0) return { ok: true, value: undefined };
  try {
    return { ok: true, value: JSON.parse(raw.toString('utf8')) };
  } catch {
    return { ok: false };
  }
}

export function createApp(store: Store, expectedToken: string): Server {
  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      const method = req.method ?? 'GET';
      const segments = url.pathname.split('/').filter((part) => part !== '');

      // The env boot check calls /healthz twice with no auth.
      if (url.pathname === '/healthz' && method === 'GET') {
        sendJson(res, 200, { ok: true });
        return;
      }

      // Git smart HTTP: /{owner}/{repo}.git/info/refs and /{owner}/{repo}.git/git-{upload,receive}-pack.
      if (segments.length >= 3 && segments[1].endsWith('.git')) {
        const isInfoRefs = segments[2] === 'info' && segments[3] === 'refs';
        const isUploadPack = segments[2] === 'git-upload-pack';
        const isReceivePack = segments[2] === 'git-receive-pack';
        if (isInfoRefs || isUploadPack || isReceivePack) {
          if (!authorized(req, expectedToken)) {
            sendJson(res, 401, { message: 'Requires authentication' });
            return;
          }
          const owner = decodeURIComponent(segments[0]);
          const repoName = decodeURIComponent(segments[1].slice(0, -'.git'.length));
          const repo = store.getRepo(owner, repoName);
          if (repo === undefined) {
            sendJson(res, 404, { message: 'Not Found' });
            return;
          }
          if (method === 'GET' && isInfoRefs) {
            const service = url.searchParams.get('service');
            if (service !== 'git-upload-pack' && service !== 'git-receive-pack') {
              sendJson(res, 400, { message: 'service is required' });
              return;
            }
            const v2 = req.headers['git-protocol'] === 'version=2';
            const { body, contentType } = gitAdvertisement(repo, service, v2);
            sendRaw(res, 200, contentType, body);
            return;
          }
          if (method === 'POST' && isUploadPack) {
            const raw = await readBody(req);
            const v2 = req.headers['git-protocol'] === 'version=2';
            const { body, contentType } = gitPost(store, repo, {
              service: 'git-upload-pack',
              isInfoRefs: false,
              v2,
              body: raw,
            });
            sendRaw(res, 200, contentType, body);
            return;
          }
          if (method === 'POST' && isReceivePack) {
            const raw = await readBody(req);
            const { body, contentType } = gitPost(store, repo, {
              service: 'git-receive-pack',
              isInfoRefs: false,
              v2: false,
              body: raw,
            });
            sendRaw(res, 200, contentType, body);
            return;
          }
          sendJson(res, 404, { message: 'Not Found' });
          return;
        }
      }

      // REST v3.
      if (segments[0] === 'api' && segments[1] === 'v3') {
        if (!authorized(req, expectedToken)) {
          sendJson(res, 401, { message: 'Requires authentication' });
          return;
        }
        const raw = await readBody(req);
        const parsed = parseJsonBody(raw);
        if (!parsed.ok) {
          sendJson(res, 400, { message: 'malformed JSON body' });
          return;
        }
        const restReq: RestRequest = {
          method,
          segments: segments.slice(2).map((part) => decodeURIComponent(part)),
          query: url.searchParams,
          body: parsed.value,
          baseUrl: `http://${req.headers.host ?? '127.0.0.1'}`,
        };
        const reply = handleRest(store, restReq);
        sendJson(res, reply.status, reply.body, reply.headers ?? {});
        return;
      }

      // GraphQL.
      if (url.pathname === '/api/graphql' && method === 'POST') {
        if (!authorized(req, expectedToken)) {
          sendJson(res, 401, { message: 'Requires authentication' });
          return;
        }
        const raw = await readBody(req);
        const parsed = parseJsonBody(raw);
        if (!parsed.ok) {
          sendJson(res, 400, { message: 'malformed JSON body' });
          return;
        }
        sendJson(res, 200, handleGraphQL(store, parsed.value));
        return;
      }

      // MCP.
      if (url.pathname === '/mcp' && method === 'POST') {
        if (!authorized(req, expectedToken)) {
          sendJson(res, 401, { message: 'Requires authentication' });
          return;
        }
        const raw = await readBody(req);
        const parsed = parseJsonBody(raw);
        if (!parsed.ok) {
          const reply = handleMcpParseError();
          sendJson(res, reply.status, reply.body);
          return;
        }
        const reply = handleMcp(store, parsed.value);
        if (reply.status === 202) {
          res.writeHead(202, { 'x-github-request-id': randomUUID() });
          res.end();
          return;
        }
        sendJson(res, reply.status, reply.body);
        return;
      }

      sendJson(res, 404, { message: 'Not Found' });
    } catch (error) {
      // A handler must never take the server down (the suite checks the forge survives errors).
      const message = error instanceof Error ? error.message : String(error);
      try {
        sendJson(res, 500, { message });
      } catch {
        // The response is already gone; nothing more to do.
      }
    }
  });
  return server;
}
