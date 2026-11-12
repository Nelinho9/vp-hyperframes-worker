// Smoke: o grafo vendado carrega em Node nativo (type stripping) sem build step.
import { generateBuildHtmlOnly, MAX_BUILD_RETRIES, buildStoryboardFallbackHtml } from '../build-html/vendor/video-v4-steps/buildStep.ts';
import { createEdgeLintRunner } from '../build-html/vendor/video-v4-steps/edgeLint.ts';

const lint = createEdgeLintRunner();
const fallback = buildStoryboardFallbackHtml('## Frame 1: Hook (0-3s)\n## Frame 2: CTA (3-6s)', '9:16');
const result = await lint.lint(fallback);
console.log('VENDOR_LOAD_OK', typeof generateBuildHtmlOnly, 'MAX_BUILD_RETRIES=' + MAX_BUILD_RETRIES, 'fallback_lint_ok=' + result.ok);
if (!result.ok) {
  console.error('FALLBACK_LINT_ERRORS', result.errors.slice(0, 400));
  process.exit(1);
}