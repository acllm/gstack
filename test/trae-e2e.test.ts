/**
 * Trae Agent CLI E2E tests — verify skills work when invoked by Trae.
 *
 * Spawns `trae-cli run` with skills installed in a temp HOME, captures
 * output, and validates structured results. Follows the same pattern as
 * gemini-e2e.test.ts and codex-e2e.test.ts but adapted for Trae Agent CLI.
 *
 * Prerequisites:
 * - `trae-cli` (or `trae`) binary installed (pip install trae-agent)
 * - Trae authenticated via environment variables (e.g. ANTHROPIC_API_KEY or OPENAI_API_KEY)
 * - EVALS=1 env var set (same gate as Claude E2E tests)
 * - .trae/skills/ directory present (run 'bun run gen:skill-docs --host trae' first)
 *
 * Skips gracefully when prerequisites are not met.
 */

import { describe, test, expect, afterAll } from 'bun:test';
import { runTraeSkill } from './helpers/trae-session-runner';
import type { TraeResult } from './helpers/trae-session-runner';
import { EvalCollector } from './helpers/eval-store';
import { selectTests, detectBaseBranch, getChangedFiles, GLOBAL_TOUCHFILES } from './helpers/touchfiles';
import * as path from 'path';
import * as fs from 'fs';

const ROOT = path.resolve(import.meta.dir, '..');

// --- Prerequisites check ---

const TRAE_AVAILABLE = (() => {
  try {
    const resultCli = Bun.spawnSync(['which', 'trae-cli']);
    if (resultCli.exitCode === 0) return true;
    const resultTrae = Bun.spawnSync(['which', 'trae']);
    return resultTrae.exitCode === 0;
  } catch { return false; }
})();

const TRAE_SKILLS_GENERATED = fs.existsSync(path.join(ROOT, '.trae', 'skills'));

const evalsEnabled = !!process.env.EVALS;

// Skip all tests if trae is not available, skills not generated, or EVALS is not set.
const SKIP = !TRAE_AVAILABLE || !evalsEnabled || !TRAE_SKILLS_GENERATED;

const describeTrae = SKIP ? describe.skip : describe;

// Log why we're skipping (helpful for debugging CI)
if (!evalsEnabled) {
  // Silent — same as other E2E tests, EVALS=1 required
} else if (!TRAE_AVAILABLE) {
  process.stderr.write('\nTrae E2E: SKIPPED — trae-cli binary not found (install: pip install trae-agent)\n');
} else if (!TRAE_SKILLS_GENERATED) {
  process.stderr.write('\nTrae E2E: SKIPPED — .trae/skills/ not found (run: bun run gen:skill-docs --host trae)\n');
}

// --- Diff-based test selection ---

// Trae E2E touchfiles — keyed by test name, same pattern as Gemini E2E
const TRAE_E2E_TOUCHFILES: Record<string, string[]> = {
  'trae-discover-skill':    ['.trae/skills/**', 'test/helpers/trae-session-runner.ts'],
  'trae-review-findings':   ['review/**', '.trae/skills/gstack-review/**', 'test/helpers/trae-session-runner.ts'],
};

let selectedTests: string[] | null = null; // null = run all

if (evalsEnabled && !process.env.EVALS_ALL) {
  const baseBranch = process.env.EVALS_BASE
    || detectBaseBranch(ROOT)
    || 'main';
  const changedFiles = getChangedFiles(baseBranch, ROOT);

  if (changedFiles.length > 0) {
    const selection = selectTests(changedFiles, TRAE_E2E_TOUCHFILES, GLOBAL_TOUCHFILES);
    selectedTests = selection.selected;
    process.stderr.write(`\nTrae E2E selection (${selection.reason}): ${selection.selected.length}/${Object.keys(TRAE_E2E_TOUCHFILES).length} tests\n`);
    if (selection.skipped.length > 0) {
      process.stderr.write(`  Skipped: ${selection.skipped.join(', ')}\n`);
    }
    process.stderr.write('\n');
  }
  // If changedFiles is empty (e.g., on main branch), selectedTests stays null -> run all
}

/** Skip an individual test if not selected by diff-based selection. */
function testIfSelected(testName: string, fn: () => Promise<void>, timeout: number) {
  const shouldRun = selectedTests === null || selectedTests.includes(testName);
  (shouldRun ? test : test.skip)(testName, fn, timeout);
}

// --- Eval result collector ---

const evalCollector = evalsEnabled && !SKIP ? new EvalCollector('e2e-trae') : null;

/** DRY helper to record a Trae E2E test result into the eval collector. */
function recordTraeE2E(name: string, result: TraeResult, passed: boolean) {
  evalCollector?.addTest({
    name,
    suite: 'trae-e2e',
    tier: 'e2e',
    passed,
    duration_ms: result.durationMs,
    cost_usd: 0, // Trae Agent doesn't report cost directly
    output: result.output?.slice(0, 2000),
    turns_used: result.toolCalls.length,
  });
}

// --- Tests ---

describeTrae('Trae Agent CLI E2E', () => {
  afterAll(async () => {
    await evalCollector?.flush();
  });

  testIfSelected('trae-discover-skill', async () => {
    const result = await runTraeSkill({
      prompt: 'List the available gstack skills in .trae/skills/ directory. Just name them.',
      cwd: ROOT,
      timeoutMs: 120_000,
    });

    const passed = result.exitCode === 0 || result.exitCode === -1; // -1 = SKIP (binary not found)
    recordTraeE2E('trae-discover-skill', result, passed);

    if (result.output === 'SKIP: trae-cli binary not found') {
      return; // Graceful skip
    }

    // Trae should be able to list files in .trae/skills/
    expect(result.exitCode).toBe(0);
    expect(result.output.toLowerCase()).toMatch(/gstack|skill|review/i);
  }, 120_000);

  testIfSelected('trae-review-findings', async () => {
    const result = await runTraeSkill({
      prompt: 'Read the file .trae/skills/gstack-review/SKILL.md and summarize the first paragraph in one sentence.',
      cwd: ROOT,
      timeoutMs: 180_000,
    });

    const passed = result.exitCode === 0 || result.exitCode === -1;
    recordTraeE2E('trae-review-findings', result, passed);

    if (result.output === 'SKIP: trae-cli binary not found') {
      return; // Graceful skip
    }

    expect(result.exitCode).toBe(0);
    // The output should mention review or pre-landing or PR
    expect(result.output.toLowerCase()).toMatch(/review|pr|pull request|diff|landing/i);
  }, 180_000);
});
