#!/usr/bin/env node
'use strict';
// Bounded diagnostic, not a repair or a final-document acceptance gate.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');

const MAX_OUTPUT = 64 * 1024;
const STEP_TIMEOUT_MS = 10_000;
const MAX_SAMPLE_BYTES = 1024 * 1024;
const digest = bytes => crypto.createHash('sha256').update(bytes).digest('hex');

function cappedOutput(value) {
  const bytes = Buffer.from(String(value ?? ''), 'utf8');
  let end = Math.min(bytes.length, MAX_OUTPUT);
  // Do not split a UTF-8 character, which could expand into a replacement byte sequence.
  if (end < bytes.length) while (end > 0 && (bytes[end] & 0xc0) === 0x80) end--;
  return bytes.subarray(0, end).toString('utf8');
}

function runCommand(binary, args, options) {
  const start = Date.now();
  const result = spawnSync(binary, args, {
    ...options, shell: false, windowsHide: true, encoding: 'utf8',
    timeout: options.timeout ?? STEP_TIMEOUT_MS, killSignal: 'SIGKILL', maxBuffer: MAX_OUTPUT,
  });
  return {
    exitCode: result.status ?? null, signal: result.signal ?? null,
    error: result.error ? { code: result.error.code ?? null, message: result.error.message } : null,
    timedOut: result.error?.code === 'ETIMEDOUT',
    stdout: cappedOutput(result.stdout),
    stderr: cappedOutput(result.stderr), durationMs: Date.now() - start,
  };
}

function inspectSample(file) {
  const info = fs.lstatSync(file);
  if (!info.isFile() || info.size < 4 || info.size > MAX_SAMPLE_BYTES) throw new Error('Expected a nonempty regular XLSX sample of at most 1 MiB');
  const bytes = fs.readFileSync(file);
  if (!bytes.subarray(0, 4).equals(Buffer.from([0x50, 0x4b, 0x03, 0x04]))) throw new Error('Sample is not an OOXML ZIP file');
  return { path: file, size: info.size, sha256: digest(bytes), mtime: info.mtime.toISOString() };
}

function probeOfficeCliWrite({ workspace, binary, env = process.env }, run = runCommand) {
  // Do not search PATH, copy binaries, redirect TEMP, retry, or accept user documents.
  if (!workspace || !path.isAbsolute(workspace)) throw new Error('An absolute existing task workspace is required');
  const taskRoot = fs.realpathSync(workspace);
  if (!fs.statSync(taskRoot).isDirectory()) throw new Error('Task workspace must be a directory');
  const root = fs.mkdtempSync(path.join(taskRoot, '.officecli-probe-'));
  const reportPath = path.join(root, 'report.json');
  const file = path.join(root, 'probe.xlsx');
  const report = {
    schemaVersion: 1, status: 'failed', startedAt: new Date().toISOString(),
    platform: process.platform, arch: process.arch, workspace: taskRoot,
    binary: { requestedPath: binary ?? null }, reportPath, fixturePath: file,
    limits: { maxCommands: 5, timeoutPerCommandMs: STEP_TIMEOUT_MS, maxOutputPerStream: MAX_OUTPUT },
    scope: 'One new XLSX in this directory, using the configured binary and inherited temporary-directory settings.',
    unverified: ['Original denied path and cause', 'Other formats, paths and concurrent tasks', 'Final document content, formulas, pagination and visual layout'],
    steps: [],
  };
  let stage = 'binary';
  try {
    if (!binary || !path.isAbsolute(binary)) throw new Error('MYBUDDY_OFFICECLI must name the absolute configured bundled executable; PATH fallback is disabled');
    const selected = fs.realpathSync(binary);
    if (!fs.statSync(selected).isFile()) throw new Error('Configured OfficeCLI is not a regular file');
    report.binary.path = selected;
    report.binary.sha256 = digest(fs.readFileSync(selected));
    const marker = `officecli-probe-${crypto.randomUUID()}`;
    const childEnv = { ...env, OFFICECLI_NO_AUTO_RESIDENT: '1', OFFICECLI_SKIP_UPDATE: '1' };
    const commands = [
      ['version', ['--version']],
      ['create', ['create', file, '--json']],
      ['write', ['set', file, '/Sheet1/A1', '--prop', `value=${marker}`, '--json']],
      ['readback', ['view', file, 'text', '--range', 'Sheet1!A1:A1']],
      ['validate', ['validate', file, '--json']],
    ];
    let originalHash;
    for (const [name, args] of commands) {
      stage = name;
      const result = run(selected, args, { cwd: root, env: childEnv });
      report.steps.push({ name, args, ...result });
      if (result.error || result.signal || result.exitCode !== 0 || result.timedOut) throw new Error(`OfficeCLI ${name} did not finish successfully; see exact process evidence`);
      if (['create', 'write', 'validate'].includes(name)) {
        let envelope;
        try { envelope = JSON.parse(result.stdout); } catch { throw new Error(`OfficeCLI ${name} returned invalid JSON`); }
        if (envelope?.success !== true) throw new Error(`OfficeCLI ${name} did not report success in its JSON result`);
      }
      if (name === 'version') {
        if (!result.stdout.trim()) throw new Error('OfficeCLI version output is empty');
        report.binary.version = result.stdout.trim();
      }
      if (name === 'create') originalHash = inspectSample(file).sha256;
      if (name === 'write') {
        report.fixture = inspectSample(file);
        if (report.fixture.sha256 === originalHash) throw new Error('Write returned success without changing the on-disk sample');
      }
      if (name === 'readback' && !result.stdout.split(/[\t\r\n]/).some(cell => cell === `A1=${marker}`)) throw new Error('Fresh-process readback did not return the expected A1 value');
    }
    report.fixture = inspectSample(file);
    report.status = 'passed';
  } catch (error) {
    report.failure = { stage, message: error instanceof Error ? error.message : String(error) };
  }
  report.finishedAt = new Date().toISOString();
  // Only a newly allocated directory is written; existing evidence is never replaced.
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
  return report;
}

if (require.main === module) {
  try {
    if (process.argv.length !== 3) throw new Error('Usage: node probe-write.cjs ABSOLUTE_TASK_WORKSPACE (uses MYBUDDY_OFFICECLI)');
    const report = probeOfficeCliWrite({ workspace: process.argv[2], binary: process.env.MYBUDDY_OFFICECLI });
    console.log(JSON.stringify(report, null, 2));
    process.exitCode = report.status === 'passed' ? 0 : 1;
  } catch (error) {
    console.error(JSON.stringify({ status: 'failed', error: error.message, reportSaved: false }));
    process.exitCode = 1;
  }
}
module.exports = { probeOfficeCliWrite, runCommand, MAX_OUTPUT, STEP_TIMEOUT_MS };
