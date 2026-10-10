#!/usr/bin/env node
import { createInterface } from 'node:readline/promises';
import { Writable } from 'node:stream';
import { createClient, SpondError, rsvpRows, guardianRows, playerRows } from '../src/spond.js';
import { tokenStore } from '../src/store.js';

const HELP = `Spond CLI (Node.js 22+, unofficial API)

  spond login
  spond logout
  spond groups list [--json]
  spond members list --group GROUP_ID [--json]
  spond players list --group GROUP_ID [--json]
  spond guardians list --group GROUP_ID [--json]
  spond events list --group GROUP_ID [--from ISO] [--to ISO] [--limit 100] [--json]
  spond events rsvp --group GROUP_ID --event EVENT_ID [--from ISO] [--to ISO] [--limit 100] [--json]

ISO: date (YYYY-MM-DD, UTC) or date/time with a Z suffix or UTC offset.
Lists are limited; --limit sets the requested maximum (1–1000).
RSVP searches for the event in the same limited event list.
--json: data is written to stdout; warnings and errors are written to stderr.
Token: ~/.config/spond-cli/token.json (or SPOND_CONFIG_DIR).
`;
function parse(args) {
  const commands = [], options = {};
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (!arg.startsWith('--')) { commands.push(arg); continue; }
    const key = arg.slice(2);
    if (!['json', 'group', 'event', 'from', 'to', 'limit'].includes(key)) throw new SpondError(`Unknown option: ${arg}`);
    if (Object.hasOwn(options, key)) throw new SpondError(`Duplicate option: ${arg}`);
    if (key === 'json') options[key] = true;
    else {
      const value = args[++i];
      if (!value || value.startsWith('--')) throw new SpondError(`Missing value: ${arg}`);
      options[key] = value;
    }
  }
  return { command: commands.join(' '), options };
}
function date(value) {
  if (value === undefined) return undefined;
  if (!/^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2}))?$/.test(value))
    throw new SpondError('Specify a date as YYYY-MM-DD or an ISO date/time with a Z suffix or UTC offset.');
  const d = new Date(value);
  if (!Number.isFinite(d.getTime()) || (value.length === 10 && d.toISOString().slice(0, 10) !== value)) throw new SpondError('Invalid date.');
  return d.toISOString();
}
async function prompt(label, hidden = false) {
  if (!process.stdin.isTTY || !process.stdout.isTTY) throw new SpondError('Login requires an interactive terminal.');
  const output = hidden ? new Writable({ write(_chunk, _encoding, done) { done(); } }) : process.stdout;
  const rl = createInterface({ input: process.stdin, output, terminal: true });
  const cancel = () => { rl.close(); process.stderr.write('\nCancelled.\n'); process.exit(130); };
  rl.once('SIGINT', cancel);
  try {
    if (hidden) process.stdout.write(label);
    return await rl.question(hidden ? '' : label);
  } finally { rl.close(); if (hidden) process.stdout.write('\n'); }
}
// Strip terminal controls from server-provided strings in human-readable output.
function safe(value) { return String(value ?? '').replace(/[\x00-\x1f\x7f-\x9f]/g, ' '); }
function print(rows, json) {
  if (json) { console.log(JSON.stringify(rows, null, 2)); return; }
  if (!rows.length) { console.log('No entries.'); return; }
  const keys = Object.keys(rows[0]);
  const widths = keys.map(k => Math.min(64, Math.max(k.length, ...rows.map(r => safe(r[k]).length))));
  const line = row => keys.map((k, i) => safe(row[k]).slice(0, widths[i]).padEnd(widths[i])).join('  ');
  console.log(line(Object.fromEntries(keys.map(k => [k, k]))));
  for (const row of rows) console.log(line(row));
}
async function main() {
  const args = process.argv.slice(2);
  if (!args.length || args.includes('--help') || args[0] === 'help') { console.log(HELP); return; }
  const { command, options: o } = parse(args);
  const allowed = {
    login: [], logout: [], 'groups list': ['json'], 'members list': ['group', 'json'], 'players list': ['group', 'json'],
    'guardians list': ['group', 'json'],
    'events list': ['group', 'from', 'to', 'limit', 'json'],
    'events rsvp': ['group', 'event', 'from', 'to', 'limit', 'json']
  };
  if (!Object.hasOwn(allowed, command)) throw new SpondError('Unknown command. See spond --help.');
  for (const key of Object.keys(o)) if (!allowed[command].includes(key)) throw new SpondError(`Option --${key} is not valid for ${command}.`);
  if (['members list', 'players list', 'guardians list', 'events list', 'events rsvp'].includes(command) && !o.group) throw new SpondError('--group is required.');
  if (command === 'events rsvp' && !o.event) throw new SpondError('--event is required.');
  const from = date(o.from), to = date(o.to);
  if (from && to && from >= to) throw new SpondError('--from must be earlier than --to.');
  const limit = o.limit === undefined ? 100 : Number(o.limit);
  if (!Number.isInteger(limit) || limit < 1 || limit > 1000) throw new SpondError('--limit must be an integer between 1 and 1000.');
  const store = tokenStore();
  if (command === 'logout') { await store.clear(); console.log('Local token deleted.'); return; }
  if (command === 'login') {
    const email = (await prompt('Spond email: ')).trim();
    const password = await prompt('Spond password (hidden): ', true);
    if (!email || !password) throw new SpondError('Email and password are required.');
    const credentials = await createClient().login(email, password);
    await store.save(credentials);
    console.log('Logged in. Token saved; password not saved.'); return;
  }
  const client = createClient(await store.load());
  if (command === 'groups list') {
    print((await client.groups()).map(g => ({ id: g.id, name: g.name })), o.json); return;
  }
  if (command === 'members list' || command === 'players list' || command === 'guardians list' || command === 'events rsvp') {
    const group = (await client.groups()).find(g => g.id === o.group);
    if (!group) throw new SpondError('Group not found or inaccessible.');
    if (!Array.isArray(group.members)) throw new SpondError('Member list unavailable.');
    if (command === 'members list') {
      print(group.members.map(m => ({ id: m.id, name: [m.firstName, m.lastName].filter(Boolean).join(' ') })), o.json); return;
    }
    if (command === 'players list') {
      print(playerRows(group.members), o.json); return;
    }
    if (command === 'guardians list') {
      print(guardianRows(group.members), o.json); return;
    }
    const events = await client.events(o.group, { from, to, limit });
    if (events.length >= limit) console.error('Warning: Event limit reached; results may be incomplete. Narrow the date range.');
    const event = events.find(e => e.id === o.event && e.recipients?.group?.id === o.group);
    if (!event) throw new SpondError('Event not found in the retrieved group list. Check the date range and limit; hidden or scheduled events are excluded.');
    const result = rsvpRows(event, group.members);
    if (result.missingFields.length) console.error(`Note: RSVP fields not returned: ${result.missingFields.join(', ')}. No status can be inferred for them.`);
    if (result.unknownFields.length) console.error('Warning: Unknown RSVP lists are present; output may be incomplete.');
    print(result.rows, o.json); return;
  }
  const events = await client.events(o.group, { from, to, limit });
  if (events.length >= limit) console.error('Warning: Event limit reached; results may be incomplete. Narrow the date range.');
  if (events.some(e => e.recipients?.group?.id !== o.group)) throw new SpondError('Spond returned events without the requested group ID.');
  print(events.map(e => ({ id: e.id, title: e.heading, start: e.startTimestamp, end: e.endTimestamp ?? '' })), o.json);
}
main().catch(error => {
  console.error(`Error: ${error instanceof SpondError ? error.message : 'Local operation failed (check file permissions or configuration).'}`);
  process.exitCode = 1;
});
