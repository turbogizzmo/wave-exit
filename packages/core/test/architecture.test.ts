import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

/** The layers stay pure: readers don't know the model, nothing knows a UI or Node. */
const SRC = join(import.meta.dirname, "..", "src");
const files = (dir: string): string[] =>
  readdirSync(dir).flatMap((f) => (statSync(join(dir, f)).isDirectory() ? files(join(dir, f)) : f.endsWith(".ts") ? [join(dir, f)] : []));
const imports = (f: string) => [...readFileSync(f, "utf8").matchAll(/from\s+"([^"]+)"/g)].map((m) => m[1]!);

describe("layering", () => {
  it("readers never import the model", () => {
    for (const f of files(join(SRC, "readers"))) {
      expect(imports(f).filter((i) => i.includes("/model/")), relative(SRC, f)).toEqual([]);
    }
  });

  it("model imports readers only for their types", () => {
    for (const f of files(join(SRC, "model"))) {
      const text = readFileSync(f, "utf8");
      const valueImports = [...text.matchAll(/import\s+(?!type)\{([^}]*)\}\s+from\s+"([^"]*readers[^"]*)"/g)]
        .filter((m) => m[1]!.split(",").some((n) => n.trim() && !n.trim().startsWith("type ")));
      expect(valueImports.map((m) => m[2]), relative(SRC, f)).toEqual([]);
    }
  });

  it("readers and the model never import outputs", () => {
    for (const f of [...files(join(SRC, "readers")), ...files(join(SRC, "model"))]) {
      expect(imports(f).filter((i) => i.includes("outputs/")), relative(SRC, f)).toEqual([]);
    }
  });

  it("readers, the model and file outputs never import direct-load targets", () => {
    for (const f of [...files(join(SRC, "readers")), ...files(join(SRC, "model")), ...files(join(SRC, "outputs"))]) {
      expect(imports(f).filter((i) => i.includes("targets/")), relative(SRC, f)).toEqual([]);
    }
  });

  it("no UI, Node or file-system dependencies in the library", () => {
    for (const f of files(SRC)) {
      expect(imports(f).filter((i) => /^(node:|fs$|path$|react|electron|@tauri)/.test(i)), relative(SRC, f)).toEqual([]);
    }
  });
});
