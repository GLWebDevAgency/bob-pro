# Image de production de l'API Bob Pro (NestJS) — monorepo pnpm.
# Build multi-stage : on installe UNIQUEMENT le sous-arbre @bob/api (+ deps @bob/core, @bob/ai) — pas les
# dépendances lourdes du mobile/web — puis on compile, et on ne garde que le nécessaire au runtime.
# syntax=docker/dockerfile:1

FROM node:22-slim AS base
ENV PNPM_HOME="/pnpm" PATH="/pnpm:$PATH"
# openssl : requis par le moteur Prisma. corepack : active pnpm épinglé.
RUN apt-get update -y && apt-get install -y --no-install-recommends openssl ca-certificates \
  && rm -rf /var/lib/apt/lists/* \
  && corepack enable && corepack prepare pnpm@9.12.0 --activate
WORKDIR /repo

# ---- build : install filtré + compilation de la chaîne core -> ai -> api ----
FROM base AS build
# Le lockfile référence tout le workspace : on copie les sources (sans node_modules/dist via .dockerignore),
# mais on n'INSTALLE que le sous-arbre de l'API.
COPY . .
RUN pnpm install --frozen-lockfile --filter "@bob/api..."
# `@bob/api...` construit @bob/core, @bob/ai puis @bob/api dans l'ordre topologique (prisma generate + tsc).
RUN pnpm --filter "@bob/api..." run build

# ---- runtime ----
FROM base AS runner
ENV NODE_ENV="production"
WORKDIR /repo
# On copie l'arbre construit (dist + node_modules + client Prisma généré).
COPY --from=build /repo /repo
WORKDIR /repo/apps/api
# Railway/Cloud injecte PORT ; l'API l'utilise via env.PORT. 3000 par défaut.
EXPOSE 3000
# Depuis le passage aux entrées dist des packages @bob/* (clean-build-output +
# assert-production-artifact), tsc émet À PLAT sous apps/api/dist : le point d'entrée
# réel est dist/main.js (vérifié par boot local avec l'env de production).
CMD ["node", "dist/main.js"]
