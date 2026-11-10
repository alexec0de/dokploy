import { standardSchemaResolver as zodResolver } from "@hookform/resolvers/standard-schema";
import copy from "copy-to-clipboard";
import { CopyIcon, DownloadIcon, KeyRound } from "lucide-react";
import { useEffect, useState } from "react";
import { useForm } from "react-hook-form";
import { toast } from "sonner";
import { z } from "zod";
import { Button } from "@/components/ui/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogHeader,
	DialogTitle,
	DialogTrigger,
} from "@/components/ui/dialog";
import {
	Form,
	FormControl,
	FormDescription,
	FormField,
	FormItem,
	FormLabel,
	FormMessage,
} from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import { authClient } from "@/lib/auth-client";
import { api } from "@/utils/api";
import {
	BACKUP_CODES_PLACEHOLDER,
	backupCodeTemplate,
	DATE_PLACEHOLDER,
	USERNAME_PLACEHOLDER,
} from "./enable-2fa";

const PasswordSchema = z.object({
	password: z.string(),
});

type PasswordForm = z.infer<typeof PasswordSchema>;
type Step = "password" | "backup-codes";

export const Configure2FA = () => {
	const { data: currentUser } = api.user.get.useQuery();
	const [isDialogOpen, setIsDialogOpen] = useState(false);
	const [step, setStep] = useState<Step>("password");
	const [backupCodes, setBackupCodes] = useState<string[]>([]);
	const [isRegenerating, setIsRegenerating] = useState(false);

	const form = useForm<PasswordForm>({
		resolver: zodResolver(PasswordSchema),
		defaultValues: {
			password: "",
		},
	});

	useEffect(() => {
		if (!isDialogOpen) {
			setStep("password");
			setBackupCodes([]);
			form.reset();
		}
	}, [isDialogOpen, form]);

	const handlePasswordSubmit = async ({ password }: PasswordForm) => {
		setIsRegenerating(true);
		try {
			const { data, error } = await authClient.twoFactor.generateBackupCodes({
				password: password || undefined,
			});
			if (!data?.backupCodes) {
				form.setError("password", {
					message: error?.message || "Could not regenerate backup codes",
				});
				return;
			}
			setBackupCodes(data.backupCodes);
			setStep("backup-codes");
		} catch {
			toast.error("Could not regenerate backup codes");
		} finally {
			setIsRegenerating(false);
		}
	};

	const handleDownloadBackupCodes = () => {
		if (!backupCodes || backupCodes.length === 0) {
			toast.error("No backup codes to download.");
			return;
		}

		const backupCodesFormatted = backupCodes
			.map((code, index) => ` ${index + 1}. ${code}`)
			.join("\n");

		const date = new Date();
		const year = date.getFullYear();
		const month = String(date.getMonth() + 1).padStart(2, "0");
		const day = String(date.getDate()).padStart(2, "0");
		const filename = `vieploy-2fa-backup-codes-${year}${month}${day}.txt`;

		const backupCodesText = backupCodeTemplate
			.replace(USERNAME_PLACEHOLDER, currentUser?.user?.email || "unknown")
			.replace(DATE_PLACEHOLDER, date.toLocaleString())
			.replace(BACKUP_CODES_PLACEHOLDER, backupCodesFormatted);

		const blob = new Blob([backupCodesText], { type: "text/plain" });
		const url = URL.createObjectURL(blob);
		const a = document.createElement("a");
		a.href = url;
		a.download = filename;
		document.body.appendChild(a);
		a.click();
		document.body.removeChild(a);
		URL.revokeObjectURL(url);
	};

	const handleCopyBackupCodes = () => {
		const date = new Date();

		const backupCodesFormatted = backupCodes
			.map((code, index) => ` ${index + 1}. ${code}`)
			.join("\n");

		const backupCodesText = backupCodeTemplate
			.replace(USERNAME_PLACEHOLDER, currentUser?.user?.email || "unknown")
			.replace(DATE_PLACEHOLDER, date.toLocaleString())
			.replace(BACKUP_CODES_PLACEHOLDER, backupCodesFormatted);

		copy(backupCodesText);
		toast.success("Backup codes copied to clipboard");
	};

	return (
		<>
			<Dialog open={isDialogOpen} onOpenChange={setIsDialogOpen}>
				<DialogTrigger asChild>
					<Button variant="secondary">
						<KeyRound className="size-4 text-muted-foreground" />
						Manage 2FA
					</Button>
				</DialogTrigger>
				<DialogContent className="sm:max-w-xl">
					<DialogHeader>
						<DialogTitle>
							{step === "password" && "Verify Your Identity"}
							{step === "backup-codes" && "New Backup Codes"}
						</DialogTitle>
						<DialogDescription>
							{step === "password" &&
								"Regenerating your backup codes replaces all previous codes."}
							{step === "backup-codes" &&
								"Save these backup codes in a secure place"}
						</DialogDescription>
					</DialogHeader>

					{step === "password" && (
						<Form {...form}>
							<form
								onSubmit={form.handleSubmit(handlePasswordSubmit)}
								className="space-y-4"
							>
								<FormField
									control={form.control}
									name="password"
									render={({ field }) => (
										<FormItem>
											<FormLabel>Password</FormLabel>
											<FormControl>
												<Input
													type="password"
													placeholder="Enter your password"
													{...field}
												/>
											</FormControl>
											<FormDescription>
												Enter your password if you sign in with one.
											</FormDescription>
											<FormMessage />
										</FormItem>
									)}
								/>
								<div className="flex justify-end gap-4">
									<Button
										type="button"
										variant="outline"
										onClick={() => setIsDialogOpen(false)}
									>
										Cancel
									</Button>
									<Button type="submit" isLoading={isRegenerating}>
										Regenerate backup codes
									</Button>
								</div>
							</form>
						</Form>
					)}

					{step === "backup-codes" && (
						<div className="space-y-4">
							<div className="w-full space-y-3 border rounded-lg p-4 bg-muted/50">
								<div className="grid grid-cols-2 gap-2">
									{backupCodes.map((code, index) => (
										<code
											key={`${code}-${index}`}
											className="bg-background p-2 rounded text-sm font-mono text-center"
										>
											{code}
										</code>
									))}
								</div>
								<p className="text-sm text-muted-foreground">
									Save these backup codes in a secure place. You can use them to
									access your account if you lose access to your authenticator
									device. Each code can only be used once.
								</p>
							</div>

							<div className="flex gap-2">
								<Button
									variant="outline"
									onClick={handleDownloadBackupCodes}
									className="flex-1"
								>
									<DownloadIcon className="size-4 mr-2" />
									Download
								</Button>
								<Button
									variant="outline"
									onClick={handleCopyBackupCodes}
									className="flex-1"
								>
									<CopyIcon className="size-4 mr-2" />
									Copy
								</Button>
							</div>

							<div className="flex justify-end gap-4">
								<Button onClick={() => setIsDialogOpen(false)}>Done</Button>
							</div>
						</div>
					)}
				</DialogContent>
			</Dialog>
		</>
	);
};
