// Spec 0020 BK8, B-15, B2-4: exactly what `stack:backup schedule` registers, and that nothing is registered without
// --apply. schtasks and PowerShell are faked: every call is recorded.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir, userInfo } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { arg, cronLines, NOT_YET_RUN, parseAt, parseTaskInfo, RUNNING, taskArguments, taskXml, type ScheduleInputs } from './schedule.js';
import { schedule, scheduleInputs, taskState, type Exec } from './status-deps.js';

const I: ScheduleInputs = {
  at: '13:30',
  startDate: '2026-10-25',
  user: 'DESKTOP-1\\SAMUEL OPEMIPO',
  node: 'C:\\Program Files\\nodejs\\node.exe',
  pnpm: 'C:\\Users\\SAMUEL OPEMIPO\\AppData\\Local\\pnpm\\pnpm.cjs',
  repo: 'C:\\Projects\\univarse',
};

function recorder(status = 0) {
  const calls: { cmd: string; args: readonly string[]; file?: Buffer }[] = [];
  const exec: Exec = (cmd, args) => {
    const at = args.indexOf('/XML');
    const file = at >= 0 && args[at + 1] ? readFileSync(args[at + 1] ?? '') : undefined;
    calls.push({ cmd, args, ...(file ? { file } : {}) });
    return { status, stdout: '', stderr: status ? 'ERROR: Access is denied.' : '' };
  };
  return { calls, exec };
}

describe('parseAt', () => {
  it('takes a 24-hour HH:MM only', () => {
    expect(parseAt('00:00')).toBe('00:00');
    expect(parseAt('23:59')).toBe('23:59');
    for (const bad of ['24:00', '9:30', '12:60', '12:30:00', '', undefined, '1230']) expect([bad, parseAt(bad)]).toEqual([bad, null]);
  });
});

describe('taskXml', () => {
  it('[BK8] the daily task, exactly: as the owner, only when logged on, catching up after sleep, never waking, one at a time', () => {
    expect(taskXml('daily', I).split('\r\n')).toEqual([
      '<?xml version="1.0" encoding="UTF-16"?>',
      '<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">',
      '  <RegistrationInfo><Description>UniVarse: the daily sealed backup set (spec 0020 D6). Registered by pnpm stack:backup schedule.</Description></RegistrationInfo>',
      '  <Triggers><CalendarTrigger><StartBoundary>2026-10-25T13:30:00</StartBoundary><Enabled>true</Enabled><ScheduleByDay><DaysInterval>1</DaysInterval></ScheduleByDay></CalendarTrigger></Triggers>',
      '  <Principals><Principal id="Author"><UserId>DESKTOP-1\\SAMUEL OPEMIPO</UserId><LogonType>InteractiveToken</LogonType><RunLevel>LeastPrivilege</RunLevel></Principal></Principals>',
      '  <Settings>',
      '    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>',
      '    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>',
      '    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>',
      '    <StartWhenAvailable>true</StartWhenAvailable>',
      '    <WakeToRun>false</WakeToRun>',
      '    <RunOnlyIfNetworkAvailable>false</RunOnlyIfNetworkAvailable>',
      '    <ExecutionTimeLimit>PT2H</ExecutionTimeLimit>',
      '    <Enabled>true</Enabled>',
      '  </Settings>',
      '  <Actions Context="Author"><Exec><Command>C:\\Program Files\\nodejs\\node.exe</Command><Arguments>&quot;C:\\Users\\SAMUEL OPEMIPO\\AppData\\Local\\pnpm\\pnpm.cjs&quot; --dir &quot;C:\\Projects\\univarse&quot; stack:backup --scheduled</Arguments><WorkingDirectory>C:\\Projects\\univarse</WorkingDirectory></Exec></Actions>',
      '</Task>',
      '',
    ]);
  });

  it('[BK8] the WAL task repeats every 15 minutes, all day, and ships WAL', () => {
    const x = taskXml('wal', I);
    expect(x).toContain('<TimeTrigger><Repetition><Interval>PT15M</Interval><StopAtDurationEnd>false</StopAtDurationEnd></Repetition><StartBoundary>2026-10-25T00:00:00</StartBoundary><Enabled>true</Enabled></TimeTrigger>');
    expect(x).toContain('<ExecutionTimeLimit>PT1H</ExecutionTimeLimit>');
    expect(x).not.toContain('CalendarTrigger');
    expect(taskArguments('wal', I)).toBe('"C:\\Users\\SAMUEL OPEMIPO\\AppData\\Local\\pnpm\\pnpm.cjs" --dir "C:\\Projects\\univarse" stack:backup wal --scheduled');
  });

  it('escapes what XML needs, and refuses what it cannot quote', () => {
    expect(taskXml('daily', { ...I, repo: 'C:\\R&D <x>' })).toContain('<WorkingDirectory>C:\\R&amp;D &lt;x&gt;</WorkingDirectory>');
    expect(() => taskXml('daily', { ...I, repo: 'C:\\a"b' })).toThrow(/double quote/);
    expect(() => taskXml('daily', { ...I, at: '25:00' })).toThrow(/HH:MM/);
    expect(() => taskXml('daily', { ...I, startDate: '25/10/2026' })).toThrow(/start date/);
  });

  it('elsewhere, the same jobs as crontab lines, quoted for sh', () => {
    expect(cronLines({ ...I, node: '/usr/bin/node', pnpm: "/opt/it's/pnpm.cjs", repo: '/home/o/univarse', at: '07:05' })).toEqual([
      "5 7 * * * cd '/home/o/univarse' && '/usr/bin/node' '/opt/it'\\''s/pnpm.cjs' stack:backup --scheduled",
      "*/15 * * * * cd '/home/o/univarse' && '/usr/bin/node' '/opt/it'\\''s/pnpm.cjs' stack:backup wal --scheduled",
    ]);
  });
});

describe('schedule', () => {
  it('[BK8] without --apply, prints both definitions and runs nothing', () => {
    const { calls, exec } = recorder();
    const r = schedule('print', I, { platform: 'win32', exec });
    expect(calls).toEqual([]);
    expect(r.ok).toBe(true);
    expect(r.lines[0]).toBe('── \\UniVarse\\backup ──');
    expect(r.lines).toContain('── \\UniVarse\\backup-wal ──');
    expect(r.lines.at(-1)).toMatch(/nothing is registered: .* --apply/);
  });

  it('[BK8] with --apply, registers each from its XML as UTF-16 with a byte-order mark, and removes the file', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'uv-sched-'));
    const { calls, exec } = recorder();
    const r = schedule('apply', I, { platform: 'win32', exec, tmp });
    expect(r.ok).toBe(true);
    expect(calls.map((c) => [c.cmd, c.args[0], c.args[1], c.args[2], c.args[3], c.args[5]])).toEqual([
      ['schtasks.exe', '/Create', '/TN', '\\UniVarse\\backup', '/XML', '/F'],
      ['schtasks.exe', '/Create', '/TN', '\\UniVarse\\backup-wal', '/XML', '/F'],
    ]);
    const daily = calls[0]?.file ?? Buffer.alloc(0);
    expect([...daily.subarray(0, 2)]).toEqual([0xff, 0xfe]);
    expect(daily.subarray(2).toString('utf16le')).toBe(taskXml('daily', I));
    for (const c of calls) expect(existsSync(c.args[4] ?? '')).toBe(false);
  });

  it('stops at the first registration that fails, naming it', () => {
    const { calls, exec } = recorder(1);
    const r = schedule('apply', I, { platform: 'win32', exec, tmp: mkdtempSync(join(tmpdir(), 'uv-sched-')) });
    expect(r.ok).toBe(false);
    expect(calls).toHaveLength(1);
    expect(r.lines.at(-1)).toMatch(/\\UniVarse\\backup was not registered \(schtasks exited 1\): ERROR: Access is denied\./);
  });

  it('--remove deletes both', () => {
    const { calls, exec } = recorder();
    expect(schedule('remove', I, { platform: 'win32', exec }).ok).toBe(true);
    expect(calls.map((c) => c.args)).toEqual([
      ['/Delete', '/TN', '\\UniVarse\\backup', '/F'],
      ['/Delete', '/TN', '\\UniVarse\\backup-wal', '/F'],
    ]);
  });

  it('[B-15] off Windows, prints crontab lines and registers nothing; --apply is refused', () => {
    const { calls, exec } = recorder();
    expect(schedule('print', I, { platform: 'linux', exec }).lines[0]).toMatch(/not on Windows: nothing is registered/);
    const r = schedule('apply', I, { platform: 'linux', exec });
    expect(r.ok).toBe(false);
    expect(calls).toEqual([]);
  });
});

describe('scheduleInputs', () => {
  it("records pnpm's own script, the owner and this node; refuses outside pnpm", () => {
    const i = scheduleInputs('13:30', new Date(2026, 9, 25, 9, 0), { npm_execpath: 'C:\\pnpm\\pnpm.cjs', USERDOMAIN: 'DESKTOP-1', USERNAME: 'SAMUEL OPEMIPO' });
    expect(i).toMatchObject({ at: '13:30', startDate: '2026-10-25', user: 'DESKTOP-1\\SAMUEL OPEMIPO', node: process.execPath, pnpm: 'C:\\pnpm\\pnpm.cjs' });
    expect(() => scheduleInputs('13:30', new Date(), { npm_execpath: '/usr/lib/node_modules/npm/bin/npm-cli.js', USERNAME: 'x' })).toThrow(/through pnpm/);
    expect(scheduleInputs('13:30', new Date(), { npm_execpath: 'pnpm.cjs' }).user).toBe(userInfo().username);
  });
});

describe('the task state', () => {
  it('parses what the PowerShell query prints', () => {
    expect(parseTaskInfo('backup', 'null\r\n')).toEqual({ name: 'backup', registered: false, lastRun: null, lastResult: null });
    expect(parseTaskInfo('backup', '{"run":"2026-10-25T03:33:59.0000000Z","result":0}')).toEqual({ name: 'backup', registered: true, lastRun: new Date('2026-10-25T03:33:59Z'), lastResult: 0 });
    expect(parseTaskInfo('backup', `{"run":"1999-11-30T00:00:00.0000000Z","result":${String(NOT_YET_RUN)}}`)).toEqual({ name: 'backup', registered: true, lastRun: null, lastResult: null });
    expect(parseTaskInfo('backup', `{"run":"2026-10-25T03:33:59Z","result":${String(RUNNING)}}`).lastResult).toBe(0);
    expect(parseTaskInfo('backup', '{"run":"2026-10-25T03:33:59Z","result":1}').lastResult).toBe(1);
  });

  it('asks PowerShell for the task in the UniVarse folder, by name, and fails loudly when PowerShell does', () => {
    const calls: (readonly string[])[] = [];
    const ok: Exec = (_cmd, args) => (calls.push(args), { status: 0, stdout: '{"run":"2026-10-25T03:33:59Z","result":0}', stderr: '' });
    expect(taskState('wal', ok)).toMatchObject({ name: 'backup-wal', registered: true, lastResult: 0 });
    expect(calls[0]?.at(-1)).toContain("Get-ScheduledTask -TaskPath '\\UniVarse\\' -TaskName 'backup-wal'");
    expect(() => taskState('daily', () => ({ status: 1, stdout: '', stderr: '' }))).toThrow(/PowerShell exited 1/);
  });
});

describe("[B2-4] the task's command line, as Windows splits it", () => {
  it('doubles the backslashes before a closing quote, so a path ending in \\ keeps its quote', () => {
    expect(arg('C:\\Projects\\univarse\\')).toBe('"C:\\Projects\\univarse\\\\"');
    expect(arg('C:\\a\\\\')).toBe('"C:\\a\\\\\\\\"');
    expect(arg('C:\\Projects\\univarse')).toBe('"C:\\Projects\\univarse"');
    expect(arg('C:\\x\\y z')).toBe('"C:\\x\\y z"');
    // This checkout's own path, from a directory URL, ends in the separator: the case that broke.
    expect(taskArguments('daily', { ...I, repo: 'C:\\Projects\\univarse\\' })).toBe(
      '"C:\\Users\\SAMUEL OPEMIPO\\AppData\\Local\\pnpm\\pnpm.cjs" --dir "C:\\Projects\\univarse\\\\" stack:backup --scheduled',
    );
  });

  // Task Scheduler hands the Arguments string to the program unparsed, and the program's runtime splits it; Node's
  // windowsVerbatimArguments does the same (and so leaves the program's own path unquoted too: Task Scheduler passes
  // it apart, quoted, as argv0 does here). A script stands in for pnpm and prints what it received.
  it.runIf(process.platform === 'win32')('on this Windows host: every task argument arrives whole, a trailing backslash and spaces included', () => {
    const dir = mkdtempSync(join(tmpdir(), 'uv-sched argv '));
    const script = join(dir, 'argv.cjs');
    writeFileSync(script, 'console.log(JSON.stringify(process.argv.slice(2)))');
    for (const repo of ['C:\\Projects\\univarse\\', 'C:\\Projects\\univarse', `${dir}\\with space\\`]) {
      for (const kind of ['daily', 'wal'] as const) {
        const line = taskArguments(kind, { ...I, pnpm: script, repo });
        const r = spawnSync(process.execPath, [line], { windowsVerbatimArguments: true, argv0: `"${process.execPath}"`, encoding: 'utf8' });
        expect(r.status, `${r.stderr} (${line})`).toBe(0);
        expect(JSON.parse(r.stdout)).toEqual(['--dir', repo, 'stack:backup', ...(kind === 'wal' ? ['wal'] : []), '--scheduled']);
      }
    }
  });
});
