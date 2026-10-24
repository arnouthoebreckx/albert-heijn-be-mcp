# Build dist/ with the dev dependencies (TypeScript).
FROM node:24-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build

# The production dependencies only.
FROM node:24-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts

# The runtime: anonymous mode over streamable HTTP. It holds no secrets, runs as the unprivileged node user and
# writes nothing to disk (the token stays in memory), so `docker run --read-only` works.
FROM node:24-slim
ENV NODE_ENV=production AH_SITE=be AH_MCP_HOST=0.0.0.0 AH_MCP_PORT=3000
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./
COPY assets/icon.png ./assets/icon.png
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:' + process.env.AH_MCP_PORT + '/healthz').then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"]
ENTRYPOINT ["node", "dist/index.js"]
CMD ["--anonymous", "--transport", "streamable-http"]
