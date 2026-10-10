#!/usr/bin/env node
import { createInterface } from 'node:readline/promises';
import { Writable } from 'node:stream';
import { createClient, SpondError, rsvpRows, guardianRows, playerRows } from '../src/spond.js';
import { tokenStore } from '../src/store.js';

const HELP = `Spond CLI (Node.js 22+, inoffizielle API)

  spond login
  spond logout
  spond groups list [--json]
  spond members list --group GROUP_ID [--json]
  spond players list --group GROUP_ID [--json]
  spond guardians list --group GROUP_ID [--json]
  spond events list --group GROUP_ID [--from ISO] [--to ISO] [--limit 100] [--json]
  spond events rsvp --group GROUP_ID --event EVENT_ID [--from ISO] [--to ISO] [--limit 100] [--json]

ISO: Datum (YYYY-MM-DD, UTC) oder Datum/Zeit mit Z/Offset.
Listen sind begrenzt; --limit setzt die angeforderte Obergrenze (1–1000).
RSVP sucht das Event in derselben begrenzten Eventliste.
--json: Daten nach stdout, Warnungen/Fehler nach stderr.
Token: ~/.config/spond-cli/token.json (oder SPOND_CONFIG_DIR).
`;
function parse(args) {
  const commands = [], options = {};
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (!arg.startsWith('--')) { commands.push(arg); continue; }
    const key = arg.slice(2);
    if (!['json', 'group', 'event', 'from', 'to', 'limit'].includes(key)) throw new SpondError(`Unbekannte Option: ${arg}`);
    if (Object.hasOwn(options, key)) throw new SpondError(`Doppelte Option: ${arg}`);
    if (key === 'json') options[key] = true;
    else {
      const value = args[++i];
      if (!value || value.startsWith('--')) throw new SpondError(`Wert fehlt: ${arg}`);
      options[key] = value;
    }
  }
  return { command: commands.join(' '), options };
}
function date(value) {
  if (value === undefined) return undefined;
  if (!/^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2}))?$/.test(value))
    throw new SpondError('Datum als YYYY-MM-DD oder ISO-Zeit mit Z/Offset angeben.');
  const d = new Date(value);
  if (!Number.isFinite(d.getTime()) || (value.length === 10 && d.toISOString().slice(0, 10) !== value)) throw new SpondError('Ungültiges Datum.');
  return d.toISOString();
}
async function prompt(label, hidden = false) {
  if (!process.stdin.isTTY || !process.stdout.isTTY) throw new SpondError('Login benötigt ein interaktives Terminal.');
  const output = hidden ? new Writable({ write(_chunk, _encoding, done) { done(); } }) : process.stdout;
  const rl = createInterface({ input: process.stdin, output, terminal: true });
  const cancel = () => { rl.close(); process.stderr.write('\nAbgebrochen.\n'); process.exit(130); };
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
  if (!rows.length) { console.log('Keine Einträge.'); return; }
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
  if (!Object.hasOwn(allowed, command)) throw new SpondError('Unbekannter Befehl. Siehe spond --help.');
  for (const key of Object.keys(o)) if (!allowed[command].includes(key)) throw new SpondError(`Option --${key} passt nicht zu ${command}.`);
  if (['members list', 'players list', 'guardians list', 'events list', 'events rsvp'].includes(command) && !o.group) throw new SpondError('--group ist erforderlich.');
  if (command === 'events rsvp' && !o.event) throw new SpondError('--event ist erforderlich.');
  const from = date(o.from), to = date(o.to);
  if (from && to && from >= to) throw new SpondError('--from muss vor --to liegen.');
  const limit = o.limit === undefined ? 100 : Number(o.limit);
  if (!Number.isInteger(limit) || limit < 1 || limit > 1000) throw new SpondError('--limit muss eine ganze Zahl zwischen 1 und 1000 sein.');
  const store = tokenStore();
  if (command === 'logout') { await store.clear(); console.log('Lokaler Token gelöscht.'); return; }
  if (command === 'login') {
    const email = (await prompt('Spond-E-Mail: ')).trim();
    const password = await prompt('Spond-Passwort (verdeckt): ', true);
    if (!email || !password) throw new SpondError('E-Mail und Passwort sind erforderlich.');
    const credentials = await createClient().login(email, password);
    await store.save(credentials);
    console.log('Angemeldet. Token gespeichert; Passwort nicht gespeichert.'); return;
  }
  const client = createClient(await store.load());
  if (command === 'groups list') {
    print((await client.groups()).map(g => ({ id: g.id, name: g.name })), o.json); return;
  }
  if (command === 'members list' || command === 'players list' || command === 'guardians list' || command === 'events rsvp') {
    const group = (await client.groups()).find(g => g.id === o.group);
    if (!group) throw new SpondError('Gruppe nicht gefunden oder nicht zugänglich.');
    if (!Array.isArray(group.members)) throw new SpondError('Mitgliederliste nicht verfügbar.');
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
    if (events.length >= limit) console.error('Warnung: Event-Limit erreicht; Ergebnis möglicherweise unvollständig. Zeitraum eingrenzen.');
    const event = events.find(e => e.id === o.event && e.recipients?.group?.id === o.group);
    if (!event) throw new SpondError('Event nicht in der abgerufenen Gruppenliste gefunden. Zeitraum/Limit prüfen; versteckte oder geplante Events sind ausgeschlossen.');
    const result = rsvpRows(event, group.members);
    if (result.missingFields.length) console.error(`Hinweis: Nicht gelieferte RSVP-Felder: ${result.missingFields.join(', ')}. Keine Aussage über diese Zustände.`);
    if (result.unknownFields.length) console.error('Warnung: Unbekannte RSVP-Listen vorhanden; Ausgabe möglicherweise unvollständig.');
    print(result.rows, o.json); return;
  }
  const events = await client.events(o.group, { from, to, limit });
  if (events.length >= limit) console.error('Warnung: Event-Limit erreicht; Ergebnis möglicherweise unvollständig. Zeitraum eingrenzen.');
  if (events.some(e => e.recipients?.group?.id !== o.group)) throw new SpondError('Spond lieferte Events ohne passende Gruppen-ID.');
  print(events.map(e => ({ id: e.id, title: e.heading, start: e.startTimestamp, end: e.endTimestamp ?? '' })), o.json);
}
main().catch(error => {
  console.error(`Fehler: ${error instanceof SpondError ? error.message : 'Lokaler Vorgang fehlgeschlagen (Dateirechte oder Konfiguration prüfen).'}`);
  process.exitCode = 1;
});
