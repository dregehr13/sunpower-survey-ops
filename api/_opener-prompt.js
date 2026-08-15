// The morning Teams opener prompt, in one place.
//
// It lived verbatim in both api/morning-card.js and api/team-opener.js — the
// same fifteen lines twice, which is how one of them ends up a release behind
// the other the first time the wording is tuned.
//
// The two callers differ only in where the stats come from: morning-card
// computes them from data.json server-side, team-opener takes them from the
// client.

export const OPENER_MODEL = 'claude-haiku-4-5-20251001';
export const OPENER_MAX_TOKENS = 120;

export function openerPrompt(stats, now = new Date()) {
  const dayName = now.toLocaleDateString('en-US', { weekday: 'long', timeZone: 'America/Denver' });
  const dateStr = now.toLocaleDateString('en-US', { month: 'long', day: 'numeric', timeZone: 'America/Denver' });
  const completed = stats?.completed ?? 0;
  const refLabel = stats?.refLabel?.toLowerCase() ?? 'yesterday';
  const wip = stats?.wip ?? 0;
  const unscheduled = stats?.unscheduled ?? 0;

  return `Write a short morning greeting for a small remote ops team (3 people: schedulers and account managers at SunPower, a solar company). It goes into a Teams message from their manager Doug to kick off the day.

Rules:
- 2–3 sentences max
- Warm, light-hearted, human — this is about connection, not metrics
- Include something topical: a sports score, a day-of-week observation, something seasonal, a gentle joke, or a pop culture reference — whatever feels natural for ${dayName}
- Do NOT restate the stats — they appear separately in the card below the opener
- Do NOT sign off — Doug's name is already shown in the card header
- Sound like a real person, not a bot or a corporate newsletter
- Today is ${dayName}, ${dateStr}

Stats for tone context only (don't repeat them): ${completed} surveys completed ${refLabel}, ${wip} open, ${unscheduled} unscheduled.

Return only the greeting text, no quotes, no labels.`;
}
