#!/usr/bin/env node
// Usage: npm run import -- "/path/to/customer_report.xlsx"
const { importZotaFile } = require('../lib/importZota');

const file = process.argv[2];
if (!file) {
  console.error('Usage: npm run import -- "/path/to/customer_report.xlsx"');
  process.exit(1);
}
const result = importZotaFile(file);
console.log(`Import done: ${result.added} added, ${result.updated} updated, ${result.skipped} skipped (no phone number).`);
