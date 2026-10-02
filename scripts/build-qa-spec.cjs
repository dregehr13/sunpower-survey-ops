#!/usr/bin/env node
// scripts/build-qa-spec.cjs — Site Capture form JSON → qa/specs/sitecapture-v<N>.json
//
// The form export is the template's own definition: every field, its type,
// whether it is required and what answer makes it appear. Flattening it into
// one ordered list is what lets the parser walk a report against the template
// instead of guessing at labels, and lets the QA page say which template
// fields no rule reads.
//   node scripts/build-qa-spec.cjs "<path to Site_Survey_Form_V.13.json>"
const fs = require('fs');
const path = require('path');

const src = process.argv[2];
if (!src) { console.error('usage: build-qa-spec.cjs <form.json>'); process.exit(1); }
const form = JSON.parse(fs.readFileSync(src, 'utf8'));

// The form's own key names the version (site_survey_form_v14 -> sitecapture-v14), so each
// form version gets its own spec and older reports keep reading against theirs.
const ver = (String(form.projectKey || '').match(/_v(\d+)$/) || [])[1];
if (!ver) { console.error(`no version in projectKey "${form.projectKey}"`); process.exit(1); }
const specId = 'sitecapture-v' + ver;

const norm = s => String(s || '').replace(/\s+/g, ' ').trim();
const fields = [];
let order = 0;

function addField(f, section, group) {
  const label = norm(f.displayName);
  const photoMin = (label.match(/(\d+)\+\s*(?:overlapping\s+)?photo/i) || [])[1];
  const opts = (f.fieldOptions || []).map(o => o.value || o.name).filter(Boolean);
  fields.push({
    key: f.fieldKey,
    label,
    type: f.type,
    section: section.sectionKey,
    group: group || null,
    required: !!f.required,
    dependsOnKey: f.dependsOnKey || null,
    dependsOnValue: f.dependsOnValue === undefined ? null : f.dependsOnValue,
    photoRequired: /photo/i.test(f.validationTypeDisplay || '') && /always required/i.test(f.validationTypeDisplay || ''),
    commentRequired: /comment/i.test(f.validationTypeDisplay || '') && /always required/i.test(f.validationTypeDisplay || ''),
    minPhotos: photoMin ? Number(photoMin) : null,
    options: opts.length ? opts : undefined,
    order: order++,
  });
}

const groups = {};
for (const s of form.sections) {
  for (const f of s.fields) {
    if (f.isGroup) {
      // idKey is the field whose answer names the instance ("MP1", "SP1",
      // "Meter 1") — the report's photo captions refer to a group instance by
      // that name, so it is how a photo is tied back to its plane or panel.
      groups[f.groupKey] = { key: f.groupKey, name: f.name, section: s.sectionKey, idKey: f.groupFields[0].fieldKey };
      for (const g of f.groupFields) addField(g, s, f.groupKey);
    } else addField(f, s, null);
  }
}

const spec = {
  id: specId,
  vendor: 'sitecapture',
  title: form.title,
  formId: form.id,
  generatedFrom: path.basename(src),
  sections: form.sections.map(s => ({ key: s.sectionKey, title: s.title })),
  groups,
  fields,
};
fs.writeFileSync(path.join(__dirname, '..', 'qa', 'specs', specId + '.json'), JSON.stringify(spec, null, 1) + '\n');
console.log(`${specId}: ${fields.length} fields, ${Object.keys(groups).length} groups, ${fields.filter(f => f.type === 'FOTO').length} photo fields`);
