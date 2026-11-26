export const categories = [
  "Other photos",
  "Receipts",
  "Documents",
  "Screenshots",
  "People",
  "Places",
  "Videos",
] as const;

export type CategoryRow = {
  owner: string;
  key: string;
  kind: string;
  label: string;
  emoji: string;
  rule: string;
  sort_order: number;
};

const EMOJI: Record<string, string> = {
  "Other photos": "🖼️",
  Receipts: "🧾",
  Documents: "📄",
  Screenshots: "📱",
  People: "🧑",
  Places: "🗺️",
  Videos: "🎬",
};

const RULES: Record<string, string> = {
  "Other photos": "Any photo that does not clearly belong in another category.",
  Receipts: "Receipts, invoices, bills and proofs of purchase.",
  Documents: "Letters, forms, contracts, tickets, IDs and whiteboards.",
  Screenshots: "Screenshots and screen recordings of apps or websites.",
  People: "Photos where a person is the subject.",
  Places: "Landscapes, buildings, streets and travel scenery.",
  Videos: "Any video, whatever its subject.",
};

const key = (label: string) => label.toLowerCase().replace(/[^a-z0-9]+/g, "-");

/** The rows a new user's `categories` table starts with. */
export function seedRows(owner: string): CategoryRow[] {
  return categories.map((label, i) => ({
    owner,
    key: key(label),
    kind: label === "Videos" ? "video" : "photo",
    label,
    emoji: EMOJI[label] ?? "",
    rule: RULES[label] ?? "",
    sort_order: i,
  }));
}

export function safeCategory(kind: string, category: string) {
  const valid =
    categories.some((c) => c === category) &&
    (kind === "video") === (category === "Videos");
  return {
    category: valid ? category : kind === "video" ? "Videos" : "Other photos",
    review: !valid,
  };
}
