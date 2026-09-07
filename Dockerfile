# the proxy only needs node and the server folder, nothing else :)
FROM node:24-alpine
WORKDIR /app
COPY server ./server
ENV NODE_ENV=production PORT=8787 PCBCODE_DB=/data/pcbcode.db
EXPOSE 8787
CMD ["node", "server/index.js"]
