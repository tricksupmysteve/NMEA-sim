# ---------------------------------------------------------------- build stage
FROM node:22-alpine AS build

WORKDIR /app

# Install dependencies first so the layer caches across source-only changes.
COPY package.json package-lock.json* ./
RUN npm ci

COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build


# -------------------------------------------------------------- runtime stage
FROM node:22-alpine AS runtime

ENV NODE_ENV=production

# The NMEA stream and the HTTP control API both listen on all interfaces so
# Railway's TCP proxy and health check can reach them. The published TCP port is
# assigned by Railway and will not be 39150 — see the README.
ENV NMEA_HOST=0.0.0.0 \
    NMEA_PORT=39150 \
    HTTP_HOST=0.0.0.0 \
    PORT=3000

WORKDIR /app

# There are no runtime dependencies, but installing this way keeps the image
# correct if one is ever added.
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev && npm cache clean --force

COPY --from=build /app/dist ./dist
COPY .env.example ./.env.example

# Run unprivileged. The node image already provides the `node` user.
USER node

EXPOSE 39150
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# Node is PID 1 here; the process installs its own SIGTERM/SIGINT handlers, so
# `docker stop` and Railway redeploys shut down cleanly.
CMD ["node", "dist/index.js"]
