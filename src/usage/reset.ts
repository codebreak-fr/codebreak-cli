/**
 * Indice de remise à zéro extrait d'un message d'erreur de limite (« resets in 2h 5m », « reset at 3pm », « retry after 30s »).
 * C'est une ESTIMATION (le texte est libre) : l'appelant la marque `estimated`. `null` si rien d'exploitable.
 */
export function parseResetHint(message: string, now: number): number | null {
  const m = message.toLowerCase();

  // « |1790256000 » (epoch secondes, format historique de Claude Code) ou epoch explicite
  const epoch = /(?:reset[s]?(?: at)?\s*[:=|]?\s*|\|)(\d{10})\b/.exec(m);
  if (epoch) return Number(epoch[1]) * 1000;

  // « in 1h30 » / « dans 2h05 »
  const compact = /(?:in|after|dans|après)\s+(\d+)h(\d{1,2})\b/.exec(m);
  if (compact) return now + Number(compact[1]) * 3_600_000 + Number(compact[2]) * 60_000;

  // durées : « in 2 hours 5 minutes », « after 45m », « retry after 30s », « in 1h30 »
  const rel = /(?:in|after|retry[- ]after|dans|après)\s+((?:\d+\s*(?:d|days?|h|hours?|hrs?|m|min(?:ute)?s?|s|sec(?:ond)?s?|heures?|jours?)\b[\s,]*(?:and\s+)?)+)/.exec(m);
  if (rel) {
    let ms = 0;
    for (const p of rel[1]!.matchAll(/(\d+)\s*(d|days?|jours?|h|hours?|hrs?|heures?|m|min(?:ute)?s?|s|sec(?:ond)?s?)\b/g)) {
      const n = Number(p[1]);
      const u = p[2]![0]!;
      ms += n * (u === 'd' || u === 'j' ? 864e5 : u === 'h' ? 3_600_000 : u === 'm' ? 60_000 : 1000);
    }
    if (ms > 0) return now + ms;
  }

  // « retry-after: 30 » (secondes)
  const ra = /retry[- ]after[:=\s]+(\d+)\b/.exec(m);
  if (ra) return now + Number(ra[1]) * 1000;

  // heure locale : « resets at 3pm », « reset at 15:30 » → prochaine occurrence
  const clock = /\bat\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\b/.exec(m);
  if (clock) {
    let h = Number(clock[1]);
    const min = Number(clock[2] ?? 0);
    if (clock[3] === 'pm' && h < 12) h += 12;
    if (clock[3] === 'am' && h === 12) h = 0;
    if (h > 23 || min > 59) return null;
    const d = new Date(now);
    d.setHours(h, min, 0, 0);
    if (d.getTime() <= now) d.setDate(d.getDate() + 1);
    return d.getTime();
  }
  return null;
}
