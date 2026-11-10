import fs from "node:fs";

export const {
	DATABASE_URL,
	POSTGRES_PASSWORD_FILE,
	POSTGRES_USER = "dokploy",
	POSTGRES_DB = "dokploy",
	POSTGRES_HOST = "dokploy-postgres",
	POSTGRES_PORT = "5432",
} = process.env;

export function readSecret(path: string): string {
	try {
		return fs.readFileSync(path, "utf8").trim();
	} catch {
		throw new Error(`Cannot read secret at ${path}`);
	}
}
const LEGACY_POSTGRES_PASSWORD = "amukds4wi9001583845717ad2";

export let dbUrl: string;
if (DATABASE_URL) {
	// Compatibilidad legacy / overrides
	dbUrl = DATABASE_URL;
} else if (POSTGRES_PASSWORD_FILE) {
	const password = readSecret(POSTGRES_PASSWORD_FILE);
	dbUrl = `postgres://${POSTGRES_USER}:${encodeURIComponent(
		password,
	)}@${POSTGRES_HOST}:${POSTGRES_PORT}/${POSTGRES_DB}`;
} else {
	if (process.env.NODE_ENV !== "test") {
		console.warn(
			"Using legacy development database credentials. Configure DATABASE_URL or POSTGRES_PASSWORD_FILE for production.",
		);
	}

	if (process.env.NODE_ENV === "production") {
		dbUrl = `postgres://dokploy:${LEGACY_POSTGRES_PASSWORD}@dokploy-postgres:5432/dokploy`;
	} else {
		dbUrl = `postgres://dokploy:${LEGACY_POSTGRES_PASSWORD}@localhost:5432/dokploy`;
	}
}

export function assertProductionDatabaseCredentials() {
	const password = decodeURIComponent(new URL(dbUrl).password);
	if (password === LEGACY_POSTGRES_PASSWORD) {
		throw new Error(
			"Configure private PostgreSQL credentials with DATABASE_URL or POSTGRES_PASSWORD_FILE before starting Vieploy.",
		);
	}
}
