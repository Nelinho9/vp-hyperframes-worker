// Smoke: o grafo vendado dos steps LLM carrega sob Node (type stripping + zod).
import('../llm-step-runner.js')
  .then(async (m) => {
    console.log('LLM_STEP_RUNNER_OK', m.LLM_STEP_SUPPORTED.join(','), typeof m.runLlmStepJob);
    for (const step of m.LLM_STEP_SUPPORTED) {
      if (step === 'audio') continue; // audio usa runAudioPipeline, não StepConfig
      const cfg = m.stepConfigFor(step);
      if (!cfg || cfg.name !== step) throw new Error(`config missing for ${step}`);
    }
    const audio = await import('../build-html/vendor/video-v4-audio/audioPipeline.ts');
    if (typeof audio.runAudioPipeline !== 'function') throw new Error('runAudioPipeline missing');
    console.log('LLM_STEP_CONFIGS_OK');
  })
  .catch((e) => { console.error('FATAL', e.message); process.exit(1); });