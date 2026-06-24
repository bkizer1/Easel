/**
 * Easel — shared agent tool definitions and executors.
 *
 * Provides the typed tool schemas and executor functions used by the
 * `anthropic-api` and `local-openai` hand-built agent loops.  Each tool maps
 * to an operation on {@link ProjectFs} or {@link ImageProvider}.
 *
 * The Claude Agent SDK backend (`claudeAgentSdk.ts`) uses its own built-in
 * tools, but MAY optionally call executors here for consistent path-sandboxing.
 *
 * Tool list:
 *  - `read_file`      — read a UTF-8 file within the project
 *  - `write_file`     — write/overwrite a UTF-8 file (produces a diff event)
 *  - `apply_patch`    — apply a unified diff string to a file
 *  - `list_dir`       — list directory contents
 *  - `glob`           — glob for files matching a pattern
 *  - `grep`           — ripgrep/JS fallback content search
 *  - `replace_image`  — delegate to the active ImageProvider, write asset, return path
 */

import path from 'node:path';
import type { ProjectFs, GrepQuery } from '@shared/agent';
import type { ImageProvider, FileDiff } from '@shared/types';

/* -------------------------------------------------------------------------- */
/*  Tool schema types                                                          */
/* -------------------------------------------------------------------------- */

/** A single tool definition in the Anthropic tool-use format. */
export interface ToolDefinition {
  name: string;
  description: string;
  input_schema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
  };
}

/* -------------------------------------------------------------------------- */
/*  Tool input shapes                                                          */
/* -------------------------------------------------------------------------- */

export interface ReadFileInput {
  path: string;
}

export interface WriteFileInput {
  path: string;
  content: string;
}

export interface ApplyPatchInput {
  path: string;
  /** Unified diff text to apply (git-style hunks). */
  patch: string;
}

export interface ListDirInput {
  path: string;
}

export interface GlobInput {
  pattern: string;
}

export interface GrepInput {
  pattern: string;
  is_regex?: boolean;
  ignore_case?: boolean;
  include?: string[];
  max_results?: number;
}

export interface ReplaceImageInput {
  /** Relative path within the project to write the new image asset. */
  output_path: string;
  /** What to do: 'generate' | 'edit' | 'fetch'. */
  mode: 'generate' | 'edit' | 'fetch';
  /** Natural-language description of the desired image. */
  prompt: string;
  /** For 'edit' mode: data URL of source image. */
  source_image_data_url?: string;
  /** For 'fetch' mode: URL to retrieve. */
  source_url?: string;
  width?: number;
  height?: number;
}

/** Discriminated union of all tool inputs for safe dispatch. */
export type ToolInput =
  | { tool: 'read_file'; input: ReadFileInput }
  | { tool: 'write_file'; input: WriteFileInput }
  | { tool: 'apply_patch'; input: ApplyPatchInput }
  | { tool: 'list_dir'; input: ListDirInput }
  | { tool: 'glob'; input: GlobInput }
  | { tool: 'grep'; input: GrepInput }
  | { tool: 'replace_image'; input: ReplaceImageInput };

/** The structured result returned to the model after executing a tool. */
export interface ToolResult {
  /** Whether the tool call succeeded. */
  ok: boolean;
  /** Human-readable result string (file contents, listing, etc.). */
  output: string;
  /** When a file was modified: the computed diff. */
  diff?: FileDiff;
  /** For `replace_image`: the written relative asset path. */
  assetPath?: string;
  /** Error message when `ok` is false. */
  error?: string;
}

/* -------------------------------------------------------------------------- */
/*  Schema definitions                                                         */
/* -------------------------------------------------------------------------- */

export const TOOL_DEFINITIONS: readonly ToolDefinition[] = [
  {
    name: 'read_file',
    description:
      'Read the contents of a source file within the project. The path is relative to the project root. Use this to understand the current code before making edits.',
    input_schema: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'File path relative to the project root, e.g. "src/components/Button.tsx".',
        },
      },
      required: ['path'],
    },
  },
  {
    name: 'write_file',
    description:
      'Write (or overwrite) a UTF-8 source file within the project. The path is relative to the project root. Always read the file first unless creating a new file from scratch.',
    input_schema: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'File path relative to the project root.',
        },
        content: {
          type: 'string',
          description: 'Full UTF-8 content to write to the file.',
        },
      },
      required: ['path', 'content'],
    },
  },
  {
    name: 'apply_patch',
    description:
      'Apply a unified diff (git-style hunks) to a source file. Use this as an alternative to write_file when you only need to change a small region and want to minimise token usage. The patch must be valid unified-diff format.',
    input_schema: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'File path relative to the project root.',
        },
        patch: {
          type: 'string',
          description:
            'Unified diff text (e.g. output of `diff -u`). Lines prefixed with `+` are added, `-` removed.',
        },
      },
      required: ['path', 'patch'],
    },
  },
  {
    name: 'list_dir',
    description: 'List the files and directories immediately inside a directory in the project.',
    input_schema: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'Directory path relative to the project root. Use "." for the root.',
        },
      },
      required: ['path'],
    },
  },
  {
    name: 'glob',
    description:
      'Find files matching a glob pattern within the project, e.g. "src/**/*.tsx". Respects .gitignore. Returns paths relative to the project root.',
    input_schema: {
      type: 'object',
      properties: {
        pattern: {
          type: 'string',
          description: 'Glob pattern, e.g. "src/**/*.tsx" or "**/*.css".',
        },
      },
      required: ['pattern'],
    },
  },
  {
    name: 'grep',
    description:
      'Search the project source files for a text pattern. Uses ripgrep when available, JavaScript fallback otherwise. Returns matching file paths, line numbers, and line text.',
    input_schema: {
      type: 'object',
      properties: {
        pattern: {
          type: 'string',
          description: 'Substring or regex pattern to search for.',
        },
        is_regex: {
          type: 'boolean',
          description: 'Whether to treat pattern as a regular expression. Default: false.',
        },
        ignore_case: {
          type: 'boolean',
          description: 'Case-insensitive search. Default: false.',
        },
        include: {
          type: 'array',
          items: { type: 'string' },
          description: 'Glob patterns to restrict the search, e.g. ["src/**/*.tsx"].',
        },
        max_results: {
          type: 'number',
          description: 'Maximum number of matches to return. Default: 50.',
        },
      },
      required: ['pattern'],
    },
  },
  {
    name: 'replace_image',
    description:
      'Generate, edit, or fetch an image asset and write it to the project. After writing, rewrite the referencing source attribute (e.g. <img src>) with the returned relative path.',
    input_schema: {
      type: 'object',
      properties: {
        output_path: {
          type: 'string',
          description:
            'Relative path within the project to write the image, e.g. "public/hero.png".',
        },
        mode: {
          type: 'string',
          enum: ['generate', 'edit', 'fetch'],
          description:
            '"generate" — create from scratch; "edit" — transform source image; "fetch" — download from URL.',
        },
        prompt: {
          type: 'string',
          description: 'Natural-language description of the desired image.',
        },
        source_image_data_url: {
          type: 'string',
          description: 'For edit mode: data URL of the source image.',
        },
        source_url: {
          type: 'string',
          description: 'For fetch mode: URL to retrieve.',
        },
        width: { type: 'number', description: 'Desired output width in pixels.' },
        height: { type: 'number', description: 'Desired output height in pixels.' },
      },
      required: ['output_path', 'mode', 'prompt'],
    },
  },
] as const;

/* -------------------------------------------------------------------------- */
/*  Executor context                                                           */
/* -------------------------------------------------------------------------- */

/** Dependencies injected into each tool executor. */
export interface ToolExecutorContext {
  fs: ProjectFs;
  imageProvider: ImageProvider;
  /** A stable id for the image request (echoed back in ImageResult). */
  nextImageId: () => string;
}

/* -------------------------------------------------------------------------- */
/*  Executor                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Execute a typed tool call and return a structured result.  The caller is
 * responsible for emitting the appropriate {@link AgentEvent}s (tool-call /
 * file-edit / etc.) after calling this.
 *
 * All path inputs are relative and will be sandboxed by `ProjectFs`.
 */
export async function executeTool(
  toolInput: ToolInput,
  ctx: ToolExecutorContext,
): Promise<ToolResult> {
  switch (toolInput.tool) {
    case 'read_file':
      return _execReadFile(toolInput.input, ctx);
    case 'write_file':
      return _execWriteFile(toolInput.input, ctx);
    case 'apply_patch':
      return _execApplyPatch(toolInput.input, ctx);
    case 'list_dir':
      return _execListDir(toolInput.input, ctx);
    case 'glob':
      return _execGlob(toolInput.input, ctx);
    case 'grep':
      return _execGrep(toolInput.input, ctx);
    case 'replace_image':
      return _execReplaceImage(toolInput.input, ctx);
  }
}

/**
 * Parse a raw `unknown` tool call from the LLM into a typed {@link ToolInput}.
 * Returns null if the tool name is unknown.
 */
export function parseToolInput(toolName: string, rawInput: unknown): ToolInput | null {
  const input = rawInput as Record<string, unknown>;
  switch (toolName) {
    case 'read_file':
      return { tool: 'read_file', input: { path: String(input['path'] ?? '') } };
    case 'write_file':
      return {
        tool: 'write_file',
        input: { path: String(input['path'] ?? ''), content: String(input['content'] ?? '') },
      };
    case 'apply_patch':
      return {
        tool: 'apply_patch',
        input: { path: String(input['path'] ?? ''), patch: String(input['patch'] ?? '') },
      };
    case 'list_dir':
      return { tool: 'list_dir', input: { path: String(input['path'] ?? '.') } };
    case 'glob':
      return { tool: 'glob', input: { pattern: String(input['pattern'] ?? '**/*') } };
    case 'grep':
      return {
        tool: 'grep',
        input: {
          pattern: String(input['pattern'] ?? ''),
          is_regex: Boolean(input['is_regex']),
          ignore_case: Boolean(input['ignore_case']),
          include: Array.isArray(input['include']) ? (input['include'] as string[]) : undefined,
          max_results:
            typeof input['max_results'] === 'number' ? input['max_results'] : undefined,
        },
      };
    case 'replace_image': {
      const mode = String(input['mode'] ?? 'generate');
      return {
        tool: 'replace_image',
        input: {
          output_path: String(input['output_path'] ?? ''),
          mode: (mode === 'edit' || mode === 'fetch' ? mode : 'generate') as
            | 'generate'
            | 'edit'
            | 'fetch',
          prompt: String(input['prompt'] ?? ''),
          source_image_data_url:
            typeof input['source_image_data_url'] === 'string'
              ? input['source_image_data_url']
              : undefined,
          source_url:
            typeof input['source_url'] === 'string' ? input['source_url'] : undefined,
          width: typeof input['width'] === 'number' ? input['width'] : undefined,
          height: typeof input['height'] === 'number' ? input['height'] : undefined,
        },
      };
    }
    default:
      return null;
  }
}

/* -------------------------------------------------------------------------- */
/*  Individual executors                                                       */
/* -------------------------------------------------------------------------- */

async function _execReadFile(input: ReadFileInput, ctx: ToolExecutorContext): Promise<ToolResult> {
  try {
    const content = await ctx.fs.readFile(input.path);
    // Prefix with the path so the model always knows what it read.
    return { ok: true, output: `// ${input.path}\n${content}` };
  } catch (err) {
    return { ok: false, output: '', error: `read_file failed: ${String(err)}` };
  }
}

async function _execWriteFile(input: WriteFileInput, ctx: ToolExecutorContext): Promise<ToolResult> {
  try {
    // Compute diff BEFORE writing (diff needs the old content).
    const diff = await ctx.fs.diff(input.path, input.content);
    await ctx.fs.writeFile(input.path, input.content);
    return {
      ok: true,
      output: `Wrote ${input.path} (${diff.additions} additions, ${diff.deletions} deletions)`,
      diff,
    };
  } catch (err) {
    return { ok: false, output: '', error: `write_file failed: ${String(err)}` };
  }
}

async function _execApplyPatch(
  input: ApplyPatchInput,
  ctx: ToolExecutorContext,
): Promise<ToolResult> {
  try {
    // Apply the unified diff to the existing file content.
    let original: string;
    try {
      original = await ctx.fs.readFile(input.path);
    } catch {
      original = ''; // New file
    }

    const patched = applyUnifiedDiff(original, input.patch);
    if (patched === null) {
      return {
        ok: false,
        output: '',
        error: 'apply_patch failed: patch did not apply cleanly. Check context lines.',
      };
    }

    const diff = await ctx.fs.diff(input.path, patched);
    await ctx.fs.writeFile(input.path, patched);

    return {
      ok: true,
      output: `Applied patch to ${input.path} (${diff.additions}+, ${diff.deletions}-)`,
      diff,
    };
  } catch (err) {
    return { ok: false, output: '', error: `apply_patch failed: ${String(err)}` };
  }
}

async function _execListDir(input: ListDirInput, ctx: ToolExecutorContext): Promise<ToolResult> {
  try {
    const entries = await ctx.fs.readdir(input.path);
    return { ok: true, output: entries.join('\n') };
  } catch (err) {
    return { ok: false, output: '', error: `list_dir failed: ${String(err)}` };
  }
}

async function _execGlob(input: GlobInput, ctx: ToolExecutorContext): Promise<ToolResult> {
  try {
    const files = await ctx.fs.glob(input.pattern);
    return {
      ok: true,
      output: files.length > 0 ? files.join('\n') : '(no files matched)',
    };
  } catch (err) {
    return { ok: false, output: '', error: `glob failed: ${String(err)}` };
  }
}

async function _execGrep(input: GrepInput, ctx: ToolExecutorContext): Promise<ToolResult> {
  try {
    const query: GrepQuery = {
      pattern: input.pattern,
      isRegex: input.is_regex,
      ignoreCase: input.ignore_case,
      include: input.include,
      maxResults: input.max_results ?? 50,
    };
    const matches = await ctx.fs.grep(query);

    if (matches.length === 0) {
      return { ok: true, output: '(no matches)' };
    }

    const lines = matches.map(
      (m) => `${m.filePath}:${m.line}:${m.column}: ${m.lineText.trim()}`,
    );
    return { ok: true, output: lines.join('\n') };
  } catch (err) {
    return { ok: false, output: '', error: `grep failed: ${String(err)}` };
  }
}

async function _execReplaceImage(
  input: ReplaceImageInput,
  ctx: ToolExecutorContext,
): Promise<ToolResult> {
  try {
    // Validate output path has a sane extension.
    const ext = path.extname(input.output_path).slice(1).toLowerCase();
    const allowedExts = ['png', 'jpg', 'jpeg', 'webp', 'gif', 'avif', 'svg'];
    if (ext && !allowedExts.includes(ext)) {
      return {
        ok: false,
        output: '',
        error: `replace_image: unsupported output extension ".${ext}". Use one of: ${allowedExts.join(', ')}`,
      };
    }

    // Ask the image provider to fulfill the request.
    const result = await ctx.imageProvider.request({
      id: ctx.nextImageId(),
      mode: input.mode,
      prompt: input.prompt,
      sourceImageDataUrl: input.source_image_data_url,
      sourceUrl: input.source_url,
      width: input.width,
      height: input.height,
      format: (ext as 'png' | 'jpeg' | 'webp') || 'png',
    });

    if (!result.ok || !result.imageDataUrl) {
      return {
        ok: false,
        output: '',
        error: `replace_image: provider failed — ${result.error ?? 'unknown error'}`,
      };
    }

    // Convert data URL to binary and write via ProjectFs.
    const dataUrl = result.imageDataUrl;
    const base64Match = dataUrl.match(/^data:[^;]+;base64,(.+)$/);
    if (!base64Match || !base64Match[1]) {
      return { ok: false, output: '', error: 'replace_image: provider returned invalid data URL' };
    }

    const bytes = Buffer.from(base64Match[1], 'base64');
    const outputPath = input.output_path || `public/easel-image-${ctx.nextImageId()}.${result.extension ?? 'png'}`;

    await ctx.fs.writeBinary(outputPath, bytes);

    return {
      ok: true,
      output: `Image written to ${outputPath}`,
      assetPath: outputPath,
    };
  } catch (err) {
    return { ok: false, output: '', error: `replace_image failed: ${String(err)}` };
  }
}

/* -------------------------------------------------------------------------- */
/*  Minimal unified-diff applicator                                            */
/* -------------------------------------------------------------------------- */

/**
 * Apply a unified diff string to `original`, returning the patched content.
 * Returns null if the patch cannot be applied cleanly.
 *
 * Supports standard unified diff format:
 *   @@ -startA,countA +startB,countB @@
 *   -removed lines
 *   +added lines
 *    context lines
 *
 * This is intentionally minimal — it handles the common cases the LLM
 * generates.  For production-grade patching, `diff` npm package can be added.
 */
export function applyUnifiedDiff(original: string, patch: string): string | null {
  const originalLines = original.split('\n');
  const patchLines = patch.split('\n');

  // Build a list of hunks from the patch.
  interface Hunk {
    origStart: number; // 1-based
    origCount: number;
    newLines: string[];
    removeCount: number;
  }

  const hunks: Hunk[] = [];
  let i = 0;

  // Skip file header lines (--- / +++ / diff --git etc.)
  while (i < patchLines.length && !patchLines[i].startsWith('@@')) i++;

  while (i < patchLines.length) {
    const headerLine = patchLines[i];
    const hunkMatch = headerLine.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/);
    if (!hunkMatch) {
      i++;
      continue;
    }

    const origStart = parseInt(hunkMatch[1], 10);
    const origCount = parseInt(hunkMatch[2] ?? '1', 10);
    i++;

    const newLines: string[] = [];
    let removeCount = 0;

    while (i < patchLines.length && !patchLines[i].startsWith('@@')) {
      const line = patchLines[i];
      if (line.startsWith('+')) {
        newLines.push(line.slice(1));
      } else if (line.startsWith('-')) {
        removeCount++;
      } else if (line.startsWith(' ')) {
        // Context line — kept in output.
        newLines.push(line.slice(1));
      } else if (line === '\\ No newline at end of file') {
        // Ignore this meta line.
      }
      i++;
    }

    hunks.push({ origStart, origCount, newLines, removeCount });
  }

  if (hunks.length === 0) {
    // No hunks found — return original unchanged.
    return original;
  }

  // Apply hunks from bottom to top to avoid offset issues.
  const result = [...originalLines];
  for (const hunk of [...hunks].reverse()) {
    const startIdx = hunk.origStart - 1; // Convert to 0-based
    const deleteCount = hunk.origCount;

    // Validate that the hunk region exists.
    if (startIdx < 0 || startIdx > result.length) {
      return null;
    }

    result.splice(startIdx, deleteCount, ...hunk.newLines);
  }

  return result.join('\n');
}
