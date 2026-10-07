FROM node:24-alpine
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY src ./src
COPY db ./db
COPY test/synthetic-erp.js ./test/synthetic-erp.js
COPY web ./web
USER node
CMD ["npm", "run", "demo"]
