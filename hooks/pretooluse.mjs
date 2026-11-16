#!/usr/bin/env node
// The PreToolUse hook: refuses a tool call that breaks a rule of hooks/rules.json for the phase.
//
//   node hooks/pretooluse.mjs <hook config>      (written by hooks/install.mjs; Claude Code runs it)
//
// Reads the hook input on stdin. A refusal is printed as the documented PreToolUse JSON
// (permissionDecision "deny", with a reason that names the rule) and logged; anything else
// prints nothing, so the normal permission flow goes on. Any error refuses too: a fence that
// fails open is not a fence.

import { readFileSync } from 'node:fs';
import { decide, loadRules, readJson, appendLog } from './lib.mjs';

function respond(result) {
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: result.reason,
      },
    }),
  );
}

let config = null;
let input = {};
try {
  const configPath = process.argv[2];
  if (!configPath) throw new Error('no hook config path given');
  config = readJson(configPath, null);
  if (!config) throw new Error(`cannot read the hook config ${configPath}`);
  input = JSON.parse(readFileSync(0, 'utf8') || '{}');
  const rules = loadRules(config.rules_path);
  const result = decide(input, config, rules);
  if (result.decision === 'deny') {
    appendLog(config, {
      event: 'deny',
      phase: config.phase,
      rule: result.rule,
      tool: input.tool_name,
      input: input.tool_input,
      reason: result.reason,
    });
    respond(result);
  }
  process.exit(0);
} catch (err) {
  const result = { rule: 'hook-error', reason: `CrankHarness denied [hook-error]: the PreToolUse hook failed, so it refuses (${err.message})` };
  appendLog(config, { event: 'deny', rule: 'hook-error', tool: input.tool_name, reason: result.reason });
  respond(result);
  process.exit(0);
}
