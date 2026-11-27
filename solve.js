// Fast drop-in for makefun-diff 1.0.0 (make.fun's own line diff), written for
// diff-speed-01-run-20261126. It returns, for { old, new }, exactly the patch
// makefun-diff 1.0.0 returns, but computes it with an optimised Myers search:
//
//   - Lines are cut after every "\n" (a "\r" is part of its line); a last line
//     with no "\n" is a line too. Two lines are equal only when they are the
//     same code units, newline or its absence included.
//   - The common prefix of lines is kept, then the common suffix of the lines
//     left. Between them, Myers's greedy search from the first lines keeps, on
//     each diagonal, the path reaching furthest into the old text, and when a
//     deletion and an insertion reach the same point it keeps the deletion's
//     (jsdiff keeps the insertion's). No move past either text's end is a
//     candidate, no edge diagonal is pruned, and every run of lines equal in
//     both is followed as far as it goes. The first path to reach both ends
//     is the script.
//   - The patch is "makefun-diff/1 old=N new=M hunks=H deleted=D inserted=I",
//     then per hunk "@ os ol ns nl" and one line per line it covers ("=" kept,
//     "-" deleted, "+" inserted; deletions before insertions in a run; up to 3
//     kept lines before and after each run; runs at most 6 kept lines apart
//     share a hunk). A line ending its text with no newline is written with
//     one and followed by a line "%". Identical texts are the first line alone.
//
// Speed, in the order it matters for 20k-40k-line texts with ~1-2k changed
// lines (the search cost grows with the square of the edits):
//   - Lines are interned once per case into small integer ids (one Map), so
//     every comparison inside the search is an integer comparison, never a
//     string comparison, and the prefix/suffix trims are integer scans. The
//     raw pieces from splitting on "\n" are interned as they are, with no
//     "\n" glued back on: every line but possibly a text's last ends in "\n",
//     and a last line without one is interned in a second, tiny map, so it
//     can never share an id with the same content ending in "\n".
//   - The search runs on flat Int32Arrays: one V array holding the furthest
//     reach per diagonal (in place, one array for all depths, diagonals of
//     the previous depth still readable because they have the other parity),
//     and one flat history array holding every depth's V slice, so the path
//     is rebuilt by walking the snapshots backwards instead of by keeping a
//     linked list of path objects per (depth, diagonal).
//   - No object is allocated inside the search loop at all.

const KEEP = 0;
const DELETE = 1;
const INSERT = 2;

/** V of depth d on diagonal k from the flat history, or -1 when that diagonal holds no path at that depth. */
function snap(hist, d, k) {
  if (k < -d || k > d) return -1;
  return hist[d * d + (k + d)];
}

/**
 * The edit script of the middle region a[a0..a1) into b[b0..b1), as runs
 * [kind, count] in order (kind 0 keep, 1 delete, 2 insert). The middle region
 * is what is left after the common prefix and suffix were trimmed, so it
 * starts and ends with a difference (or is empty on one or both sides).
 */
function myersRuns(a, b, a0, a1, b0, b1) {
  const N = a1 - a0;
  const M = b1 - b0;
  if (N === 0) return M === 0 ? [] : [[INSERT, M]];
  if (M === 0) return [[DELETE, N]];

  // Views of the middle region, so the search indexes from 0.
  const ai = a.subarray(a0, a1);
  const bi = b.subarray(b0, b1);

  const maxD = N + M;
  const off = maxD + 1;
  // V, one array for all depths: depth d writes diagonals of d's parity only,
  // so a read of k - 1 / k + 1 still sees depth d - 1. -1 means "no path".
  const v = new Int32Array(2 * maxD + 3).fill(-1);
  // History: depth d's V slice (diagonals -d..d) starts at d*d, length 2d+1.
  let histCap = 1 << 23;
  let hist = new Int32Array(histCap);

  // Depth 0: the snake from the first lines.
  let x = 0;
  let y = 0;
  while (x < N && y < M && ai[x] === bi[y]) { x++; y++; }
  v[off] = x;
  hist[0] = x;
  if (x >= N && y >= M) return []; // the whole middle is kept (unreachable after trimming, kept for safety)

  let D = -1;
  let kEnd = 0;
  outer: for (let d = 1; d <= maxD; d++) {
    const need = (d + 1) * (d + 1);
    if (need > histCap) {
      const nh = new Int32Array(histCap * 2);
      nh.set(hist);
      hist = nh;
      histCap *= 2;
    }
    const base = d * d;
    let vi = off - d;
    for (let k = -d; k <= d; k += 2, vi += 2) {
      const xm1 = v[vi - 1];
      const xp1 = v[vi + 1];
      // Deletion: one old line past the (d-1)-path on k-1, only when such a
      // line exists. Insertion: one new line past the (d-1)-path on k+1,
      // only when such a line exists. The deletion wins ties.
      const xDel = xm1 >= 0 && xm1 < N ? xm1 + 1 : -2;
      const xIns = xp1 >= 0 && xp1 - k - 1 < M ? xp1 : -2;
      if (xDel === -2 && xIns === -2) { v[vi] = -1; continue; }
      let xx = xDel >= xIns ? xDel : xIns;
      let yy = xx - k;
      while (xx < N && yy < M && ai[xx] === bi[yy]) { xx++; yy++; }
      v[vi] = xx;
      if (xx >= N && yy >= M) { D = d; kEnd = k; break outer; }
    }
    hist.set(v.subarray(off - d, off + d + 1), base);
  }

  // Walk the snapshots backwards from (N, M), rebuilding the script in
  // reverse: the snake back to the pre-snake point is keeps, then the one
  // edit that depth d added.
  const rr = [];
  const pushRev = (kind, count) => {
    const last = rr[rr.length - 1];
    if (last !== undefined && last[0] === kind) last[1] += count;
    else rr.push([kind, count]);
  };
  let k = kEnd;
  x = N;
  y = M;
  for (let d = D; d >= 1; d--) {
    const xm1 = snap(hist, d - 1, k - 1);
    const xp1 = snap(hist, d - 1, k + 1);
    const xDel = xm1 >= 0 && xm1 < N ? xm1 + 1 : -2;
    const xIns = xp1 >= 0 && xp1 - k - 1 < M ? xp1 : -2;
    let xPre;
    let yPre;
    let kind;
    if (xDel >= xIns) {
      kind = DELETE;
      xPre = xDel;
      yPre = xDel - k;
    } else {
      kind = INSERT;
      xPre = xIns;
      yPre = xIns - k;
    }
    const keeps = x - xPre;
    if (keeps > 0) pushRev(KEEP, keeps);
    pushRev(kind, 1);
    if (kind === DELETE) {
      x = xm1;
      y = xm1 - (k - 1);
      k = k - 1;
    } else {
      x = xp1;
      y = xp1 - (k + 1);
      k = k + 1;
    }
  }
  if (x > 0) pushRev(KEEP, x); // depth 0's snake, from the first lines
  rr.reverse();
  return rr;
}

/** makefun-diff 1.0.0's answer for one case's input: its patch of { old, new }, as one string. */
export function run(input) {
  if (input === null || typeof input !== 'object' || typeof input.old !== 'string' || typeof input.new !== 'string') {
    throw new TypeError('makefun-diff: the input is { old, new }, two strings');
  }
  // Split on "\n": pieces [0..last-1] are the lines ending in "\n", and the
  // last piece is the final line without one, when the text does not end in
  // one (an empty last piece means no such line).
  const aParts = input.old.split('\n');
  const bParts = input.new.split('\n');
  const aLast = aParts.length - 1;
  const bLast = bParts.length - 1;
  const aBare = aParts[aLast] !== '';
  const bBare = bParts[bLast] !== '';
  const n = aLast + (aBare ? 1 : 0);
  const m = bLast + (bBare ? 1 : 0);

  // Intern every distinct line once, so the search compares integers. The
  // bare last lines go in their own map, so a bare line never shares an id
  // with the same content ending in "\n".
  const ids = new Map();
  const bareIds = new Map();
  const a = new Int32Array(n);
  const b = new Int32Array(m);
  let nextId = 0;
  for (let i = 0; i < aLast; i++) {
    const s = aParts[i];
    let id = ids.get(s);
    if (id === undefined) { id = nextId++; ids.set(s, id); }
    a[i] = id;
  }
  if (aBare) {
    const s = aParts[aLast];
    let id = bareIds.get(s);
    if (id === undefined) { id = nextId++; bareIds.set(s, id); }
    a[aLast] = id;
  }
  for (let i = 0; i < bLast; i++) {
    const s = bParts[i];
    let id = ids.get(s);
    if (id === undefined) { id = nextId++; ids.set(s, id); }
    b[i] = id;
  }
  if (bBare) {
    const s = bParts[bLast];
    let id = bareIds.get(s);
    if (id === undefined) { id = nextId++; bareIds.set(s, id); }
    b[bLast] = id;
  }

  // The common prefix, then the common suffix of what is left.
  let prefix = 0;
  while (prefix < n && prefix < m && a[prefix] === b[prefix]) prefix++;
  let suffix = 0;
  while (suffix < n - prefix && suffix < m - prefix && a[n - 1 - suffix] === b[m - 1 - suffix]) suffix++;

  const runs = [];
  if (prefix > 0) runs.push([KEEP, prefix]);
  runs.push(...myersRuns(a, b, prefix, n - suffix, prefix, m - suffix));
  if (suffix > 0) runs.push([KEEP, suffix]);

  // The change runs: each a stretch of deletions and insertions between two kept lines, at old line o and new line p.
  const changes = [];
  let o = 0;
  let p = 0;
  let deleted = 0;
  let inserted = 0;
  for (const [kind, count] of runs) {
    if (kind === KEEP) {
      o += count;
      p += count;
      continue;
    }
    let c = changes[changes.length - 1];
    if (c === undefined || c.o + c.dels !== o || c.p + c.ins !== p) {
      c = { o, p, dels: 0, ins: 0 };
      changes.push(c);
    }
    if (kind === DELETE) {
      c.dels += count;
      o += count;
      deleted += count;
    } else {
      c.ins += count;
      p += count;
      inserted += count;
    }
  }

  // The hunks: change runs at most 2 * 3 kept lines apart share one.
  const hunks = [];
  for (const c of changes) {
    const h = hunks[hunks.length - 1];
    const prev = h !== undefined ? h[h.length - 1] : undefined;
    if (prev !== undefined && c.o - (prev.o + prev.dels) <= 6) h.push(c);
    else hunks.push([c]);
  }

  // A line as the patch writes it: its op, the line, a newline, and "%" on a
  // line of its own when it had none. Only a text's last line can lack one.
  const wOld = (op, i) => i < aLast ? op + aParts[i] + '\n' : op + aParts[i] + '\n%\n';
  const wNew = (op, j) => j < bLast ? op + bParts[j] + '\n' : op + bParts[j] + '\n%\n';

  const out = [`makefun-diff/1 old=${n} new=${m} hunks=${hunks.length} deleted=${deleted} inserted=${inserted}\n`];
  for (const h of hunks) {
    const first = h[0];
    const last = h[h.length - 1];
    const oldStart = Math.max(0, first.o - 3);
    const newStart = first.p - (first.o - oldStart);
    const after = Math.min(3, n - (last.o + last.dels));
    const oldEnd = last.o + last.dels + after;
    const newEnd = last.p + last.ins + after;
    out.push(`@ ${oldStart + 1} ${oldEnd - oldStart} ${newStart + 1} ${newEnd - newStart}\n`);
    let at = oldStart;
    for (const c of h) {
      for (; at < c.o; at++) out.push(wOld('=', at));
      for (let i = 0; i < c.dels; i++) out.push(wOld('-', c.o + i));
      for (let i = 0; i < c.ins; i++) out.push(wNew('+', c.p + i));
      at = c.o + c.dels;
    }
    for (; at < oldEnd; at++) out.push(wOld('=', at));
  }
  return out.join('');
}
