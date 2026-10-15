# Gujarat Sentinel

## Run locally with Docker

Docker Compose starts PostGIS, the FastAPI backend, and the Vite frontend:

```powershell
docker compose up --build
```

Open the frontend at <http://localhost:5173>, the API at <http://localhost:8000>,
and the API docs at <http://localhost:8000/docs>. The first startup builds the
backend image and installs frontend dependencies, so it can take several minutes.

The database is initialized from `backend/scripts/init.sql` when its data volume
is first created. To stop the services, press Ctrl+C and run
`docker compose down`. Database and backend data are kept in Docker volumes;
`docker compose down -v` removes that data.
The database is available from the host on port 5434 by default; set
`POSTGRES_PORT` in `.env` to use another port.

The default database credentials are for local development only. Set
`POSTGRES_USER`, `POSTGRES_PASSWORD`, and `POSTGRES_DB` in a root `.env` file to
override them. Set `ONVIF_CREDENTIALS_KEY` in `backend/.env` before saving ONVIF
credentials; Docker Compose passes that file to the backend. See
[backend/README.md](backend/README.md) for generating the key.

The application requires a single-admin login. Configure `ADMIN_PASSWORD` with at
least 16 characters and `SESSION_SIGNING_KEY` with at least 32 random bytes in
`backend/.env`; Compose passes the file to the backend. The login uses a signed,
HTTP-only cookie and expires after eight hours. Only origins listed in
`CORS_ORIGINS` are allowed to make credentialed browser requests. Do not use `*`.
The local `backend/.env` is excluded from Git and Docker build contexts.
The development environment already has a generated administrator password in
`backend/.env`; keep it private. Rotate `SESSION_SIGNING_KEY` along with the
password to invalidate existing sessions.

On Render, set `ADMIN_PASSWORD` as a private environment variable. The blueprint
generates the session and ONVIF encryption keys and attaches persistent storage
for encrypted camera credentials. Configure `CORS_ORIGINS` to the exact HTTPS
origin of the trusted frontend.

For development without Docker, start the backend on port 8000 and run
`npm run dev` from `frontend`; the Vite proxy uses the same local API port.

The video wall and ANPR screen include two distinct bundled demo clips for testing
without camera hardware. See [ARCHITECTURE.md](ARCHITECTURE.md) for the read-only
camera integration, event flow, and demonstration steps.
