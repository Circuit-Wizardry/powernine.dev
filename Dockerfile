FROM node:20-slim

# Install dependencies for Playwright Chromium and SQLite
RUN apt-get update && apt-get install -y --no-install-recommends \
    # Playwright/Chromium dependencies
    libnss3 libatk1.0-0 libatk-bridge2.0-0 libcups2 libdrm2 \
    libxkbcommon0 libxcomposite1 libxdamage1 libxrandr2 libgbm1 \
    libpango-1.0-0 libcairo2 libasound2 libxshmfence1 \
    # General
    ca-certificates fonts-liberation wget \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy package files and install dependencies
COPY package*.json ./
RUN npm ci --omit=dev

# Install only Chromium for Playwright
RUN npx playwright install chromium

# Copy application code
COPY . .

# Ensure data directory exists (Railway volume mounts here)
RUN mkdir -p /app/data /app/data/backups /app/private/uploads

EXPOSE 3000

CMD ["node", "index.js"]
