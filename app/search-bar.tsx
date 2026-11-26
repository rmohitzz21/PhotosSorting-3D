"use client";
import { Search } from "lucide-react";
import { categories } from "../lib/categories";

export default function SearchBar({
  query,
  setQuery,
  category,
  setCategory,
}: {
  query: string;
  setQuery: (query: string) => void;
  category: string;
  setCategory: (category: string) => void;
}) {
  return (
    <div className="filters">
      <label>
        <Search />
        <input
          aria-label="Search library"
          placeholder="Search photos, receipts, places…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
      </label>
      <select
        aria-label="Filter by category"
        value={category}
        onChange={(e) => setCategory(e.target.value)}
      >
        {["All categories", ...categories].map((c) => (
          <option key={c}>{c}</option>
        ))}
      </select>
    </div>
  );
}
