/** Minimal line diff (LCS) for showing what an install would change. */
export function lineDiff(before: string, after: string, context = 2): string {
  const a = before.split("\n");
  const b = after.split("\n");
  const n = a.length;
  const m = b.length;
  const lcs: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--)
    for (let j = m - 1; j >= 0; j--) lcs[i]![j] = a[i] === b[j] ? lcs[i + 1]![j + 1]! + 1 : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!);

  const ops: Array<{ t: " " | "-" | "+"; line: string }> = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      ops.push({ t: " ", line: a[i]! });
      i++;
      j++;
    } else if (lcs[i + 1]![j]! >= lcs[i]![j + 1]!) ops.push({ t: "-", line: a[i++]! });
    else ops.push({ t: "+", line: b[j++]! });
  }
  while (i < n) ops.push({ t: "-", line: a[i++]! });
  while (j < m) ops.push({ t: "+", line: b[j++]! });

  const keep = ops.map((op, k) => op.t !== " " || ops.slice(Math.max(0, k - context), k + context + 1).some((o) => o.t !== " "));
  const out: string[] = [];
  ops.forEach((op, k) => {
    if (keep[k]) out.push(`${op.t} ${op.line}`);
    else if (keep[k - 1]) out.push("  …");
  });
  return out.length ? out.join("\n") : "(no differences)";
}
