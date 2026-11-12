# Runs Rome Cloud's dev server and tools. Rome Cloud creates each Rome with the
# docker CLI, so the image carries it.
FROM docker:27-cli AS docker
FROM node:24-bookworm
COPY --from=docker /usr/local/bin/docker /usr/local/bin/docker
