FROM node:22-alpine AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist ./dist
# Private storage for proof-of-delivery / driver documents and uploads (mount volumes here)
RUN mkdir -p /app/storage/private /app/uploads && chown -R node:node /app/storage /app/uploads
USER node
EXPOSE 4000
HEALTHCHECK --interval=30s --timeout=5s --start-period=40s --retries=3 \
  CMD wget -qO- http://127.0.0.1:4000/api/health >/dev/null 2>&1 || exit 1
# Pending migrations first (idempotent), then the API
CMD ["sh", "-c", "node dist/database/run-migrations.js && node dist/main"]
