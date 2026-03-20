/**
 * Trae Agent CLI subprocess runner for skill E2E testing.
 *
 * Spawns `trae-cli run` as an independent process, parses its output,
 * and returns structured results. Follows the same pattern as
 * gemini-session-runner.ts but adapted for the Trae Agent CLI.
 *
 * Key differences from Gemini session-runner:
 * - Uses `trae-cli run` instead of `gemini -p`
 * - Trae Agent CLI outputs plain text (not NDJSON)
 * - Skills are discovered from `~/.trae/skills/` or `.trae/skills/` in cwd
 * - Trae Agent supports multiple LLM providers (openai, anthropic, google)
 */

import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';

// --- Interfaces ---

export interface TraeResult {
  output: string;           // Full assistant output text
  toolCalls: string[];      // Tool invocations (from trajectory file if available)
  exitCode: number;         // Process exit code
  durationMs: number;       // Wall clock time
  rawOutput: string;        // Raw stdout for debugging
}

// --- Skill installation helper ---

/**
 * Install gstack Trae skills into a temporary home directory for testing.
 *
 * Creates ~/.trae/skills/ symlinks pointing to the generated .trae/skills/
 * directory, without modifying the real user's home.
 */
export function installSkillToTempHome(opts: {
  tempHome: string;
  gstackRoot: string;
}): void {
  const { tempHome, gstackRoot } = opts;
  const traeSkillsDir = path.join(tempHome, '.trae', 'skills');
  fs.mkdirSync(traeSkillsDir, { recursive: true });

  const generatedDir = path.join(gstackRoot, '.trae', 'skills');
  if (!fs.existsSync(generatedDir)) {
    throw new Error(
      `No .trae/skills/ directory found in ${gstackRoot}. ` +
      `Run 'bun run gen:skill-docs --host trae' first.`
    );
  }

  // Symlink all generated Trae skills into the temp home
  for (const entry of fs.readdirSync(generatedDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const src = path.join(generatedDir, entry.name);
    const dst = path.join(traeSkillsDir, entry.name);
    if (!fs.existsSync(dst)) {
      fs.symlinkSync(src, dst);
    }
  }

  // Symlink gstack root for runtime assets (bin/, browse/)
  const gstackDst = path.join(traeSkillsDir, 'gstack');
  if (!fs.existsSync(gstackDst)) {
    fs.symlinkSync(gstackRoot, gstackDst);
  }
}

// --- Main runner ---

/**
 * Run a prompt via `trae-cli run` and return structured results.
 *
 * Spawns trae-cli with a task prompt, captures output,
 * and returns a TraeResult. Skips gracefully if trae-cli binary is not found.
 */
export async function runTraeSkill(opts: {
  prompt: string;           // What to ask Trae
  timeoutMs?: number;       // Default 300000 (5 min)
  cwd?: string;             // Working directory (where .trae/skills/ lives)
  env?: Record<string, string>; // Additional environment variables
}): Promise<TraeResult> {
  const {
    prompt,
    timeoutMs = 300_000,
    cwd,
    env,
  } = opts;

  const startTime = Date.now();

  // Check if trae-cli binary exists
  const whichResult = Bun.spawnSync(['which', 'trae-cli']);
  const traeCliBin = whichResult.exitCode === 0 ? 'trae-cli' : null;

  // Also try `trae` as an alternative binary name
  const whichTrae = Bun.spawnSync(['which', 'trae']);
  const traeBin = whichTrae.exitCode === 0 ? 'trae' : null;

  const bin = traeCliBin || traeBin;

  if (!bin) {
    return {
      output: 'SKIP: trae-cli binary not found',
      toolCalls: [],
      exitCode: -1,
      durationMs: Date.now() - startTime,
      rawOutput: '',
    };
  }

  // Create a temporary trajectory file for tool call tracking
  const trajectoryFile = `/tmp/trae-trajectory-${Date.now()}.json`;

  // Build trae-cli command
  // trae-cli run "<prompt>" [--trajectory-file <path>]
  const args = ['run', prompt, '--trajectory-file', trajectoryFile];

  // Spawn trae-cli — uses cwd for skill discovery
  const proc = Bun.spawn([bin, ...args], {
    cwd: cwd || process.cwd(),
    stdout: 'pipe',
    stderr: 'pipe',
    env: {
      ...process.env,
      ...env,
    },
  });

  // Race against timeout
  let timedOut = false;
  const timeoutId = setTimeout(() => {
    timedOut = true;
    proc.kill();
  }, timeoutMs);

  // Collect stdout
  const outputChunks: string[] = [];
  const stderrPromise = new Response(proc.stderr).text();

  const reader = proc.stdout.getReader();
  const decoder = new TextDecoder();

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = decoder.decode(value, { stream: true });
      outputChunks.push(chunk);

      // Real-time progress to stderr
      const elapsed = Math.round((Date.now() - startTime) / 1000);
      const preview = chunk.replace(/\n/g, ' ').slice(0, 100);
      if (preview.trim()) {
        process.stderr.write(`  [trae ${elapsed}s] ${preview}\n`);
      }
    }
  } catch { /* stream read error — fall through to exit code handling */ }

  const stderr = await stderrPromise;
  const exitCode = await proc.exited;
  clearTimeout(timeoutId);

  const durationMs = Date.now() - startTime;
  const rawOutput = outputChunks.join('');

  // Extract tool calls from trajectory file if it exists
  const toolCalls: string[] = [];
  try {
    if (fs.existsSync(trajectoryFile)) {
      const trajectory = JSON.parse(fs.readFileSync(trajectoryFile, 'utf-8'));
      // Trajectory format varies by trae-cli version; extract tool names defensively
      if (Array.isArray(trajectory)) {
        for (const entry of trajectory) {
          const toolName = entry?.tool_name || entry?.tool || entry?.action;
          if (toolName && typeof toolName === 'string') {
            toolCalls.push(toolName);
          }
        }
      }
      fs.unlinkSync(trajectoryFile);
    }
  } catch { /* trajectory parsing is best-effort */ }

  // Log stderr if non-empty (may contain auth errors, etc.)
  if (stderr.trim()) {
    process.stderr.write(`  [trae stderr] ${stderr.trim().slice(0, 200)}\n`);
  }

  return {
    output: rawOutput,
    toolCalls,
    exitCode: timedOut ? 124 : exitCode,
    durationMs,
    rawOutput,
  };
}
