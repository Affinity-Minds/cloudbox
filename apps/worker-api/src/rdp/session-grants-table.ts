// Owner: WT-11. Folded into `db/schema.ts` at the phase-2/devices consolidation (docs/ISSUE_LOG.md
// P2-7): every table now lives there, per that file's own header comment. Kept as a re-export so
// this module's existing importers (session.ts, rdp-session.test.ts) are unchanged.
export { rdpSessionGrants } from "../db/schema";
