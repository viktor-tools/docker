FROM alpine:latest

RUN apk update && \
    apk add --no-cache curl jq bc git && \
    rm -rf /var/cache/apk/*

COPY entrypoint.sh /usr/local/bin/viktor-deep

RUN chmod +x /usr/local/bin/viktor-deep

ENTRYPOINT ["/usr/local/bin/viktor-deep"]
