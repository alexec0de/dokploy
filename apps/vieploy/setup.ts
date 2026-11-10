import { exit } from "node:process";
import { setupDirectories } from "@vieploy/server/setup/config-paths";
import { initializePostgres } from "@vieploy/server/setup/postgres-setup";
import {
	initializeNetwork,
	initializeSwarm,
} from "@vieploy/server/setup/setup";
import {
	createDefaultMiddlewares,
	createDefaultServerTraefikConfig,
	createDefaultTraefikConfig,
	initializeStandaloneTraefik,
} from "@vieploy/server/setup/traefik-setup";

(async () => {
	try {
		setupDirectories();
		createDefaultMiddlewares();
		await initializeSwarm();
		await initializeNetwork();
		createDefaultTraefikConfig();
		createDefaultServerTraefikConfig();
		await initializeStandaloneTraefik();
		await initializePostgres();
		console.log("Vieploy setup completed");
		exit(0);
	} catch (e) {
		console.error("Error in dokploy setup", e);
	}
})();
