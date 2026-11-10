import { beforeEach, describe, expect, it, vi } from "vitest";

const dbSet = vi.hoisted(() => vi.fn());

vi.mock("@vieploy/server/db", () => {
	const chain: any = {
		set: vi.fn((values: unknown) => {
			dbSet(values);
			return chain;
		}),
		where: vi.fn(() => chain),
		returning: vi.fn().mockResolvedValue([{}]),
	};
	return {
		db: {
			update: vi.fn(() => chain),
			query: {
				applications: { findFirst: vi.fn() },
				patch: { findMany: vi.fn().mockResolvedValue([]) },
			},
		},
	};
});

vi.mock("@vieploy/server/services/admin", () => ({
	getDokployUrl: vi.fn().mockResolvedValue("http://localhost:3000"),
}));

vi.mock("@vieploy/server/services/deployment", async () => {
	const actual = await vi.importActual<
		typeof import("@vieploy/server/services/deployment")
	>("@vieploy/server/services/deployment");
	return {
		...actual,
		createDeployment: vi.fn(),
		updateDeploymentStatus: vi.fn(),
	};
});

vi.mock("@vieploy/server/utils/providers/git", async () => {
	const actual = await vi.importActual<
		typeof import("@vieploy/server/utils/providers/git")
	>("@vieploy/server/utils/providers/git");
	return { ...actual, getGitCommitInfo: vi.fn().mockResolvedValue(null) };
});

vi.mock("@vieploy/server/utils/process/execAsync", async () => {
	const actual = await vi.importActual<
		typeof import("@vieploy/server/utils/process/execAsync")
	>("@vieploy/server/utils/process/execAsync");
	return { ...actual, execAsync: vi.fn(), execAsyncRemote: vi.fn() };
});

vi.mock("@vieploy/server/utils/builders", async () => {
	const actual = await vi.importActual<
		typeof import("@vieploy/server/utils/builders")
	>("@vieploy/server/utils/builders");
	return {
		...actual,
		getBuildCommand: vi.fn().mockResolvedValue("docker build ."),
		mechanizeDockerContainer: vi.fn(),
	};
});

vi.mock("@vieploy/server/utils/notifications/build-success", () => ({
	sendBuildSuccessNotifications: vi.fn(),
}));

vi.mock("@vieploy/server/utils/notifications/build-error", () => ({
	sendBuildErrorNotifications: vi.fn(),
}));

import { db } from "@vieploy/server/db";
import { deployApplication } from "@vieploy/server/services/application";
import {
	createDeployment,
	updateDeploymentStatus,
} from "@vieploy/server/services/deployment";
import { sendBuildErrorNotifications } from "@vieploy/server/utils/notifications/build-error";
import {
	ExecError,
	execAsyncRemote,
} from "@vieploy/server/utils/process/execAsync";

const keepaliveTimeout = () =>
	new ExecError("SSH connection error: Keepalive timeout", {
		command: "docker build .",
		serverId: "server-1",
		originalError: new Error("Keepalive timeout"),
	});

describe("deployApplication on an unreachable server", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		vi.mocked(db.query.applications.findFirst).mockResolvedValue({
			applicationId: "app-1",
			name: "App",
			appName: "app-abc",
			sourceType: "git",
			customGitUrl: "https://github.com/Dokploy/examples.git",
			customGitBranch: "main",
			customGitSSHKeyId: null,
			serverId: "server-1",
			buildServerId: null,
			environmentId: "env-1",
			environment: {
				projectId: "project-1",
				name: "production",
				project: { name: "Project", organizationId: "org-1" },
			},
			domains: [],
		} as any);
		vi.mocked(createDeployment).mockResolvedValue({
			deploymentId: "deployment-1",
			logPath: "/etc/dokploy/logs/app-abc/app-abc.log",
		} as any);
		vi.mocked(execAsyncRemote).mockRejectedValue(keepaliveTimeout());
	});

	it("marks the deployment as failed even when the error log cannot be written", async () => {
		await expect(
			deployApplication({
				applicationId: "app-1",
				titleLog: "Deploy",
				descriptionLog: "",
			}),
		).rejects.toThrow("Keepalive timeout");

		expect(updateDeploymentStatus).toHaveBeenCalledWith(
			"deployment-1",
			"error",
		);
		expect(dbSet).toHaveBeenCalledWith({ applicationStatus: "error" });
		expect(dbSet).toHaveBeenCalledWith({
			errorMessage: "SSH connection error: Keepalive timeout",
		});
		expect(sendBuildErrorNotifications).toHaveBeenCalledWith(
			expect.objectContaining({
				errorMessage: "SSH connection error: Keepalive timeout",
			}),
		);
	});
});
