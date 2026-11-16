// github-core-clone-01 entry: the in-memory store plus the git object/pack primitives.
// Written from scratch for this bounty. Node 22 standard library only.

import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';

export type ObjType = 'blob' | 'tree' | 'commit' | 'tag';

export interface GitObject {
  type: ObjType;
  data: Buffer;
}

export const ZERO_OID = '0000000000000000000000000000000000000000';

const TYPE_CODE: Record<ObjType, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };
const CODE_TYPE: Record<number, ObjType> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };

export const VIEWER = {
  login: 'adaiversen',
  id: 1000,
  name: 'ada iversen',
  email: 'adaiversen@example.invalid',
};

export function sha1Hex(data: Buffer): string {
  return createHash('sha1').update(data).digest('hex');
}

/** The id of a git object: sha1("<type> <len>\0" + data). */
export function hashObject(type: ObjType, data: Buffer): string {
  const header = Buffer.from(`${type} ${data.length}\0`, 'ascii');
  return sha1Hex(Buffer.concat([header, data]));
}

export function isOid(value: string): boolean {
  return /^[0-9a-f]{40}$/.test(value);
}

// ---------------------------------------------------------------------------------------------
// commits, trees, tags
// ---------------------------------------------------------------------------------------------

export interface ParsedCommit {
  tree: string;
  parents: string[];
  author: string;
  committer: string;
  message: string;
}

export function parseCommit(data: Buffer): ParsedCommit {
  const text = data.toString('utf8');
  const split = text.indexOf('\n\n');
  const head = split === -1 ? text : text.slice(0, split);
  const message = split === -1 ? '' : text.slice(split + 2);
  let tree = '';
  const parents: string[] = [];
  let author = '';
  let committer = '';
  for (const line of head.split('\n')) {
    if (line.startsWith('tree ')) tree = line.slice(5).trim();
    else if (line.startsWith('parent ')) parents.push(line.slice(7).trim());
    else if (line.startsWith('author ')) author = line.slice(7);
    else if (line.startsWith('committer ')) committer = line.slice(10);
  }
  return { tree, parents, author, committer, message };
}

export function buildCommit(input: {
  tree: string;
  parents: readonly string[];
  author: string;
  committer: string;
  message: string;
}): Buffer {
  const lines: string[] = [`tree ${input.tree}`];
  for (const parent of input.parents) lines.push(`parent ${parent}`);
  lines.push(`author ${input.author}`);
  lines.push(`committer ${input.committer}`);
  lines.push('');
  const message = input.message.endsWith('\n') ? input.message : `${input.message}\n`;
  // The header block ends with a blank line: lines.join('\n') already ends in one '\n'
  // (from the empty last element), so one more '\n' separates the headers from the message.
  return Buffer.from(`${lines.join('\n')}\n${message}`, 'utf8');
}

export interface TreeEntry {
  mode: string;
  name: string;
  oid: string;
}

export function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let offset = 0;
  while (offset < data.length) {
    const space = data.indexOf(0x20, offset);
    if (space === -1) break;
    const mode = data.subarray(offset, space).toString('ascii');
    const nul = data.indexOf(0x00, space + 1);
    if (nul === -1) break;
    const name = data.subarray(space + 1, nul).toString('utf8');
    const oid = data.subarray(nul + 1, nul + 21).toString('hex');
    entries.push({ mode, name, oid });
    offset = nul + 21;
  }
  return entries;
}

/** Canonical git tree order: entries sort by name, directories as if named with a trailing '/'. */
export function treeSortKey(entry: TreeEntry): string {
  return entry.mode === '40000' ? `${entry.name}/` : entry.name;
}

export function buildTree(entries: readonly TreeEntry[]): Buffer {
  const sorted = [...entries].sort((a, b) => {
    const ka = treeSortKey(a);
    const kb = treeSortKey(b);
    return ka < kb ? -1 : ka > kb ? 1 : 0;
  });
  const parts: Buffer[] = [];
  for (const entry of sorted) {
    parts.push(Buffer.from(`${entry.mode} ${entry.name}\0`, 'utf8'));
    parts.push(Buffer.from(entry.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

export interface ParsedTag {
  object: string;
  type: string;
  tag: string;
  tagger: string;
  message: string;
}

export function parseTag(data: Buffer): ParsedTag {
  const text = data.toString('utf8');
  const split = text.indexOf('\n\n');
  const head = split === -1 ? text : text.slice(0, split);
  const message = split === -1 ? '' : text.slice(split + 2);
  let object = '';
  let type = '';
  let tag = '';
  let tagger = '';
  for (const line of head.split('\n')) {
    if (line.startsWith('object ')) object = line.slice(7).trim();
    else if (line.startsWith('type ')) type = line.slice(5).trim();
    else if (line.startsWith('tag ')) tag = line.slice(4).trim();
    else if (line.startsWith('tagger ')) tagger = line.slice(7);
  }
  return { object, type, tag, tagger, message };
}

// ---------------------------------------------------------------------------------------------
// packfiles: write plain objects; read (and resolve) plain and delta objects
// ---------------------------------------------------------------------------------------------

/** Encode one object's pack header: the type/size varint of the pack format. */
function writePackObjectHeader(type: ObjType, size: number): Buffer {
  const code = TYPE_CODE[type];
  const bytes: number[] = [];
  let remaining = size;
  let first = (code << 4) | (remaining & 0x0f);
  remaining = Math.floor(remaining / 16);
  while (remaining > 0) {
    bytes.push(first | 0x80);
    first = remaining & 0x7f;
    remaining = Math.floor(remaining / 128);
  }
  bytes.push(first);
  return Buffer.from(bytes);
}

/** Build a packfile from plain objects (no deltas). Order is the caller's. */
export function writePack(objects: Iterable<GitObject>): Buffer {
  const list = [...objects];
  const parts: Buffer[] = [];
  const header = Buffer.allocUnsafe(12);
  header.write('PACK', 0, 4, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(list.length, 8);
  parts.push(header);
  for (const object of list) {
    const data = Buffer.isBuffer(object.data) ? object.data : Buffer.from(object.data);
    parts.push(writePackObjectHeader(object.type, data.length));
    parts.push(deflateSync(data));
  }
  const body = Buffer.concat(parts);
  return Buffer.concat([body, createHash('sha1').update(body).digest()]);
}

/** Read a pack's variable-length size field. Returns the size and the next offset. */
function readVarintSize(buffer: Buffer, offset: number): { size: number; first: number; next: number } {
  const first = buffer[offset];
  let size = first & 0x0f;
  let shift = 4;
  let pos = offset + 1;
  while (first !== undefined && (buffer[pos - 1] & 0x80) !== 0) {
    size |= (buffer[pos] & 0x7f) << shift;
    shift += 7;
    pos += 1;
  }
  return { size, first, next: pos };
}

/** Read an OFS_DELTA base offset: the negative-offset varint. */
function readOfsDeltaBase(buffer: Buffer, offset: number): { baseOffset: number; next: number } {
  let byte = buffer[offset];
  let pos = offset + 1;
  let baseOffset = byte & 0x7f;
  while ((byte & 0x80) !== 0) {
    byte = buffer[pos];
    pos += 1;
    baseOffset = ((baseOffset + 1) << 7) | (byte & 0x7f);
  }
  return { baseOffset, next: pos };
}

/** Inflate one zlib stream starting at `offset`; returns the bytes and the next offset.
 * Node's inflateSync ignores trailing bytes, so the exact stream end is the smallest length
 * that inflates successfully (a shorter slice throws "unexpected end of file"). Found by
 * binary search between a failing short slice and the pack end, which always succeeds. */
function inflateAt(buffer: Buffer, offset: number, limit: number): { data: Buffer; next: number } {
  let lo = offset; // too short: throws
  let hi = limit; // long enough: succeeds (trailing bytes ignored)
  let data: Buffer;
  try {
    data = inflateSync(buffer.subarray(offset, hi));
  } catch {
    throw new Error('pack entry zlib stream is truncated');
  }
  while (hi - lo > 1) {
    const mid = Math.floor((lo + hi) / 2);
    try {
      inflateSync(buffer.subarray(offset, mid));
      hi = mid;
    } catch {
      lo = mid;
    }
  }
  data = inflateSync(buffer.subarray(offset, hi));
  return { data, next: hi };
}

/** Apply a git delta to a base buffer. */
export function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let pos = 0;
  const readVarint = (): number => {
    let value = 0;
    let shift = 0;
    for (;;) {
      const byte = delta[pos];
      pos += 1;
      value |= (byte & 0x7f) << shift;
      shift += 7;
      if ((byte & 0x80) === 0) break;
    }
    return value;
  };
  const sourceSize = readVarint();
  const targetSize = readVarint();
  if (sourceSize !== base.length) throw new Error(`delta base size ${sourceSize} does not match ${base.length}`);
  const parts: Buffer[] = [];
  let produced = 0;
  while (pos < delta.length) {
    const opcode = delta[pos];
    pos += 1;
    if ((opcode & 0x80) !== 0) {
      let offset = 0;
      let size = 0;
      if (opcode & 0x01) { offset = delta[pos]; pos += 1; }
      if (opcode & 0x02) { offset |= delta[pos] << 8; pos += 1; }
      if (opcode & 0x04) { offset |= delta[pos] << 16; pos += 1; }
      if (opcode & 0x08) { offset |= delta[pos] << 24; pos += 1; }
      if (opcode & 0x10) { size = delta[pos]; pos += 1; }
      if (opcode & 0x20) { size |= delta[pos] << 8; pos += 1; }
      if (opcode & 0x40) { size |= delta[pos] << 16; pos += 1; }
      if (size === 0) size = 0x10000;
      parts.push(base.subarray(offset, offset + size));
      produced += size;
    } else if (opcode !== 0) {
      parts.push(delta.subarray(pos, pos + opcode));
      produced += opcode;
      pos += opcode;
    } else {
      throw new Error('delta opcode 0 is invalid');
    }
  }
  const out = Buffer.concat(parts);
  if (produced !== targetSize || out.length !== targetSize) {
    throw new Error(`delta produced ${out.length} bytes, expected ${targetSize}`);
  }
  return out;
}

export interface PackReadResult {
  objects: Map<string, GitObject>;
  deltaCount: number;
}

/**
 * Read a packfile, resolving OFS_DELTA and REF_DELTA entries. `lookup` supplies objects a thin
 * pack leaves out (REF_DELTA bases the client already holds / the store holds).
 */
export function readPack(pack: Buffer, lookup?: (oid: string) => GitObject | undefined): PackReadResult {
  if (pack.length < 32) throw new Error(`pack is ${pack.length} bytes, too short`);
  if (pack.subarray(0, 4).toString('ascii') !== 'PACK') throw new Error('pack does not start with PACK');
  const version = pack.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new Error(`unsupported pack version ${version}`);
  const declaredCount = pack.readUInt32BE(8);
  const trailerStart = pack.length - 20;
  const trailer = pack.subarray(trailerStart).toString('hex');
  const computed = sha1Hex(pack.subarray(0, trailerStart));
  if (trailer !== computed) throw new Error('pack trailer checksum mismatch');

  interface Raw {
    offset: number;
    typeCode: number;
    size: number;
    data: Buffer;
    baseOffset?: number;
    baseOid?: string;
    resolvedType?: ObjType;
    resolved?: Buffer;
    oid?: string;
  }
  const raw: Raw[] = [];
  const byOffset = new Map<number, Raw>();
  let offset = 12;
  for (let index = 0; index < declaredCount; index += 1) {
    const entryOffset = offset;
    const header = readVarintSize(pack, offset);
    offset = header.next;
    const typeCode = (header.first >> 4) & 0x07;
    const entry: Raw = { offset: entryOffset, typeCode, size: header.size, data: Buffer.alloc(0) };
    if (typeCode === 6) {
      const base = readOfsDeltaBase(pack, offset);
      offset = base.next;
      entry.baseOffset = entryOffset - base.baseOffset;
    } else if (typeCode === 7) {
      entry.baseOid = pack.subarray(offset, offset + 20).toString('hex');
      offset += 20;
    } else if (!CODE_TYPE[typeCode]) {
      throw new Error(`pack entry ${index} has unknown type code ${typeCode}`);
    }
    const inflated = inflateAt(pack.subarray(0, trailerStart), offset, trailerStart);
    if (inflated.data.length !== header.size) {
      throw new Error(`pack entry at ${entryOffset} declares ${header.size} bytes but inflated to ${inflated.data.length}`);
    }
    entry.data = inflated.data;
    offset = inflated.next;
    raw.push(entry);
    byOffset.set(entryOffset, entry);
  }
  if (offset !== trailerStart) throw new Error(`pack has ${trailerStart - offset} stray bytes before its trailer`);

  const objects = new Map<string, GitObject>();
  const resolvedByOid = new Map<string, Raw>();
  const resolving = new Set<number>();
  let deltaCount = 0;
  const resolve = (entry: Raw): { type: ObjType; data: Buffer; oid: string } => {
    if (entry.resolved && entry.resolvedType && entry.oid) {
      return { type: entry.resolvedType, data: entry.resolved, oid: entry.oid };
    }
    if (resolving.has(entry.offset)) throw new Error(`delta cycle at pack offset ${entry.offset}`);
    resolving.add(entry.offset);
    let type: ObjType;
    let data: Buffer;
    if (entry.typeCode === 6) {
      const baseEntry = byOffset.get(entry.baseOffset!);
      if (!baseEntry) throw new Error(`ofs-delta base at offset ${entry.baseOffset} is not in the pack`);
      const base = resolve(baseEntry);
      type = base.type;
      data = applyDelta(base.data, entry.data);
    } else if (entry.typeCode === 7) {
      const wanted = entry.baseOid!;
      const baseEntry = resolvedByOid.get(wanted);
      if (baseEntry) {
        const base = resolve(baseEntry);
        type = base.type;
        data = applyDelta(base.data, entry.data);
      } else {
        const external = lookup?.(wanted);
        if (!external) throw new Error(`ref-delta base ${wanted} is neither in the pack nor in the store`);
        type = external.type;
        data = applyDelta(external.data, entry.data);
      }
    } else {
      type = CODE_TYPE[entry.typeCode];
      data = entry.data;
    }
    const oid = hashObject(type, data);
    entry.resolved = data;
    entry.resolvedType = type;
    entry.oid = oid;
    resolvedByOid.set(oid, entry);
    resolving.delete(entry.offset);
    return { type, data, oid };
  };
  for (const entry of raw) {
    const resolved = resolve(entry);
    if (entry.typeCode === 6 || entry.typeCode === 7) deltaCount += 1;
    if (!objects.has(resolved.oid)) objects.set(resolved.oid, { type: resolved.type, data: resolved.data });
  }
  return { objects, deltaCount };
}

// ---------------------------------------------------------------------------------------------
// reachability, trees, merges
// ---------------------------------------------------------------------------------------------

export type ObjectLookup = (oid: string) => GitObject | undefined;

/**
 * Walk objects reachable from `tips`. Commits contribute their tree closure and their parents;
 * tags contribute their target. With `depthLimit`, only commits closer than that depth from a tip
 * are followed (their trees are still fully included); `stopAt` commits are included but their
 * parents are not followed (a shallow boundary the client already holds).
 * Returns the object set plus the boundary commits (included commits at the depth cutoff that
 * still have parents) — the shallow-info lines a depth-limited fetch reports.
 */
export function collectReachable(
  lookup: ObjectLookup,
  tips: Iterable<string>,
  options: { depthLimit?: number; stopAt?: ReadonlySet<string> } = {},
): { objects: Set<string>; boundary: Set<string> } {
  const objects = new Set<string>();
  const boundary = new Set<string>();
  const depthLimit = options.depthLimit;
  const stopAt = options.stopAt ?? new Set<string>();
  // Depth-first walk of commits, tracking each commit's distance from a tip.
  const commitDepth = new Map<string, number>();
  const stack: Array<{ oid: string; depth: number }> = [];
  for (const tip of tips) stack.push({ oid: tip, depth: 0 });
  const visitTree = (treeOid: string): void => {
    const queue = [treeOid];
    while (queue.length > 0) {
      const oid = queue.pop()!;
      if (objects.has(oid)) continue;
      const object = lookup(oid);
      if (!object || object.type !== 'tree') continue;
      objects.add(oid);
      for (const entry of parseTree(object.data)) {
        if (entry.mode === '40000') queue.push(entry.oid);
        else objects.add(entry.oid);
      }
    }
  };
  while (stack.length > 0) {
    const { oid, depth } = stack.pop()!;
    const known = commitDepth.get(oid);
    if (known !== undefined && known <= depth) continue;
    commitDepth.set(oid, depth);
    const object = lookup(oid);
    if (!object) continue;
    if (object.type === 'tag') {
      objects.add(oid);
      const target = parseTag(object.data).object;
      stack.push({ oid: target, depth });
      continue;
    }
    if (object.type !== 'commit') {
      objects.add(oid);
      continue;
    }
    if (depthLimit !== undefined && depth >= depthLimit) continue;
    objects.add(oid);
    const parsed = parseCommit(object.data);
    visitTree(parsed.tree);
    if (stopAt.has(oid)) continue;
    if (depthLimit !== undefined && depth === depthLimit - 1) {
      if (parsed.parents.length > 0) boundary.add(oid);
      continue;
    }
    for (const parent of parsed.parents) stack.push({ oid: parent, depth: depth + 1 });
  }
  return { objects, boundary };
}

/** Flatten a tree (recursively) into path -> {oid, mode}. */
export function flattenTree(lookup: ObjectLookup, treeOid: string): Map<string, { oid: string; mode: string }> {
  const out = new Map<string, { oid: string; mode: string }>();
  const walk = (oid: string, prefix: string): void => {
    const object = lookup(oid);
    if (!object || object.type !== 'tree') return;
    for (const entry of parseTree(object.data)) {
      const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
      if (entry.mode === '40000') walk(entry.oid, path);
      else out.set(path, { oid: entry.oid, mode: entry.mode });
    }
  };
  walk(treeOid, '');
  return out;
}

/** Read one path out of a tree, or null. */
export function getPathInTree(
  lookup: ObjectLookup,
  treeOid: string | null,
  path: string,
): { oid: string; mode: string } | null {
  if (treeOid === null) return null;
  const segments = path.split('/').filter((part) => part !== '');
  let current: string | null = treeOid;
  for (let index = 0; index < segments.length; index += 1) {
    if (current === null) return null;
    const object = lookup(current);
    if (!object || object.type !== 'tree') return null;
    const entry = parseTree(object.data).find((candidate) => candidate.name === segments[index]);
    if (!entry) return null;
    if (index === segments.length - 1) return { oid: entry.oid, mode: entry.mode };
    if (entry.mode !== '40000') return null;
    current = entry.oid;
  }
  return null;
}

/** The first commit reachable from both `a` and `b` (exact for the linear histories here). */
export function mergeBase(lookup: ObjectLookup, a: string, b: string): string | null {
  const ancestorsA = new Set<string>();
  const queueA = [a];
  while (queueA.length > 0) {
    const oid = queueA.pop()!;
    if (ancestorsA.has(oid)) continue;
    const object = lookup(oid);
    if (!object || object.type !== 'commit') continue;
    ancestorsA.add(oid);
    for (const parent of parseCommit(object.data).parents) queueA.push(parent);
  }
  const queueB = [b];
  const seenB = new Set<string>();
  while (queueB.length > 0) {
    const oid = queueB.pop()!;
    if (seenB.has(oid)) continue;
    seenB.add(oid);
    if (ancestorsA.has(oid)) return oid;
    const object = lookup(oid);
    if (!object || object.type !== 'commit') continue;
    for (const parent of parseCommit(object.data).parents) queueB.push(parent);
  }
  return null;
}

/** Line multiset diff: how many lines were added / removed between two texts. */
export function lineDiff(oldText: string, newText: string): { additions: number; deletions: number } {
  const count = (text: string): Map<string, number> => {
    const map = new Map<string, number>();
    for (const line of text.split('\n')) map.set(line, (map.get(line) ?? 0) + 1);
    return map;
  };
  const oldLines = count(oldText);
  const newLines = count(newText);
  let additions = 0;
  let deletions = 0;
  for (const [line, n] of newLines) additions += Math.max(0, n - (oldLines.get(line) ?? 0));
  for (const [line, n] of oldLines) deletions += Math.max(0, n - (newLines.get(line) ?? 0));
  return { additions, deletions };
}

// ---------------------------------------------------------------------------------------------
// the store
// ---------------------------------------------------------------------------------------------

export interface Issue {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: Array<{ name: string; color: string }>;
  comments: Array<{ id: number; body: string; createdAt: string }>;
  createdAt: string;
  updatedAt: string;
}

export interface PullFile {
  filename: string;
  status: 'added' | 'removed' | 'modified';
  additions: number;
  deletions: number;
  changes: number;
}

export interface Pull {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  head: string;
  base: string;
  merged: boolean;
  mergedAt: string | null;
  mergeCommitSha: string | null;
  files: PullFile[];
  createdAt: string;
  updatedAt: string;
}

export interface Repo {
  id: number;
  owner: string;
  name: string;
  description: string;
  private: boolean;
  defaultBranch: string;
  createdAt: string;
  updatedAt: string;
  objects: Map<string, GitObject>;
  refs: Map<string, string>;
  labels: Map<string, { name: string; color: string }>;
  issues: Issue[];
  pulls: Pull[];
  nextNumber: number;
}

export function repoKey(owner: string, name: string): string {
  return `${owner}/${name}`;
}

export class Store {
  readonly repos = new Map<string, Repo>();
  private nextRepoId = 1;
  private nextCommentId = 1;
  private nextRestId = 1;

  /** A stable numeric id for REST objects (issues, pull requests). */
  restId(): number {
    const id = this.nextRestId;
    this.nextRestId += 1;
    return id;
  }

  createRepo(owner: string, name: string, input: { description?: string; private?: boolean }): Repo | null {
    const key = repoKey(owner, name);
    if (this.repos.has(key)) return null;
    const now = new Date().toISOString();
    const repo: Repo = {
      id: this.nextRepoId,
      owner,
      name,
      description: input.description ?? '',
      private: input.private ?? false,
      defaultBranch: 'main',
      createdAt: now,
      updatedAt: now,
      objects: new Map(),
      refs: new Map(),
      labels: new Map(),
      issues: [],
      pulls: [],
      nextNumber: 1,
    };
    this.nextRepoId += 1;
    this.repos.set(key, repo);
    return repo;
  }

  getRepo(owner: string, name: string): Repo | undefined {
    return this.repos.get(repoKey(owner, name));
  }

  deleteRepo(owner: string, name: string): boolean {
    return this.repos.delete(repoKey(owner, name));
  }

  listRepos(owner: string): Repo[] {
    return [...this.repos.values()].filter((repo) => repo.owner === owner);
  }

  nextComment(): number {
    const id = this.nextCommentId;
    this.nextCommentId += 1;
    return id;
  }

  // -- git object helpers bound to one repo -----------------------------------------------

  lookup(repo: Repo): ObjectLookup {
    return (oid: string) => repo.objects.get(oid);
  }

  putObject(repo: Repo, type: ObjType, data: Buffer): string {
    const oid = hashObject(type, data);
    if (!repo.objects.has(oid)) repo.objects.set(oid, { type, data });
    return oid;
  }

  /** Set one path in a tree (creating intermediate trees), returning the new root tree oid. */
  setPathInTree(repo: Repo, rootTreeOid: string | null, path: string, blobOid: string | null): string {
    const segments = path.split('/').filter((part) => part !== '');
    const build = (treeOid: string | null, index: number): string => {
      const lookup = this.lookup(repo);
      const current = treeOid === null ? [] : parseTree(lookup(treeOid)?.data ?? Buffer.alloc(0));
      const name = segments[index]!;
      const entries: TreeEntry[] = [];
      let replaced = false;
      for (const entry of current) {
        if (entry.name !== name) {
          entries.push(entry);
          continue;
        }
        replaced = true;
        if (index === segments.length - 1) {
          if (blobOid !== null) entries.push({ mode: '100644', name, oid: blobOid });
          // blobOid null on the last segment deletes the entry.
        } else {
          const child = build(entry.oid, index + 1);
          entries.push({ mode: '40000', name, oid: child });
        }
      }
      if (!replaced) {
        if (index === segments.length - 1) {
          if (blobOid !== null) entries.push({ mode: '100644', name, oid: blobOid });
        } else {
          const child = build(null, index + 1);
          entries.push({ mode: '40000', name, oid: child });
        }
      }
      return this.putObject(repo, 'tree', buildTree(entries));
    };
    return build(rootTreeOid, 0);
  }

  /** Build a tree from a flat path -> {oid, mode} map. */
  buildTreeFromPaths(repo: Repo, files: Map<string, { oid: string; mode: string }>): string {
    const buildDir = (prefix: string): string => {
      const entries: TreeEntry[] = [];
      const dirs = new Set<string>();
      for (const [path, file] of files) {
        if (prefix !== '' && !path.startsWith(`${prefix}/`)) continue;
        const rest = prefix === '' ? path : path.slice(prefix.length + 1);
        const slash = rest.indexOf('/');
        if (slash === -1) entries.push({ mode: file.mode, name: rest, oid: file.oid });
        else dirs.add(rest.slice(0, slash));
      }
      for (const dir of dirs) {
        entries.push({ mode: '40000', name: dir, oid: buildDir(prefix === '' ? dir : `${prefix}/${dir}`) });
      }
      return this.putObject(repo, 'tree', buildTree(entries));
    };
    return buildDir('');
  }

  makeCommit(
    repo: Repo,
    input: { tree: string; parents: readonly string[]; message: string; timestamp?: number },
  ): string {
    const timestamp = input.timestamp ?? Math.floor(Date.now() / 1000);
    const identity = `${VIEWER.name} <${VIEWER.email}> ${timestamp} +0000`;
    const data = buildCommit({
      tree: input.tree,
      parents: input.parents,
      author: identity,
      committer: identity,
      message: input.message,
    });
    return this.putObject(repo, 'commit', data);
  }

  /** Peel a tag object to its commit, following nested tags. */
  peelToCommit(repo: Repo, oid: string): string {
    let current = oid;
    for (let guard = 0; guard < 16; guard += 1) {
      const object = repo.objects.get(current);
      if (!object || object.type !== 'tag') return current;
      current = parseTag(object.data).object;
    }
    return current;
  }

  /** The tip oid of a branch, or null when the branch does not exist. */
  branchTip(repo: Repo, branch: string): string | null {
    return repo.refs.get(`refs/heads/${branch}`) ?? null;
  }
}
