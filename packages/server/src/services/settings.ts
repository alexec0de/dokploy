import { readdirSync } from "node:fs";
import { join } from "node:path";
import {
	execAsync,
	execAsyncRemote,
} from "@vieploy/server/utils/process/execAsync";
import { and, eq } from "drizzle-orm";

import semver from "semver";
import { db } from "../db";
import { compose } from "../db/schema";
import {
	ensureTraefikImage,
	initializeStandaloneTraefik,
	initializeTraefikService,
	restoreInterruptedTraefik,
	TRAEFIK_VERSION,
	type TraefikOptions,
} from "../setup/traefik-setup";
export interface IUpdateData {
	latestVersion: string | null;
	imageDigest: string | null;
	updateAvailable: boolean;
}

const updateRepository = "alexec0de/dokploy";
const updateBranch = "vieploy";
export const VIEPLOY_IMAGE = "ghcr.io/alexec0de/vieploy";

export const DEFAULT_UPDATE_DATA: IUpdateData = {
	latestVersion: null,
	imageDigest: null,
	updateAvailable: false,
};

export const getDokployImageTag = () => process.env.RELEASE_TAG || "latest";

export const getUpdateData = async (): Promise<IUpdateData> => {
	const fetchOptions = { redirect: "error" } as const;
	const commitResponse = await fetch(
		`https://api.github.com/repos/${updateRepository}/commits/${updateBranch}`,
		{
			...fetchOptions,
			headers: {
				Accept: "application/vnd.github+json",
				"User-Agent": "Vieploy",
			},
			signal: AbortSignal.timeout(10_000),
		},
	);
	if (!commitResponse.ok) {
		throw new Error("Could not read the Vieploy branch on GitHub.");
	}

	const { sha } = (await commitResponse.json()) as { sha?: unknown };
	if (typeof sha !== "string" || !/^[a-f0-9]{40}$/.test(sha)) {
		throw new Error(
			"GitHub returned an invalid commit for the Vieploy branch.",
		);
	}

	const imagePath = VIEPLOY_IMAGE.slice("ghcr.io/".length);
	const registry = "https://ghcr.io";
	const tokenUrl = new URL("/token", registry);
	tokenUrl.searchParams.set("service", "ghcr.io");
	tokenUrl.searchParams.set("scope", `repository:${imagePath}:pull`);
	const tokenResponse = await fetch(tokenUrl, {
		...fetchOptions,
		signal: AbortSignal.timeout(10_000),
	});
	if (!tokenResponse.ok) {
		throw new Error(
			"The Vieploy package is unavailable. Check GitHub Actions and the package's public visibility.",
		);
	}

	const { token } = (await tokenResponse.json()) as { token?: unknown };
	if (typeof token !== "string" || !token) {
		throw new Error(
			"GitHub Container Registry did not grant read access to Vieploy.",
		);
	}

	const manifest = await fetch(`${registry}/v2/${imagePath}/manifests/${sha}`, {
		...fetchOptions,
		method: "HEAD",
		headers: {
			Authorization: `Bearer ${token}`,
			Accept:
				"application/vnd.oci.image.index.v1+json, application/vnd.docker.distribution.manifest.list.v2+json",
		},
		signal: AbortSignal.timeout(10_000),
	});
	if (manifest.status === 404) {
		return { ...DEFAULT_UPDATE_DATA, latestVersion: sha };
	}
	if (!manifest.ok) {
		throw new Error(
			"Could not read the Vieploy image in GitHub Container Registry.",
		);
	}

	const imageDigest = manifest.headers.get("Docker-Content-Digest");
	if (!imageDigest || !/^sha256:[a-f0-9]{64}$/.test(imageDigest)) {
		throw new Error(
			"GitHub Container Registry returned an invalid image digest.",
		);
	}

	const { stdout } = await execAsync(
		"docker service inspect dokploy --format '{{.Spec.TaskTemplate.ContainerSpec.Image}}'",
	);
	const deployedDigest = stdout.trim().split("@")[1];
	return {
		latestVersion: sha,
		imageDigest,
		updateAvailable: deployedDigest !== imageDigest,
	};
};

interface TreeDataItem {
	id: string;
	name: string;
	type: "file" | "directory";
	children?: TreeDataItem[];
}

export const readDirectory = async (
	dirPath: string,
	serverId?: string,
): Promise<TreeDataItem[]> => {
	if (serverId) {
		const { stdout } = await execAsyncRemote(
			serverId,
			`
process_items() {
    local parent_dir="$1"
    local __resultvar=$2

    local items_json=""
    local first=true
    for item in "$parent_dir"/*; do
        [ -e "$item" ] || continue
        process_item "$item" item_json
        if [ "$first" = true ]; then
            first=false
            items_json="$item_json"
        else
            items_json="$items_json,$item_json"
        fi
    done

    eval $__resultvar="'[$items_json]'"
}

process_item() {
    local item_path="$1"
    local __resultvar=$2

    local item_name=$(basename "$item_path")
    local escaped_name=$(echo "$item_name" | sed 's/"/\\"/g')
    local escaped_path=$(echo "$item_path" | sed 's/"/\\"/g')

    if [ -d "$item_path" ]; then
        # Is directory
        process_items "$item_path" children_json
        local json='{"id":"'"$escaped_path"'","name":"'"$escaped_name"'","type":"directory","children":'"$children_json"'}'
    else
        # Is file
        local json='{"id":"'"$escaped_path"'","name":"'"$escaped_name"'","type":"file"}'
    fi

    eval $__resultvar="'$json'"
}

root_dir=${dirPath}

process_items "$root_dir" json_output

echo "$json_output"
			`,
		);
		const result = JSON.parse(stdout);
		return result;
	}

	const stack = [dirPath];
	const result: TreeDataItem[] = [];
	const parentMap: Record<string, TreeDataItem[]> = {};

	while (stack.length > 0) {
		const currentPath = stack.pop();
		if (!currentPath) continue;

		const items = readdirSync(currentPath, { withFileTypes: true });
		const currentDirectoryResult: TreeDataItem[] = [];

		for (const item of items) {
			const fullPath = join(currentPath, item.name);
			if (item.isDirectory()) {
				stack.push(fullPath);
				const directoryItem: TreeDataItem = {
					id: fullPath,
					name: item.name,
					type: "directory",
					children: [],
				};
				currentDirectoryResult.push(directoryItem);
				parentMap[fullPath] = directoryItem.children as TreeDataItem[];
			} else {
				const fileItem: TreeDataItem = {
					id: fullPath,
					name: item.name,
					type: "file",
				};
				currentDirectoryResult.push(fileItem);
			}
		}

		if (parentMap[currentPath]) {
			parentMap[currentPath].push(...currentDirectoryResult);
		} else {
			result.push(...currentDirectoryResult);
		}
	}
	return result;
};

export const getDockerResourceType = async (
	resourceName: string,
	serverId?: string,
) => {
	try {
		let result = "";
		const command = `
RESOURCE_NAME="${resourceName}"
if docker service inspect "$RESOURCE_NAME" >/dev/null 2>&1; then
	echo "service"
elif docker inspect "$RESOURCE_NAME" >/dev/null 2>&1; then
	echo "standalone"
else
	echo "unknown"
fi`;

		if (serverId) {
			const { stdout } = await execAsyncRemote(serverId, command);
			result = stdout.trim();
		} else {
			const { stdout } = await execAsync(command);
			result = stdout.trim();
		}
		if (result === "service") {
			return "service";
		}
		if (result === "standalone") {
			return "standalone";
		}
		return "unknown";
	} catch (error) {
		console.error(error);
		return "unknown";
	}
};

export const reloadDockerResource = async (
	resourceName: string,
	serverId?: string,
) => {
	const resourceType = await getDockerResourceType(resourceName, serverId);
	let command = "";
	if (resourceType === "service") {
		command = `docker service update --force ${resourceName}`;
	} else if (resourceType === "standalone") {
		command = `docker restart ${resourceName}`;
	} else {
		throw new Error("Resource type not found");
	}
	if (serverId) {
		await execAsyncRemote(serverId, command);
	} else {
		await execAsync(command);
	}
};

export const readEnvironmentVariables = async (
	resourceName: string,
	serverId?: string,
) => (await readEnvironmentVariableList(resourceName, serverId)).join("\n");

export const readEnvironmentVariableList = async (
	resourceName: string,
	serverId?: string,
): Promise<string[]> => {
	const resourceType = await getDockerResourceType(resourceName, serverId);
	let command = "";
	if (resourceType === "service") {
		command = `docker service inspect ${resourceName} --format '{{json .Spec.TaskTemplate.ContainerSpec.Env}}'`;
	} else if (resourceType === "standalone") {
		command = `docker container inspect ${resourceName} --format '{{json .Config.Env}}'`;
	}
	let result = "";
	if (serverId) {
		const { stdout } = await execAsyncRemote(serverId, command);
		result = stdout.trim();
	} else {
		const { stdout } = await execAsync(command);
		result = stdout.trim();
	}
	if (result === "null") {
		return [];
	}
	return JSON.parse(result) ?? [];
};

export const readPorts = async (
	resourceName: string,
	serverId?: string,
): Promise<
	{ targetPort: number; publishedPort: number; protocol?: string }[]
> => {
	const resourceType = await getDockerResourceType(resourceName, serverId);
	let command = "";
	if (resourceType === "service") {
		command = `docker service inspect ${resourceName} --format '{{json .Spec.EndpointSpec.Ports}}'`;
	} else if (resourceType === "standalone") {
		command = `docker container inspect ${resourceName} --format '{{json .NetworkSettings.Ports}}'`;
	} else {
		throw new Error("Resource type not found");
	}
	let result = "";
	if (serverId) {
		const { stdout } = await execAsyncRemote(serverId, command);
		result = stdout.trim();
	} else {
		const { stdout } = await execAsync(command);
		result = stdout.trim();
	}

	if (result === "null") {
		return [];
	}

	const parsedResult = JSON.parse(result);

	if (resourceType === "service") {
		return parsedResult
			.map((port: any) => ({
				targetPort: port.TargetPort,
				publishedPort: port.PublishedPort,
				protocol: port.Protocol,
			}))
			.filter((port: any) => port.targetPort !== 80 && port.targetPort !== 443);
	}
	const ports: {
		targetPort: number;
		publishedPort: number;
		protocol?: string;
	}[] = [];
	const seenPorts = new Set<string>();
	for (const key in parsedResult) {
		if (Object.hasOwn(parsedResult, key)) {
			const containerPortMappings = parsedResult[key];
			const protocol = key.split("/")[1];
			const targetPort = Number.parseInt(key.split("/")[0] ?? "0", 10);

			// Take only the first mapping to avoid duplicates (IPv4 and IPv6)
			const firstMapping = containerPortMappings[0];
			if (firstMapping) {
				const publishedPort = Number.parseInt(firstMapping.HostPort, 10);
				const portKey = `${targetPort}-${publishedPort}-${protocol}`;
				if (!seenPorts.has(portKey)) {
					seenPorts.add(portKey);
					ports.push({
						targetPort: targetPort,
						publishedPort: publishedPort,
						protocol: protocol,
					});
				}
			}
		}
	}
	return ports.filter(
		(port: any) => port.targetPort !== 80 && port.targetPort !== 443,
	);
};

export const DOKPLOY_PANEL_PORT = 3000;

export const PANEL_PORT_RECOVERY_COMMAND = `docker service update --publish-add published=${DOKPLOY_PANEL_PORT},target=${DOKPLOY_PANEL_PORT},mode=host dokploy`;

export const isPanelPortPublished = async () => {
	const ports = await readPorts("dokploy");
	return ports.some((port) => port.targetPort === DOKPLOY_PANEL_PORT);
};

export const isRequestFromPanelHost = (
	requestHost: string | undefined,
	panelHost: string | null | undefined,
) => {
	if (!requestHost || !panelHost) return false;
	try {
		const { hostname, port } = new URL(`http://${requestHost}`);
		if (Number(port) === DOKPLOY_PANEL_PORT) return false;
		return hostname === panelHost.trim().toLowerCase();
	} catch {
		return false;
	}
};

export const togglePanelPort = async (enable: boolean) => {
	const resourceType = await getDockerResourceType("dokploy");
	if (resourceType !== "service") {
		throw new Error(
			"The Vieploy panel is not running as a Docker Swarm service, the port can't be managed from the UI",
		);
	}
	const publishFlag = enable
		? `--publish-add published=${DOKPLOY_PANEL_PORT},target=${DOKPLOY_PANEL_PORT},mode=host`
		: `--publish-rm published=${DOKPLOY_PANEL_PORT},target=${DOKPLOY_PANEL_PORT},mode=host --publish-rm published=${DOKPLOY_PANEL_PORT},target=${DOKPLOY_PANEL_PORT},mode=ingress`;
	await execAsync(`docker service update --detach ${publishFlag} dokploy`);
};

export const checkPortInUse = async (
	port: number,
	serverId?: string,
): Promise<{ isInUse: boolean; conflictingContainer?: string }> => {
	try {
		// Check if port is in use by a Docker container
		const dockerCommand = `docker ps -a --format '{{.Names}}' | grep -v '^dokploy-traefik$' | while read name; do docker port "$name" 2>/dev/null | grep -q ':${port}' && echo "$name" && break; done || true`;
		const { stdout: dockerOut } = serverId
			? await execAsyncRemote(serverId, dockerCommand)
			: await execAsync(dockerCommand);

		const container = dockerOut.trim();

		if (container) {
			return {
				isInUse: true,
				conflictingContainer: `container "${container}"`,
			};
		}

		// Check if port is in use by a host-level service (non-Docker)
		// Vieploy runs inside a container, so we spawn an ephemeral container
		// with --net=host to share the host's network stack and use nc -z to
		// check if something is listening on the port
		const hostCommand = `docker run --rm --net=host busybox sh -c 'nc -z 0.0.0.0 ${port} 2>/dev/null && echo in_use || echo free'`;
		const { stdout: hostOut } = serverId
			? await execAsyncRemote(serverId, hostCommand)
			: await execAsync(hostCommand);

		if (hostOut.includes("in_use")) {
			return {
				isInUse: true,
				conflictingContainer: "a host-level service",
			};
		}

		return { isInUse: false };
	} catch (error) {
		console.error("Error checking port availability:", error);
		return { isInUse: false };
	}
};

export const writeTraefikSetup = async (input: TraefikOptions) => {
	await restoreInterruptedTraefik(input.serverId);
	const resourceType = await getDockerResourceType(
		"dokploy-traefik",
		input.serverId,
	);

	if (resourceType === "service") {
		await initializeTraefikService({
			env: input.env,
			additionalPorts: input.additionalPorts,
			serverId: input.serverId,
		});
		await reconnectServicesToTraefik(input.serverId);
	} else if (resourceType === "standalone") {
		await initializeStandaloneTraefik({
			env: input.env,
			additionalPorts: input.additionalPorts,
			serverId: input.serverId,
		});

		await reconnectServicesToTraefik(input.serverId);
	} else {
		throw new Error("Traefik resource type not found");
	}
};

const splitImageReference = (image: string) => {
	// Swarm service images carry a @sha256 digest.
	const reference = image.split("@")[0] ?? "";
	const tagStart = reference.lastIndexOf(":");
	// A colon followed by a slash is a registry port, not a tag.
	if (tagStart === -1 || reference.slice(tagStart).includes("/")) {
		return { repository: reference, tag: null };
	}
	return {
		repository: reference.slice(0, tagStart),
		tag: reference.slice(tagStart + 1),
	};
};

export const parseTraefikImageVersion = (image: string) => {
	const { tag } = splitImageReference(image);
	return tag ? (semver.coerce(tag)?.version ?? null) : null;
};

// The exec helpers have no timeout of their own.
const rejectAfter = <T>(promise: Promise<T>, ms: number, message: string) => {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const deadline = new Promise<never>((_, reject) => {
		timer = setTimeout(() => reject(new Error(message)), ms);
	});
	return Promise.race([promise, deadline]).finally(() => clearTimeout(timer));
};

const OFFICIAL_TRAEFIK_REPOSITORIES = [
	"traefik",
	"library/traefik",
	"docker.io/traefik",
	"docker.io/library/traefik",
];

type TraefikVersionStatus =
	| "not-found"
	| "custom"
	| "unknown"
	| "outdated"
	| "up-to-date"
	| "newer";

export const getTraefikOverview = async (serverId?: string) => {
	const recommendedVersion = TRAEFIK_VERSION;

	// Unlike getDockerResourceType, an unreachable server throws instead of
	// being reported as a missing Traefik.
	const command = `
if ! docker info >/dev/null 2>&1; then
	echo "docker-unavailable"
elif docker service inspect dokploy-traefik >/dev/null 2>&1; then
	task=$(docker service ps dokploy-traefik --filter desired-state=running --no-trunc -q | head -n 1)
	[ -z "$task" ] && task=$(docker service ps dokploy-traefik --no-trunc -q | head -n 1)
	if [ -n "$task" ]; then
		docker inspect "$task" --format '{{.Spec.ContainerSpec.Image}}|{{.Status.State}}|{{.Status.Timestamp}}'
	else
		echo "$(docker service inspect dokploy-traefik --format '{{.Spec.TaskTemplate.ContainerSpec.Image}}')|stopped|"
	fi
elif docker container inspect dokploy-traefik >/dev/null 2>&1; then
	docker container inspect dokploy-traefik --format '{{.Config.Image}}|{{.State.Status}}|{{.State.StartedAt}}'
else
	echo "missing"
fi`;
	const { stdout } = await rejectAfter(
		serverId ? execAsyncRemote(serverId, command) : execAsync(command),
		30_000,
		"Timed out reading the Traefik status from this server after 30 seconds.",
	);
	const output = stdout.trim();

	if (output === "docker-unavailable") {
		throw new Error(
			"Docker is not reachable on this server. Check that it is installed and running.",
		);
	}
	if (output === "missing") {
		return {
			state: null,
			startedAt: null,
			image: null,
			currentVersion: null,
			recommendedVersion,
			versionStatus: "not-found" as const,
		};
	}

	const [image = "", state = "", startedAt = ""] = output.split("|");
	const currentVersion = parseTraefikImageVersion(image);
	const target = semver.coerce(recommendedVersion)?.version;

	let versionStatus: TraefikVersionStatus = "up-to-date";
	if (
		!OFFICIAL_TRAEFIK_REPOSITORIES.includes(
			splitImageReference(image).repository,
		)
	) {
		versionStatus = "custom";
	} else if (!currentVersion || !target) {
		versionStatus = "unknown";
	} else if (semver.lt(currentVersion, target)) {
		versionStatus = "outdated";
	} else if (semver.gt(currentVersion, target)) {
		versionStatus = "newer";
	}

	return {
		state: state || null,
		startedAt: state === "running" && startedAt ? startedAt : null,
		image,
		currentVersion,
		recommendedVersion,
		versionStatus,
	};
};

// Stays under proxy timeouts (~100s); the download continues in the background.
export const pullTraefikImage = (serverId?: string) =>
	rejectAfter(
		ensureTraefikImage(serverId),
		90_000,
		"the download took longer than 90 seconds. It continues in the background, so try again in a minute.",
	);

export const reconnectServicesToTraefik = async (serverId?: string) => {
	const composeResult = await db.query.compose.findMany({
		where: and(
			...(serverId ? [eq(compose.serverId, serverId)] : []),
			eq(compose.isolatedDeployment, true),
		),
	});

	if (composeResult.length === 0) {
		return;
	}
	let commands = "";

	for (const compose of composeResult) {
		commands += `docker network connect ${compose.appName} $(docker ps --filter "name=dokploy-traefik" -q) >/dev/null 2>&1 || true\n`;
	}

	if (serverId) {
		await execAsyncRemote(serverId, commands);
	} else {
		await execAsync(commands);
	}
};
