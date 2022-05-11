## docker build -t gcr.io/prysmaticlabs/documentation
FROM node:11-alpine as builder

RUN apk add --no-cache \
    autoconf \
    automake \
    bash \
    g++ \
    libc6-compat \
    libjpeg-turbo-dev \
    libpng-dev \
    make \
    nasm

WORKDIR /app/website
COPY ./docs /app/docs
COPY ./website /app/website

COPY ./website/package.json ./website/package-lock.json ./

# Storing node modules on a separate layer will prevent unnecessary npm installs at each build
RUN npm i -g npm@6.4
RUN npm ci
RUN mv ./node_modules .

RUN npm run build

# Copy only the dist dir.
FROM nginx:1.21
RUN rm -rf /usr/share/nginx/html/*

COPY --from=builder /app/website/build/prysm-docs /usr/share/nginx/html

CMD ["nginx", "-g", "daemon off;"]
