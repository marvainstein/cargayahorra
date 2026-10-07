# Imagen única: API + frontend + jobs programados. Base SQLite en /data (montar un volumen).
FROM node:22-slim
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build && npm prune --omit=dev
ENV NODE_ENV=production \
    PORT=8787 \
    DATABASE_PATH=/data/carga-y-ahorra.db \
    NODE_OPTIONS=--disable-warning=ExperimentalWarning \
    NODE_EXTRA_CA_CERTS=/app/certs/digicert-global-g2-tls-rsa-sha256-2020-ca1.pem
VOLUME ["/data"]
EXPOSE 8787
CMD ["npx", "tsx", "src/server/main.ts"]
