# =============================================
# SALES SCRAPER SERVICE - PRODUCTION DOCKERFILE
# =============================================
FROM node:18-alpine AS base
# Install system dependencies
RUN apk add --no-cache \
    curl \
    wget \
    dumb-init \
    && rm -rf /var/cache/apk/*
# Create app directory
WORKDIR /app
# Create non-root user
RUN addgroup -g 1001 -S nodejs && \
    adduser -S scraper -u 1001 -G nodejs
# =============================================
# DEPENDENCIES STAGE
# =============================================
FROM base AS deps
# Copy package files
COPY package*.json ./
# Install dependencies (usando npm install en lugar de npm ci)
RUN npm install --only=production && \
    npm cache clean --force
# =============================================
# BUILD STAGE
# =============================================
FROM base AS build
# Copy package files
COPY package*.json ./
# Install all dependencies (usando npm install)
RUN npm install
# Copy source code
COPY src/ ./src/
COPY config/ ./config/
# =============================================
# PRODUCTION STAGE
# =============================================
FROM base AS production
# Set environment
ENV NODE_ENV=production
ENV PORT=3000
# Copy production dependencies
COPY --from=deps --chown=scraper:nodejs /app/node_modules ./node_modules
# Copy application code
COPY --from=build --chown=scraper:nodejs /app/src ./src
COPY --from=build --chown=scraper:nodejs /app/config ./config
COPY --chown=scraper:nodejs package*.json ./
# Create logs directory
RUN mkdir -p logs && \
    chown -R scraper:nodejs logs
# Switch to non-root user
USER scraper
# Expose port
EXPOSE 3000
# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=30s --retries=3 \
    CMD curl -f http://localhost:3000/health || exit 1
# Use dumb-init for proper signal handling
ENTRYPOINT ["dumb-init", "--"]
# Start application
CMD ["node", "src/server.js"]
