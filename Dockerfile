FROM node:20-alpine AS build
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm install
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM node:20-alpine
WORKDIR /app
ENV NODE_ENV=production
# su-exec: a tiny setuid helper the entrypoint uses to drop from root to
# PUID/PGID after fixing config-file ownership. See docker-entrypoint.sh.
RUN apk add --no-cache su-exec
COPY package.json package-lock.json* ./
RUN npm install --omit=dev
COPY --from=build /app/dist ./dist
COPY config ./config
COPY public ./public
COPY docker-entrypoint.sh ./
RUN chmod +x docker-entrypoint.sh

EXPOSE 8420
HEALTHCHECK --interval=30s --timeout=3s CMD wget -qO- http://127.0.0.1:8420/health || exit 1

ENTRYPOINT ["/app/docker-entrypoint.sh"]
CMD ["node", "dist/index.js"]
