import type { AutomatonDatabase } from '../types.js';

/** Run once at process startup, before consuming inbox or starting workers. */
export function quarantineInterruptedOperatorMessages(db: AutomatonDatabase): string[] {
  return db.raw.transaction(() => {
    const rows = db.raw.prepare("SELECT id FROM inbox_messages WHERE status='in_progress' AND substr(id,1,3)='op_'").all() as { id: string }[];
    const timestamp = new Date().toISOString();
    for (const { id } of rows) {
      db.raw.prepare("UPDATE inbox_messages SET status='failed' WHERE id=?").run(id);
      db.setKV(`operator.interrupted:${id}`, JSON.stringify({ id, timestamp, reason: 'runtime_restart', outcome: 'unknown' }));
    }
    return rows.map(row => row.id);
  })();
}
