// lib/qa-vision.cjs — the Claude photo check for the QA review (QA → Settings).
//
// A reviewer should not have to squint at forty photos. When the check is on, each
// key photo is sent to Claude once, with what that category has to show, and comes
// back as "readable or not" plus one sentence. It is ADVICE: it can pull a photo to
// the front of its row and say why, but it never marks a photo or settles a check.
// Nothing here is stored. The page sends a downsized copy through api/qa-vision.js.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.OpsQAVision = factory();
})(typeof self !== 'undefined' ? self : this, function () {

  const MODEL = 'claude-sonnet-5-5';

  // What each key photo category has to show (the Site Survey Guide's wording).
  const CRITERIA = {
    breaker: 'the main service panel with its breakers; readable means the main breaker and its amp rating, or the ratings on the individual breakers, can be read',
    label: 'the label on the main service panel; readable means the printed text, including the bus rating, can be read',
    meter: 'the face of the utility meter; readable means the meter number and the numbers on the glass can be read',
    pitch: 'a roof pitch or tilt reading; readable means the pitch number or the angle on the level or app can be read',
    framing: 'attic framing; readable means a tape or measuring app is in the shot and the rafter size or the rafter spacing can be read from it',
    eave: 'the roof overhang or eave; readable means a tape is in the shot and the measurement can be read',
    attic: 'the inside of an attic; readable means the rafters or trusses and the decking are lit and in focus',
    sitemap: 'a site map of the house, drawn or marked on an aerial; readable means the roof planes are outlined and labelled and the equipment locations are marked',
    location: 'the wall an electrical panel is mounted on; readable means the whole wall is in frame and the panel can be seen in its surroundings',
    deadoff: 'an electrical panel with its cover removed; readable means the breakers, bus and wiring are visible and in focus',
    meterloc: 'the side of a house with the utility meter; readable means the meter and the wall around it are in frame',
  };

  const SYSTEM = `You check one photo from a home solar site survey for a QA reviewer. You are told what the photo is supposed to show. Say whether a designer could read what they need from it. Be strict: blurry, dark, cropped, glare-covered or wrong-subject photos are not readable. Reply with JSON only: {"readable": true|false, "note": "<one short sentence: what you can read, or why you cannot>"}`;

  function buildRequest(category, imageB64, mediaType) {
    if (!CRITERIA[category]) return null;
    return {
      model: MODEL, max_tokens: 160, system: SYSTEM,
      messages: [{ role: 'user', content: [
        { type: 'image', source: { type: 'base64', media_type: mediaType || 'image/jpeg', data: imageB64 } },
        { type: 'text', text: `This photo should show: ${CRITERIA[category]}.` },
      ] }],
    };
  }

  // The reply is meant to be JSON; take it from inside any stray text, and say so when it is not.
  function parse(text) {
    const m = String(text || '').match(/\{[\s\S]*\}/);
    if (!m) return null;
    try {
      const j = JSON.parse(m[0]);
      if (typeof j.readable !== 'boolean') return null;
      return { readable: j.readable, note: String(j.note || '').replace(/\s+/g, ' ').trim().slice(0, 200) };
    } catch (e) { return null; }
  }

  async function check(client, category, imageB64, mediaType) {
    const req = buildRequest(category, imageB64, mediaType);
    if (!req) return { error: 'unknown_category' };
    const msg = await client.messages.create(req);
    const text = (msg.content || []).filter(b => b.type === 'text').map(b => b.text).join('');
    return parse(text) || { error: 'unreadable_reply' };
  }

  return { MODEL, CRITERIA, SYSTEM, buildRequest, parse, check };
});
