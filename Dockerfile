# Railway Deployment Dockerfile for Tethra DEX Backend
# Optimized for always-on services with Pyth price monitoring

FROM node:20-alpine

# Set working directory
WORKDIR /app

# Copy package files
COPY package*.json ./

# Install ALL dependencies (including devDependencies for build)
RUN npm ci

# Copy TypeScript config
COPY tsconfig.json ./

# Copy source code and ABI files
COPY src ./src

# Build TypeScript
RUN npm run build

# Remove devDependencies after build to reduce image size
RUN npm prune --production

# Expose port (Railway will provide PORT env variable)
EXPOSE 3001

# Set environment to production
ENV NODE_ENV=production

# Health check for Railway
HEALTHCHECK --interval=30s --timeout=10s --start-period=40s --retries=3 \
  CMD node -e "require('http').get('http://localhost:' + (process.env.PORT || 3001) + '/health', (r) => {process.exit(r.statusCode === 200 ? 0 : 1)})"

# Start the application
CMD ["node", "dist/index.js"]
