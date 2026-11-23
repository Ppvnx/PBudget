# PBudget — Next.js + Prisma. Single-stage for reliability (homelab scale):
# keep node_modules so the next CLI serves and the prisma CLI is there for
# scripts/migrate.sh (run once per deploy as a Job, never at container start).
FROM node:22-slim

# Prisma needs openssl at runtime.
RUN apt-get update \
  && apt-get install -y --no-install-recommends openssl ca-certificates \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Google's Antigravity CLI: the worker reads screenshots with Gemini through it
# (src/lib/agy.ts). Pinned by version and sha512 from the release manifest
# (antigravity-cli-auto-updater-974169037036.us-central1.run.app/manifests/linux_amd64.json),
# the same build TLDRadar runs. Bump both lines together.
ARG AGY_URL=https://storage.googleapis.com/antigravity-public/antigravity-cli/1.5.14-5302690847260672/linux-x64/cli_linux_x64.tar.gz
ARG AGY_SHA512=83311d3f354567612dc16c1ae2ea9b503d6f6833aa4e138d39aa229da3f3bb99b0e4d7cca0bce4796b0060d6a51d8113eb7449ed5dc0e7900bf217107ea5bff9
RUN node -e "fetch(process.argv[1]).then(async (r) => { if (!r.ok) throw new Error(r.status); require('fs').writeFileSync('/tmp/agy.tgz', Buffer.from(await r.arrayBuffer())); })" "$AGY_URL" \
  && echo "$AGY_SHA512  /tmp/agy.tgz" | sha512sum -c - \
  && tar -xzf /tmp/agy.tgz -C /tmp antigravity \
  && install -m 755 /tmp/antigravity /usr/local/bin/agy \
  && rm -f /tmp/agy.tgz /tmp/antigravity

# Install deps first. prisma/ is copied before `npm ci` so the postinstall
# `prisma generate` finds the schema.
COPY package*.json ./
COPY prisma ./prisma
RUN npm ci

COPY . .

# Prod runs on the shared postgres-ai cluster. Swapping the Prisma provider
# from sqlite -> postgresql is the ONLY change needed to move databases
# (CLAUDE.md); DATABASE_URL comes from Vault at runtime.
RUN sed -i 's/provider = "sqlite"/provider = "postgresql"/' prisma/schema.prisma

RUN npm run build

ENV NODE_ENV=production
EXPOSE 5300

# k8s overrides this to also source /vault/secrets/*. Start only: the schema step
# is scripts/migrate.sh, which the deploy runs once as a Job before the pods roll.
CMD ["node_modules/.bin/next", "start", "-p", "5300"]
