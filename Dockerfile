FROM node:22-bookworm-slim
WORKDIR /app
COPY package.json tsconfig.json ./
COPY src ./src
RUN npm install && npm run build && npm prune --omit=dev
ENV NODE_ENV=production
ENV PORT=8080
ENV AUBOT_AUTO_START=true
ENV AUBOT_TICK_MS=1000
EXPOSE 8080
CMD ["npm", "start"]
