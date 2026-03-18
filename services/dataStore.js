import fs from "fs/promises";
import path from "path";
import Database from "@replit/database";

function cloneValue(value) {
  if (value === undefined) return null;
  return JSON.parse(JSON.stringify(value));
}

class FileBackedStore {
  constructor(filePath) {
    this.filePath = filePath;
    this.state = {};
    this.ready = this.load();
  }

  async load() {
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    try {
      const raw = await fs.readFile(this.filePath, "utf8");
      const parsed = JSON.parse(raw);
      this.state = parsed && typeof parsed === "object" ? parsed : {};
    } catch (err) {
      if (err.code !== "ENOENT") {
        console.warn("[DB] Failed to read local store, starting empty:", err.message);
      }
      this.state = {};
      await this.flush();
    }
  }

  async flush() {
    await fs.writeFile(
      this.filePath,
      JSON.stringify(this.state, null, 2),
      "utf8",
    );
  }

  async get(key) {
    await this.ready;
    return cloneValue(this.state[key] ?? null);
  }

  async set(key, value) {
    await this.ready;
    this.state[key] = cloneValue(value);
    await this.flush();
    return this.get(key);
  }

  async delete(key) {
    await this.ready;
    delete this.state[key];
    await this.flush();
  }
}

export function createKeyValueStore() {
  const dbUrl = String(
    process.env.REPLIT_DB_URL || process.env.REPL_DB_URL || "",
  ).trim();

  if (dbUrl) {
    console.log("[DB] Using Replit Database");
    return new Database(dbUrl);
  }

  const dataFile = path.resolve(
    process.cwd(),
    process.env.LOCAL_DB_FILE || "data/render-db.json",
  );
  console.warn(
    `[DB] REPLIT_DB_URL is not set. Falling back to local file store at ${dataFile}`,
  );
  console.warn(
    "[DB] Render disks are ephemeral unless you attach a persistent disk. Chat history and local auth users may reset on redeploy.",
  );
  return new FileBackedStore(dataFile);
}

