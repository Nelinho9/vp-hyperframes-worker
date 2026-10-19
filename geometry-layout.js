import { parseHTML } from 'linkedom';

/** Mirror of geometry-layout.js: inline margin cascade, including shorthand. */
export function readAuthoredMargin(style, side) {
  let value = '0px';
  let important = false;
  for (const decl of (style ?? '').split(';')) {
    const match = /^\s*(margin|margin-left|margin-top)\s*:\s*(.*?)\s*$/i.exec(decl);
    if (!match || (match[1].toLowerCase() !== 'margin' && match[1].toLowerCase() !== `margin-${side}`)) continue;
    const priority = /\s*!important\s*$/i.test(match[2]);
    if (important && !priority) continue;
    let next = match[2].replace(/\s*!important\s*$/i, '').trim();
    if (match[1].toLowerCase() === 'margin') {
      const parts = next.match(/(?:[^\s()]|\([^)]*\))+/g) ?? [];
      if (parts.length < 1 || parts.length > 4) continue;
      next = parts[side === 'top' || parts.length === 1 ? 0 : parts.length === 4 ? 3 : 1];
    }
    value = next;
    important = priority;
  }
  const numeric = /^-?(?:\d+(?:\.\d+)?|\.\d+)px$/.test(value) || /^-?0(?:\.0+)?$/.test(value);
  return { value, pixels: numeric ? Number.parseFloat(value) : null, important };
}

export function setGeometryConsumption(el, property, consumption) {
  const sep = consumption.indexOf(':');
  const name = consumption.slice(0, sep).trim();
  const value = consumption.slice(sep + 1).trim();
  const priority = property === 'x' || property === 'y' ? el.style.getPropertyValue(`--el-margin-priority-${property}`) : '';
  const current = el.style.getPropertyValue(name).trim();
  const currentPriority = typeof el.style.getPropertyPriority === 'function' ? el.style.getPropertyPriority(name) : /!important\s*$/.test(current) ? 'important' : '';
  const order = (el.getAttribute('style') ?? '').split(';').map(d => d.split(':')[0].trim().toLowerCase());
  if (current.replace(/\s*!important\s*$/, '').trim() === value && currentPriority === priority
    && (property !== 'x' && property !== 'y' || order.lastIndexOf(name) > order.lastIndexOf('margin'))) return;
  if (property === 'x' || property === 'y') el.style.removeProperty(name); // after any authored shorthand
  el.style.setProperty(name, value, priority);
  // linkedom has no CSS priority API; preserve priority in its serialization.
  if (priority && typeof el.style.getPropertyPriority !== 'function') el.style.setProperty(name, `${value} !important`);
}

export function prepareLayoutGeometry(el) {
  for (const [axis, side] of [['x', 'left'], ['y', 'top']]) {
    const key = `--el-margin-${axis}`;
    if (!el.style.getPropertyValue(key)) {
      const margin = readAuthoredMargin(el.getAttribute('style'), side);
      if (margin.pixels === null) throw new Error('GEOMETRY_MARGIN_UNRESOLVED');
      el.style.setProperty(key, margin.value);
      if (margin.important) el.style.setProperty(`--el-margin-priority-${axis}`, 'important');
    }
    if (readAuthoredMargin(`margin-${side}:${el.style.getPropertyValue(key)}`, side).pixels === null) throw new Error('GEOMETRY_MARGIN_UNRESOLVED');
  }
  if (/^var\(--el-x,\s*0px\)\s+var\(--el-y,\s*0px\)$/.test(el.style.getPropertyValue('translate').trim())) {
    el.style.removeProperty('translate');
    for (const [axis, side] of [['x', 'left'], ['y', 'top']]) {
      setGeometryConsumption(el, axis, `margin-${side}: calc(var(--el-margin-${axis}, 0px) + var(--el-${axis}, 0px))`);
    }
  }
}

/** Migrate only the editor's old translate consumer, before GSAP parses it.
 * Canonical bytes remain the publication authority; this is a render/serve copy.
 * Authored transforms and unrelated individual translations stay untouched.
 */
export function normalizeManualGeometry(html) {
  if (!/translate\s*:\s*var\(--el-x/.test(html)) return html;
  const { document } = parseHTML(html);
  let changed = false;
  for (const el of document.querySelectorAll('[style]')) {
    if (!/^var\(--el-x,\s*0px\)\s+var\(--el-y,\s*0px\)$/.test(el.style.getPropertyValue('translate').trim())) continue;
    const initialStyle = el.getAttribute('style');
    try { prepareLayoutGeometry(el); } catch { el.setAttribute('style', initialStyle); continue; }
    changed = true;
  }
  return changed ? document.toString() : html;
}
