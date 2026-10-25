FROM node:22-alpine AS build
WORKDIR /app
# The Node 22 image still ships npm 10, whose bundled deps are vulnerable.
# npm 11.19.1 is the Node 24 LTS CLI and scans clean.
RUN npm install -g npm@11.19.1
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build
FROM node:22-alpine
# The runtime only needs the node binary. Removing npm drops the bundled npm 10 advisories.
RUN rm -rf /usr/local/lib/node_modules/npm /usr/local/bin/npm /usr/local/bin/npx
WORKDIR /app
ENV NODE_ENV=production PORT=3000 HOSTNAME=0.0.0.0
COPY --from=build /app/.next/standalone ./
COPY --from=build /app/.next/static ./.next/static
COPY --from=build /app/public ./public
COPY --from=build /app/lib/pages-renderer.mjs ./lib/pages-renderer.mjs
EXPOSE 3000
CMD ["node", "server.js"]
