FROM node:20-alpine

WORKDIR /app

COPY package*.json ./
# npm ci (et non npm install) : échoue si package-lock.json et package.json
# divergent, au lieu de re-résoudre silencieusement des versions différentes
# de celles auditées (npm audit, tests) à chaque build.
RUN npm ci --omit=dev

COPY index.js logic.js ./

EXPOSE 8787

# Utilisateur non privilégié fourni par l'image de base : le processus n'a
# besoin d'aucun privilège root, et network_mode: host (docker-compose.yml)
# supprime déjà l'isolation réseau du conteneur — root serait une surface
# inutile en plus.
USER node

CMD ["node", "index.js"]
