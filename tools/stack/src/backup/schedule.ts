// Spec 0020 D6, BK8, B-15, B2-4: `pnpm stack:backup schedule --at HH:MM [--apply | --remove]`. Two Windows scheduled
// tasks, in the \UniVarse\ folder: the daily set, and WAL shipping every 15 minutes. Without --apply it prints their
// XML and changes nothing; the owner reads it, then registers it. Each runs as the owner, only when logged on (Docker
// Desktop lives in the session; the other choice stores the owner's Windows password), with node's and pnpm's absolute
// paths from when the schedule was made, so Task Scheduler's PATH never matters. Elsewhere: crontab lines, nothing
// registered.

export const TASK_FOLDER = '\\UniVarse\\';
export const TASKS = { daily: 'backup', wal: 'backup-wal' } as const;
export type TaskKind = keyof typeof TASKS;
export const taskPath = (kind: TaskKind) => `${TASK_FOLDER}${TASKS[kind]}`;

export interface ScheduleInputs {
  /** The daily set's local time, HH:MM. */
  readonly at: string;
  /** The task's start date (local), YYYY-MM-DD: today. */
  readonly startDate: string;
  /** DOMAIN\user: the owner, who the tasks run as. */
  readonly user: string;
  readonly node: string;
  /** pnpm's own script (pnpm.cjs), run by `node`. */
  readonly pnpm: string;
  readonly repo: string;
}

/** HH:MM on a 24-hour clock, or null. */
export function parseAt(s: string | undefined): string | null {
  const m = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(s ?? '');
  return m ? `${m[1] ?? ''}:${m[2] ?? ''}` : null;
}

const xml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
/** One argument for Windows' command line: quoted, since the owner's paths hold spaces (a path can't hold a `"`). */
const arg = (s: string) => {
  if (s.includes('"')) throw new Error(`a path with a double quote can't be scheduled: ${s}`);
  return `"${s}"`;
};

/** What the task runs: the backup command, in this checkout, in scheduled mode (its log, and its wait for the lock). */
export function taskArguments(kind: TaskKind, i: ScheduleInputs): string {
  return [arg(i.pnpm), '--dir', arg(i.repo), 'stack:backup', ...(kind === 'wal' ? ['wal'] : []), '--scheduled'].join(' ');
}

/** The task's definition, as `schtasks /Create /XML` reads it. */
export function taskXml(kind: TaskKind, i: ScheduleInputs): string {
  const at = parseAt(i.at);
  if (!at) throw new Error('--at takes HH:MM, a 24-hour local time');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(i.startDate)) throw new Error(`bad start date ${i.startDate}`);
  const start = `${i.startDate}T${kind === 'daily' ? at : '00:00'}:00`;
  const trigger =
    kind === 'daily'
      ? `<CalendarTrigger><StartBoundary>${start}</StartBoundary><Enabled>true</Enabled><ScheduleByDay><DaysInterval>1</DaysInterval></ScheduleByDay></CalendarTrigger>`
      : `<TimeTrigger><Repetition><Interval>PT15M</Interval><StopAtDurationEnd>false</StopAtDurationEnd></Repetition><StartBoundary>${start}</StartBoundary><Enabled>true</Enabled></TimeTrigger>`;
  const what = kind === 'daily' ? 'the daily sealed backup set' : 'WAL shipping, every 15 minutes';
  return [
    '<?xml version="1.0" encoding="UTF-16"?>',
    '<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">',
    `  <RegistrationInfo><Description>UniVarse: ${what} (spec 0020 D6). Registered by pnpm stack:backup schedule.</Description></RegistrationInfo>`,
    `  <Triggers>${trigger}</Triggers>`,
    // Only when logged on (InteractiveToken): no stored password, and Docker Desktop is in the owner's session.
    `  <Principals><Principal id="Author"><UserId>${xml(i.user)}</UserId><LogonType>InteractiveToken</LogonType><RunLevel>LeastPrivilege</RunLevel></Principal></Principals>`,
    '  <Settings>',
    '    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>',
    '    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>',
    '    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>',
    // A run missed while the machine slept runs at the next wake; neither task wakes the machine.
    '    <StartWhenAvailable>true</StartWhenAvailable>',
    '    <WakeToRun>false</WakeToRun>',
    '    <RunOnlyIfNetworkAvailable>false</RunOnlyIfNetworkAvailable>',
    `    <ExecutionTimeLimit>${kind === 'daily' ? 'PT2H' : 'PT1H'}</ExecutionTimeLimit>`,
    '    <Enabled>true</Enabled>',
    '  </Settings>',
    `  <Actions Context="Author"><Exec><Command>${xml(i.node)}</Command><Arguments>${xml(taskArguments(kind, i))}</Arguments><WorkingDirectory>${xml(i.repo)}</WorkingDirectory></Exec></Actions>`,
    '</Task>',
    '',
  ].join('\r\n');
}

/** The same two jobs for cron, printed on other systems; nothing is registered there. */
export function cronLines(i: ScheduleInputs): string[] {
  const at = parseAt(i.at);
  if (!at) throw new Error('--at takes HH:MM, a 24-hour local time');
  const [h, m] = at.split(':').map(Number);
  const q = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
  const run = (kind: TaskKind) => `cd ${q(i.repo)} && ${q(i.node)} ${q(i.pnpm)} stack:backup${kind === 'wal' ? ' wal' : ''} --scheduled`;
  return [`${String(m)} ${String(h)} * * * ${run('daily')}`, `*/15 * * * * ${run('wal')}`];
}

/** Get-ScheduledTaskInfo's result codes that aren't failures: not run yet (0x41303), running now (0x41301). */
export const NOT_YET_RUN = 0x41303;
export const RUNNING = 0x41301;

/** What the status query prints for one task (status-deps.ts): `null`, or `{"run":"<ISO>","result":<n>}`. */
export function parseTaskInfo(name: string, out: string): { name: string; registered: boolean; lastRun: Date | null; lastResult: number | null } {
  const t = out.trim();
  if (t === '' || t === 'null') return { name, registered: false, lastRun: null, lastResult: null };
  const v = JSON.parse(t) as { run?: string; result?: number };
  const result = typeof v.result === 'number' ? v.result : null;
  if (result === NOT_YET_RUN) return { name, registered: true, lastRun: null, lastResult: null };
  const run = v.run ? new Date(v.run) : null;
  return { name, registered: true, lastRun: run && !Number.isNaN(run.getTime()) ? run : null, lastResult: result === RUNNING ? 0 : result };
}
