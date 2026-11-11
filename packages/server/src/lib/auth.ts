import { randomBytes, randomUUID } from "node:crypto";
import type { IncomingMessage } from "node:http";
import { apiKey } from "@better-auth/api-key";
import { passkey } from "@better-auth/passkey";
import { scim } from "@better-auth/scim";
import { sso } from "@better-auth/sso";
import { createOTP } from "@better-auth/utils/otp";
import * as bcrypt from "bcrypt";
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import {
	APIError,
	createAuthEndpoint,
	createAuthMiddleware,
} from "better-auth/api";
import { setSessionCookie } from "better-auth/cookies";
import {
	generateRandomString,
	symmetricDecrypt,
	symmetricEncrypt,
} from "better-auth/crypto";
import { admin, organization, twoFactor } from "better-auth/plugins";
import { and, desc, eq, exists, isNull, lte, or, sql } from "drizzle-orm";
import { z } from "zod";
import { IS_CLOUD } from "../constants";
import { db } from "../db";
import * as schema from "../db/schema";
import {
	getTrustedOrigins,
	getTrustedProviders,
	getUserByToken,
} from "../services/admin";
import { createAuditLog } from "../services/proprietary/audit-log";
import { resolveOrganizationDefaultRole } from "../services/proprietary/license-key";
import {
	getWebServerSettings,
	updateWebServerSettings,
} from "../services/web-server-settings";
import { getHubSpotUTK, submitToHubSpot } from "../utils/tracking/hubspot";
import { captureEvent, getPostHogSessionId } from "../utils/tracking/posthog";
import {
	sendEmail,
	sendVerificationEmail,
} from "../verification/send-verification-email";
import { getPublicIpWithFallback } from "../wss/utils";
import { ac, adminRole, memberRole, ownerRole } from "./access-control";
import { betterAuthSecret } from "./auth-secret";

const resolveTrustedOrigins = async () => {
	try {
		if (IS_CLOUD) {
			return await getTrustedOrigins();
		}
		const [trustedOrigins, settings] = await Promise.all([
			getTrustedOrigins(),
			getWebServerSettings(),
		]);

		if (!settings) return [];

		const devOrigins =
			process.env.NODE_ENV === "development"
				? [
						"http://localhost:3000",
						"https://absolutely-handy-falcon.ngrok-free.app",
					]
				: [];
		return [
			...(settings?.serverIp ? [`http://${settings?.serverIp}:3000`] : []),
			...(settings?.host ? [`https://${settings?.host}`] : []),
			...devOrigins,
			...trustedOrigins,
		];
	} catch (error) {
		console.error("Failed to resolve trusted origins:", error);
		return [];
	}
};

const rewriteToCanonicalOrigin = async (url: string): Promise<string> => {
	try {
		const configured = process.env.BETTER_AUTH_URL;
		let origin: string | null = configured ?? null;
		if (!origin) {
			const settings = await getWebServerSettings();
			origin = settings?.host
				? `${settings.https ? "https" : "http"}://${settings.host}`
				: settings?.serverIp
					? `http://${settings.serverIp}:3000`
					: null;
		}
		if (!origin) return url;
		const target = new URL(url);
		const canonical = new URL(origin);
		target.protocol = canonical.protocol;
		target.host = canonical.host;
		return target.toString();
	} catch {
		return url;
	}
};

const verifyTotpPath = "/two-factor/verify-totp";
const verifyBackupCodePath = "/two-factor/verify-backup-code";
const enableTwoFactorPath = "/two-factor/enable";

const hasTwoFactorProof = (session: {
	session: {
		id: string;
		twoFactorVerified?: boolean;
		impersonatedBy?: string | null;
	};
	user: {
		id: string;
		twoFactorEnabled?: boolean | null;
		banned?: boolean | null;
	};
}) =>
	session.user.twoFactorEnabled === true &&
	!session.user.banned &&
	session.session.twoFactorVerified === true &&
	!session.session.impersonatedBy;

const twoFactorIsEnrolled = (userId: string) =>
	exists(
		db
			.select({ id: schema.twoFactor.id })
			.from(schema.twoFactor)
			.where(
				and(
					eq(schema.twoFactor.userId, userId),
					eq(schema.twoFactor.verified, true),
				),
			),
	);

// Reuse Better Auth verification while letting an authenticated session start enrollment.
const twoFactorPlugin = () => {
	const plugin = twoFactor({ allowPasswordless: true });
	const enable = plugin.endpoints.enableTwoFactor;

	return {
		...plugin,
		endpoints: {
			...plugin.endpoints,
			enableTwoFactor: createAuthEndpoint(
				enableTwoFactorPath,
				enable.options,
				async (ctx) => {
					const { user, session } = ctx.context.session;
					if (session.impersonatedBy) throw new APIError("FORBIDDEN");

					const key = ctx.context.secretConfig;
					const { secret, backupCodes } = await db.transaction(async (tx) => {
						const [account] = await tx
							.select({
								banned: schema.user.banned,
								twoFactorEnabled: schema.user.twoFactorEnabled,
							})
							.from(schema.user)
							.where(eq(schema.user.id, user.id))
							.for("update");

						if (!account || account.banned || account.twoFactorEnabled) {
							throw new APIError("FORBIDDEN", {
								message: "This account cannot enroll a new authenticator",
							});
						}

						const pending = await tx.query.twoFactor.findFirst({
							where: eq(schema.twoFactor.userId, user.id),
						});
						if (pending && !pending.verified) {
							const storedCodes = await symmetricDecrypt({
								key,
								data: pending.backupCodes,
							});
							const backupCodes = z
								.array(z.string())
								.parse(JSON.parse(storedCodes));
							return {
								secret: await symmetricDecrypt({ key, data: pending.secret }),
								backupCodes,
							};
						}

						const secret = generateRandomString(32);
						const backupCodes = Array.from({ length: 10 }, () => {
							const code = generateRandomString(10, "a-z", "0-9", "A-Z");
							return `${code.slice(0, 5)}-${code.slice(5)}`;
						});
						await tx
							.delete(schema.twoFactor)
							.where(eq(schema.twoFactor.userId, user.id));
						await tx.insert(schema.twoFactor).values({
							id: randomUUID(),
							userId: user.id,
							secret: await symmetricEncrypt({ key, data: secret }),
							backupCodes: await symmetricEncrypt({
								key,
								data: JSON.stringify(backupCodes),
							}),
							verified: false,
						});
						return { secret, backupCodes };
					});

					return ctx.json({
						totpURI: createOTP(secret, { digits: 6, period: 30 }).url(
							ctx.body.issuer || ctx.context.appName,
							user.email,
						),
						backupCodes,
					});
				},
			),
		},
	};
};

const createBetterAuth = () =>
	betterAuth({
		database: drizzleAdapter(db, {
			provider: "pg",
			schema: schema,
		}),
		disabledPaths: [
			"/sso/register",
			"/two-factor/disable",
			"/two-factor/get-totp-uri",
			"/admin/impersonate-user",
			"/organization/create",
			"/organization/update",
			"/organization/delete",
			"/organization/update-member-role",
			"/organization/invite-member",
			// GHSA-j8v8-g9cx-5qf4: SCIM providers are managed via tRPC, org-scoped only.
			"/scim/generate-token",
			"/scim/list-provider-connections",
			"/scim/get-provider-connection",
			"/scim/delete-provider-connection",
			...(!IS_CLOUD ? ["/verify-email"] : []),
		],
		secret: betterAuthSecret,
		onAPIError: {
			errorURL: "/",
		},
		...(!IS_CLOUD
			? {
					advanced: {
						useSecureCookies: false,
						defaultCookieAttributes: {
							sameSite: "lax",
							secure: false,
							httpOnly: true,
							path: "/",
						},
					},
				}
			: {}),

		account: {
			accountLinking: {
				enabled: true,
				async trustedProviders() {
					const fromDb = await getTrustedProviders();
					return ["github", "google", ...fromDb];
				},
				allowDifferentEmails: true,
			},
		},
		appName: "Vieploy",
		socialProviders: {
			github: {
				clientId: process.env.GITHUB_CLIENT_ID as string,
				clientSecret: process.env.GITHUB_CLIENT_SECRET as string,
			},
			google: {
				clientId: process.env.GOOGLE_CLIENT_ID as string,
				clientSecret: process.env.GOOGLE_CLIENT_SECRET as string,
			},
		},
		logger: {
			disabled: process.env.NODE_ENV === "production",
		},
		trustedOrigins: resolveTrustedOrigins,
		hooks: {
			before: createAuthMiddleware(async (ctx) => {
				ctx.context.trustedOrigins = [
					...(ctx.context.baseURL ? [new URL(ctx.context.baseURL).origin] : []),
					...(await resolveTrustedOrigins()),
				].filter(Boolean);

				if (ctx.path === "/admin/remove-user") {
					throw new APIError("FORBIDDEN", {
						message: "Use the account deletion flow to remove users",
					});
				}

				if (
					ctx.path === "/two-factor/disable" ||
					ctx.path === "/two-factor/get-totp-uri" ||
					ctx.path === "/admin/impersonate-user"
				) {
					throw new APIError("FORBIDDEN", {
						message: "Two-factor authentication is required",
					});
				}

				const isVerification =
					ctx.path === verifyTotpPath || ctx.path === verifyBackupCodePath;
				if (isVerification && ctx.body?.trustDevice) {
					throw new APIError("BAD_REQUEST", {
						message: "Two-factor authentication is required for every session",
					});
				}

				if (ctx.path !== "/get-session") {
					const token = await ctx.getSignedCookie(
						ctx.context.authCookies.sessionToken.name,
						ctx.context.secret,
					);
					const stored = token
						? await ctx.context.internalAdapter.findSession(token)
						: null;
					const session =
						stored && stored.session.expiresAt > new Date() ? stored : null;

					if (
						session &&
						ctx.path === enableTwoFactorPath &&
						session.user.twoFactorEnabled
					) {
						throw new APIError("FORBIDDEN", {
							message: "Two-factor authentication is already enabled",
						});
					}
					if (session && !hasTwoFactorProof(session)) {
						const mayVerify =
							!session.session.impersonatedBy &&
							(ctx.path === verifyTotpPath ||
								(ctx.path === verifyBackupCodePath &&
									session.user.twoFactorEnabled));
						const mayEnroll =
							!session.session.impersonatedBy &&
							ctx.path === enableTwoFactorPath &&
							!session.user.twoFactorEnabled;
						if (
							!mayVerify &&
							!mayEnroll &&
							ctx.path !== "/sign-out" &&
							ctx.path !== "/admin/stop-impersonating"
						) {
							throw new APIError("FORBIDDEN", {
								message: "Complete two-factor authentication first",
							});
						}
						if (mayVerify) {
							// Better Auth applies its account lockout only to its sign-in challenge.
							// Existing OAuth, SSO, and passkey sessions need the same attempt budget.
							const [attempt] = await db
								.update(schema.twoFactor)
								.set({
									failedVerificationCount: sql`case when ${schema.twoFactor.lockedUntil} <= timezone('UTC', now()) then 1 else ${schema.twoFactor.failedVerificationCount} + 1 end`,
									lockedUntil: sql`case when ${schema.twoFactor.lockedUntil} is null and ${schema.twoFactor.failedVerificationCount} >= 9 then timezone('UTC', now()) + interval '15 minutes' end`,
								})
								.where(
									and(
										eq(schema.twoFactor.userId, session.user.id),
										or(
											isNull(schema.twoFactor.lockedUntil),
											lte(schema.twoFactor.lockedUntil, new Date()),
										),
									),
								)
								.returning({ id: schema.twoFactor.id });
							if (!attempt) {
								throw new APIError("TOO_MANY_REQUESTS", {
									message:
										"No authenticator is available or the account is temporarily locked",
								});
							}
						}
					}
				}

				const isBlockedAuthPath =
					ctx.path.startsWith("/sign-in/email") ||
					ctx.path.startsWith("/sign-in/social") ||
					ctx.path.startsWith("/sign-in/passkey") ||
					ctx.path.startsWith("/sign-up/email") ||
					ctx.path.startsWith("/passkey/verify-authentication") ||
					ctx.path.startsWith("/passkey/generate-authenticate-options");

				if (!IS_CLOUD && isBlockedAuthPath) {
					const settings = await getWebServerSettings();
					if (settings?.enforceSSO) {
						throw new APIError("FORBIDDEN", {
							message:
								"SSO is enforced. Direct password, social, and passkey sign-in are disabled.",
						});
					}
				}
			}),
			after: createAuthMiddleware(async (ctx) => {
				if (ctx.path === "/get-session" && ctx.request) {
					const session = ctx.context.session;
					if (session && !hasTwoFactorProof(session)) return ctx.json(null);
				}
				if (ctx.path !== verifyTotpPath && ctx.path !== verifyBackupCodePath)
					return;
				if (ctx.path === verifyBackupCodePath && ctx.body?.disableSession)
					return;

				const result = ctx.context.returned;
				const newSession = ctx.context.newSession;
				const verified = newSession ?? ctx.context.session;
				if (
					!result ||
					typeof result !== "object" ||
					!("token" in result) ||
					typeof result.token !== "string" ||
					!verified ||
					verified.session.impersonatedBy
				)
					return;
				if (hasTwoFactorProof(verified)) return;

				// Replace a primary-only token so a copy of it cannot gain access after verification.
				const token = newSession
					? verified.session.token
					: randomBytes(32).toString("hex");
				const [session] = await db.transaction(async (tx) => {
					const promoted = await tx
						.update(schema.session)
						.set({ token, twoFactorVerified: true })
						.where(
							and(
								eq(schema.session.id, verified.session.id),
								eq(schema.session.userId, verified.user.id),
								eq(schema.session.token, verified.session.token),
								eq(schema.session.twoFactorVerified, false),
								twoFactorIsEnrolled(verified.user.id),
								exists(
									db
										.select({ id: schema.user.id })
										.from(schema.user)
										.where(
											and(
												eq(schema.user.id, verified.user.id),
												eq(schema.user.twoFactorEnabled, true),
											),
										),
								),
							),
						)
						.returning();
					if (promoted.length) {
						await tx
							.update(schema.twoFactor)
							.set({ failedVerificationCount: 0, lockedUntil: null })
							.where(eq(schema.twoFactor.userId, verified.user.id));
					}
					return promoted;
				});
				if (!session)
					throw new APIError("UNAUTHORIZED", {
						message: "Could not verify this session. Sign in again.",
					});

				if (!newSession) {
					await setSessionCookie(ctx, { session, user: verified.user });
					return ctx.json({ ...result, token });
				}
			}),
		},
		emailVerification: {
			sendOnSignUp: true,
			autoSignInAfterVerification: true,
			sendOnSignIn: true,
			sendVerificationEmail: async ({ user, url }) => {
				if (IS_CLOUD) {
					await sendVerificationEmail({
						userName: user.name || "User",
						email: user.email,
						verificationUrl: await rewriteToCanonicalOrigin(url),
					});
				}
			},
		},
		emailAndPassword: {
			enabled: true,
			autoSignIn: !IS_CLOUD,
			requireEmailVerification:
				IS_CLOUD && process.env.NODE_ENV === "production",
			password: {
				async hash(password) {
					return bcrypt.hashSync(password, 10);
				},
				async verify({ hash, password }) {
					return bcrypt.compareSync(password, hash);
				},
			},
			sendResetPassword: async ({ user, url }) => {
				const safeUrl = await rewriteToCanonicalOrigin(url);
				await sendEmail({
					email: user.email,
					subject: "Reset your password",
					text: `
				<p>Click the link to reset your password: <a href="${safeUrl}">Reset Password</a></p>
				`,
				});
			},
		},
		databaseHooks: {
			user: {
				create: {
					before: async (_user, context) => {
						if (context?.path.includes("/scim")) {
							return { data: { emailVerified: true } };
						}
						if (!IS_CLOUD) {
							const xDokployToken =
								context?.request?.headers?.get("x-dokploy-token");
							if (xDokployToken) {
								let invitation: Awaited<ReturnType<typeof getUserByToken>>;
								try {
									invitation = await getUserByToken(xDokployToken);
								} catch {
									throw new APIError("BAD_REQUEST", {
										message: "Invalid invitation token",
									});
								}
								if (invitation.isExpired) {
									throw new APIError("BAD_REQUEST", {
										message: "Invitation has expired",
									});
								}
								if (invitation.status !== "pending") {
									throw new APIError("BAD_REQUEST", {
										message: "Invitation has already been used",
									});
								}
								if (
									_user.email.toLowerCase().trim() !==
									invitation.email.toLowerCase().trim()
								) {
									throw new APIError("BAD_REQUEST", {
										message: "Email does not match invitation",
									});
								}
							} else {
								const isSSORequest = context?.path.includes("/sso");
								if (isSSORequest) {
									return;
								}
								const isAdminPresent = await db.query.member.findFirst({
									where: eq(schema.member.role, "owner"),
								});
								if (isAdminPresent) {
									throw new APIError("BAD_REQUEST", {
										message: "Admin is already created",
									});
								}
							}
						}
					},
					after: async (user, context) => {
						const isSSORequest = context?.path.includes("/sso");
						const isSCIMRequest = context?.path.includes("/scim");
						const isAdminPresent = await db.query.member.findFirst({
							where: eq(schema.member.role, "owner"),
						});

						if (!IS_CLOUD && !isAdminPresent) {
							await updateWebServerSettings({
								serverIp: await getPublicIpWithFallback(),
							});
						}

						if (IS_CLOUD) {
							try {
								const hutk = getHubSpotUTK(
									context?.request?.headers?.get("cookie") || undefined,
								);
								// Cast to include additional fields
								const userWithFields = user as typeof user & {
									lastName?: string;
								};
								const hubspotSuccess = await submitToHubSpot(
									{
										email: user.email,
										firstName: user.name || "", // name is mapped to firstName column
										lastName: userWithFields.lastName || "",
									},
									hutk,
								);
								if (!hubspotSuccess) {
									console.error("Failed to submit to HubSpot");
								}
							} catch (error) {
								console.error("Error submitting to HubSpot", error);
							}
						}

						if (isSCIMRequest) {
							const membership = await db.query.member.findFirst({
								where: eq(schema.member.userId, user.id),
							});
							if (membership) {
								const defaultRole = await resolveOrganizationDefaultRole(
									membership.organizationId,
								);
								if (defaultRole !== membership.role) {
									await db
										.update(schema.member)
										.set({ role: defaultRole })
										.where(eq(schema.member.id, membership.id));
								}
							}
							return;
						}

						if (IS_CLOUD || !isAdminPresent) {
							const createdOrganization = await db.transaction(async (tx) => {
								const organization = await tx
									.insert(schema.organization)
									.values({
										name: "My Organization",
										ownerId: user.id,
										createdAt: new Date(),
									})
									.returning()
									.then((res) => res[0]);

								await tx.insert(schema.member).values({
									userId: user.id,
									organizationId: organization?.id || "",
									role: "owner",
									createdAt: new Date(),
									isDefault: true, // Mark first organization as default
								});

								return organization;
							});

							if (IS_CLOUD) {
								void captureEvent({
									distinctId: user.id,
									event: "user_signed_up",
									organizationId: createdOrganization?.id,
									sessionId: getPostHogSessionId(context?.request?.headers),
									properties: {
										method: context?.path,
										$set: { email: user.email, name: user.name },
										$set_once: { signed_up_at: new Date().toISOString() },
									},
								});
							}
						} else if (isSSORequest) {
							const providerId = context?.params?.providerId;
							if (!providerId) {
								throw new APIError("BAD_REQUEST", {
									message: "Provider ID is required",
								});
							}
							const provider = await db.query.ssoProvider.findFirst({
								where: eq(schema.ssoProvider.providerId, providerId),
							});

							if (!provider) {
								throw new APIError("BAD_REQUEST", {
									message: "Provider not found",
								});
							}
							const defaultRole = provider.organizationId
								? await resolveOrganizationDefaultRole(provider.organizationId)
								: "member";
							await db.insert(schema.member).values({
								userId: user.id,
								organizationId: provider?.organizationId || "",
								role: defaultRole,
								createdAt: new Date(),
								isDefault: true,
							});
						}
					},
				},
			},
			session: {
				create: {
					before: async (session) => {
						// Find the default organization for this user
						// Priority: 1) isDefault=true, 2) most recently created
						const member = await db.query.member.findFirst({
							where: eq(schema.member.userId, session.userId),
							orderBy: [
								desc(schema.member.isDefault),
								desc(schema.member.createdAt),
							],
							with: {
								organization: true,
							},
						});

						return {
							data: {
								...session,
								activeOrganizationId: member?.organization.id,
							},
						};
					},
					after: async (session) => {
						const orgId = (
							session as typeof session & { activeOrganizationId?: string }
						).activeOrganizationId;
						if (!orgId) return;
						const memberRecord = await db.query.member.findFirst({
							where: and(
								eq(schema.member.userId, session.userId),
								eq(schema.member.organizationId, orgId),
							),
							with: { user: true },
						});
						if (!memberRecord) return;
						await createAuditLog({
							organizationId: orgId,
							userId: session.userId,
							userEmail: memberRecord.user.email,
							userRole: memberRecord.role,
							action: "login",
							resourceType: "session",
						});
					},
				},
				delete: {
					after: async (session) => {
						const orgId = (
							session as typeof session & { activeOrganizationId?: string }
						).activeOrganizationId;
						if (!orgId) return;
						const memberRecord = await db.query.member.findFirst({
							where: and(
								eq(schema.member.userId, session.userId),
								eq(schema.member.organizationId, orgId),
							),
							with: { user: true },
						});
						if (!memberRecord) return;
						await createAuditLog({
							organizationId: orgId,
							userId: session.userId,
							userEmail: memberRecord.user.email,
							userRole: memberRecord.role,
							action: "logout",
							resourceType: "session",
						});
					},
				},
			},
		},
		session: {
			expiresIn: 60 * 60 * 24 * 3,
			updateAge: 60 * 60 * 24,
			cookieCache: { enabled: false },
			additionalFields: {
				twoFactorVerified: {
					type: "boolean",
					defaultValue: false,
					input: false,
				},
			},
		},
		user: {
			modelName: "user",
			fields: {
				name: "firstName", // Map better-auth's default 'name' field to 'firstName' column
			},
			additionalFields: {
				role: {
					type: "string",
					// required: true,
					input: false,
				},
				ownerId: {
					type: "string",
					// required: true,
					input: false,
				},
				allowImpersonation: {
					fieldName: "allowImpersonation",
					type: "boolean",
					defaultValue: false,
				},
				lastName: {
					type: "string",
					required: false,
					input: true,
					defaultValue: "",
				},
				enableEnterpriseFeatures: {
					type: "boolean",
					required: false,
					input: false,
				},
				isValidEnterpriseLicense: {
					type: "boolean",
					required: false,
					input: false,
				},
			},
		},
		plugins: [
			apiKey({
				enableMetadata: true,
				references: "user",
			}),
			sso({ trustEmailVerified: true }),
			scim({
				beforeSCIMTokenGenerated: async ({ user }) => {
					const dbUser = await db.query.user.findFirst({
						where: eq(schema.user.id, user.id),
						columns: { enableEnterpriseFeatures: true },
					});

					if (!dbUser?.enableEnterpriseFeatures) {
						throw new APIError("FORBIDDEN", {
							message: "SCIM provisioning requires an enterprise license",
						});
					}
				},
			}),
			twoFactorPlugin(),
			passkey(),
			organization({
				ac,
				roles: {
					owner: ownerRole,
					admin: adminRole,
					member: memberRole,
				},
				dynamicAccessControl: {
					enabled: true,
					maximumRolesPerOrganization: 10,
				},
			}),
			// Self-hosted needs the admin plugin too: SCIM deactivation (active: false)
			// maps to the admin plugin's `banned` field and is rejected without it.
			// adminRoles: [] keeps every /admin/* endpoint locked on self-hosted.
			admin(
				IS_CLOUD
					? { adminUserIds: [process.env.USER_ADMIN_ID as string] }
					: { adminRoles: [] },
			),
		],
	});

const globalForAuth = globalThis as unknown as {
	betterAuthInstance?: ReturnType<typeof createBetterAuth>;
};

if (!globalForAuth.betterAuthInstance) {
	globalForAuth.betterAuthInstance = createBetterAuth();
}

const { handler, api } = globalForAuth.betterAuthInstance;

const _auth = {
	handler,
	createApiKey: api.createApiKey,
	registerSSOProvider: api.registerSSOProvider,
	updateSSOProvider: api.updateSSOProvider,
	generateSCIMToken: api.generateSCIMToken,
	listSCIMProviderConnections: api.listSCIMProviderConnections,
	deleteSCIMProviderConnection: api.deleteSCIMProviderConnection,
};

export type AuthType = typeof _auth;
export const auth: AuthType = _auth;

const getBrowserSession = (request: IncomingMessage) =>
	api.getSession({
		headers: new Headers({ cookie: request.headers.cookie || "" }),
		query: { disableCookieCache: true },
	});

export const getTwoFactorState = async (request: IncomingMessage) => {
	const session = await getBrowserSession(request);
	if (!session) return null;
	if (session.session.impersonatedBy || session.user.banned)
		return { step: "sign-out" } as const;
	if (hasTwoFactorProof(session)) return { step: "complete" } as const;
	if (session.user.twoFactorEnabled) return { step: "verify" } as const;

	return { step: "enroll", email: session.user.email } as const;
};

export const validateRequest = async (request: IncomingMessage) => {
	const apiKey = request.headers["x-api-key"] as string;
	if (apiKey) {
		try {
			const { valid, key, error } = await api.verifyApiKey({
				body: {
					key: apiKey,
				},
			});

			if (error) {
				throw new Error(error.message?.toString() || "Error verifying API key");
			}
			if (!valid || !key) {
				return {
					session: null,
					user: null,
				};
			}

			const apiKeyRecord = await db.query.apikey.findFirst({
				where: and(
					eq(schema.apikey.id, key.id),
					twoFactorIsEnrolled(key.referenceId),
				),
				with: {
					user: true,
				},
			});

			if (!apiKeyRecord?.user?.twoFactorEnabled || apiKeyRecord.user.banned) {
				return {
					session: null,
					user: null,
				};
			}

			const organizationId = (
				JSON.parse(apiKeyRecord.metadata || "{}") as {
					organizationId?: string;
				}
			).organizationId;

			if (!organizationId) {
				return {
					session: null,
					user: null,
				};
			}

			const member = await db.query.member.findFirst({
				where: and(
					eq(schema.member.userId, apiKeyRecord.user.id),
					eq(schema.member.organizationId, organizationId),
				),
				with: {
					organization: true,
				},
			});

			if (!member) {
				return {
					session: null,
					user: null,
				};
			}

			// When accessing from DB, use actual column names
			const userFromDb = apiKeyRecord.user as typeof apiKeyRecord.user & {
				firstName: string;
				lastName: string;
			};

			const mockSession = {
				session: {
					userId: apiKeyRecord.user.id,
					activeOrganizationId: organizationId || "",
				},
				user: {
					id: userFromDb.id,
					name: userFromDb.firstName, // Map firstName back to name for better-auth
					email: userFromDb.email,
					emailVerified: userFromDb.emailVerified,
					image: userFromDb.image,
					createdAt: userFromDb.createdAt,
					updatedAt: userFromDb.updatedAt,
					twoFactorEnabled: userFromDb.twoFactorEnabled,
					role: member?.role || "member",
					ownerId: member?.organization.ownerId || apiKeyRecord.user.id,
					enableEnterpriseFeatures: userFromDb.enableEnterpriseFeatures,
					isValidEnterpriseLicense: userFromDb.isValidEnterpriseLicense,
				},
			};

			return mockSession;
		} catch (error) {
			console.error("Error verifying API key", error);
			return {
				session: null,
				user: null,
			};
		}
	}

	// If no API key, proceed with normal session validation
	const session = await getBrowserSession(request);

	if (!session || !hasTwoFactorProof(session)) {
		return {
			session: null,
			user: null,
		};
	}

	if (session?.user) {
		const member = await db.query.member.findFirst({
			where: and(
				eq(schema.member.userId, session.user.id),
				...(session.session.activeOrganizationId
					? [
							eq(
								schema.member.organizationId,
								session.session.activeOrganizationId || "",
							),
						]
					: []),
			),
			orderBy: [desc(schema.member.isDefault), desc(schema.member.createdAt)],
			with: {
				organization: true,
				user: true,
			},
		});

		session.user.role = member?.role || "member";
		session.user.enableEnterpriseFeatures =
			member?.user.enableEnterpriseFeatures || false;
		session.user.isValidEnterpriseLicense =
			member?.user.isValidEnterpriseLicense || false;
		session.session.activeOrganizationId = member?.organization.id || "";
		if (member) {
			session.user.ownerId = member.organization.ownerId;
		} else {
			session.user.ownerId = session.user.id;
		}
	}

	return session;
};
