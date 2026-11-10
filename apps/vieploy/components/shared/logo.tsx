import { useTheme } from "next-themes";
import { cn } from "@/lib/utils";

interface Props {
	className?: string;
	logoUrl?: string;
	logoLightUrl?: string;
}

export const Logo = ({
	className = "size-14",
	logoUrl,
	logoLightUrl,
}: Props) => {
	const { resolvedTheme } = useTheme();
	const effectiveUrl =
		resolvedTheme === "light" && logoLightUrl ? logoLightUrl : logoUrl;

	if (effectiveUrl) {
		return (
			<img
				src={effectiveUrl}
				alt="Organization Logo"
				className={cn(className, "object-contain rounded-sm")}
			/>
		);
	}

	return (
		<svg viewBox="0 0 48 48" aria-hidden="true" className={className}>
			<path className="fill-primary" d="M3 8h10l11 23L35 8h10L24 43Z" />
			<path className="fill-primary" d="M20 8h8l-4 8Z" />
		</svg>
	);
};
