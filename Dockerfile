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

# Chrome Headless Shell gerido pelo HyperFrames (o `render` usa-o em vez do
# chromium de sistema; precisa de unzip para extrair o download).
RUN hyperframes browser ensure || echo "browser ensure falhou — será retomado no boot"

# HyperFrames skills registry (public repo — cloned at build time).
RUN git clone --depth=1 https://github.com/heygen-com/hyperframes /opt/hf-skills

ENV NODE_ENV=production \
    PORT=8787 \
    WORK_DIR=/tmp/hyperframes-worker \
    WORKERS=1 \
    CHROME_PATH=/usr/bin/chromium \
    PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium \
    HYPERFRAMES_NO_SANDBOX=1

WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY server.js preview-token.js preview-helper.js package.json ./
COPY fixtures ./fixtures

RUN mkdir -p $WORK_DIR

EXPOSE 8787

HEALTHCHECK --interval=30s --timeout=10s --start-period=20s --retries=3 \
  CMD wget -qO- http://localhost:8787/health || exit 1

CMD ["node", "server.js"]
