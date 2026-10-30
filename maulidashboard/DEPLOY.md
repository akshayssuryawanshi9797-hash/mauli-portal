# Deploy Mauli Portal (free): Neon (database) + Render (server)

## 1. Free database - Neon
1. Sign up at https://neon.tech and create a project.
2. Copy the connection string (looks like `postgresql://user:pass@ep-xxx.neon.tech/neondb?sslmode=require`).
The server creates the `app_state` table automatically on first start.

## 2. Put the code on GitHub
Upload this folder (server.js, package.json, public/, render.yaml) to a new GitHub repo.

## 3. Free server - Render
1. https://render.com -> New + -> Web Service -> connect the GitHub repo.
2. Runtime: Node, Build: `npm install`, Start: `npm start`, Plan: Free.
3. Environment -> add `DATABASE_URL` = the Neon string.
4. Deploy. Open the `https://<name>.onrender.com` URL.
(Free Render services sleep after ~15 min idle; the first visit then takes ~30-60 s. Data is safe in Neon.)

## Run locally (no database setup needed, uses SQLite)
    node server.js      # Node 22+, open http://localhost:3000

## API
GET /api/state | GET/PUT/DELETE /api/state/:key  (keys: mauli_staff, mauli_as2, mauli_resp, mauli_tasks)
PUT body: {"value": <json>}
