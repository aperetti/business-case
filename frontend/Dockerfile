FROM node:22-alpine AS builder

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY . .
ENV VITE_API_BASE_URL=""
RUN npm run build

FROM nginx:1.27-alpine

ENV NGINX_ENVSUBST_FILTER=^BACKEND_UPSTREAM$
ENV BACKEND_UPSTREAM=backend:8000

COPY nginx.conf.template /etc/nginx/templates/default.conf.template
COPY --from=builder /app/dist /usr/share/nginx/html

EXPOSE 80

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD wget -qO- http://127.0.0.1/health >/dev/null || exit 1
