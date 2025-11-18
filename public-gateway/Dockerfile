########################################
# Build stage
########################################
FROM node:20-bookworm-slim AS build
WORKDIR /app

# Native build toolchain + libs for rocksdb/sodium rebuilds
RUN apt-get update && \
    apt-get install -y --no-install-recommends \
      build-essential python3 pkg-config \
      libsodium-dev libsnappy-dev zlib1g-dev libbz2-dev liblz4-dev libzstd-dev && \
    rm -rf /var/lib/apt/lists/*

# Install deps with lockfiles to avoid drift (rocksdb-native version stays pinned)
COPY shared/package.json shared/package-lock.json ./shared/
RUN cd shared && npm ci --omit=dev

COPY public-gateway/package.json public-gateway/package-lock.json ./public-gateway/
RUN cd public-gateway && npm ci --omit=dev

# Web bundle needs dev deps (vite)
COPY public-gateway/public-web/package.json public-gateway/public-web/package-lock.json ./public-gateway/public-web/
RUN cd public-gateway/public-web && npm ci --include=dev

# Bring in sources
COPY shared ./shared
COPY public-gateway ./public-gateway
# Desktop modules required by the web bundle
COPY hypertuna-desktop ./hypertuna-desktop

# Build web client (invoke vite via node to avoid exec-bit surprises)
RUN cd public-gateway/public-web && node ./node_modules/vite/bin/vite.js build

# Ensure native modules are ready for the image arch and place addon where require-addon expects
RUN set -eux; \
    cd public-gateway; \
    npm rebuild sodium-native --build-from-source --unsafe-perm --verbose; \
    arch=$(node -p "process.arch === 'x64' ? 'x64' : process.arch"); \
    outdir="node_modules/rocksdb-native/prebuilds/linux-$arch"; \
    mkdir -p "$outdir"; \
    src="$outdir/rocksdb-native.node"; \
    if [ ! -f "$src" ]; then echo "rocksdb-native prebuilt addon not found at $src"; exit 1; fi; \
    ls -l "$outdir"

########################################
# Runtime stage
########################################
FROM node:20-bookworm-slim
WORKDIR /app/public-gateway

# Runtime shared libs required by rocksdb-native/sodium-native
RUN apt-get update && \
    apt-get install -y --no-install-recommends \
      libsodium23 libsnappy1v5 zlib1g libbz2-1.0 liblz4-1 libzstd1 libatomic1 && \
    rm -rf /var/lib/apt/lists/*

COPY --from=build /app/public-gateway/node_modules ./node_modules
COPY --from=build /app/public-gateway/src ./src
COPY --from=build /app/shared /app/shared
COPY --from=build /app/public-gateway/public-web/dist /opt/hypertuna/public-web/dist

# Ensure rocksdb-native addon is available at all require-addon fallback locations
RUN set -eux; \
    arch=$(node -p "process.arch === 'x64' ? 'x64' : process.arch"); \
    src="/app/public-gateway/node_modules/rocksdb-native/prebuilds/linux-$arch/rocksdb-native.node"; \
    test -f "$src"; \
    mkdir -p "/prebuilds/linux-$arch" "/app/prebuilds/linux-$arch" "/app/public-gateway/prebuilds/linux-$arch"; \
    ln -sf "$src" "/prebuilds/linux-$arch/rocksdb-native.node"; \
    ln -sf "$src" "/app/prebuilds/linux-$arch/rocksdb-native.node"; \
    ln -sf "$src" "/app/public-gateway/prebuilds/linux-$arch/rocksdb-native.node"; \
    ls -l "/app/public-gateway/node_modules/rocksdb-native/prebuilds/linux-$arch" "/prebuilds/linux-$arch" "/app/prebuilds/linux-$arch" "/app/public-gateway/prebuilds/linux-$arch"

RUN mkdir -p /data/gateway-relay

ENV NODE_ENV=production \
    STORAGE_DIR=/data \
    NODE_PATH=/app/public-gateway/node_modules:/app/shared/node_modules \
    GATEWAY_PUBLIC_WEB_ENABLED=true \
    GATEWAY_PUBLIC_WEB_DIST=/opt/hypertuna/public-web/dist \
    GATEWAY_PUBLIC_WEB_BASEPATH=/public

VOLUME ["/data"]
EXPOSE 4430
CMD ["node", "src/index.mjs"]
