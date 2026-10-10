// @vitest-environment node
/**
 * preview-helper-f06.test.ts — F06.02/F06.06 (V5.34):
 * envelope versionado com props reais por tipo, leitores partilhados
 * click/element-bbox, sessão inline multiline/Esc/paste sem innerHTML e
 * capabilities trim/speed/ducking unsupported.
 */
import { describe, expect, it } from "vitest";
import { PREVIEW_HELPER_SCRIPT } from "./preview-helper.js";

describe("PREVIEW_HELPER_SCRIPT x F06 (propriedades/persistencia)", () => {
  it("select usa envelope versionado com source hf-preview", () => {
    expect(PREVIEW_HELPER_SCRIPT).toContain("SELECTION_ENVELOPE_VERSION");
    expect(PREVIEW_HELPER_SCRIPT).toContain("buildSelectEnvelope(el, 'select')");
    expect(PREVIEW_HELPER_SCRIPT).toContain("envelopeVersion: SELECTION_ENVELOPE_VERSION");
  });

  it("click e element-bbox partilham os mesmos leitores (sem duplicacao)", () => {
    expect(PREVIEW_HELPER_SCRIPT).toContain("function buildSelectEnvelope(");
    expect(PREVIEW_HELPER_SCRIPT).toContain("function readAuthoredAttrs(");
    expect(PREVIEW_HELPER_SCRIPT).toContain("sendToParent(buildSelectEnvelope(fbEl, 'element-bbox'))");
  });

  it("inclui conteudo textual e attrs authored de animacao/audio + timing + capacidade", () => {
    expect(PREVIEW_HELPER_SCRIPT).toContain("out.text = el.textContent");
    expect(PREVIEW_HELPER_SCRIPT).toContain("data-anim-in");
    expect(PREVIEW_HELPER_SCRIPT).toContain("parseAudioAttrs(el)");
    expect(PREVIEW_HELPER_SCRIPT).toContain("data-kf");
    expect(PREVIEW_HELPER_SCRIPT).toContain("out.timing");
    expect(PREVIEW_HELPER_SCRIPT).toContain("editableAsText");
  });

  it("capability declara trim/speed/ducking unsupported", () => {
    expect(PREVIEW_HELPER_SCRIPT).toContain("supportsTrim: false");
    expect(PREVIEW_HELPER_SCRIPT).toContain("supportsSpeed: false");
    expect(PREVIEW_HELPER_SCRIPT).toContain("supportsDucking: false");
  });

  it("inline: Enter insere linha, Ctrl/Cmd+Enter confirma, Esc cancela sem persistir", () => {
    expect(PREVIEW_HELPER_SCRIPT).toContain("finishEdit(true)");
    expect(PREVIEW_HELPER_SCRIPT).toContain("finishEdit(false)");
    expect(PREVIEW_HELPER_SCRIPT).toContain("msg.cancelled = cancelled === true");
    expect(PREVIEW_HELPER_SCRIPT).toContain("ev.ctrlKey || ev.metaKey");
  });

  it("paste insere texto puro; nunca innerHTML de conteudo do utilizador", () => {
    expect(PREVIEW_HELPER_SCRIPT).toContain("onEditPaste");
    expect(PREVIEW_HELPER_SCRIPT).toContain("getData('text/plain')");
    expect(PREVIEW_HELPER_SCRIPT).not.toContain("el.innerHTML = originalText");
    expect(PREVIEW_HELPER_SCRIPT).not.toContain(".innerHTML = value");
  });
});
