FROM ghcr.io/puppeteer/puppeteer:21.6.1
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=false
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
EXPOSE 10000
CMD ["node", "server.js"]
