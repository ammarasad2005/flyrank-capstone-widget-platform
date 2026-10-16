FROM node:20-alpine

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY src ./src
COPY db ./db
COPY public ./public
COPY demo ./demo
USER node
EXPOSE 3000
CMD ["npm", "start"]
