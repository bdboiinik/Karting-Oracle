import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

interface StoredChannelConfig {
  version: 1;
  guilds: Record<string, { channelId: string }>;
}

function isSnowflake(value: unknown): value is string {
  return typeof value === "string" && /^\d+$/.test(value);
}

function parseStoredConfig(rawConfig: string): Map<string, string> {
  const parsed: unknown = JSON.parse(rawConfig);

  if (
    typeof parsed !== "object" ||
    parsed === null ||
    !("version" in parsed) ||
    parsed.version !== 1 ||
    !("guilds" in parsed) ||
    typeof parsed.guilds !== "object" ||
    parsed.guilds === null
  ) {
    throw new Error("The channel configuration file has an invalid format.");
  }

  const channels = new Map<string, string>();

  for (const [guildId, guildConfig] of Object.entries(parsed.guilds)) {
    if (
      !isSnowflake(guildId) ||
      typeof guildConfig !== "object" ||
      guildConfig === null ||
      !("channelId" in guildConfig) ||
      !isSnowflake(guildConfig.channelId)
    ) {
      throw new Error("The channel configuration file contains an invalid entry.");
    }

    channels.set(guildId, guildConfig.channelId);
  }

  return channels;
}

function isMissingFileError(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === "ENOENT"
  );
}

export class ChannelConfigStore {
  private readonly channels = new Map<string, string>();
  private mutationQueue: Promise<void> = Promise.resolve();

  public constructor(private readonly filePath: string) {}

  public async load(): Promise<void> {
    try {
      const rawConfig = await readFile(this.filePath, "utf8");
      const storedChannels = parseStoredConfig(rawConfig);

      this.channels.clear();
      for (const [guildId, channelId] of storedChannels) {
        this.channels.set(guildId, channelId);
      }
    } catch (error) {
      if (isMissingFileError(error)) {
        return;
      }

      throw new Error(`Could not load channel configuration from ${this.filePath}.`, {
        cause: error,
      });
    }
  }

  public get(guildId: string): string | undefined {
    return this.channels.get(guildId);
  }

  public has(guildId: string): boolean {
    return this.channels.has(guildId);
  }

  public set(guildId: string, channelId: string): Promise<void> {
    return this.enqueueMutation(async () => {
      const previousChannelId = this.channels.get(guildId);
      this.channels.set(guildId, channelId);

      try {
        await this.writeConfig();
      } catch (error) {
        if (previousChannelId === undefined) {
          this.channels.delete(guildId);
        } else {
          this.channels.set(guildId, previousChannelId);
        }

        throw error;
      }
    });
  }

  public delete(guildId: string): Promise<void> {
    return this.enqueueMutation(async () => {
      const previousChannelId = this.channels.get(guildId);

      if (previousChannelId === undefined) {
        return;
      }

      this.channels.delete(guildId);

      try {
        await this.writeConfig();
      } catch (error) {
        this.channels.set(guildId, previousChannelId);
        throw error;
      }
    });
  }

  private enqueueMutation(mutation: () => Promise<void>): Promise<void> {
    const result = this.mutationQueue.then(mutation, mutation);
    this.mutationQueue = result.catch(() => undefined);
    return result;
  }

  private async writeConfig(): Promise<void> {
    const guilds = Object.fromEntries(
      [...this.channels.entries()]
        .sort(([firstGuildId], [secondGuildId]) =>
          firstGuildId.localeCompare(secondGuildId),
        )
        .map(([guildId, channelId]) => [guildId, { channelId }]),
    );
    const config: StoredChannelConfig = { version: 1, guilds };
    const temporaryFilePath = `${this.filePath}.tmp`;

    await mkdir(dirname(this.filePath), { recursive: true });
    await writeFile(temporaryFilePath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
    await rename(temporaryFilePath, this.filePath);
  }
}
