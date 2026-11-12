/**
 * sfxCatalog.ts — F03.6: catálogo/eventos SFX básicos.
 *
 * F03 até 01A: sem capability real de SFX (budget 0 EUR, sem assets). Por isso
 * `SFX_SUPPORTED=false`: UI indica ausência de suporte e o servidor rejeita
 * `sfx:on` com erro acionável, em vez de fingir que o toggle funciona.
 * Quando houver asset ID/proveniência/licença/timing/gain/fade/capability real,
 * ligar `SFX_SUPPORTED=true` e preencher `SFX_TRACKS`.
 */

export const SFX_SUPPORTED = false as const;
export const SFX_CATALOG_VERSION = 1 as const;

export interface SfxTrack {
  id: string;
  file: string;
  title: string;
  provenance: string;
  license: string;
  durationSec: number;
}

export const SFX_TRACKS: readonly SfxTrack[] = [];

export interface SfxEvent {
  assetId: string;
  start: number;
  end: number;
  gain?: number;
  fadeInMs?: number;
  fadeOutMs?: number;
}

export function validateSfxRequest(args: {
  sfx: string;
  events?: SfxEvent[] | null;
}): { ok: true } | { ok: false; code: string; detail: string } {
  if (args.sfx !== "on") return { ok: true };
  if (SFX_SUPPORTED === false) {
    return {
      ok: false,
      code: "SFX_NOT_SUPPORTED",
      detail: "SFX:on pedido mas a capability SFX não está disponível nesta fase (sem catálogo real). Usa sfx:off/auto ou aguarda F07.",
    };
  }
  const events = Array.isArray(args.events) ? args.events : [];
  if (events.length === 0) {
    return { ok: false, code: "SFX_EVENTS_MISSING", detail: "SFX:on exige eventos com asset ID, timing, gain/fade." };
  }
  for (let i = 0; i < events.length; i++) {
    const e = events[i];
    if (!e || typeof e.assetId !== "string" || !e.assetId.trim()) {
      return { ok: false, code: "SFX_ASSET_INVALID", detail: `Evento SFX ${i} sem asset ID/proveniência/licença.` };
    }
    if (typeof e.start !== "number" || typeof e.end !== "number" || !(e.end > e.start) || e.start < 0) {
      return { ok: false, code: "SFX_TIMING_INVALID", detail: `Evento SFX ${e.assetId} com janela inválida.` };
    }
  }
  return { ok: true };
}
