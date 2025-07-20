# Simple Dockerfile for debugging
FROM node:18-alpine

# Install basic tools
RUN apk add --no-cache curl

# Create app directory
WORKDIR /app

# Copy package files
COPY package*.json ./

# Install dependencies
RUN npm install

# Copy all files
COPY . .

# Create logs directory
RUN mkdir -p logs

# Expose port
EXPOSE 3000

# Simple direct command - no dumb-init, no user switching
CMD ["node", "src/server.js"]
