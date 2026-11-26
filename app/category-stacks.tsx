import { Image as Photo } from "lucide-react";
import type { CSSProperties } from "react";
import { categories } from "../lib/categories";

type StackItem = { id: string; category: string; preview: boolean };
export default function CategoryStacks({
  items,
  selected,
  select,
}: {
  items: StackItem[];
  selected: string;
  select: (category: string) => void;
}) {
  const stacks = new Map<string, { count: number; covers: string[] }>();
  for (const item of items) {
    const stack = stacks.get(item.category) ?? { count: 0, covers: [] };
    stack.count++;
    if (item.preview && stack.covers.length < 3) stack.covers.push(item.id);
    stacks.set(item.category, stack);
  }
  if (!stacks.size) return null;
  return (
    <section className="stack-shelf" aria-label="Browse category stacks">
      {categories.map((category) => {
        const stack = stacks.get(category);
        if (!stack) return null;
        return (
          <button
            key={category}
            className="category-stack"
            aria-pressed={selected === category}
            onClick={() =>
              select(selected === category ? "All categories" : category)
            }
          >
            <span className="stack-covers" aria-hidden="true">
              {stack.covers.length ? (
                stack.covers.map((id, i) => (
                  <img
                    key={id}
                    src={"/api/thumb/" + id}
                    loading="lazy"
                    alt=""
                    style={
                      {
                        "--layer": i - (stack.covers.length - 1) / 2,
                        animationDelay: i * 65 + "ms",
                      } as CSSProperties
                    }
                  />
                ))
              ) : (
                <Photo />
              )}
            </span>
            <strong>{category}</strong>
            <small>
              {stack.count} {stack.count === 1 ? "item" : "items"}
            </small>
          </button>
        );
      })}
    </section>
  );
}
