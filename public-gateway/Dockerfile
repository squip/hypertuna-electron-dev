# syntax=docker/dockerfile:1
FROM node:20-alpine AS base
WORKDIR /app/public-gateway

COPY public-gateway/package*.json ./
RUN npm install --omit=dev

COPY public-gateway/src ./src
COPY shared ./../shared

ENV NODE_ENV=production
EXPOSE 4430
CMD ["node", "src/index.mjs"]
