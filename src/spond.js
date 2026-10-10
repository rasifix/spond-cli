export class SpondError extends Error {}
const BASE = 'https://api.spond.com/core/v1/';
export function createClient(token, fetchFn = fetch) {
  async function request(path, { method = 'GET', body, params } = {}) {
    const url = new URL(path, BASE);
    for (const [key, value] of Object.entries(params ?? {})) {
      if (value !== undefined) url.searchParams.set(key, String(value));
    }
    let response;
    try {
      response = await fetchFn(url, {
        method, redirect: 'error', signal: AbortSignal.timeout(30_000),
        headers: { Accept: 'application/json', ...(body ? { 'Content-Type': 'application/json' } : {}),
          ...(token ? { Authorization: `Bearer ${token}` } : {}) },
        ...(body ? { body: JSON.stringify(body) } : {})
      });
    } catch { throw new SpondError('Spond nicht erreichbar (Netzwerk, Timeout oder Redirect).'); }
    if (!response.ok) {
      const messages = { 401: path === 'auth2/login'
        ? 'Anmeldung fehlgeschlagen. Zugangsdaten und Konto prüfen.'
        : 'Token ungültig oder abgelaufen. Bitte spond login ausführen.',
        403: 'Kein Zugriff. Gruppenrechte prüfen.', 429: 'Zu viele Anfragen. Bitte später erneut versuchen.' };
      throw new SpondError(messages[response.status] ?? `Spond-Anfrage fehlgeschlagen (HTTP ${response.status}).`);
    }
    try { return await response.json(); }
    catch { throw new SpondError('Spond hat kein gültiges JSON geliefert.'); }
  }
  return {
    async login(email, password) {
      const data = await request('auth2/login', { method: 'POST', body: { email, password } });
      const access = data?.accessToken;
      if (typeof access?.token !== 'string' || !access.token || /[\r\n]/.test(access.token))
        throw new SpondError('Anmeldung ohne Token: Zugangsdaten prüfen; MFA/Challenges werden nicht unterstützt.');
      return { token: access.token, ...(typeof access.expiration === 'string' ? { expiration: access.expiration } : {}) };
    },
    async groups() {
      const groups = await request('groups');
      if (!Array.isArray(groups)) throw new SpondError('Unerwartete Gruppenstruktur.');
      return groups;
    },
    async events(groupId, { from, to, limit = 100 } = {}) {
      const events = await request('sponds', { params: {
        groupId, minStartTimestamp: from, maxStartTimestamp: to, max: limit,
        order: 'asc', scheduled: false, includeHidden: false, includeComments: true, addProfileInfo: true
      } });
      if (!Array.isArray(events)) throw new SpondError('Unerwartete Eventstruktur.');
      return events;
    }
  };
}
const statuses = { acceptedIds: 'accepted', declinedIds: 'declined', unansweredIds: 'unanswered',
  waitinglistIds: 'waitinglist', unconfirmedIds: 'unconfirmed' };
export function rsvpRows(event, members) {
  if (!event.responses || typeof event.responses !== 'object' || Array.isArray(event.responses))
    throw new SpondError('RSVP nicht verfügbar; möglicherweise eingeschränkte Sichtbarkeit.');
  const names = new Map(members.map(m => [m.id, [m.firstName, m.lastName].filter(Boolean).join(' ')]));
  const rows = [];
  const seen = new Set();
  for (const [field, status] of Object.entries(statuses)) {
    const ids = event.responses[field];
    if (ids === undefined) continue;
    if (!Array.isArray(ids) || ids.some(id => typeof id !== 'string'))
      throw new SpondError(`Unerwartete RSVP-Struktur: ${field}.`);
    for (const id of ids) {
      if (seen.has(id)) throw new SpondError('Widersprüchliche oder doppelte RSVP-IDs.');
      seen.add(id);
      rows.push({ memberId: id, name: names.get(id) || '(nicht zugeordnet)', status });
    }
  }
  return { rows, missingFields: Object.keys(statuses).filter(k => event.responses[k] === undefined),
    unknownFields: Object.keys(event.responses).filter(k => !Object.hasOwn(statuses, k) && /Ids$/.test(k)) };
}

// One row per guardian/member relationship; shared guardians remain linked to each member.
export function guardianRows(members) {
  const rows = [], seen = new Set();
  for (const member of members) {
    if (member.guardians == null) continue;
    if (!Array.isArray(member.guardians)) throw new SpondError('Unerwartete Guardians-Struktur.');
    for (const guardian of member.guardians) {
      if (!guardian || typeof guardian.id !== 'string' || !guardian.id || typeof member.id !== 'string' || !member.id)
        throw new SpondError('Guardian- oder Mitglieds-ID fehlt.');
      const key = JSON.stringify([guardian.id, member.id]);
      if (seen.has(key)) continue;
      seen.add(key);
      rows.push({ guardianId: guardian.id,
        name: [guardian.firstName, guardian.lastName].filter(Boolean).join(' '),
        email: typeof guardian.email === 'string' ? guardian.email : '',
        memberId: member.id,
        memberName: [member.firstName, member.lastName].filter(Boolean).join(' ') });
    }
  }
  return rows;
}

export function playerRows(members) {
  return members
    .filter(member => member?.respondent === true)
    .map(member => ({ id: member.id,
      name: [member.firstName, member.lastName].filter(Boolean).join(' ') }));
}
