'use strict';
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');
const root = path.resolve(__dirname, '../../../..');
const backend = path.join(root, 'backend');
const canonical = require(path.join(backend, 'modules/canonicalOutput'));
const source = fs.readFileSync(path.join(backend, 'videoProcessor.js'), 'utf8');
const start = source.indexOf('const MODEL_FRAME_EVIDENCE_MAX_DISTANCE_SECONDS =');
const end = source.indexOf('\nfunction publishCanonicalOutput(', start);
if (start < 0 || end < start) throw new Error('Cannot locate pure adapter');
const sandbox = { ...canonical };
vm.createContext(sandbox);
vm.runInContext(source.slice(start, end) + '\nthis.validateSaved = canonicalizeModelOutput;', sandbox);
for (const runName of process.argv.slice(2)) {
  const runDir = path.resolve(runName);
  const input = JSON.parse(fs.readFileSync(path.join(runDir, 'input_context.json'), 'utf8'));
  const result = JSON.parse(fs.readFileSync(path.join(runDir, 'result.json'), 'utf8'));
  const summary = [];
  for (const model of result.models.filter(m => m.outputFile)) {
    const raw = fs.readFileSync(path.join(runDir, model.outputFile), 'utf8');
    const validated = sandbox.validateSaved(raw, {
      duration: Math.floor(input.duration), audioLanguage: input.audioLanguage,
      dialogueTrack: input.dialogueTrack, dialogueTimestampTolerance: 1,
      frameEvidence: input.frames.map(f => ({ timestamp: f.timestamp }))
    });
    const out = path.join(runDir, 'validation'); fs.mkdirSync(out, { recursive: true });
    fs.writeFileSync(path.join(out, model.model + '.json'), JSON.stringify(validated, null, 2));
    fs.writeFileSync(path.join(out, model.model + '.accepted.txt'), validated.accepted.map(e => `[${e.timestamp}][${e.tag}] ${e.text}`).join('\n'));
    summary.push({ model: model.requestedModel, rawLines: raw.split(/\r?\n/).filter(Boolean).length,
      accepted: validated.accepted.length, excluded: validated.events.filter(e => e.validationStatus !== 'accepted').map(e => ({ rawLine: e.rawLine, reasons: e.validationReasons })),
      changed: validated.accepted.filter(e => e.rawLine !== `[${e.timestamp}][${e.tag}] ${e.text}`).length });
  }
  const provenance = { source: 'pure backend adapter loaded via vm; no DB/API/TTS calls', videoProcessorSha256: crypto.createHash('sha256').update(source).digest('hex'), canonicalOutputSha256: crypto.createHash('sha256').update(fs.readFileSync(path.join(backend, 'modules/canonicalOutput.js'))).digest('hex'), summary };
  fs.writeFileSync(path.join(runDir, 'validation_summary.json'), JSON.stringify(provenance, null, 2));
  console.log(JSON.stringify(provenance, null, 2));
}
