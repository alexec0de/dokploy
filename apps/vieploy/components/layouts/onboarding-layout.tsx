import Link from "next/link";
import type React from "react";
import { useWhitelabelingPublic } from "@/utils/hooks/use-whitelabeling";
import { GithubIcon } from "../icons/data-tools-icons";
import { Logo } from "../shared/logo";
import { Button } from "../ui/button";

interface Props {
	children: React.ReactNode;
	/** Overrides the default quote in the left panel (desktop only). */
	leftPanel?: React.ReactNode;
}
export const OnboardingLayout = ({ children, leftPanel }: Props) => {
	const { config: whitelabeling } = useWhitelabelingPublic();
	const appName = whitelabeling?.appName || "Vieploy";
	const appDescription =
		whitelabeling?.appDescription ||
		"\u201CThe Open Source alternative to Netlify, Vercel, Heroku.\u201D";
	const logoUrl =
		whitelabeling?.loginLogoUrl || whitelabeling?.logoUrl || undefined;
	const logoLightUrl =
		whitelabeling?.loginLogoLightUrl ||
		whitelabeling?.logoLightUrl ||
		undefined;

	return (
		<div className="container relative min-h-svh flex-col items-center justify-center flex lg:max-w-none lg:grid lg:grid-cols-2 lg:px-0 w-full">
			<div className="relative hidden h-full flex-col  p-10 text-primary dark:border-r lg:flex">
				<div className="absolute inset-0 bg-muted" />
				<Link
					href="/"
					className="relative z-20 flex items-center text-lg font-medium gap-4  text-primary"
				>
					<Logo
						className="size-10"
						logoUrl={logoUrl}
						logoLightUrl={logoLightUrl}
					/>
					{appName}
				</Link>
				<div className="relative z-20 mt-auto">
					{leftPanel ?? (
						<blockquote className="space-y-2">
							<p className="text-lg text-primary">{appDescription}</p>
						</blockquote>
					)}
				</div>
			</div>
			<div className="flex min-h-svh w-full flex-col">
				<div className="flex w-full flex-1 flex-col justify-center space-y-6 max-w-lg mx-auto py-8">
					{children}
				</div>
				<div className="mx-auto flex w-full max-w-lg items-center justify-center gap-1 pb-6 text-muted-foreground sm:justify-end">
					<Button variant="ghost" size="icon" asChild>
						<Link
							href="https://github.com/alexec0de/dokploy"
							aria-label="Vieploy on GitHub"
						>
							<GithubIcon />
						</Link>
					</Button>
				</div>
			</div>
		</div>
	);
};
