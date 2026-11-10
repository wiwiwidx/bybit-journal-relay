FROM node:22-alpine
WORKDIR /app
COPY server.mjs ./server.mjs
ENV NODE_ENV=production BIND_ADDRESS=0.0.0.0 PORT=8080
USER node
EXPOSE 8080
CMD ["node", "server.mjs"]
