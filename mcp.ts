// github-core-clone-01 entry: the MCP surface (/mcp).
// JSON-RPC 2.0 over Streamable HTTP, revision 2026-07-28 with a legacy initialize handshake
// fallback. The same store as REST. Written from scratch; Node 22 standard library only.

import { VIEWER, type Issue, type Pull, type Repo, type Store } from './store.ts';
import { squashMerge } from './rest.ts';

export const MCP_SERVER_NAME = 'github-core-clone';
export const MCP_SERVER_VERSION = '1.0.0';
export const MCP_PROTOCOL_VERSION = '2026-07-28';

interface ToolDef {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, { type: string; description: string }>;
    required: string[];
  };
}

// The tool list is built once so two tools/list answers are byte-identical.
const TOOLS: ToolDef[] = [
  {
    name: 'create_repo',
    description: 'Create a repository owned by the authenticated user.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'The repository name.' },
        description: { type: 'string', description: 'A short description of the repository.' },
        private: { type: 'boolean', description: 'Whether the repository is private.' },
      },
      required: ['name'],
    },
  },
  {
    name: 'get_repo',
    description: 'Get a repository by owner and name.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        title: { type: 'string', description: 'The issue title.' },
        body: { type: 'string', description: 'The issue body.' },
      },
      required: ['owner', 'repo', 'title'],
    },
  },
  {
    name: 'list_issues',
    description: 'List the issues of a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        state: { type: 'string', description: 'Filter by state: open, closed or all.' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_pull_request',
    description: 'Open a pull request from a head branch into a base branch.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        title: { type: 'string', description: 'The pull request title.' },
        body: { type: 'string', description: 'The pull request body.' },
        head: { type: 'string', description: 'The head branch name.' },
        base: { type: 'string', description: 'The base branch name.' },
      },
      required: ['owner', 'repo', 'head', 'base'],
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Merge a pull request with a squash commit onto its base branch.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        pull_number: { type: 'integer', description: 'The pull request number.' },
      },
      required: ['owner', 'repo', 'pull_number'],
    },
  },
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function repoJson(repo: Repo): Record<string, unknown> {
  return {
    id: repo.id,
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    owner: { login: repo.owner, id: VIEWER.id, type: 'User' },
    private: repo.private,
    description: repo.description,
    default_branch: repo.defaultBranch,
    created_at: repo.createdAt,
    updated_at: repo.updatedAt,
  };
}

function issueJson(issue: Issue): Record<string, unknown> {
  return {
    id: issue.id,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map((label) => ({ name: label.name, color: label.color })),
    user: { login: VIEWER.login, id: VIEWER.id },
    comments: issue.comments.length,
    created_at: issue.createdAt,
    updated_at: issue.updatedAt,
  };
}

function pullJson(store: Store, repo: Repo, pull: Pull): Record<string, unknown> {
  const headTip = store.branchTip(repo, pull.head);
  const baseTip = store.branchTip(repo, pull.base);
  return {
    id: pull.id,
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state,
    merged: pull.merged,
    merged_at: pull.mergedAt,
    merge_commit_sha: pull.mergeCommitSha,
    head: { ref: pull.head, sha: headTip ?? '', label: `${repo.owner}:${pull.head}` },
    base: { ref: pull.base, sha: baseTip ?? '', label: `${repo.owner}:${pull.base}` },
    user: { login: VIEWER.login, id: VIEWER.id },
    created_at: pull.createdAt,
    updated_at: pull.updatedAt,
  };
}

function resolveRepo(store: Store, owner: unknown, repoName: unknown): Repo | null {
  if (owner !== VIEWER.login || typeof repoName !== 'string') return null;
  return store.getRepo(VIEWER.login, repoName) ?? null;
}

type ToolOutcome =
  | { ok: true; value: unknown }
  | { ok: false; message: string };

function callTool(store: Store, name: string, args: Record<string, unknown>): ToolOutcome {
  switch (name) {
    case 'create_repo': {
      const repoName = args.name;
      if (typeof repoName !== 'string' || repoName === '') return { ok: false, message: 'name is required' };
      const created = store.createRepo(VIEWER.login, repoName, {
        description: typeof args.description === 'string' ? args.description : '',
        private: args.private === true,
      });
      if (created === null) return { ok: false, message: `Repository ${repoName} already exists` };
      return { ok: true, value: repoJson(created) };
    }
    case 'get_repo': {
      const repo = resolveRepo(store, args.owner, args.repo);
      if (repo === null) return { ok: false, message: 'Not Found' };
      return { ok: true, value: repoJson(repo) };
    }
    case 'create_issue': {
      const repo = resolveRepo(store, args.owner, args.repo);
      if (repo === null) return { ok: false, message: 'Not Found' };
      if (typeof args.title !== 'string' || args.title === '') return { ok: false, message: 'title is required' };
      const now = new Date().toISOString();
      const issue: Issue = {
        id: store.restId(),
        number: repo.nextNumber,
        title: args.title,
        body: typeof args.body === 'string' ? args.body : '',
        state: 'open',
        labels: [],
        comments: [],
        createdAt: now,
        updatedAt: now,
      };
      repo.nextNumber += 1;
      repo.issues.push(issue);
      return { ok: true, value: issueJson(issue) };
    }
    case 'list_issues': {
      const repo = resolveRepo(store, args.owner, args.repo);
      if (repo === null) return { ok: false, message: 'Not Found' };
      const state = typeof args.state === 'string' ? args.state : 'open';
      const list = state === 'all' ? repo.issues : repo.issues.filter((issue) => issue.state === state);
      return { ok: true, value: list.map((issue) => issueJson(issue)) };
    }
    case 'create_pull_request': {
      const repo = resolveRepo(store, args.owner, args.repo);
      if (repo === null) return { ok: false, message: 'Not Found' };
      const head = typeof args.head === 'string' ? args.head : '';
      const base = typeof args.base === 'string' ? args.base : repo.defaultBranch;
      if (head === '' || store.branchTip(repo, head) === null) return { ok: false, message: 'head branch does not exist' };
      if (store.branchTip(repo, base) === null) return { ok: false, message: 'base branch does not exist' };
      const existing = repo.pulls.find((pull) => pull.state === 'open' && pull.head === head && pull.base === base);
      if (existing) return { ok: false, message: 'a pull request already exists for this head and base' };
      const now = new Date().toISOString();
      const pull: Pull = {
        id: store.restId(),
        number: repo.nextNumber,
        title: typeof args.title === 'string' ? args.title : '',
        body: typeof args.body === 'string' ? args.body : '',
        state: 'open',
        head,
        base,
        merged: false,
        mergedAt: null,
        mergeCommitSha: null,
        files: [],
        createdAt: now,
        updatedAt: now,
      };
      repo.nextNumber += 1;
      repo.pulls.push(pull);
      return { ok: true, value: pullJson(store, repo, pull) };
    }
    case 'merge_pull_request': {
      const repo = resolveRepo(store, args.owner, args.repo);
      if (repo === null) return { ok: false, message: 'Not Found' };
      const number = typeof args.pull_number === 'number' ? args.pull_number : parseInt(String(args.pull_number ?? ''), 10);
      const pull = repo.pulls.find((candidate) => candidate.number === number);
      if (!pull) return { ok: false, message: 'Not Found' };
      if (pull.merged || pull.state !== 'open') return { ok: false, message: 'pull request is not open' };
      const outcome = squashMerge(store, repo, pull);
      if (!outcome.ok) return { ok: false, message: outcome.reason ?? 'merge conflict' };
      return { ok: true, value: { sha: outcome.sha, merged: true, message: `Merged pull request #${pull.number}` } };
    }
    default:
      return { ok: false, message: `unknown tool ${name}` };
  }
}

const KNOWN_TOOLS = new Set(TOOLS.map((tool) => tool.name));

export interface McpReply {
  status: number;
  body: unknown;
}

/**
 * Handle one POST /mcp body. The body must already be parsed JSON; when it is not JSON the
 * caller answers HTTP 400 with -32700 (see handleMcpRaw below). Returns a JSON-RPC response
 * object, or null for a notification (the caller then answers 202 with no body).
 */
export function handleMcp(store: Store, body: unknown): McpReply {
  if (!isRecord(body) || typeof body.method !== 'string') {
    return {
      status: 200,
      body: { jsonrpc: '2.0', id: isRecord(body) && 'id' in body ? body.id : null, error: { code: -32600, message: 'Invalid Request' } },
    };
  }
  const id = 'id' in body ? body.id : null;
  const isNotification = id === undefined || id === null;
  const method = body.method;
  const params = isRecord(body.params) ? body.params : {};

  const result = (value: unknown): McpReply => ({
    status: 200,
    body: { jsonrpc: '2.0', id, result: value },
  });
  const rpcError = (code: number, message: string): McpReply => ({
    status: 200,
    body: { jsonrpc: '2.0', id, error: { code, message } },
  });

  // A notification has no id and gets no JSON-RPC answer (HTTP 202, empty body).
  if (method === 'notifications/initialized' || method.startsWith('notifications/')) {
    return { status: 202, body: null };
  }

  if (method === 'server/discover') {
    const serverInfo = { name: MCP_SERVER_NAME, version: MCP_SERVER_VERSION };
    return result({
      resultType: 'DiscoverResult',
      supportedVersions: [MCP_PROTOCOL_VERSION, '2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'],
      capabilities: { tools: {} },
      serverInfo,
      _meta: { 'io.modelcontextprotocol/serverInfo': serverInfo },
    });
  }

  if (method === 'initialize') {
    const offered = typeof params.protocolVersion === 'string' ? params.protocolVersion : MCP_PROTOCOL_VERSION;
    const supported = [MCP_PROTOCOL_VERSION, '2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
    const negotiated = supported.includes(offered) ? offered : MCP_PROTOCOL_VERSION;
    return result({
      protocolVersion: negotiated,
      capabilities: { tools: {} },
      serverInfo: { name: MCP_SERVER_NAME, version: MCP_SERVER_VERSION },
    });
  }

  if (method === 'ping') return result({});

  if (method === 'tools/list') {
    // The array is built once at module load, so repeated calls are byte-identical.
    return result({ tools: TOOLS });
  }

  if (method === 'tools/call') {
    const name = typeof params.name === 'string' ? params.name : '';
    const args = isRecord(params.arguments) ? params.arguments : {};
    if (!KNOWN_TOOLS.has(name)) return rpcError(-32601, `Method not found: tools/call ${name}`);
    const tool = TOOLS.find((candidate) => candidate.name === name)!;
    const missing = tool.inputSchema.required.filter((required) => !(required in args) || args[required] === undefined);
    if (missing.length > 0) {
      return result({
        content: [{ type: 'text', text: `missing required argument(s): ${missing.join(', ')}` }],
        isError: true,
      });
    }
    const outcome = callTool(store, name, args);
    if (!outcome.ok) {
      return result({
        content: [{ type: 'text', text: outcome.message }],
        isError: true,
      });
    }
    return result({
      content: [{ type: 'text', text: JSON.stringify(outcome.value) }],
      structuredContent: outcome.value,
    });
  }

  return rpcError(-32601, `Method not found: ${method}`);
}

/** The reply for a body that is not valid JSON: HTTP 400 carrying JSON-RPC -32700. */
export function handleMcpParseError(): McpReply {
  return {
    status: 400,
    body: { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } },
  };
}
