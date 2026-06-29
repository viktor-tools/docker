FROM oven/bun:alpine

RUN apk update && \
    apk add --no-cache git && \
    rm -rf /var/cache/apk/*

COPY entrypoint.js /usr/local/bin/viktor-deep

RUN chmod +x /usr/local/bin/viktor-deep

ENTRYPOINT ["bun", "/usr/local/bin/viktor-deep"]
