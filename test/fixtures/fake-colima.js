#!/usr/bin/env node
// Fake `colima` CLI. `list --json` prints one profile line controlled by
// $FAKE_COLIMA_STATUS (default "Running"). start/stop just exit 0.
const argv = process.argv.slice(2);
if (argv[0] === 'list') {
  const status = process.env.FAKE_COLIMA_STATUS || 'Running';
  process.stdout.write(JSON.stringify({
    name: 'default', status, arch: 'aarch64', cpus: 4,
    memory: 6442450944, disk: 64424509440, runtime: 'docker',
  }) + '\n');
  process.exit(0);
}
if (argv[0] === 'start') {
  // Optional failure injection for the "failed VM start surfaced" test.
  if (process.env.FAKE_COLIMA_START_FAIL) { process.stderr.write('fake-colima: start failed (injected)\n'); process.exit(1); }
  process.exit(0);
}
if (argv[0] === 'stop') process.exit(0);
process.stderr.write(`fake-colima: unsupported: ${argv.join(' ')}\n`);
process.exit(1);
