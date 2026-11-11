import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const execAsync = vi.hoisted(() => vi.fn());
vi.mock("@vieploy/server/utils/process/execAsync", () => ({
	execAsync,
	execAsyncRemote: vi.fn(),
}));

import { getUpdateData } from "@vieploy/server/services/settings";

const commit = "a".repeat(40);
const digest = `sha256:${"b".repeat(64)}`;
const fetchMock = vi.fn<typeof fetch>();

describe("manual Vieploy updates", () => {
	beforeEach(() => {
		vi.resetAllMocks();
		vi.stubGlobal("fetch", fetchMock);
		fetchMock
			.mockResolvedValueOnce(Response.json({ sha: commit }))
			.mockResolvedValueOnce(Response.json({ token: "registry-test-token" }));
	});

	afterEach(() => vi.unstubAllGlobals());

	it("checks the fork branch and its commit-tagged image", async () => {
		fetchMock.mockResolvedValueOnce(
			new Response(null, { headers: { "Docker-Content-Digest": digest } }),
		);
		execAsync.mockResolvedValue({ stdout: "vieploy:local" });

		await expect(getUpdateData()).resolves.toEqual({
			latestVersion: commit,
			imageDigest: digest,
			updateAvailable: true,
		});
		expect(fetchMock).toHaveBeenNthCalledWith(
			1,
			"https://api.github.com/repos/alexec0de/dokploy/commits/vieploy",
			expect.objectContaining({ redirect: "error" }),
		);
		expect(fetchMock).toHaveBeenNthCalledWith(
			3,
			`https://ghcr.io/v2/alexec0de/vieploy/manifests/${commit}`,
			expect.objectContaining({
				method: "HEAD",
				headers: expect.objectContaining({
					Authorization: "Bearer registry-test-token",
				}),
			}),
		);
	});

	it("does not offer a commit whose image is still unpublished", async () => {
		fetchMock.mockResolvedValueOnce(new Response(null, { status: 404 }));

		await expect(getUpdateData()).resolves.toEqual({
			latestVersion: commit,
			imageDigest: null,
			updateAvailable: false,
		});
		expect(execAsync).not.toHaveBeenCalled();
	});

	it("does not offer to reinstall an identical image", async () => {
		fetchMock.mockResolvedValueOnce(
			new Response(null, { headers: { "Docker-Content-Digest": digest } }),
		);
		execAsync.mockResolvedValue({
			stdout: `ghcr.io/alexec0de/vieploy@${digest}\n`,
		});

		await expect(getUpdateData()).resolves.toMatchObject({
			updateAvailable: false,
		});
	});

	it("rejects a manifest with an invalid digest", async () => {
		fetchMock.mockResolvedValueOnce(
			new Response(null, { headers: { "Docker-Content-Digest": "latest" } }),
		);

		await expect(getUpdateData()).rejects.toThrow("invalid image digest");
		expect(execAsync).not.toHaveBeenCalled();
	});
});
