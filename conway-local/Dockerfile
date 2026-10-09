FROM node:22-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends git openssl python3 make g++ \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
RUN corepack enable && corepack prepare pnpm@10.28.1 --activate
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/cli/package.json ./packages/cli/package.json
RUN pnpm install --frozen-lockfile
COPY . .
RUN pnpm build && mkdir -p /state /workspace /control && chown node:node /state /workspace /control
ENV AUTOMATON_DIR=/state
ENV AUTOMATON_WORKSPACE=/workspace
ENV LOG_LEVEL=debug
USER node
CMD ["node", "conway-local/setup.mjs", "--state-dir", "/state", "--status"]
