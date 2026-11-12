# ═══════════════════════════════════════════════════════════════════════════
# VisttaPro HyperFrames Render Worker — V4-1 (Coolify / docker-compose)
#
# Multi-stage build (R2: keep the final image lean):
#   deps stage  — installs worker npm dependencies
#   runtime     — chromium + ffmpeg + vendored fonts + hyperframes CLI (pinned)
#
# Worker is DUMB: no Supabase secrets baked in — CALLBACK/preview secrets and
# signed URLs arrive per-job from the orchestrator edge.
# ═══════════════════════════════════════════════════════════════════════════

# ── Stage 1: dependencies ───────────────────────────────────────────────────
FROM node:22-bookworm-slim AS deps
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm install --omit=dev && npm cache clean --force

# ── Stage 2: runtime ────────────────────────────────────────────────────────
FROM node:22-bookworm-slim AS runtime

# Chromium + FFmpeg + fonts (R4: fonts vendored via apt packages — no Google
# CDN at render time; composition fonts are additionally bundled in fixtures).
RUN apt-get update && apt-get install -y --no-install-recommends \
    chromium \
    chromium-sandbox \
    ffmpeg \
    fonts-inter \
    fonts-liberation \
    fonts-noto-color-emoji \
    ca-certificates \
    git \
    wget \
    tar \
    unzip \
    && rm -rf /var/lib/apt/lists/*

# HyperFrames CLI pinned (V4-0 spike version — determinism contract).
RUN npm install -g hyperframes@0.7.109 && npm cache clean --force

# The pinned CLI can start a detached global npm auto-install even on a
# non-TTY build. Disable it before browser ensure and during worker runtime.
ENV HYPERFRAMES_NO_UPDATE_CHECK=1 \
    HYPERFRAMES_NO_AUTO_INSTALL=1

# Chrome Headless Shell gerido pelo HyperFrames (o `render` usa-o em vez do
# chromium de sistema; precisa de unzip para extrair o download).
RUN hyperframes browser ensure || echo "browser ensure falhou — será retomado no boot"

ENV NODE_ENV=production \
    PORT=8787 \
    WORK_DIR=/tmp/hyperframes-worker \
    WORKERS=1 \
    CHROME_PATH=/usr/bin/chromium \
    PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium \
    HYPERFRAMES_NO_SANDBOX=1

WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
# Wildcard: a lista explícita já falhou 2x (media-preloader.js em fba2377;
# patch-engine.js + composition-sanitizer.js em d40beaf — deploy 22-08-2026
# com ERR_MODULE_NOT_FOUND e rollback do Coolify). Testes são *.ts, ficam fora.
COPY package.json *.js ./
# F1 (plano v2): grafo vendado do build HTML (.ts puros, type stripping nativo
# do Node >= 22.18) + PROVENANCE.json. Os testes *.ts do vendor NÃO são copiados.
COPY build-html ./build-html
COPY fixtures ./fixtures
COPY bgm ./bgm

# Guard de build: falha cedo (com mensagem clara) se algum import local do
# grafo server.js não existir na imagem — antes disto, o crash só aparecia no
# boot (ERR_MODULE_NOT_FOUND) após o build, em crash-loop.
# Incidente 12-11-2026 (deploy forrkp0ise6esf46xz1qxyrq): o guard inline
# resolvia specs a partir da RAIZ (flat) e dava falsos positivos no grafo
# vendado; o script resolve relativo ao importador (como docker-copy.test.ts).
COPY scripts/docker-import-guard.mjs ./scripts/docker-import-guard.mjs
RUN node scripts/docker-import-guard.mjs

# F1 (plano v2): o grafo vendado do build-html (.ts) tem de carregar na imagem
# com o type stripping nativo do Node — falha cedo no build, não no boot.
RUN node --input-type=module -e "import('./build-html-runner.js').then(() => console.log('build-html graph OK')).catch((e) => { console.error('FATAL — build-html graph:', e.message); process.exit(1); })"

# F2 (plano v2): o runner llm-step (motor runStep vendado + zod local) também
# tem de carregar na imagem — mesmo guard de build.
RUN node --input-type=module -e "import('./llm-step-runner.js').then(() => console.log('llm-step graph OK')).catch((e) => { console.error('FATAL — llm-step graph:', e.message); process.exit(1); })"

RUN mkdir -p $WORK_DIR

EXPOSE 8787

HEALTHCHECK --interval=30s --timeout=10s --start-period=20s --retries=3 \
  CMD wget -qO- http://localhost:8787/health || exit 1

CMD ["node", "server.js"]
