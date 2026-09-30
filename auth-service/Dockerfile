# Auth Service Dockerfile
FROM node:20-alpine

# Set working directory
WORKDIR /app

# Copy master-db for Prisma client generation
COPY master-db ./master-db
RUN cd master-db && npm install && npx prisma generate

# Install auth-service dependencies
WORKDIR /app/auth-service
COPY auth-service/package*.json ./
RUN npm ci --only=production

# Copy Prisma schema and generate client
COPY auth-service/prisma ./prisma
RUN npx prisma generate

# Copy source code
COPY auth-service/ .

# Build TypeScript
RUN npm run build

# Expose port
EXPOSE 4000

# Health check
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://localhost:4000/health || exit 1

# Start the service
CMD ["npm", "start"]
