import type { BackupSchedule } from "@vieploy/server/services/backup";
import {
	createDeploymentBackup,
	updateDeploymentStatus,
} from "@vieploy/server/services/deployment";
import { findDestinationByIdForOrganization } from "@vieploy/server/services/destination";
import { findEnvironmentById } from "@vieploy/server/services/environment";
import type { Mariadb } from "@vieploy/server/services/mariadb";
import { findProjectById } from "@vieploy/server/services/project";
import { sendDatabaseBackupNotifications } from "../notifications/database-backup";
import { execAsync, execAsyncRemote } from "../process/execAsync";
import {
	getBackupCommand,
	getBackupFileName,
	getS3Credentials,
	normalizeS3Path,
} from "./utils";

export const runMariadbBackup = async (
	mariadb: Mariadb,
	backup: BackupSchedule,
) => {
	const { environmentId, name, appName } = mariadb;
	const environment = await findEnvironmentById(environmentId);
	const project = await findProjectById(environment.projectId);
	const { prefix } = backup;
	const destination = await findDestinationByIdForOrganization(
		backup.destinationId,
		project.organizationId,
	);
	const backupFileName = getBackupFileName(backup.customName, "sql.gz");
	const bucketDestination = `${appName}/${normalizeS3Path(prefix)}${backupFileName}`;
	const deployment = await createDeploymentBackup({
		backupId: backup.backupId,
		title: "MariaDB Backup",
		description: "MariaDB Backup",
	});
	try {
		const rcloneFlags = getS3Credentials(destination);
		const rcloneDestination = `:s3:${destination.bucket}/${bucketDestination}`;
		const backupCommand = getBackupCommand(
			backup,
			rcloneFlags,
			rcloneDestination,
			deployment.logPath,
		);
		if (mariadb.serverId) {
			await execAsyncRemote(mariadb.serverId, backupCommand);
		} else {
			await execAsync(backupCommand, {
				shell: "/bin/bash",
			});
		}

		await sendDatabaseBackupNotifications({
			applicationName: name,
			projectName: project.name,
			databaseType: "mariadb",
			type: "success",
			organizationId: project.organizationId,
			databaseName: backup.database,
		});
		await updateDeploymentStatus(deployment.deploymentId, "done");
	} catch (error) {
		console.log(error);
		await sendDatabaseBackupNotifications({
			applicationName: name,
			projectName: project.name,
			databaseType: "mariadb",
			type: "error",
			// @ts-ignore
			errorMessage: error?.message || "Error message not provided",
			organizationId: project.organizationId,
			databaseName: backup.database,
		});
		await updateDeploymentStatus(deployment.deploymentId, "error");
		throw error;
	}
};
