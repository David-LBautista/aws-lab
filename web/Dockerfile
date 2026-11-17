# ---------- Etapa 1: build ----------
FROM node:24-alpine AS build
WORKDIR /app

# Primero solo las dependencias (Docker cachea esta capa)
COPY package*.json ./
RUN npm ci

# Luego el código y el build
COPY . .
ARG NG_CONFIG=production
RUN npx ng build --configuration=$NG_CONFIG

# ---------- Etapa 2: servir con nginx ----------
FROM nginx:1.27-alpine
COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/dist/aws-lab/browser /usr/share/nginx/html
EXPOSE 80
