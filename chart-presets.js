/**
 * chart-presets — E06: static materialization of `data-vp-chart` graphics.
 *
 * The composition authors ONE JSON attribute on the chart root. This module
 * injects a single static `<script id="__vp-chart-materialized__">` before
 * `</body>`; the ES5 applier derives every chart from the DOM at boot and after
 * a hot-swap, so preview, reload and render see the same static DOM. There is
 * no timeline work and no seek dependence: seeking cannot change a chart.
 *
 * Security: all authored strings are rendered with `textContent`; the root
 * attribute is JSON-parsed with a hard six-column shape.
 *
 * Mirror of `visttapro/src/video/v4/graphicsCatalog.ts` (CHART_CANONICAL_JSON,
 * bar height formula, six classes). Parity is asserted in both repos.
 */

export const CHART_BLOCK_ID = "__vp-chart-materialized__";
export const CHART_APPLY_FN_NAME = "__vpApplyCharts";
export const CHART_BARS = 6;
export const CHART_MAX_BAR_PX = 210;

/** Canonical contract — IDENTICAL to the frontend CHART_CANONICAL_JSON. */
export const CHART_CANONICAL_JSON = JSON.stringify({
  bars: CHART_BARS,
  maxBarPx: CHART_MAX_BAR_PX,
  version: 1,
});

/**
 * ES5 applier. Executed by the static block at boot and embedded in the
 * preview helper for hot-swap. Idempotent per attribute value.
 */
export const CHART_APPLY_SOURCE = [
  "function __vpApplyCharts() {",
  "  var doc = document;",
  "  var hosts = doc.querySelectorAll('[data-vp-chart]');",
  "  for (var hi = 0; hi < hosts.length; hi++) {",
  "    var host = hosts[hi];",
  "    if (!host || !host.getAttribute) continue;",
  "    var raw = host.getAttribute('data-vp-chart') || '';",
  "    if (host.__vpChartRaw === raw) continue;",
  "    var spec;",
  "    try { spec = JSON.parse(raw); } catch (eParse) { continue; }",
  "    if (!spec || typeof spec !== 'object') continue;",
  "    var labels = Array.isArray(spec.labels) ? spec.labels : [];",
  "    var values = Array.isArray(spec.values) ? spec.values : [];",
  "    if (labels.length !== " + CHART_BARS + " || values.length !== " + CHART_BARS + ") continue;",
  "    var unit = typeof spec.unit === 'string' ? spec.unit : '';",
  "    var unitText = unit ? '(' + unit + ')' : '';",
  "    var title = typeof spec.title === 'string' ? spec.title : '';",
  "    var series = typeof spec.series === 'string' ? spec.series : '';",
  "    var source = typeof spec.source === 'string' ? spec.source : '';",
  "    var accent = typeof spec.accent === 'string' ? spec.accent : '#c8ff3d';",
  "    var textColor = typeof spec.textColor === 'string' ? spec.textColor : '#ffffff';",
  "    var background = typeof spec.background === 'string' ? spec.background : 'rgba(12,12,16,0.88)';",
  "    var maxValue = 0;",
  "    var nums = [];",
  "    for (var vi = 0; vi < " + CHART_BARS + "; vi++) {",
  "      var v0 = Number(values[vi]);",
  "      if (!isFinite(v0) || v0 < 0) v0 = 0;",
  "      nums.push(v0);",
  "      if (v0 > maxValue) maxValue = v0;",
  "    }",
  "    host.style.background = background;",
  "    host.style.color = textColor;",
  "    while (host.firstChild) host.removeChild(host.firstChild);",
  "    function mk(tag, cls, style, text) {",
  "      var node = doc.createElement(tag);",
  "      if (cls) node.className = cls;",
  "      if (style) node.setAttribute('style', style);",
  "      if (text !== undefined && text !== null) node.textContent = String(text);",
  "      return node;",
  "    }",
  "    var head = mk('div', 'gfx-chart-head', 'display:flex;align-items:flex-end;justify-content:space-between;gap:12px');",
  "    var headLeft = mk('div', '', 'min-width:0');",
  "    headLeft.appendChild(mk('div', 'gfx-chart-title', 'font-size:30px;font-weight:700;line-height:1.1;white-space:nowrap;overflow:hidden;text-overflow:ellipsis', title));",
  "    headLeft.appendChild(mk('div', 'gfx-chart-series', 'font-size:14px;opacity:0.72;margin-top:4px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis', series));",
  "    head.appendChild(headLeft);",
  "    if (unitText) head.appendChild(mk('div', 'gfx-chart-unit', 'font-size:14px;font-weight:600;opacity:0.8;white-space:nowrap', unitText));",
  "    host.appendChild(head);",
  "    var grid = mk('div', 'gfx-chart-grid', 'flex:1;display:flex;align-items:flex-end;gap:10px;min-height:0;border-bottom:1px solid rgba(255,255,255,0.14);padding-bottom:8px');",
  "    for (var ci = 0; ci < " + CHART_BARS + "; ci++) {",
  "      var value = nums[ci];",
  "      var h = 0;",
  "      if (value > 0 && maxValue > 0) {",
  "        h = Math.round((value / maxValue) * " + CHART_MAX_BAR_PX + ");",
  "        if (h < 6) h = 6;",
  "      }",
  "      var col = mk('div', 'gfx-chart-col', 'flex:1;display:flex;flex-direction:column;align-items:center;justify-content:flex-end;gap:8px;min-width:0');",
  "      var rounded = Math.round(value * 100) / 100;",
  "      col.appendChild(mk('div', 'gfx-chart-value', 'font-size:16px;font-weight:700;line-height:1', String(rounded) + unit));",
  "      col.appendChild(mk('div', 'gfx-chart-bar', 'width:100%;max-width:64px;height:' + h + 'px;background-color:' + accent + ';border-radius:8px 8px 2px 2px'));",
  "      col.appendChild(mk('div', 'gfx-chart-label', 'font-size:14px;line-height:1.2;opacity:0.82;text-align:center;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:100%', labels[ci]));",
  "      grid.appendChild(col);",
  "    }",
  "    host.appendChild(grid);",
  "    host.appendChild(mk('div', 'gfx-chart-source', 'font-size:12px;line-height:1.3;opacity:0.6;white-space:nowrap;overflow:hidden;text-overflow:ellipsis', source));",
  "    host.__vpChartRaw = raw;",
  "    host.setAttribute('data-vp-chart-rendered', '1');",
  "  }",
  "}",
].join("\n");

/** True when a patch batch writes the chart transport. */
export function touchesChartProps(patches) {
  if (!Array.isArray(patches)) return false;
  for (const patch of patches) {
    if (patch && patch.property === "chart") return true;
  }
  return false;
}

/**
 * Insert/refresh/remove the static chart block in a composition HTML string.
 * The block is derived from the DOM at boot, so only presence/absence matters.
 */
export function upsertChartBlock(html) {
  if (typeof html !== "string") return html;
  const without = html.replace(
    new RegExp(`<script id="${CHART_BLOCK_ID}">[\\s\\S]*?<\\/script>`, "gi"),
    "",
  );
  if (!/\sdata-vp-chart\s*=/.test(without)) return without;
  const tag = `<script id="${CHART_BLOCK_ID}">(${CHART_APPLY_SOURCE})();</script>`;
  const bodyClose = without.search(/<\/body>/i);
  if (bodyClose === -1) return `${without}\n${tag}`;
  return `${without.slice(0, bodyClose)}${tag}\n${without.slice(bodyClose)}`;
}
