FROM node:24-bookworm-slim AS build

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM node:24-bookworm-slim AS runtime

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev \
    && npm cache clean --force \
    && mkdir -p /app/data \
    && chown node:node /app/data

COPY --from=build --chown=node:node /app/dist ./dist

USER node

STOPSIGNAL SIGTERM

CMD ["npm", "start"]
