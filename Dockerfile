# syntax=docker/dockerfile:1

FROM node:24.22-alpine AS build
WORKDIR /app

COPY package.json yarn.lock ./
RUN yarn install --frozen-lockfile

COPY tsconfig.json ./
COPY src ./src
RUN yarn build

FROM node:24.22-alpine AS runtime
WORKDIR /app

ENV NODE_ENV=production
ENV APP_PORT=3000
ENV UPLOAD_DISK_DIRECTORY=/app/uploads

COPY package.json yarn.lock ./
RUN yarn install --frozen-lockfile --production && yarn cache clean

COPY --from=build /app/dist ./dist
RUN mkdir uploads && chown node:node uploads

USER node
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD wget -qO- http://127.0.0.1:3000/healthz || exit 1

CMD ["node", "dist/index.js"]
