// github-core-clone-01 entry: git smart HTTP (upload-pack v2/v0, receive-pack v0, ls-refs).
// Written from scratch for this bounty. Node 22 standard library only.

import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  ZERO_OID,
  collectReachable,
  hashObject,
  isOid,
  parseCommit,
  parseTag,
  parseTree,
  readPack,
  writePack,
  type GitObject,
  type ObjType,
  type Repo,
  type Store,
} from './store.ts';

// ---------------------------------------------------------------------------------------------
// pkt-line framing
// ---------------------------------------------------------------------------------------------

export function pktLine(data: string | Buffer): Buffer {
  const payload = typeof data === 'string' ? Buffer.from(data, 'utf8') : data;
  const header = Buffer.allocUnsafe(4);
  header.write((payload.length + 4).toString(16).padStart(4, '0'), 0, 4, 'ascii');
  return Buffer.concat([header, payload]);
}

export const pktFlush = (): Buffer => Buffer.from('0000', 'ascii');
export const pktDelim = (): Buffer => Buffer.from('0001', 'ascii');

export type Packet = { kind: 'data' | 'flush' | 'delim' | 'response-end'; payload: Buffer };

/** Decode a whole buffer of pkt-lines into packets. Throws on a malformed line. */
export function decodePktLines(buffer: Buffer): Packet[] {
  const packets: Packet[] = [];
  let offset = 0;
  while (offset < buffer.length) {
    if (offset + 4 > buffer.length) throw new Error('truncated pkt-line length');
    const text = buffer.subarray(offset, offset + 4).toString('ascii');
    if (text === '0000') { packets.push({ kind: 'flush', payload: Buffer.alloc(0) }); offset += 4; continue; }
    if (text === '0001') { packets.push({ kind: 'delim', payload: Buffer.alloc(0) }); offset += 4; continue; }
    if (text === '0002') { packets.push({ kind: 'response-end', payload: Buffer.alloc(0) }); offset += 4; continue; }
    const length = parseInt(text, 16);
    if (!Number.isFinite(length) || length < 4 || offset + length > buffer.length) {
      throw new Error(`malformed pkt-line length ${JSON.stringify(text)}`);
    }
    packets.push({ kind: 'data', payload: buffer.subarray(offset + 4, offset + length) });
    offset += length;
  }
  return packets;
}

/**
 * Split a receive-pack body at its first flush pkt-line: the command lines before it and the
 * raw pack bytes after it. Only the prefix is pkt-line framed; the pack is raw, so the scan
 * stops at the flush and never tries to decode the pack as pkt-lines.
 */
export function splitAtFlush(buffer: Buffer): { lines: string[]; rest: Buffer } {
  const lines: string[] = [];
  let offset = 0;
  while (offset + 4 <= buffer.length) {
    const text = buffer.subarray(offset, offset + 4).toString('ascii');
    if (text === '0000') {
      return { lines, rest: buffer.subarray(offset + 4) };
    }
    const length = parseInt(text, 16);
    if (!Number.isFinite(length) || length < 4 || offset + length > buffer.length) {
      throw new Error(`malformed pkt-line length ${JSON.stringify(text)}`);
    }
    lines.push(buffer.subarray(offset + 4, offset + length).toString('utf8'));
    offset += length;
  }
  throw new Error('receive-pack body has no flush after the command list');
}

/** Frame a pack's bytes as side-band-64k band-1 pkt-lines (each at most 65520 bytes total). */
export function sidebandPack(pack: Buffer): Buffer {
  const parts: Buffer[] = [];
  const CHUNK = 65500;
  for (let offset = 0; offset < pack.length; offset += CHUNK) {
    const slice = pack.subarray(offset, Math.min(pack.length, offset + CHUNK));
    parts.push(pktLine(Buffer.concat([Buffer.from([1]), slice])));
  }
  if (pack.length === 0) parts.push(pktLine(Buffer.from([1])));
  return Buffer.concat(parts);
}

// ---------------------------------------------------------------------------------------------
// advertisement
// ---------------------------------------------------------------------------------------------

const UPLOAD_V2_CAPS = [
  'fetch=shallow filter',
  'ls-refs=unborn',
  'object-format=sha1',
  'agent=github-core-clone/1.0',
];

const UPLOAD_V0_CAPS = 'symref=HEAD:refs/heads/main side-band-64k shallow thin-pack ofs-delta multi_ack';
const RECEIVE_V0_CAPS = 'report-status side-band-64k delete-refs ofs-delta';

function sortedRefs(repo: Repo): Array<{ name: string; oid: string }> {
  return [...repo.refs.entries()]
    .map(([name, oid]) => ({ name, oid }))
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

/** The oid HEAD resolves to, or ZERO when the repo has no refs yet. */
function headOid(repo: Repo): string {
  return repo.refs.get(`refs/heads/${repo.defaultBranch}`) ?? ZERO_OID;
}

function advertisementV2(service: string): Buffer {
  const parts: Buffer[] = [pktLine(`# service=${service}\n`), pktFlush(), pktLine('version 2\n')];
  for (const cap of UPLOAD_V2_CAPS) parts.push(pktLine(`${cap}\n`));
  parts.push(pktFlush());
  return Buffer.concat(parts);
}

function advertisementV0(repo: Repo, service: string, caps: string): Buffer {
  const refs = sortedRefs(repo);
  const parts: Buffer[] = [pktLine(`# service=${service}\n`), pktFlush()];
  const head = headOid(repo);
  const firstLine = `${head} HEAD\0${caps}\n`;
  if (refs.length === 0) {
    parts.push(pktLine(`${ZERO_OID} capabilities^{}\0${caps}\n`));
  } else {
    parts.push(pktLine(firstLine));
    for (const ref of refs) {
      parts.push(pktLine(`${ref.oid} ${ref.name}\n`));
      const object = repo.objects.get(ref.oid);
      if (object && object.type === 'tag') {
        const peeled = repo.objects.get(parseTag(object.data).object);
        if (peeled) {
          const target = parseTag(object.data).object;
          parts.push(pktLine(`${target} ${ref.name}^{}\n`));
        }
      }
    }
  }
  parts.push(pktFlush());
  return Buffer.concat(parts);
}

// ---------------------------------------------------------------------------------------------
// ls-refs (v2)
// ---------------------------------------------------------------------------------------------

interface LsRef {
  oid: string;
  name: string;
  symrefTarget?: string;
  peeled?: string;
  unborn?: boolean;
}

function lsRefs(repo: Repo, args: { peel: boolean; symrefs: boolean; unborn: boolean; prefixes: string[] }): LsRef[] {
  const refs: LsRef[] = [];
  const keep = (name: string): boolean =>
    args.prefixes.length === 0 || args.prefixes.some((prefix) => name.startsWith(prefix));
  const head = headOid(repo);
  // HEAD is a ref like any other for prefix filtering: it is included exactly when a prefix
  // matches it (a clone asks for ref-prefix HEAD, refs/heads/ and refs/tags/ together, and
  // expects the HEAD line back; a refs/heads/-only query must not see it).
  if (keep('HEAD')) {
    if (head === ZERO_OID) {
      if (args.unborn) refs.push({ oid: ZERO_OID, name: 'HEAD', symrefTarget: `refs/heads/${repo.defaultBranch}`, unborn: true });
    } else {
      const entry: LsRef = { oid: head, name: 'HEAD' };
      if (args.symrefs) entry.symrefTarget = `refs/heads/${repo.defaultBranch}`;
      refs.push(entry);
    }
  }
  for (const ref of sortedRefs(repo)) {
    if (!keep(ref.name)) continue;
    const entry: LsRef = { oid: ref.oid, name: ref.name };
    if (args.peel) {
      const object = repo.objects.get(ref.oid);
      if (object && object.type === 'tag') entry.peeled = peelToCommitOid(repo, ref.oid);
    }
    refs.push(entry);
  }
  return refs;
}

function peelToCommitOid(repo: Repo, oid: string): string {
  let current = oid;
  for (let guard = 0; guard < 16; guard += 1) {
    const object = repo.objects.get(current);
    if (!object || object.type !== 'tag') return current;
    current = parseTag(object.data).object;
  }
  return current;
}

// ---------------------------------------------------------------------------------------------
// fetch: the send set
// ---------------------------------------------------------------------------------------------

interface FetchPlan {
  /** Objects to send, in pack order. */
  objects: GitObject[];
  /** New shallow boundaries to report (depth-limited fetches). */
  shallow: string[];
  /** Old boundaries that are no longer shallow. */
  unshallow: string[];
  /** Ref tips that match a want, for the wanted-refs section. */
  wantedRefs: Array<{ oid: string; ref: string }>;
}

function planFetch(
  repo: Repo,
  wants: string[],
  haves: string[],
  shallowBoundaries: string[],
  depth: number | null,
): FetchPlan {
  const lookup = (oid: string): GitObject | undefined => repo.objects.get(oid);
  const shallowSet = new Set(shallowBoundaries);
  const wantClosure = collectReachable(lookup, wants, {
    depthLimit: depth ?? undefined,
    stopAt: new Set<string>(),
  });
  const haveClosure = collectReachable(lookup, haves, { stopAt: shallowSet });
  const send = new Set<string>();
  for (const oid of wantClosure.objects) if (!haveClosure.objects.has(oid)) send.add(oid);
  const objects: GitObject[] = [];
  for (const oid of [...send].sort()) {
    const object = repo.objects.get(oid);
    if (object) objects.push(object);
  }
  // Shallow bookkeeping.
  const shallow: string[] = [];
  const unshallow: string[] = [];
  if (depth !== null) {
    for (const oid of [...wantClosure.boundary].sort()) shallow.push(oid);
    const heldAfter = new Set([...haveClosure.objects, ...send]);
    for (const boundaryOid of shallowBoundaries) {
      const object = repo.objects.get(boundaryOid);
      if (!object || object.type !== 'commit') continue;
      const parents = parseCommit(object.data).parents;
      if (parents.length > 0 && parents.every((parent) => heldAfter.has(parent))) unshallow.push(boundaryOid);
    }
  }
  const wantedRefs: Array<{ oid: string; ref: string }> = [];
  const wantSet = new Set(wants);
  for (const ref of sortedRefs(repo)) {
    if (wantSet.has(ref.oid)) wantedRefs.push({ oid: ref.oid, ref: ref.name });
  }
  return { objects, shallow, unshallow, wantedRefs };
}

/** The pack bytes for a fetch plan (an empty pack when nothing is sent). */
function packFor(objects: GitObject[]): Buffer {
  return writePack(objects);
}

// ---------------------------------------------------------------------------------------------
// v2 fetch response
// ---------------------------------------------------------------------------------------------

function v2FetchResponse(repo: Repo, plan: FetchPlan, haves: string[]): Buffer {
  const parts: Buffer[] = [];
  // The acknowledgments section exists only when the client sent have lines: a fresh clone
  // sends none, and real git dies if it sees the section when it expected the packfile.
  if (haves.length > 0) {
    const acks: string[] = [];
    for (const have of haves) {
      if (repo.objects.has(have)) acks.push(have);
    }
    parts.push(pktLine('acknowledgments\n'));
    if (acks.length > 0) {
      for (const ack of acks) parts.push(pktLine(`ACK ${ack}\n`));
      parts.push(pktLine('ready\n'));
    } else {
      parts.push(pktLine('NAK\n'));
    }
    parts.push(pktDelim());
  }
  if (plan.shallow.length > 0 || plan.unshallow.length > 0) {
    parts.push(pktLine('shallow-info\n'));
    for (const oid of plan.shallow) parts.push(pktLine(`shallow ${oid}\n`));
    for (const oid of plan.unshallow) parts.push(pktLine(`unshallow ${oid}\n`));
    parts.push(pktDelim());
  }
  // No wanted-refs section: neither the suite's client nor real git asks for it, and real git
  // dies on a section it did not expect.
  parts.push(pktLine('packfile\n'));
  parts.push(sidebandPack(packFor(plan.objects)));
  parts.push(pktFlush());
  return Buffer.concat(parts);
}

// ---------------------------------------------------------------------------------------------
// v0 fetch response: NAK/ACK/shallow lines unframed, then sideband packets
// ---------------------------------------------------------------------------------------------

function v0FetchResponse(repo: Repo, plan: FetchPlan, haves: string[]): Buffer {
  const parts: Buffer[] = [];
  const acks: string[] = [];
  for (const have of haves) {
    if (repo.objects.has(have)) acks.push(have);
  }
  if (acks.length > 0) {
    for (const ack of acks) parts.push(pktLine(`ACK ${ack}\n`));
  } else {
    parts.push(pktLine('NAK\n'));
  }
  for (const oid of plan.shallow) parts.push(pktLine(`shallow ${oid}\n`));
  for (const oid of plan.unshallow) parts.push(pktLine(`unshallow ${oid}\n`));
  parts.push(sidebandPack(packFor(plan.objects)));
  parts.push(pktFlush());
  return Buffer.concat(parts);
}

// ---------------------------------------------------------------------------------------------
// receive-pack
// ---------------------------------------------------------------------------------------------

interface PushCommand {
  oldOid: string;
  newOid: string;
  ref: string;
}

/** Parse a receive-pack request body into commands and a pack. */
function parseReceivePack(body: Buffer): { commands: PushCommand[]; pack: Buffer | null } {
  const { lines, rest } = splitAtFlush(body);
  const commands: PushCommand[] = [];
  for (const line of lines) {
    const text = line.replace(/\n$/, '');
    if (text === '') continue;
    const nul = text.indexOf('\0');
    const head = nul === -1 ? text : text.slice(0, nul);
    const parts = head.split(' ');
    if (parts.length < 3) throw new Error(`bad push command ${JSON.stringify(text.slice(0, 60))}`);
    commands.push({ oldOid: parts[0], newOid: parts[1], ref: parts.slice(2).join(' ') });
  }
  return { commands, pack: rest.length > 0 ? rest : null };
}

/** Is `newOid` a descendant of `oldOid` (or is the update a create)? */
function isFastForward(repo: Repo, oldOid: string, newOid: string): boolean {
  if (oldOid === ZERO_OID) return true;
  if (newOid === ZERO_OID) return true; // a delete: the old-oid match is checked by the caller
  if (oldOid === newOid) return true;
  const lookup = (oid: string): GitObject | undefined => repo.objects.get(oid);
  const { objects } = collectReachable(lookup, [newOid]);
  return objects.has(oldOid);
}

function handleReceivePack(store: Store, repo: Repo, body: Buffer): Buffer {
  const { commands, pack } = parseReceivePack(body);
  if (commands.length === 0) throw new Error('push needs at least one command');
  // Unpack first: store every object the pack carries (validating hashes and deltas).
  if (pack !== null) {
    const read = readPack(pack, (oid) => repo.objects.get(oid));
    for (const [oid, object] of read.objects) {
      if (!repo.objects.has(oid)) repo.objects.set(oid, object);
    }
  }
  const reportLines: string[] = ['unpack ok\n'];
  for (const command of commands) {
    const current = repo.refs.get(command.ref);
    let ok = true;
    let reason = '';
    if (command.newOid !== ZERO_OID && !repo.objects.has(command.newOid)) {
      ok = false;
      reason = 'missing object';
    } else if (command.oldOid === ZERO_OID) {
      if (current !== undefined) {
        ok = false;
        reason = 'already exists';
      }
    } else if (command.newOid === ZERO_OID) {
      // Delete: the old oid must match the current tip.
      if (current === undefined || current !== command.oldOid) {
        ok = false;
        reason = 'non-fast-forward';
      }
    } else if (current === undefined) {
      // Updating a ref that does not exist with a non-zero old oid.
      ok = false;
      reason = 'non-fast-forward';
    } else if (current !== command.oldOid) {
      ok = false;
      reason = 'non-fast-forward';
    } else if (!isFastForward(repo, command.oldOid, command.newOid)) {
      ok = false;
      reason = 'non-fast-forward';
    }
    if (ok) {
      if (command.newOid === ZERO_OID) repo.refs.delete(command.ref);
      else repo.refs.set(command.ref, command.newOid);
      reportLines.push(`ok ${command.ref}\n`);
    } else {
      reportLines.push(`ng ${command.ref} ${reason}\n`);
    }
  }
  const inner = Buffer.concat([...reportLines.map((line) => pktLine(line)), pktFlush()]);
  // The report travels inside band 1, chunked so no outer pkt-line exceeds the 64k frame.
  const outerParts: Buffer[] = [];
  const CHUNK = 65500;
  for (let offset = 0; offset < inner.length; offset += CHUNK) {
    const slice = inner.subarray(offset, Math.min(inner.length, offset + CHUNK));
    outerParts.push(pktLine(Buffer.concat([Buffer.from([1]), slice])));
  }
  outerParts.push(pktFlush());
  return Buffer.concat(outerParts);
}

// ---------------------------------------------------------------------------------------------
// upload-pack: v2 command dispatch and v0 fetch
// ---------------------------------------------------------------------------------------------

function parseV2Request(body: Buffer): { command: string; args: string[] } {
  const packets = decodePktLines(body);
  const lines: string[] = [];
  let sawDelim = false;
  for (const packet of packets) {
    if (packet.kind === 'flush') break;
    if (packet.kind === 'delim') { sawDelim = true; continue; }
    if (packet.kind === 'data') lines.push(packet.payload.toString('utf8'));
  }
  void sawDelim;
  const command = (lines[0] ?? '').replace(/\n$/, '');
  return { command, args: lines.slice(1) };
}

function handleUploadPackV2(store: Store, repo: Repo, body: Buffer): Buffer {
  const { command, args } = parseV2Request(body);
  if (command === 'command=ls-refs') {
    let peel = false;
    let symrefs = false;
    let unborn = false;
    const prefixes: string[] = [];
    for (const raw of args) {
      const line = raw.replace(/\n$/, '');
      if (line === 'peel') peel = true;
      else if (line === 'symrefs') symrefs = true;
      else if (line === 'unborn') unborn = true;
      else if (line.startsWith('ref-prefix ')) prefixes.push(line.slice('ref-prefix '.length));
    }
    const refs = lsRefs(repo, { peel, symrefs, unborn, prefixes });
    const parts: Buffer[] = [];
    for (const ref of refs) {
      let line: string;
      if (ref.unborn === true) {
        line = `unborn ${ref.name}${ref.symrefTarget ? ` symref-target:${ref.symrefTarget}` : ''}\n`;
      } else {
        line = `${ref.oid} ${ref.name}`;
        if (ref.symrefTarget) line += ` symref-target:${ref.symrefTarget}`;
        if (ref.peeled) line += ` peeled:${ref.peeled}`;
        line += '\n';
      }
      parts.push(pktLine(line));
    }
    parts.push(pktFlush());
    return Buffer.concat(parts);
  }
  if (command === 'command=fetch') {
    const wants: string[] = [];
    const haves: string[] = [];
    const shallow: string[] = [];
    let depth: number | null = null;
    for (const raw of args) {
      const line = raw.replace(/\n$/, '');
      if (line.startsWith('want ')) wants.push(line.slice(5).trim());
      else if (line.startsWith('have ')) haves.push(line.slice(5).trim());
      else if (line.startsWith('shallow ')) shallow.push(line.slice(8).trim());
      else if (line.startsWith('deepen ')) {
        const n = parseInt(line.slice(7).trim(), 10);
        if (Number.isFinite(n)) depth = n;
      }
    }
    for (const want of wants) {
      if (!isOid(want) || !repo.objects.has(want)) {
        // Unknown want: answer a sideband error so the client fails loudly, not silently.
        // The acknowledgments section is only sent when the client sent have lines.
        const parts: Buffer[] = [];
        if (haves.length > 0) {
          parts.push(pktLine('acknowledgments\n'), pktLine('NAK\n'), pktDelim());
        }
        parts.push(pktLine('packfile\n'));
        parts.push(pktLine(Buffer.concat([Buffer.from([3]), Buffer.from(`object not found: ${want}\n`, 'utf8')])));
        parts.push(pktFlush());
        return Buffer.concat(parts);
      }
    }
    const plan = planFetch(repo, wants, haves, shallow, depth);
    return v2FetchResponse(repo, plan, haves);
  }
  throw new Error(`unsupported v2 command ${JSON.stringify(command)}`);
}

function handleUploadPackV0(store: Store, repo: Repo, body: Buffer): Buffer {
  // Two sections: wants (+shallow/deepen), flush, haves + done, flush.
  const packets = decodePktLines(body);
  const wants: string[] = [];
  const haves: string[] = [];
  const shallow: string[] = [];
  let depth: number | null = null;
  let section = 0;
  for (const packet of packets) {
    if (packet.kind === 'flush') { section += 1; continue; }
    if (packet.kind !== 'data') continue;
    const line = packet.payload.toString('utf8').replace(/\n$/, '');
    if (section === 0) {
      if (line.startsWith('want ')) wants.push(line.slice(5).split(' ')[0]);
      else if (line.startsWith('shallow ')) shallow.push(line.slice(8).trim());
      else if (line.startsWith('deepen ')) {
        const n = parseInt(line.slice(7).trim(), 10);
        if (Number.isFinite(n)) depth = n;
      }
    } else {
      if (line.startsWith('have ')) haves.push(line.slice(5).trim());
    }
  }
  const plan = planFetch(repo, wants, haves, shallow, depth);
  return v0FetchResponse(repo, plan, haves);
}

// ---------------------------------------------------------------------------------------------
// entry points used by the HTTP router
// ---------------------------------------------------------------------------------------------

export interface GitRequest {
  owner: string;
  repoName: string;
  service: 'git-upload-pack' | 'git-receive-pack';
  isInfoRefs: boolean;
  v2: boolean;
  body: Buffer;
}

export function gitAdvertisement(repo: Repo, service: 'git-upload-pack' | 'git-receive-pack', v2: boolean): { body: Buffer; contentType: string } {
  if (v2 && service === 'git-upload-pack') {
    return { body: advertisementV2(service), contentType: 'application/x-git-upload-pack-advertisement' };
  }
  if (service === 'git-upload-pack') {
    return { body: advertisementV0(repo, service, UPLOAD_V0_CAPS), contentType: 'application/x-git-upload-pack-advertisement' };
  }
  return { body: advertisementV0(repo, service, RECEIVE_V0_CAPS), contentType: 'application/x-git-receive-pack-advertisement' };
}

export function gitPost(store: Store, repo: Repo, request: GitRequest): { body: Buffer; contentType: string } {
  if (request.service === 'git-receive-pack') {
    return { body: handleReceivePack(store, repo, request.body), contentType: 'application/x-git-receive-pack-result' };
  }
  if (request.v2) {
    return { body: handleUploadPackV2(store, repo, request.body), contentType: 'application/x-git-upload-pack-result' };
  }
  return { body: handleUploadPackV0(store, repo, request.body), contentType: 'application/x-git-upload-pack-result' };
}

export { hashObject };
export type { ObjType };
