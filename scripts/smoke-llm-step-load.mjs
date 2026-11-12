// Smoke: o grafo vendado dos steps LLM carrega sob Node (type stripping + zod).
import('../llm-step-runner.js')
  .then((m) => {
    console.log('LLM_STEP_RUNNER_OK', m.LLM_STEP_SUPPORTED.join(','), typeof m.runLlmStepJob);
    for (const step of m.LLM_STEP_SUPPORTED) {
      const cfg = m.stepConfigFor(step);
      if (!cfg || cfg.name !== step) throw new Error(`config missing for ${step}`);
    }
    console.log('LLM_STEP_CONFIGS_OK');
  })
  .catch((e) => { console.error('FATAL', e.message); process.exit(1); });