FROM node:20-bookworm-slim

WORKDIR /app/public-gateway

# If you still have other native addons that need compilation,
# leave this block in; otherwise you can remove it.
RUN apt-get update && \
    apt-get install -y --no-install-recommends \
      build-essential \
      python3 \
      pkg-config \
      libsodium-dev \
      postgresql \
      postgresql-client && \
    rm -rf /var/lib/apt/lists/*

COPY public-gateway/package*.json ./
RUN npm install --omit=dev

COPY public-gateway/src ./src
COPY public-gateway/bin ./bin
COPY shared /app/shared

RUN npm install --prefix /app/shared --omit=dev && \
    chmod +x ./bin/start.sh

ENV NODE_PATH=/app/public-gateway/node_modules:/app/shared/node_modules
ENV POSTGRES_DATA_DIR=/data/postgres
EXPOSE 4430
CMD ["./bin/start.sh"]
