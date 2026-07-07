FROM node:22-alpine

WORKDIR /app

ENV NODE_ENV=production
ENV APP_ENV=pilot

COPY package*.json ./
RUN npm install

COPY . .
RUN npm run build
RUN npm prune --omit=dev
RUN mkdir -p /app/data && chown -R node:node /app/data

ENV PORT=8170
ENV DATA_DIR=/app/data

EXPOSE 8170

USER node

CMD ["node", "server/index.js"]
