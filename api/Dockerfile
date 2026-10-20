# ---- dependances de production ----
FROM node:22-alpine AS base
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

# ---- image de test (dependances de developpement incluses) ----
FROM base AS test
ENV NODE_ENV=test
RUN npm ci && npm cache clean --force
COPY . .
CMD ["npm", "test"]

# ---- image d'execution ----
FROM base AS production
COPY src ./src
COPY openapi ./openapi
RUN mkdir -p /app/logs && chown -R node:node /app/logs
USER node
EXPOSE 3000
HEALTHCHECK --interval=15s --timeout=3s --start-period=10s --retries=3 \
  CMD wget -qO- http://127.0.0.1:3000/sante > /dev/null || exit 1
CMD ["node", "src/server.js"]
