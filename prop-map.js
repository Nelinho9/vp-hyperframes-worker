/**
 * prop-map — V5-P0B (AD-1): tabela canónica de props do inspector → CSS
 *
 * Espelho OBRIGATÓRIO de `visttapro/src/video/v4/propMap.ts` (repos separados
 * não partilham import; a paridade é garantida por PROP_MAP_CANONICAL_JSON,
 * testada byte-a-byte nos dois repos).
 *
 * Regra AD-1: a geometria do editor NUNCA escreve left/top/right/bottom em
 * elementos geridos pelo runtime. Escreve CSS custom properties (`--el-*`)
 * consumidas no próprio elemento por individual transforms / layout vars.
 *
 * Doc: docs/video-engine/V5_P0B_GEOMETRIA_TRANSFORM.md §2
 */

/** @type {Record<string, {output: string, kind: 'decl'|'geom', unit: string}>} */
export const PROP_MAP = {
  font: { output: "font-family", kind: "decl", unit: "" },
  size: { output: "font-size", kind: "decl", unit: "px" },
  weight: { output: "font-weight", kind: "decl", unit: "" },
  color: { output: "color", kind: "decl", unit: "" },
  opacity: { output: "opacity", kind: "decl", unit: "" },
  x: { output: "--el-x", kind: "geom", unit: "px" },
  y: { output: "--el-y", kind: "geom", unit: "px" },
  width: { output: "--el-w", kind: "geom", unit: "px" },
  height: { output: "--el-h", kind: "geom", unit: "px" },
  rotation: { output: "--el-rotate", kind: "geom", unit: "deg" },
};

/** Serialização canónica — espelhada num teste do frontend (paridade CI). */
export const PROP_MAP_CANONICAL_JSON = JSON.stringify(PROP_MAP);

/** Declarações de consumo, por prop de geometria (x/y partilham translate). */
export const GEOM_CONSUMPTION = {
  x: "translate: var(--el-x, 0px) var(--el-y, 0px)",
  y: "translate: var(--el-x, 0px) var(--el-y, 0px)",
  width: "width: var(--el-w)",
  height: "height: var(--el-h)",
  rotation: "rotate: var(--el-rotate, 0deg)",
};

/**
 * Declaração de consumo que deve acompanhar a escrita da var de uma prop de
 * geometria (ou `null` para props decl/desconhecidas).
 * @param {string} property
 * @returns {string | null}
 */
export function consumptionFor(property) {
  return Object.prototype.hasOwnProperty.call(GEOM_CONSUMPTION, property)
    ? GEOM_CONSUMPTION[property]
    : null;
}

/**
 * Converte a posição absoluta desejada num delta de translate relativamente ao
 * baseline authored (rect no helper; `left/top` inline no worker).
 * @param {number} baseline
 * @param {number} desired
 * @returns {number}
 */
export function computeGeomDelta(baseline, desired) {
  return desired - baseline;
}
