import { getTwoFactorState } from "@vieploy/server/lib/auth";
import type { GetServerSidePropsContext } from "next";
import { type FormEvent, type ReactElement, useState } from "react";
import { toast } from "sonner";
import { Enable2FA } from "@/components/dashboard/settings/profile/enable-2fa";
import { OnboardingLayout } from "@/components/layouts/onboarding-layout";
import { Button } from "@/components/ui/button";
import {
	Card,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { authClient } from "@/lib/auth-client";

type Props = Exclude<
	Awaited<ReturnType<typeof getTwoFactorState>>,
	null | { step: "complete" }
>;

export default function TwoFactor(props: Props) {
	const [useBackupCode, setUseBackupCode] = useState(false);
	const [code, setCode] = useState("");
	const [isPending, setIsPending] = useState(false);
	const [error, setError] = useState("");
	const continueToDashboard = () => window.location.replace("/dashboard/home");

	const verify = async (event: FormEvent<HTMLFormElement>) => {
		event.preventDefault();
		setIsPending(true);
		setError("");
		try {
			const result = useBackupCode
				? await authClient.twoFactor.verifyBackupCode({ code: code.trim() })
				: await authClient.twoFactor.verifyTotp({ code });
			if (result.error) {
				setError(result.error.message || "The code could not be verified.");
				return;
			}
			continueToDashboard();
		} catch {
			setError("The code could not be verified. Please try again.");
		} finally {
			setIsPending(false);
		}
	};

	const signOut = async () => {
		try {
			const { error } = await authClient.signOut();
			if (error) throw new Error(error.message);
			window.location.replace("/");
		} catch {
			toast.error("Could not sign out. Please try again.");
		}
	};

	return (
		<Card>
			<CardHeader>
				<CardTitle>Two-factor authentication</CardTitle>
				<CardDescription>
					{props.step === "enroll" &&
						"Set up an authenticator app to access Vieploy."}
					{props.step === "verify" &&
						"Verify this session to continue to Vieploy."}
					{props.step === "sign-out" &&
						"Sign out and verify a new session to access Vieploy."}
				</CardDescription>
			</CardHeader>
			<CardContent className="space-y-4">
				{props.step === "enroll" && (
					<Enable2FA email={props.email} onVerified={continueToDashboard} />
				)}
				{props.step === "verify" && (
					<form className="ph-no-capture space-y-4" onSubmit={verify}>
						<div className="space-y-2">
							<Label htmlFor="verification-code">
								{useBackupCode ? "Backup code" : "Authenticator code"}
							</Label>
							<Input
								id="verification-code"
								value={code}
								onChange={(event) => setCode(event.target.value)}
								inputMode={useBackupCode ? "text" : "numeric"}
								autoComplete="one-time-code"
								pattern={useBackupCode ? undefined : "[0-9]{6}"}
								required
							/>
							{error && (
								<p role="alert" className="text-sm text-destructive">
									{error}
								</p>
							)}
						</div>
						<Button type="submit" className="w-full" isLoading={isPending}>
							Verify
						</Button>
						<Button
							type="button"
							variant="link"
							disabled={isPending}
							onClick={() => {
								setUseBackupCode(!useBackupCode);
								setCode("");
								setError("");
							}}
						>
							{useBackupCode ? "Use authenticator app" : "Use a backup code"}
						</Button>
					</form>
				)}
				<Button type="button" variant="outline" onClick={signOut}>
					Sign out
				</Button>
			</CardContent>
		</Card>
	);
}

TwoFactor.getLayout = (page: ReactElement) => (
	<OnboardingLayout>{page}</OnboardingLayout>
);

export async function getServerSideProps({
	req,
	res,
}: GetServerSidePropsContext) {
	res.setHeader("Cache-Control", "no-store");
	const state = await getTwoFactorState(req);
	if (!state || state.step === "complete") {
		return {
			redirect: {
				permanent: false,
				destination: state ? "/dashboard/home" : "/",
			},
		};
	}
	return { props: state };
}
