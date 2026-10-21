FROM node:22-alpine

WORKDIR /app

# Install dependencies first so Docker can cache this layer.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY . .

ENV NODE_ENV=production
EXPOSE 3000

# Apply migrations, then start the API. The worker overrides this command.
CMD ["sh", "-c", "node scripts/migrate.js && node src/server.js"]
