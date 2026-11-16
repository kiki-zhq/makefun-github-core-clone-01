// github-core-clone-01 entry: the REST v3 surface (/api/v3).
// Written from scratch for this bounty. Node 22 standard library only.

import {
  VIEWER,
  flattenTree,
  getPathInTree,
  lineDiff,
  mergeBase,
  parseCommit,
  parseTree,
  type GitObject,
  type Issue,
  type Pull,
  type PullFile,
  type Repo,
  type Store,
} from './store.ts';

export interface RestRequest {
  method: string;
  /** Path segments after /api/v3 (decoded). */
  segments: string[];
  query: URLSearchParams;
  /** Parsed JSON body, or undefined when there is none. */
  body: unknown;
  /** The request's origin, for Link headers and URLs. */
  baseUrl: string;
}

export interface RestReply {
  status: number;
  body: unknown;
  headers?: Record<string, string>;
}

const ok = (body: unknown, status = 200, headers?: Record<string, string>): RestReply => ({ status, body, headers });
const err = (status: number, message: string): RestReply => ({ status, body: { message } });

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function str(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

function repoJson(repo: Repo, baseUrl: string): Record<string, unknown> {
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
    html_url: `${baseUrl}/${repo.owner}/${repo.name}`,
    url: `${baseUrl}/api/v3/repos/${repo.owner}/${repo.name}`,
    clone_url: `${baseUrl}/${repo.owner}/${repo.name}.git`,
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

/** Resolve a repo from /repos/{owner}/{name}: any other owner is a 404, never a 403. */
function resolveRepo(store: Store, owner: string, name: string): Repo | null {
  if (owner !== VIEWER.login) return null;
  return store.getRepo(owner, name) ?? null;
}

function parsePage(query: URLSearchParams): { page: number; perPage: number } {
  const page = Math.max(1, parseInt(query.get('page') ?? '1', 10) || 1);
  const perPage = Math.min(100, Math.max(1, parseInt(query.get('per_page') ?? '30', 10) || 30));
  return { page, perPage };
}

function paginate<T>(items: readonly T[], page: number, perPage: number): { slice: T[]; hasNext: boolean; total: number } {
  const start = (page - 1) * perPage;
  const slice = items.slice(start, start + perPage);
  return { slice, hasNext: start + perPage < items.length, total: items.length };
}

function linkHeader(baseUrl: string, path: string, query: URLSearchParams, page: number, perPage: number, hasNext: boolean): string | null {
  if (!hasNext) return null;
  const next = new URLSearchParams(query);
  next.set('page', String(page + 1));
  next.set('per_page', String(perPage));
  return `<${baseUrl}${path}?${next.toString()}>; rel="next"`;
}

// ---------------------------------------------------------------------------------------------
// contents: commits built from the object store
// ---------------------------------------------------------------------------------------------

function resolveRefCommit(store: Store, repo: Repo, ref: string | null): string | null {
  if (ref === null) return store.branchTip(repo, repo.defaultBranch);
  const branchTip = store.branchTip(repo, ref);
  if (branchTip !== null) return branchTip;
  const object = repo.objects.get(ref);
  if (object && object.type === 'commit') return ref;
  return null;
}

function treeOfCommit(repo: Repo, commitOid: string): string | null {
  const object = repo.objects.get(commitOid);
  if (!object || object.type !== 'commit') return null;
  return parseCommit(object.data).tree;
}

interface ContentsPut {
  status: number;
  contentSha?: string;
  commitSha?: string;
  message?: string;
}

function putContents(
  store: Store,
  repo: Repo,
  path: string,
  input: { message?: string; content?: string; branch?: string; sha?: string },
): ContentsPut {
  const message = str(input.message, '');
  const contentB64 = str(input.content, '');
  if (message === '' || contentB64 === '') return { status: 422, message: 'message and content are required' };
  let content: Buffer;
  try {
    content = Buffer.from(contentB64, 'base64');
  } catch {
    return { status: 422, message: 'content is not valid base64' };
  }
  const branch = input.branch ?? repo.defaultBranch;
  let tip = store.branchTip(repo, branch);
  if (tip === null && branch !== repo.defaultBranch) {
    // A branch that does not exist yet is created from the default branch's tip.
    const defaultTip = store.branchTip(repo, repo.defaultBranch);
    if (defaultTip !== null) {
      repo.refs.set(`refs/heads/${branch}`, defaultTip);
      tip = defaultTip;
    }
  }
  const lookup = store.lookup(repo);
  const baseTree = tip === null ? null : treeOfCommit(repo, tip);
  const current = baseTree === null ? null : getPathInTree(lookup, baseTree, path);
  if (input.sha !== undefined) {
    if (!current) return { status: 422, message: 'cannot update a file that does not exist' };
    if (current.oid !== input.sha) return { status: 409, message: 'sha does not match the current file' };
  } else if (current) {
    return { status: 422, message: 'file already exists' };
  }
  const blobOid = store.putObject(repo, 'blob', content);
  const newTree = store.setPathInTree(repo, baseTree, path, blobOid);
  const commitOid = store.makeCommit(repo, { tree: newTree, parents: tip === null ? [] : [tip], message });
  repo.refs.set(`refs/heads/${branch}`, commitOid);
  return { status: current ? 200 : 201, contentSha: blobOid, commitSha: commitOid };
}

function deleteContents(
  store: Store,
  repo: Repo,
  path: string,
  input: { message?: string; sha?: string; branch?: string },
): ContentsPut {
  const branch = input.branch ?? repo.defaultBranch;
  const tip = store.branchTip(repo, branch);
  if (tip === null) return { status: 404, message: 'Not Found' };
  const lookup = store.lookup(repo);
  const baseTree = treeOfCommit(repo, tip);
  if (baseTree === null) return { status: 404, message: 'Not Found' };
  const current = getPathInTree(lookup, baseTree, path);
  if (!current) return { status: 404, message: 'Not Found' };
  if (input.sha !== undefined && input.sha !== current.oid) {
    return { status: 409, message: 'sha does not match the current file' };
  }
  const newTree = store.setPathInTree(repo, baseTree, path, null);
  const commitOid = store.makeCommit(repo, {
    tree: newTree,
    parents: [tip],
    message: str(input.message, `Delete ${path}`),
  });
  repo.refs.set(`refs/heads/${branch}`, commitOid);
  return { status: 200, commitSha: commitOid };
}

function getContents(store: Store, repo: Repo, path: string, ref: string | null): RestReply {
  const commitOid = resolveRefCommit(store, repo, ref);
  if (commitOid === null) return err(404, 'Not Found');
  const lookup = store.lookup(repo);
  const treeOid = treeOfCommit(repo, commitOid);
  if (treeOid === null) return err(404, 'Not Found');
  const segments = path.split('/').filter((part) => part !== '');
  if (segments.length === 0) {
    return ok(listDirectory(store, repo, treeOid, ''));
  }
  const found = getPathInTree(lookup, treeOid, path);
  if (!found) return err(404, 'Not Found');
  if (found.mode === '40000') {
    return ok(listDirectory(store, repo, found.oid, path));
  }
  const object = repo.objects.get(found.oid);
  if (!object) return err(404, 'Not Found');
  const name = segments[segments.length - 1];
  return ok({
    type: 'file',
    encoding: 'base64',
    size: object.data.length,
    name,
    path,
    content: object.data.toString('base64'),
    sha: found.oid,
  });
}

function listDirectory(store: Store, repo: Repo, treeOid: string, path: string): Array<Record<string, unknown>> {
  const object = repo.objects.get(treeOid);
  if (!object || object.type !== 'tree') return [];
  return parseTree(object.data).map((entry) => ({
    type: entry.mode === '40000' ? 'dir' : 'file',
    name: entry.name,
    path: path === '' ? entry.name : `${path}/${entry.name}`,
    sha: entry.oid,
    size: entry.mode === '40000' ? 0 : (repo.objects.get(entry.oid)?.data.length ?? 0),
  }));
}

// ---------------------------------------------------------------------------------------------
// pull requests: diffs and squash merges
// ---------------------------------------------------------------------------------------------

function diffFiles(store: Store, repo: Repo, baseCommit: string, headCommit: string): PullFile[] {
  const lookup = store.lookup(repo);
  const baseTree = treeOfCommit(repo, baseCommit);
  const headTree = treeOfCommit(repo, headCommit);
  const base = baseTree === null ? new Map() : flattenTree(lookup, baseTree);
  const head = headTree === null ? new Map() : flattenTree(lookup, headTree);
  const files: PullFile[] = [];
  const paths = new Set([...base.keys(), ...head.keys()]);
  for (const path of [...paths].sort()) {
    const inBase = base.get(path);
    const inHead = head.get(path);
    if (inBase && !inHead) {
      const oldText = repo.objects.get(inBase.oid)?.data.toString('utf8') ?? '';
      const { deletions } = lineDiff(oldText, '');
      files.push({ filename: path, status: 'removed', additions: 0, deletions, changes: deletions });
    } else if (!inBase && inHead) {
      const newText = repo.objects.get(inHead.oid)?.data.toString('utf8') ?? '';
      const { additions } = lineDiff('', newText);
      files.push({ filename: path, status: 'added', additions, deletions: 0, changes: additions });
    } else if (inBase && inHead && inBase.oid !== inHead.oid) {
      const oldText = repo.objects.get(inBase.oid)?.data.toString('utf8') ?? '';
      const newText = repo.objects.get(inHead.oid)?.data.toString('utf8') ?? '';
      const { additions, deletions } = lineDiff(oldText, newText);
      files.push({ filename: path, status: 'modified', additions, deletions, changes: additions + deletions });
    }
  }
  return files;
}

interface MergeOutcome {
  ok: boolean;
  sha?: string;
  reason?: string;
}

/** A file-level three-way squash merge onto the base branch. */
export function squashMerge(store: Store, repo: Repo, pull: Pull): MergeOutcome {
  const baseTip = store.branchTip(repo, pull.base);
  const headTip = store.branchTip(repo, pull.head);
  if (baseTip === null || headTip === null) return { ok: false, reason: 'head or base branch is missing' };
  const lookup = store.lookup(repo);
  const mb = mergeBase(lookup, headTip, baseTip);
  if (mb === null) return { ok: false, reason: 'no merge base' };
  const baseTree = treeOfCommit(repo, mb);
  const headTree = treeOfCommit(repo, headTip);
  const tipTree = treeOfCommit(repo, baseTip);
  if (baseTree === null || headTree === null || tipTree === null) return { ok: false, reason: 'missing tree' };
  const base = flattenTree(lookup, baseTree);
  const head = flattenTree(lookup, headTree);
  const tip = flattenTree(lookup, tipTree);
  const merged = new Map<string, { oid: string; mode: string }>(tip);
  const paths = new Set([...base.keys(), ...head.keys(), ...tip.keys()]);
  for (const path of paths) {
    const mbEntry = base.get(path);
    const headEntry = head.get(path);
    const tipEntry = tip.get(path);
    const headChanged = (headEntry?.oid ?? null) !== (mbEntry?.oid ?? null);
    const tipChanged = (tipEntry?.oid ?? null) !== (mbEntry?.oid ?? null);
    if (headChanged && tipChanged && (headEntry?.oid ?? null) !== (tipEntry?.oid ?? null)) {
      return { ok: false, reason: 'merge conflict' };
    }
    if (headChanged) {
      if (headEntry) merged.set(path, { oid: headEntry.oid, mode: headEntry.mode });
      else merged.delete(path);
    }
  }
  const mergedTree = store.buildTreeFromPaths(repo, merged);
  const sha = store.makeCommit(repo, {
    tree: mergedTree,
    parents: [baseTip],
    message: pull.title,
  });
  repo.refs.set(`refs/heads/${pull.base}`, sha);
  pull.merged = true;
  pull.mergedAt = new Date().toISOString();
  pull.mergeCommitSha = sha;
  pull.state = 'closed';
  pull.updatedAt = new Date().toISOString();
  return { ok: true, sha };
}

/** Whether the pull request would merge cleanly (for GraphQL's mergeable field). */
export function pullMergeable(store: Store, repo: Repo, pull: Pull): string {
  const baseTip = store.branchTip(repo, pull.base);
  const headTip = store.branchTip(repo, pull.head);
  if (baseTip === null || headTip === null) return 'UNKNOWN';
  const lookup = store.lookup(repo);
  const mb = mergeBase(lookup, headTip, baseTip);
  if (mb === null) return 'CONFLICTING';
  const baseTree = treeOfCommit(repo, mb);
  const headTree = treeOfCommit(repo, headTip);
  const tipTree = treeOfCommit(repo, baseTip);
  if (baseTree === null || headTree === null || tipTree === null) return 'UNKNOWN';
  const base = flattenTree(lookup, baseTree);
  const head = flattenTree(lookup, headTree);
  const tip = flattenTree(lookup, tipTree);
  for (const path of new Set([...base.keys(), ...head.keys(), ...tip.keys()])) {
    const headChanged = (head.get(path)?.oid ?? null) !== (base.get(path)?.oid ?? null);
    const tipChanged = (tip.get(path)?.oid ?? null) !== (base.get(path)?.oid ?? null);
    if (headChanged && tipChanged && (head.get(path)?.oid ?? null) !== (tip.get(path)?.oid ?? null)) {
      return 'CONFLICTING';
    }
  }
  return 'MERGEABLE';
}

// ---------------------------------------------------------------------------------------------
// the router
// ---------------------------------------------------------------------------------------------

export function handleRest(store: Store, req: RestRequest): RestReply {
  const s = req.segments;
  const method = req.method;
  const query = req.query;
  const body = isRecord(req.body) ? req.body : {};

  // API root and meta.
  if (s.length === 0) {
    if (method === 'GET') {
      return ok(
        { current_user_url: '/api/v3/user', rate_limit_url: '/api/v3/rate_limit' },
        200,
        { 'x-oauth-scopes': 'repo, read:org' },
      );
    }
    return err(404, 'Not Found');
  }
  if (s.length === 1 && s[0] === 'meta') {
    if (method === 'GET') return ok({ installed_version: '1.0.0' });
    return err(404, 'Not Found');
  }

  // The authenticated user.
  if (s.length === 1 && s[0] === 'user') {
    if (method === 'GET') {
      return ok({
        login: VIEWER.login,
        id: VIEWER.id,
        name: VIEWER.name,
        email: VIEWER.email,
        type: 'User',
      });
    }
    return err(404, 'Not Found');
  }

  // POST /user/repos and GET /user/repos.
  if (s.length === 2 && s[0] === 'user' && s[1] === 'repos') {
    if (method === 'POST') {
      const name = str(body.name, '');
      if (name === '' || name.length > 100 || /[/\s]/.test(name)) return err(422, 'invalid repository name');
      const created = store.createRepo(VIEWER.login, name, {
        description: str(body.description, ''),
        private: body.private === true,
      });
      if (created === null) return err(422, `Repository ${name} already exists`);
      return ok(repoJson(created, req.baseUrl), 201);
    }
    if (method === 'GET') {
      const { page, perPage } = parsePage(query);
      const repos = store.listRepos(VIEWER.login);
      const { slice, hasNext } = paginate(repos, page, perPage);
      const headers: Record<string, string> = {};
      const link = linkHeader(req.baseUrl, '/api/v3/user/repos', query, page, perPage, hasNext);
      if (link !== null) headers.link = link;
      return ok(slice.map((repo) => repoJson(repo, req.baseUrl)), 200, headers);
    }
    return err(404, 'Not Found');
  }

  // Everything below is /repos/{owner}/{name}/...
  if (s.length < 3 || s[0] !== 'repos') return err(404, 'Not Found');
  const owner = decodeURIComponent(s[1]);
  const name = decodeURIComponent(s[2]);
  const repo = resolveRepo(store, owner, name);
  if (repo === null) return err(404, 'Not Found');
  const rest = s.slice(3);

  // The repository itself.
  if (rest.length === 0) {
    if (method === 'GET') return ok(repoJson(repo, req.baseUrl));
    if (method === 'PATCH') {
      if (typeof body.description === 'string') repo.description = body.description;
      repo.updatedAt = new Date().toISOString();
      return ok(repoJson(repo, req.baseUrl));
    }
    if (method === 'DELETE') {
      store.deleteRepo(owner, name);
      return { status: 204, body: null };
    }
    return err(404, 'Not Found');
  }

  // Branches.
  if (rest[0] === 'branches') {
    if (rest.length === 1 && method === 'GET') {
      const branches = [...repo.refs.keys()]
        .filter((ref) => ref.startsWith('refs/heads/'))
        .map((ref) => ref.slice('refs/heads/'.length))
        .sort()
        .map((branch) => ({ name: branch, commit: { sha: repo.refs.get(`refs/heads/${branch}`) ?? '' } }));
      return ok(branches);
    }
    if (rest.length === 2 && method === 'GET') {
      const branch = decodeURIComponent(rest[1]);
      const tip = store.branchTip(repo, branch);
      if (tip === null) return err(404, 'Not Found');
      return ok({ name: branch, commit: { sha: tip } });
    }
    return err(404, 'Not Found');
  }

  // Commits.
  if (rest[0] === 'commits' && rest.length === 1 && method === 'GET') {
    const ref = query.get('sha');
    const tip = resolveRefCommit(store, repo, ref);
    if (tip === null) return ok([]);
    const lookup = store.lookup(repo);
    const seen = new Set<string>();
    const collected: Array<{ sha: string; time: number; commit: GitObject }> = [];
    const queue = [tip];
    while (queue.length > 0) {
      const oid = queue.pop()!;
      if (seen.has(oid)) continue;
      seen.add(oid);
      const object = lookup(oid);
      if (!object || object.type !== 'commit') continue;
      const parsed = parseCommit(object.data);
      const stamp = parseInt((parsed.author.split(' ').slice(-2)[0] ?? '0'), 10) || 0;
      collected.push({ sha: oid, time: stamp, commit: object });
      for (const parent of parsed.parents) queue.push(parent);
    }
    collected.sort((a, b) => b.time - a.time);
    return ok(
      collected.map(({ sha, commit }) => {
        const parsed = parseCommit(commit.data);
        const message = parsed.message.replace(/\n$/, '');
        // Author line: "<name> <email> <unix ts> <tz>".
        const authorParts = parsed.author.split(' ');
        const stamp = parseInt(authorParts[authorParts.length - 2] ?? '0', 10) || 0;
        const email = (authorParts[authorParts.length - 3] ?? '').replace(/[<>]/g, '');
        const name = authorParts.slice(0, -3).join(' ');
        const date = new Date(stamp * 1000).toISOString();
        return {
          sha,
          commit: {
            message,
            author: { name, email, date },
            committer: { name, email, date },
          },
        };
      }),
    );
  }

  // Git refs.
  if (rest[0] === 'git' && rest[1] === 'refs') {
    if (method === 'POST' && rest.length === 2) {
      const ref = str(body.ref, '');
      const sha = str(body.sha, '');
      if (!ref.startsWith('refs/heads/') && !ref.startsWith('refs/tags/')) {
        return err(422, 'ref must be refs/heads/* or refs/tags/*');
      }
      if (!/^[0-9a-f]{40}$/.test(sha) || !repo.objects.has(sha)) return err(422, 'sha does not exist');
      if (repo.refs.has(ref)) return err(422, 'ref already exists');
      repo.refs.set(ref, sha);
      return ok({ ref, object: { sha } }, 201);
    }
    if (method === 'GET' && rest.length >= 3) {
      const ref = `refs/${rest.slice(2).map((part) => decodeURIComponent(part)).join('/')}`;
      const tip = repo.refs.get(ref);
      if (tip === undefined) return err(404, 'Not Found');
      return ok({ ref, object: { sha: tip } });
    }
    return err(404, 'Not Found');
  }

  // Contents.
  if (rest[0] === 'contents') {
    const path = rest.slice(1).map((part) => decodeURIComponent(part)).join('/');
    if (method === 'GET') return getContents(store, repo, path, query.get('ref'));
    if (method === 'PUT') {
      const result = putContents(store, repo, path, body);
      if (result.status === 200 || result.status === 201) {
        const object = repo.objects.get(result.contentSha!);
        return ok(
          {
            content: {
              name: path.split('/').pop() ?? path,
              path,
              sha: result.contentSha,
              size: object?.data.length ?? 0,
              type: 'file',
              encoding: 'base64',
            },
            commit: { sha: result.commitSha, message: str(body.message, '') },
          },
          result.status,
        );
      }
      return err(result.status, result.message ?? 'error');
    }
    if (method === 'DELETE') {
      const result = deleteContents(store, repo, path, body);
      if (result.status === 200) return ok({ commit: { sha: result.commitSha } });
      return err(result.status, result.message ?? 'error');
    }
    return err(404, 'Not Found');
  }

  // Labels.
  if (rest[0] === 'labels') {
    if (method === 'GET') {
      return ok([...repo.labels.values()].map((label) => ({ name: label.name, color: label.color })));
    }
    if (method === 'POST') {
      const labelName = str(body.name, '');
      if (labelName === '') return err(422, 'label name is required');
      if (repo.labels.has(labelName)) return err(422, 'label already exists');
      const color = str(body.color, 'ededed');
      repo.labels.set(labelName, { name: labelName, color });
      return ok({ name: labelName, color }, 201);
    }
    return err(404, 'Not Found');
  }

  // Issues.
  if (rest[0] === 'issues') {
    if (rest.length === 1) {
      if (method === 'GET') {
        const state = query.get('state') ?? 'open';
        const direction = query.get('direction') ?? 'desc';
        const sort = query.get('sort') ?? 'created';
        let list = [...repo.issues];
        if (state !== 'all') list = list.filter((issue) => issue.state === state);
        if (sort === 'created') {
          list.sort((a, b) => (direction === 'asc' ? a.number - b.number : b.number - a.number));
        }
        const { page, perPage } = parsePage(query);
        const { slice } = paginate(list, page, perPage);
        return ok(slice.map((issue) => issueJson(issue)));
      }
      if (method === 'POST') {
        const title = str(body.title, '');
        const labels = Array.isArray(body.labels) ? (body.labels as unknown[]) : [];
        for (const label of labels) {
          if (typeof label !== 'string' || !repo.labels.has(label)) {
            return err(422, `label ${String(label)} does not exist`);
          }
        }
        const now = new Date().toISOString();
        const issue: Issue = {
          id: store.restId(),
          number: repo.nextNumber,
          title,
          body: str(body.body, ''),
          state: 'open',
          labels: (labels as string[]).map((labelName) => ({
            name: labelName,
            color: repo.labels.get(labelName)?.color ?? 'ededed',
          })),
          comments: [],
          createdAt: now,
          updatedAt: now,
        };
        repo.nextNumber += 1;
        repo.issues.push(issue);
        return ok(issueJson(issue), 201);
      }
      return err(404, 'Not Found');
    }
    const number = parseInt(rest[1], 10);
    const issue = repo.issues.find((candidate) => candidate.number === number);
    if (rest.length === 2) {
      if (!issue) return err(404, 'Not Found');
      if (method === 'GET') return ok(issueJson(issue));
      if (method === 'PATCH') {
        if (body.state === 'open' || body.state === 'closed') issue.state = body.state;
        if (typeof body.title === 'string') issue.title = body.title;
        if (typeof body.body === 'string') issue.body = body.body;
        issue.updatedAt = new Date().toISOString();
        return ok(issueJson(issue));
      }
      return err(404, 'Not Found');
    }
    if (rest.length === 3 && rest[2] === 'comments') {
      if (!issue) return err(404, 'Not Found');
      if (method === 'GET') {
        return ok(issue.comments.map((comment) => ({ id: comment.id, body: comment.body, created_at: comment.createdAt })));
      }
      if (method === 'POST') {
        const comment = {
          id: store.nextComment(),
          body: str(body.body, ''),
          createdAt: new Date().toISOString(),
        };
        issue.comments.push(comment);
        issue.updatedAt = new Date().toISOString();
        return ok({ id: comment.id, body: comment.body, created_at: comment.createdAt }, 201);
      }
      return err(404, 'Not Found');
    }
    return err(404, 'Not Found');
  }

  // Pull requests.
  if (rest[0] === 'pulls') {
    if (rest.length === 1) {
      if (method === 'GET') {
        const state = query.get('state') ?? 'open';
        let list = [...repo.pulls];
        if (state !== 'all') list = list.filter((pull) => pull.state === state);
        const { page, perPage } = parsePage(query);
        const { slice } = paginate(list, page, perPage);
        return ok(slice.map((pull) => pullJson(store, repo, pull)));
      }
      if (method === 'POST') {
        const head = str(body.head, '');
        const base = str(body.base, '') || repo.defaultBranch;
        const title = str(body.title, '');
        if (head === '' || store.branchTip(repo, head) === null) return err(422, 'head branch does not exist');
        if (store.branchTip(repo, base) === null) return err(422, 'base branch does not exist');
        const existing = repo.pulls.find((pull) => pull.state === 'open' && pull.head === head && pull.base === base);
        if (existing) return err(422, 'a pull request already exists for this head and base');
        const now = new Date().toISOString();
        const headTip = store.branchTip(repo, head)!;
        const baseTip = store.branchTip(repo, base)!;
        const lookup = store.lookup(repo);
        const mb = mergeBase(lookup, headTip, baseTip);
        const pull: Pull = {
          id: store.restId(),
          number: repo.nextNumber,
          title,
          body: str(body.body, ''),
          state: 'open',
          head,
          base,
          merged: false,
          mergedAt: null,
          mergeCommitSha: null,
          files: mb === null ? [] : diffFiles(store, repo, mb, headTip),
          createdAt: now,
          updatedAt: now,
        };
        repo.nextNumber += 1;
        repo.pulls.push(pull);
        return ok(pullJson(store, repo, pull), 201);
      }
      return err(404, 'Not Found');
    }
    const number = parseInt(rest[1], 10);
    const pull = repo.pulls.find((candidate) => candidate.number === number);
    if (rest.length === 2) {
      if (!pull) return err(404, 'Not Found');
      if (method === 'GET') return ok(pullJson(store, repo, pull));
      return err(404, 'Not Found');
    }
    if (rest.length === 3 && rest[2] === 'files') {
      if (!pull) return err(404, 'Not Found');
      if (method === 'GET') {
        return ok(
          pull.files.map((file) => ({
            filename: file.filename,
            status: file.status,
            additions: file.additions,
            deletions: file.deletions,
            changes: file.changes,
          })),
        );
      }
      return err(404, 'Not Found');
    }
    if (rest.length === 3 && rest[2] === 'merge') {
      if (!pull) return err(404, 'Not Found');
      if (method === 'PUT') {
        if (pull.merged) return err(405, 'pull request is already merged');
        if (pull.state !== 'open') return err(405, 'pull request is not open');
        const outcome = squashMerge(store, repo, pull);
        if (!outcome.ok) return err(405, outcome.reason ?? 'merge conflict');
        return ok({ sha: outcome.sha, merged: true, message: `Merged pull request #${pull.number}` });
      }
      return err(404, 'Not Found');
    }
    return err(404, 'Not Found');
  }

  return err(404, 'Not Found');
}
