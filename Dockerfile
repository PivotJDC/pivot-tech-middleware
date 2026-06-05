# Pivot-Tech middleware — production image
FROM node:20-slim AS base
WORKDIR /app
ENV NODE_ENV=production

# --- deps stage: install production dependencies only ---
FROM base AS deps
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev

# --- runtime stage ---
FROM base AS runtime
ENV PORT=3000
COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY src ./src

# Run as the non-root node user that ships with the base image
USER node
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://localhost:'+(process.env.PORT||3000)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "src/server.js"]
