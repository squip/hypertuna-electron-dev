FROM node:18-bullseye-slim
WORKDIR /app/public-gateway

RUN apt-get update && \
    apt-get install -y --no-install-recommends \
      build-essential \
      python3 \
      pkg-config \
      libsodium-dev && \
    rm -rf /var/lib/apt/lists/*

COPY public-gateway/package*.json ./
RUN npm install --omit=dev && \
    npm rebuild sodium-native --build-from-source --unsafe-perm

COPY public-gateway/src ./src
COPY shared /app/shared

RUN npm install --prefix /app/shared --omit=dev && \
    npm rebuild sodium-native --prefix /app/shared --build-from-source --unsafe-perm
RUN node -e "require('sodium-native')" && \
    node -e "require('/app/shared/node_modules/sodium-native')"

ENV NODE_PATH=/app/public-gateway/node_modules:/app/shared/node_modules
EXPOSE 4430
CMD ["node", "src/index.mjs"]
