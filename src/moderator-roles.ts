export interface ModeratorRoleEnvironment {
  MODERATOR_ROLE_IDS?: string;
  MODERATOR_ROLE_ID?: string;
}

const DISCORD_ROLE_ID_PATTERN = /^\d+$/;

export function parseModeratorRoleIds(value: string | undefined): Set<string> {
  const roleIds = (value ?? "")
    .split(",")
    .map((roleId) => roleId.trim())
    .filter((roleId) => roleId.length > 0);

  if (roleIds.some((roleId) => !DISCORD_ROLE_ID_PATTERN.test(roleId))) {
    throw new Error(
      "Moderator role IDs must be a comma-separated list of numeric Discord role IDs.",
    );
  }

  return new Set(roleIds);
}

export function resolveModeratorRoleIds(
  environment: ModeratorRoleEnvironment,
): Set<string> {
  const configuredRoleIds = parseModeratorRoleIds(
    environment.MODERATOR_ROLE_IDS,
  );

  if (configuredRoleIds.size > 0) {
    return configuredRoleIds;
  }

  const legacyRoleIds = parseModeratorRoleIds(environment.MODERATOR_ROLE_ID);

  if (legacyRoleIds.size > 0) {
    return legacyRoleIds;
  }

  throw new Error(
    "Missing required environment variable: MODERATOR_ROLE_IDS (or legacy MODERATOR_ROLE_ID).",
  );
}

export function memberHasModeratorRole(
  memberRoleIds: Iterable<string>,
  moderatorRoleIds: ReadonlySet<string>,
): boolean {
  for (const roleId of memberRoleIds) {
    if (moderatorRoleIds.has(roleId)) {
      return true;
    }
  }

  return false;
}
