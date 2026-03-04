/**
 * Apple Notes Exporter — Public Library API
 *
 * Usage:
 *   import { exportNotes, syncNotes } from 'an-export';
 *   await exportNotes({ dest: './my-notes' });
 *   await syncNotes({ dest: './my-notes' });
 */

export type { ExportOptions, SyncOptions, ExportResult, SyncManifest } from './types.ts';
export { decodeTime, sanitizeFileName } from './utils.ts';

// These will be implemented in subsequent user stories
// export { exportNotes } from './exporter.ts';
// export { syncNotes } from './sync.ts';

/**
 * Placeholder — will be replaced by the real implementation in US-002+.
 */
export async function exportNotes(_options: import('./types.ts').ExportOptions): Promise<import('./types.ts').ExportResult> {
  throw new Error('Not yet implemented. See US-002 onwards.');
}

export async function syncNotes(_options: import('./types.ts').SyncOptions): Promise<import('./types.ts').ExportResult> {
  throw new Error('Not yet implemented. See US-008.');
}
