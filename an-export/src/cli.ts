#!/usr/bin/env bun
/**
 * Apple Notes Exporter — CLI Entry Point
 *
 * Usage:
 *   bun run src/cli.ts export --dest ./my-notes
 *   bun run src/cli.ts sync   --dest ./my-notes
 */

import { exportNotes, syncNotes } from './index.ts';

const args = process.argv.slice(2);
const command = args[0];
const destIndex = args.indexOf('--dest');
const dest = destIndex !== -1 ? args[destIndex + 1] : undefined;

async function main(): Promise<void> {
  if (!command || (command !== 'export' && command !== 'sync')) {
    console.error('Usage: an-export <export|sync> --dest <output-directory>');
    process.exit(1);
  }

  if (!dest) {
    console.error('Error: --dest <output-directory> is required.');
    process.exit(1);
  }

  const onProgress = (message: string) => {
    console.log(message);
  };

  try {
    if (command === 'export') {
      console.log(`Exporting Apple Notes to: ${dest}`);
      const result = await exportNotes({ dest }, onProgress);
      console.log(
        `Done. Exported: ${result.exported}, Skipped: ${result.skipped}, Failed: ${result.failed.length}`,
      );
      if (result.failed.length > 0) {
        console.error('Failed notes:');
        for (const f of result.failed) {
          console.error(`  - ${f}`);
        }
      }
    } else {
      console.log(`Syncing Apple Notes to: ${dest}`);
      const result = await syncNotes({ dest }, onProgress);
      console.log(
        `Done. Exported: ${result.exported}, Skipped: ${result.skipped}, Deleted: ${result.deleted}, Failed: ${result.failed.length}`,
      );
      if (result.failed.length > 0) {
        console.error('Failed notes:');
        for (const f of result.failed) {
          console.error(`  - ${f}`);
        }
      }
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`Error: ${message}`);
    process.exit(1);
  }
}

main();
