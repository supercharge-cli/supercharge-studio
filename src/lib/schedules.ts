/** Scheduled runs: a prompt sent to a project on a timer (every N minutes or daily at HH:MM, local time). */
export type Schedule = { id: string; projectId: string; prompt: string; on: boolean; every?: number; at?: string; next?: number; last?: number };

/** Next run strictly after `from` (ms), or undefined when the schedule is incomplete. */
export function nextRun(s: Schedule, from: number): number | undefined {
  if (s.at) {
    const m = s.at.match(/^(\d{1,2}):(\d{2})$/);
    if (!m || +m[1] > 23 || +m[2] > 59) return undefined;
    const d = new Date(from);
    d.setHours(+m[1], +m[2], 0, 0);
    if (d.getTime() <= from) d.setDate(d.getDate() + 1);
    return d.getTime();
  }
  return s.every && s.every >= 1 ? from + s.every * 60_000 : undefined;
}

/** Enabled schedules whose time has come (a missed run fires once, not once per missed slot). */
export const dueSchedules = (list: Schedule[] | undefined, now: number) => (list ?? []).filter((s) => s.on && s.prompt.trim() && s.next != null && s.next <= now);
