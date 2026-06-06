FROM node:22-bookworm-slim
WORKDIR /app
COPY package.json tsconfig.json ./
COPY src ./src
RUN npm install && npm run build && npm prune --omit=dev
ENV NODE_ENV=production
ENV PORT=8080
ENV AUBOT_AUTO_START=true
ENV AUBOT_TICK_MS=1000
ENV AUBOT_LEDGER_DIR=/data/ledger
ENV AUBOT_JOURNAL_DIR=/data/journal
ENV AUBOT_PSYCHOLOGY_GUARD=true
ENV AUBOT_PAPER_TRADE=false
ENV AUBOT_FEE_FIRST_AUTO=true
ENV AUBOT_AUTO_APPLY_LEARNING=true
ENV AUBOT_PAIR_WR_NIGHTLY=true
RUN mkdir -p /data/ledger /data/journal
EXPOSE 8080
CMD ["npm", "start"]
