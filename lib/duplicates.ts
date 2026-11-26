export type Fingerprint = {
  id: string;
  filename: string;
  kind: string;
  bytes: number | string | null;
  hash: string | null;
  phash: string | null;
  pixels: string | null;
  screenshot: boolean;
};
export function duplicateGroups(rows: Fingerprint[]) {
  const groups: Fingerprint[][] = [];
  for (const row of [...rows].sort(
    (a, b) =>
      Number(b.bytes) - Number(a.bytes) ||
      a.filename.length - b.filename.length ||
      a.id.localeCompare(b.id),
  )) {
    if (!row.hash && !row.phash) continue;
    const group = groups.find(([best]) => {
      if (best.kind !== row.kind) return false;
      if (best.hash && best.hash === row.hash) return true;
      if (!best.phash || !row.phash || row.kind === "video") return false;
      let bits = BigInt("0x" + best.phash) ^ BigInt("0x" + row.phash),
        distance = 0;
      while (bits) {
        bits &= bits - 1n;
        if (++distance > 4) return false;
      }
      if (best.screenshot || row.screenshot) {
        if (!row.pixels || !best.pixels) return false;
        const a = Buffer.from(row.pixels, "base64"),
          b = Buffer.from(best.pixels, "base64");
        let changed = 0;
        for (let i = 0; i < a.length; i++)
          if (Math.abs(a[i] - b[i]) > 8) changed++;
        return changed / a.length <= 0.004;
      }
      return true;
    });
    if (group) group.push(row);
    else groups.push([row]);
  }
  return groups.filter((g) => g.length > 1);
}
