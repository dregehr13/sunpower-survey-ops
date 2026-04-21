import Anthropic from '@anthropic-ai/sdk';

const client = new Anthropic(); // reads ANTHROPIC_API_KEY from env

const SYSTEM_PROMPT = `You write short email commentary for Doug Regehr, Site Survey Manager at SunPower.

Voice rules — follow these exactly:
- Direct and confident. Short sentences that carry weight.
- Refined casual: professional but never corporate.
- State conclusions plainly. "Cycle time is trending down." Not "we are pleased to report an improvement in cycle time metrics."
- Never use: "it's worth noting", "additionally", "as we can see", "moving forward", "I wanted to", "please note", passive voice, or filler phrases.
- Do not oversell routine performance. Site survey is a minor department when running smoothly.
- Flag problems clearly. Explain outliers. Note if something needs attention.
- Incorporate any operational context provided — it explains why numbers look the way they do.
- Audience: Allie Morais (Site Survey Sr Lead), Rob Barker (Director Ops Pre-Install), Spencer Jensen (SVP Ops — reads in 45 seconds, wants to know if there's a problem and what it is).

Format: Return exactly 3 options, each 2–3 sentences, labeled 1. 2. 3. on separate lines. No preamble.
- Option 1: Terse. Facts and verdict only. One or two sentences max.
- Option 2: Balanced. Brief context for anything notable, then status.
- Option 3: Explanatory. Fuller picture — what happened, why, and what it means going forward if relevant.`;

function buildPrompt(stats, mode, observations, manualNote) {
  const lines = [];

  if (mode === 'monday') {
    lines.push(`Mode: Monday weekly recap`);
    lines.push(`Period: ${stats.periodLabel}`);
    lines.push(`New in: ${stats.newIn} surveys started`);
    lines.push(`Completed: ${stats.completedCount} site surveys`);
    lines.push(`WIP at end of week: ${stats.wip}${stats.wipChange != null ? ' ('+(stats.wipChange >= 0 ? '+' : '')+stats.wipChange+' vs prior week)' : ''}`);
    if (stats.medCycle != null) lines.push(`Median cycle time: ${stats.medCycle.toFixed(1)}d (target: 3d)`);
    if (stats.outlierCount > 0) lines.push(`Outliers: ${stats.outlierCount} project(s) above IQR fence. Longest: ${stats.maxOutlier.toFixed(0)}d.`);
    if (stats.trend) lines.push(`3-week median trend: ${stats.trend} (rolling median: ${stats.rollingMed != null ? stats.rollingMed.toFixed(1)+'d' : 'n/a'})`);
    if (stats.weeklyTrend) lines.push(`4-week cycle trend: ${stats.weeklyTrend.map(w=>`${w.label}: ${w.med!=null?w.med.toFixed(1)+'d':'no data'} (${w.count} completions)`).join(' → ')}`);
    if (stats.onTargetPct != null) lines.push(`On target (≤4d): ${stats.onTargetPct}%`);
  } else {
    lines.push(`Mode: Daily recap`);
    lines.push(`Yesterday (${stats.yesterday}): ${stats.completedYesterday} completed, ${stats.newInYesterday} new in`);
    lines.push(`Week to date: ${stats.completedWTD} completed, ${stats.newInWTD} new in`);
    if (stats.medCycleWTD != null) lines.push(`WTD median cycle time: ${stats.medCycleWTD.toFixed(1)}d (target: 3d)`);
  }

  if (observations && observations.length) {
    lines.push(`\nFlagged observations:\n${observations.map(o => '- ' + o).join('\n')}`);
  }

  if (manualNote && manualNote.trim()) {
    lines.push(`\nOperational context (incorporate if relevant): ${manualNote.trim()}`);
  }

  lines.push(`\nWrite 3 commentary options.`);
  return lines.join('\n');
}

function parseOptions(text) {
  const options = [];
  const matches = text.match(/^\d\.\s+(.+?)(?=\n\d\.|$)/gms);
  if (matches) {
    matches.forEach(m => {
      const clean = m.replace(/^\d\.\s+/, '').trim();
      if (clean) options.push(clean);
    });
  }
  // Fallback: split by numbered lines
  if (!options.length) {
    text.split(/\n(?=\d\.)/).forEach(chunk => {
      const clean = chunk.replace(/^\d\.\s+/, '').trim();
      if (clean) options.push(clean);
    });
  }
  return options.slice(0, 3);
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();

  const { stats, mode, observations, manualNote } = req.body;
  if (!stats || !mode) return res.status(400).json({ error: 'Missing stats or mode' });

  try {
    const message = await client.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 1024,
      system: [{ type: 'text', text: SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } }],
      messages: [{ role: 'user', content: buildPrompt(stats, mode, observations, manualNote) }],
    });

    const text = message.content[0].text;
    const options = parseOptions(text);
    res.status(200).json({ options });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
}
