FROM node:22-alpine
WORKDIR /app
COPY index.mjs package.json ./
ENV PORT=7860
EXPOSE 7860
CMD ["node", "index.mjs"]
