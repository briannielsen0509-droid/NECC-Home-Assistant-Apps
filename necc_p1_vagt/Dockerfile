FROM ghcr.io/home-assistant/base:latest

LABEL \
  io.hass.version="1.0.1" \
  io.hass.type="app" \
  io.hass.arch="aarch64"

RUN apk add --no-cache python3 tzdata

WORKDIR /app
COPY app/ /app/
COPY run.sh /run.sh
RUN chmod a+x /run.sh

CMD ["/run.sh"]
