import { findOwner } from "@vieploy/server";
import { db } from "@vieploy/server/db";
import { session, twoFactor, user } from "@vieploy/server/db/schema";
import { eq } from "drizzle-orm";

try {
	const { userId } = await findOwner();
	await db.transaction(async (tx) => {
		await tx
			.update(user)
			.set({ twoFactorEnabled: false })
			.where(eq(user.id, userId));
		await tx.delete(twoFactor).where(eq(twoFactor.userId, userId));
		await tx.delete(session).where(eq(session.userId, userId));
	});
	console.log(
		"2FA reset. Sign in and set up a new authenticator to regain access.",
	);
	process.exit(0);
} catch (error) {
	console.error("Error resetting 2FA", error);
	process.exit(1);
}
