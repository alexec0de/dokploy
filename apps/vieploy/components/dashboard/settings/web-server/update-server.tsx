import {
	Bug,
	Download,
	Info,
	RefreshCcw,
	Server,
	Sparkles,
	Stars,
	X,
} from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
	Dialog,
	DialogClose,
	DialogContent,
	DialogTitle,
	DialogTrigger,
} from "@/components/ui/dialog";
import { api } from "@/utils/api";
import { UpdateWebServer } from "./update-webserver";

export const UpdateServer = () => {
	const [hasCheckedUpdate, setHasCheckedUpdate] = useState(false);
	const [isUpdateAvailable, setIsUpdateAvailable] = useState(false);
	const { mutateAsync: getUpdateData, isPending } =
		api.settings.getUpdateData.useMutation();
	const { data: dokployVersion } = api.settings.getDokployVersion.useQuery();
	const { data: releaseTag } = api.settings.getReleaseTag.useQuery();
	const [latestVersion, setLatestVersion] = useState("");

	const handleCheckUpdates = async () => {
		try {
			const updateData = await getUpdateData();
			const versionToUpdate = updateData.latestVersion?.slice(0, 12) || "";
			setHasCheckedUpdate(true);
			setIsUpdateAvailable(updateData.updateAvailable);
			setLatestVersion(versionToUpdate);

			if (updateData.updateAvailable) {
				toast.success(versionToUpdate, {
					description: "New version available!",
				});
			} else if (updateData.latestVersion && !updateData.imageDigest) {
				toast.info("The latest GitHub commit has no published image yet.");
			} else {
				toast.info("No updates available");
			}
		} catch (error) {
			console.error("Error checking for updates:", error);
			setHasCheckedUpdate(true);
			setIsUpdateAvailable(false);
			toast.error(
				error instanceof Error ? error.message : "Could not check for updates.",
			);
		}
	};

	return (
		<Dialog>
			<DialogTrigger asChild>
				<Button variant="secondary" size="sm">
					<Download className="h-4 w-4 shrink-0" />
					Check for updates
				</Button>
			</DialogTrigger>
			<DialogContent className="max-w-lg" showCloseButton={false}>
				<div className="flex items-center gap-2 mb-8">
					<DialogTitle className="text-2xl font-semibold mr-auto">
						Web Server Update
					</DialogTitle>
					{dokployVersion && (
						<div className="flex items-center gap-1.5 rounded-full px-3 py-1 bg-muted">
							<Server className="h-4 w-4 text-muted-foreground" />
							<span className="text-sm text-muted-foreground">
								{dokployVersion}{" "}
								{(releaseTag === "canary" || releaseTag === "feature") &&
									`(${releaseTag})`}
							</span>
						</div>
					)}
					<DialogClose asChild>
						<Button variant="ghost" size="icon-sm" className="shrink-0">
							<X />
							<span className="sr-only">Close</span>
						</Button>
					</DialogClose>
				</div>

				{/* Initial state */}
				{!hasCheckedUpdate && (
					<div className="mb-8">
						<p className="text text-muted-foreground">
							Check for new releases and update Vieploy.
							<br />
							<br />
							We recommend checking for updates regularly to ensure you have the
							latest features and security improvements.
						</p>
					</div>
				)}

				{/* Update available state */}
				{isUpdateAvailable && latestVersion && (
					<div className="mb-8">
						<div className="inline-flex items-center gap-2 rounded-lg px-3 py-2 border border-emerald-900 bg-emerald-900 dark:bg-emerald-900/40 mb-4 w-full">
							<div className="flex items-center gap-1.5">
								<Download className="h-4 w-4 text-emerald-400" />
								<span className="text font-medium text-emerald-400 ">
									New version available:
								</span>
							</div>
							<span className="text font-semibold text-emerald-300">
								{latestVersion}
							</span>
						</div>

						<div className="space-y-4 text-muted-foreground">
							<p className="text">
								A new version of the server software is available. Consider
								updating if you:
							</p>
							<ul className="space-y-3">
								<li className="flex items-start gap-2">
									<Stars className="h-5 w-5 mt-0.5 text-[#5B9DFF]" />
									<span className="text">
										Want to access the latest features and improvements
									</span>
								</li>
								<li className="flex items-start gap-2">
									<Bug className="h-5 w-5 mt-0.5 text-[#5B9DFF]" />
									<span className="text">
										Are experiencing issues that may be resolved in the new
										version
									</span>
								</li>
							</ul>
						</div>
					</div>
				)}

				{/* Up to date state */}
				{hasCheckedUpdate && !isUpdateAvailable && !isPending && (
					<div className="mb-8">
						<div className="flex flex-col items-center gap-6 mb-6">
							<div className="rounded-full p-4 bg-emerald-400/40">
								<Sparkles className="h-8 w-8 text-emerald-400" />
							</div>
							<div className="text-center space-y-2">
								<h3 className="text-lg font-medium">
									You are using the latest version
								</h3>
								<p className="text text-muted-foreground">
									Your server is up to date with all the latest features and
									security improvements.
								</p>
							</div>
						</div>
					</div>
				)}

				{hasCheckedUpdate && isPending && (
					<div className="mb-8">
						<div className="flex flex-col items-center gap-6 mb-6">
							<div className="rounded-full p-4 bg-[#5B9DFF]/40 text-foreground">
								<RefreshCcw className="h-8 w-8 animate-spin" />
							</div>
							<div className="text-center space-y-2">
								<h3 className="text-lg font-medium">Checking for updates...</h3>
								<p className="text text-muted-foreground">
									Checking the latest build from the Vieploy branch on GitHub.
								</p>
							</div>
						</div>
					</div>
				)}

				{isUpdateAvailable && (
					<div className="rounded-lg bg-[#16254D] p-4 mb-8">
						<div className="flex gap-2">
							<Info className="h-5 w-5 shrink-0 text-[#5B9DFF]" />
							<div className="text-[#5B9DFF]">
								We recommend reviewing the{" "}
								<Link
									href="https://github.com/alexec0de/dokploy/commits/vieploy/"
									target="_blank"
									className="text-white underline hover:text-zinc-200"
								>
									commits
								</Link>{" "}
								for any breaking changes before updating.
							</div>
						</div>
					</div>
				)}

				<div className="flex items-center justify-end mt-4">
					<div className="flex items-center gap-2">
						<DialogClose asChild>
							<Button variant="outline">Cancel</Button>
						</DialogClose>
						{isUpdateAvailable ? (
							<UpdateWebServer buttonClassName="w-auto" />
						) : (
							<Button
								variant="secondary"
								onClick={handleCheckUpdates}
								disabled={isPending}
							>
								{isPending ? (
									<>
										<RefreshCcw className="h-4 w-4 animate-spin" />
										Checking for updates
									</>
								) : (
									<>
										<RefreshCcw className="h-4 w-4" />
										Check for updates
									</>
								)}
							</Button>
						)}
					</div>
				</div>
			</DialogContent>
		</Dialog>
	);
};
