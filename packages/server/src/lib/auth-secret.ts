import { readSecret } from "../db/constants";

export const HARDCODED_LEGACY_SECRET = "better-auth-secret-123456789";

const { BETTER_AUTH_SECRET, BETTER_AUTH_SECRET_FILE } = process.env;

function resolveBetterAuthSecret(): string {
	if (BETTER_AUTH_SECRET) {
		return BETTER_AUTH_SECRET;
	}
	if (BETTER_AUTH_SECRET_FILE) {
		return readSecret(BETTER_AUTH_SECRET_FILE);
	}
	if (process.env.NODE_ENV !== "test") {
		console.warn(
			"Using the legacy development authentication secret. Configure BETTER_AUTH_SECRET or BETTER_AUTH_SECRET_FILE for production.",
		);
	}
	return HARDCODED_LEGACY_SECRET;
}

export const betterAuthSecret = resolveBetterAuthSecret();

export function assertProductionAuthSecret() {
	if (
		betterAuthSecret === HARDCODED_LEGACY_SECRET ||
		betterAuthSecret.length < 32
	) {
		throw new Error(
			"Configure a unique BETTER_AUTH_SECRET or BETTER_AUTH_SECRET_FILE with at least 32 characters before starting Vieploy.",
		);
	}
}
