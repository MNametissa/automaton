FROM node:22-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends git openssl python3 make g++ \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
RUN corepack enable && corepack prepare pnpm@10.28.1 --activate
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/cli/package.json ./packages/cli/package.json
RUN pnpm install --frozen-lockfile
RUN apt-get update && apt-get install -y --no-install-recommends python3-venv procps \
    && rm -rf /var/lib/apt/lists/*
COPY conway-local/install-analysis-tools.mjs ./conway-local/install-analysis-tools.mjs
COPY conway-local/analysis-tools/ ./conway-local/analysis-tools/
RUN node conway-local/install-analysis-tools.mjs --prefix /opt/analysis-tools
RUN python3 -m venv /opt/supervisor && /opt/supervisor/bin/pip install --no-cache-dir supervisor==4.3.0
RUN apt-get update && apt-get install -y --no-install-recommends chromium xvfb x11vnc novnc websockify fluxbox \
    && rm -rf /var/lib/apt/lists/*
COPY conway-local/browser-tools/package*.json /opt/browser-tools/
RUN cd /opt/browser-tools && npm ci --ignore-scripts --no-audit --no-fund
COPY . .
RUN pnpm build && mkdir -p /state /workspace /control /run/operator-secrets && chown node:node /state /workspace && chmod 0700 /control /run/operator-secrets
ENV AUTOMATON_DIR=/state
ENV AUTOMATON_WORKSPACE=/workspace
ENV AUTOMATON_ANALYSIS_RUNTIME=/opt/analysis-tools
ENV AUTOMATON_ANALYSIS_STATE=/state/analysis
ENV LOG_LEVEL=debug
ENV PATH="/opt/supervisor/bin:${PATH}"
ENV SUPERVISORD_BIN=/opt/supervisor/bin/supervisord
ENV AUTOMATON_BROWSER_CLI=/opt/browser-tools/node_modules/@playwright/cli/playwright-cli.js
ENV AUTOMATON_BROWSER_EXECUTABLE=/usr/bin/chromium
ENV AUTOMATON_BROWSER_STATE=/state/browser
USER node
CMD ["node", "conway-local/setup.mjs", "--state-dir", "/state", "--status"]
