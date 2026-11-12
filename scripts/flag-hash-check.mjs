// Compara o hash SHA-256 do flag V4_LLM_STEPS_ON_WORKER (devolvido pela
// Management API) com candidatos locais. Confirma se 'quality' está na flag.
import { createHash } from 'node:crypto';
const target = 'a2ec2b6d4456ace0dbdec35aad298932557fc0142717b81fbf83d9f7bf506759';
const sha = (s) => createHash('sha256').update(s).digest('hex');
console.log('sha256("true") =', sha('true'), '(esperado b5bea41b... para V4_2_STEPS/V4_BUILD_ON_WORKER)');
const candidates = [
  'design,storyboard,audio,visual,quality',
  'design,storyboard,visual,audio,quality',
  'design,storyboard,audio,visual',
  'design,storyboard,visual',
  'design,storyboard,audio,visual,quality ',
  ' design,storyboard,audio,visual,quality',
  'design, storyboard, audio, visual, quality',
  'all',
  'true',
  'design,storyboard,audio,visual,quality,build',
];
let matched = null;
for (const c of candidates) {
  const h = sha(c);
  const hit = h === target;
  console.log(hit ? 'MATCH' : '     ', JSON.stringify(c), h.slice(0, 16));
  if (hit) matched = c;
}
console.log('RESULT', matched === null ? 'NO_MATCH (flag value differs from all candidates)' : `FLAG=${JSON.stringify(matched)} includesQuality=${matched.includes('quality')}`);