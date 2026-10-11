/**
 * audio-timeline — F07.02/F07.06 worker mirror (V5.34).
 *
 * Paridade semântica com o espelho app: derivação nunca exclui por cena,
 * replan nunca corta frases.
 */
import { describe, expect, it } from 'vitest';
import { deriveAudioClips, inferAudioRole, replanVoiceWindows, secondsToFrames } from './audio-timeline.js';

describe('worker audio-timeline — deriveAudioClips', () => {
  it('voz/música/SFX + global preservado', () => {
    const clips = deriveAudioClips([
      { id: 'scene-1-voice-1', type: 'audio', sceneId: 'scene-1', start: 0.4, duration: 5.9, srcAssetUrl: 'a.mp3' },
      { id: 'bgm-main', type: 'audio', sceneId: null, scope: 'composition', start: 0, duration: 15, assetRef: 'b.mp3' },
      { id: 'scene-2-sfx-1', type: 'audio', sceneId: 'scene-2', start: 1, duration: 0.5, srcAssetUrl: 'c.mp3' },
    ]);
    expect(clips.map((c) => c.clipId)).toEqual(['scene-1-voice-1', 'bgm-main', 'scene-2-sfx-1']);
    expect(clips[1].scope).toBe('composition');
  });
  it('inferAudioRole: bgm-main → music', () => {
    expect(inferAudioRole({ id: 'bgm-main' })).toBe('music');
  });
  it('sem source → unavailable', () => {
    const [clip] = deriveAudioClips([{ id: 'scene-1-voice-1', type: 'audio', sceneId: 'scene-1', duration: 2 }]);
    expect(clip.wave).toBe('unavailable');
  });
});

describe('worker audio-timeline — timing/regeneração', () => {
  it('secondsToFrames explícito', () => {
    expect(secondsToFrames(1.5, 30)).toBe(45);
  });
  it('overflow 5.92s/3s exige replan (nunca corte)', () => {
    const r = replanVoiceWindows([{ clipId: 'v', windowStart: 0, windowEnd: 3, measuredDuration: 5.92 }]);
    expect(r.ok).toBe(false);
  });
});

describe('worker audio-timeline — reparo F12 (composition-audio + sceneId por janela)', () => {
  const legacyRows = [
    { id: 'scene-1-voice-1', type: 'audio', role: 'composition-audio', sceneId: null, scope: 'composition', start: 0, duration: 3, assetRef: 'projects/p/audio/vo-1.wav' },
    { id: 'bgm-main', type: 'audio', role: 'composition-audio', sceneId: null, scope: 'composition', start: 0, duration: 15, assetRef: 'bgm/deep-confidence.mp3' },
  ];
  const windows = [{ id: 'scene-1', start: 0, duration: 3 }];
  it("role composition-audio cai à inferência por id (paridade app)", () => {
    expect(inferAudioRole({ id: 'scene-1-voice-1', role: 'composition-audio' })).toBe('voice');
    expect(inferAudioRole({ id: 'bgm-main', role: 'composition-audio' })).toBe('music');
  });
  it('voz sem sceneId ganha a cena da janela (paridade app)', () => {
    const clips = deriveAudioClips(legacyRows, { sceneWindows: windows });
    expect(clips.find((c) => c.clipId === 'scene-1-voice-1')?.sceneId).toBe('scene-1');
    expect(clips.find((c) => c.clipId === 'bgm-main')?.sceneId).toBeNull();
    expect(clips.filter((c) => c.role === 'voice')).toHaveLength(1);
  });
});
