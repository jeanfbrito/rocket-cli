import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const SKILLS_DIR = join(ROOT, 'skills');
const MCP_TOOLS_DIR = join(ROOT, 'src', 'mcp', 'tools');
const MCP_SERVER = join(ROOT, 'src', 'mcp', 'server.ts');

// ---------------------------------------------------------------------------
// Minimal frontmatter parser (no external deps)
// Handles:
//   - plain scalars:        key: value here
//   - single-quoted scalars: key: 'value with ''escaped'' quotes'
// ---------------------------------------------------------------------------

interface Frontmatter {
  raw: string;         // the raw block between the two --- lines
  fields: Record<string, string>;
}

function parseFrontmatter(content: string): Frontmatter | null {
  const lines = content.split('\n');
  if (lines[0]?.trim() !== '---') return null;

  const closeIdx = lines.findIndex((l, i) => i > 0 && l.trim() === '---');
  if (closeIdx === -1) return null;

  const block = lines.slice(1, closeIdx);
  const raw = block.join('\n');
  const fields: Record<string, string> = {};

  for (const line of block) {
    // top-level key: <value>
    const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*):\s*(.*)/);
    if (!m) continue;
    const key = m[1]!;
    const rest = m[2]!;

    if (rest.startsWith("'")) {
      // single-quoted scalar — strip surrounding quotes and unescape '' → '
      const inner = rest.slice(1, rest.lastIndexOf("'"));
      fields[key] = inner.replace(/''/g, "'");
    } else {
      fields[key] = rest;
    }
  }

  return { raw, fields };
}

// ---------------------------------------------------------------------------
// Collect registered tool names from source at runtime (self-healing)
// ---------------------------------------------------------------------------

function collectRegisteredTools(): Set<string> {
  const tools = new Set<string>();

  // Collect from every .ts file in src/mcp/tools/
  let toolFiles: string[] = [];
  try {
    toolFiles = readdirSync(MCP_TOOLS_DIR)
      .filter((f) => f.endsWith('.ts'))
      .map((f) => join(MCP_TOOLS_DIR, f));
  } catch {
    // directory missing — will surface as empty set, assertions catch it
  }

  // Also include server.ts
  const filesToScan = [...toolFiles, MCP_SERVER];

  for (const file of filesToScan) {
    let src: string;
    try {
      src = readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    // Match: .registerTool(\n?  'tool_name'
    for (const m of src.matchAll(/\.registerTool\(\s*\n?\s*'([^']+)'/g)) {
      tools.add(m[1]!);
    }
  }

  return tools;
}

// ---------------------------------------------------------------------------
// Collect skill files
// ---------------------------------------------------------------------------

interface SkillFile {
  dir: string;      // directory name, e.g. "rocket-send"
  path: string;     // absolute path to SKILL.md
  content: string;
  frontmatter: Frontmatter | null;
  body: string;     // content after the closing ---
}

function collectSkills(): SkillFile[] {
  const dirs = readdirSync(SKILLS_DIR, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name);

  return dirs.map((dir) => {
    const path = join(SKILLS_DIR, dir, 'SKILL.md');
    const content = readFileSync(path, 'utf8');
    const frontmatter = parseFrontmatter(content);

    // body = everything after the second ---
    const secondDash = content.indexOf('\n---\n', content.indexOf('---') + 3);
    const body = secondDash !== -1 ? content.slice(secondDash + 5) : '';

    return { dir, path, content, frontmatter, body };
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('skills', () => {
  const skills = collectSkills();
  const registeredTools = collectRegisteredTools();

  // Sanity: we found skills and tools
  it('discovers at least one skill', () => {
    expect(skills.length).toBeGreaterThan(0);
  });

  it('discovers at least one registered MCP tool', () => {
    expect(registeredTools.size).toBeGreaterThan(0);
  });

  for (const skill of skills) {
    describe(`skill: ${skill.dir}`, () => {
      it('has a frontmatter block', () => {
        expect(skill.frontmatter).not.toBeNull();
      });

      it('name field is present and matches directory name', () => {
        expect(skill.frontmatter?.fields['name']).toBe(skill.dir);
      });

      it('description field is present and at least 100 chars (truncation canary)', () => {
        const desc = skill.frontmatter?.fields['description'] ?? '';
        expect(desc.length).toBeGreaterThanOrEqual(100);
      });

      it('description plain scalar does not contain " #" (YAML comment truncation hazard)', () => {
        if (!skill.frontmatter) return;
        // Find the raw frontmatter line for `description:`
        const rawLine = skill.frontmatter.raw
          .split('\n')
          .find((l) => l.match(/^description:\s*/));
        if (!rawLine) return;

        const valueStart = rawLine.indexOf(':') + 1;
        const rawValue = rawLine.slice(valueStart).trimStart();

        // If quoted (starts with ' or "), the YAML parser handles it — no risk
        const isQuoted = rawValue.startsWith("'") || rawValue.startsWith('"');
        if (!isQuoted) {
          expect(rawValue).not.toMatch(/ #/);
        }
      });

      it('body is non-empty and contains at least one ## section', () => {
        expect(skill.body.trim().length).toBeGreaterThan(0);
        expect(skill.body).toMatch(/^## /m);
      });

      it('all snake_case tool tokens in body exist in the registered tool list', () => {
        // Extract snake_case tokens that look like MCP tool names
        const candidates = skill.body.match(
          /\b(?:get|list|send|add|upload|download|search|sync|open)_[a-z_]+\b/g,
        );
        if (!candidates) return;

        const unique = [...new Set(candidates)];
        for (const token of unique) {
          expect(registeredTools, `Tool "${token}" referenced in ${skill.dir}/SKILL.md is not registered`).toContain(token);
        }
      });
    });
  }
});
