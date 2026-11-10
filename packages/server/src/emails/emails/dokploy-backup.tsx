import {
	Body,
	Container,
	Head,
	Heading,
	Html,
	Preview,
	Section,
	Tailwind,
	Text,
} from "@react-email/components";
import { emailTailwindConfig } from "../tailwind-config";

export type TemplateProps = {
	type: "error" | "success";
	errorMessage?: string;
	date: string;
	backupSize?: string;
};

export const DokployBackupEmail = ({
	type = "success",
	errorMessage,
	date = "2023-05-01T00:00:00.000Z",
	backupSize,
}: TemplateProps) => {
	const previewText = `Vieploy instance backup was ${type === "success" ? "successful ✅" : "failed ❌"}`;

	return (
		<Html>
			<Preview>{previewText}</Preview>
			<Tailwind config={emailTailwindConfig}>
				<Head />
				<Body className="bg-white my-auto mx-auto font-sans px-2">
					<Container className="border border-solid border-[#eaeaea] rounded-lg my-[40px] mx-auto p-[20px] max-w-[465px]">
						<Section className="mt-[32px]">
							<Text className="text-[#18181b] text-[26px] font-bold text-center my-0">
								Vieploy
							</Text>
						</Section>
						<Heading className="text-black text-[24px] font-normal text-center p-0 my-[30px] mx-0">
							Vieploy Instance Backup
						</Heading>
						<Text className="text-black text-[14px] leading-[24px]">
							Hello,
						</Text>
						<Text className="text-black text-[14px] leading-[24px]">
							Your Vieploy instance backup was{" "}
							{type === "success"
								? "successful ✅"
								: "failed. Please check the error message below. ❌"}
							.
						</Text>
						<Section className="flex text-black text-[14px] leading-[24px] bg-[#F4F4F5] rounded-lg p-2">
							<Text className="!leading-3 font-bold">Details: </Text>
							<Text className="!leading-3">
								Backup Type: <strong>Complete Vieploy Instance</strong>
							</Text>
							<Text className="!leading-3">
								Content: <strong>/etc/dokploy + PostgreSQL Database</strong>
							</Text>
							{backupSize && (
								<Text className="!leading-3">
									Backup Size: <strong>{backupSize}</strong>
								</Text>
							)}
							<Text className="!leading-3">
								Date: <strong>{date}</strong>
							</Text>
							<Text className="!leading-3">
								Status:{" "}
								<strong>{type === "success" ? "Successful" : "Failed"}</strong>
							</Text>
						</Section>
						{type === "error" && errorMessage ? (
							<Section className="flex text-black text-[14px] mt-4 leading-[24px] bg-[#F4F4F5] rounded-lg p-2">
								<Text className="!leading-3 font-bold">Reason: </Text>
								<Text className="text-[12px] leading-[24px]">
									{errorMessage || "Error message not provided"}
								</Text>
							</Section>
						) : null}
					</Container>
				</Body>
			</Tailwind>
		</Html>
	);
};

export default DokployBackupEmail;
