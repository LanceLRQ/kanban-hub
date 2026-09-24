import { randomBytes } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { KhError, parseInput } from "@kanban-hub/core/errors";
import {
  type Machine,
  type MachineOs,
  type User,
  type UserRole,
  machineSchema,
  userSchema,
} from "@kanban-hub/core/schema";
import { readYamlFile, writeFileAtomic, writeYamlFile } from "./fsio";
import type { WriteQueue } from "./queue";

/** 凭据文件的位置（相对数据目录）。auth/ 被数据目录的 .gitignore 排除，不进 git 历史 */
export const AUTH_FILES = {
  users: "auth/users.yaml",
  machines: "auth/machines.yaml",
  sessionSecret: "auth/session-secret",
} as const;

const SECRET_FILE_MODE = 0o600;
const AUTH_DIR_MODE = 0o700;
const SECRET_MIN_LENGTH = 32;

const usersFileSchema = z.object({ users: z.array(userSchema) });
const machinesFileSchema = z.object({ machines: z.array(machineSchema) });

export interface AuthDeps {
  now: () => Date;
  newId: () => string;
}

/** 用户、机器与会话密钥的存储。写操作经过写入队列；认证逻辑在 M2 */
export class AuthRepo {
  private users: User[] = [];
  private machines: Machine[] = [];
  private secret = "";

  constructor(
    private readonly dataDir: string,
    private readonly queue: WriteQueue,
    private readonly deps: AuthDeps,
  ) {}

  async load(): Promise<void> {
    await fs.mkdir(this.abs("auth"), { recursive: true, mode: AUTH_DIR_MODE });
    // mkdir 的 mode 只在新建目录时生效，已存在的目录（备份还原、手工 mkdir -p 等）要显式修正权限
    await fs.chmod(this.abs("auth"), AUTH_DIR_MODE);
    this.users = (await readYamlFile(this.abs(AUTH_FILES.users), usersFileSchema))?.users ?? [];
    this.machines = (await readYamlFile(this.abs(AUTH_FILES.machines), machinesFileSchema))?.machines ?? [];
    this.secret = await this.loadOrCreateSecret();
  }

  listUsers(): readonly User[] {
    return this.users;
  }

  getUser(id: string): User | undefined {
    return this.users.find((u) => u.id === id);
  }

  listMachines(): readonly Machine[] {
    return this.machines;
  }

  getMachine(id: string): Machine | undefined {
    return this.machines.find((m) => m.id === id);
  }

  /** 会话 cookie 的签名密钥 */
  sessionSecret(): string {
    return this.secret;
  }

  createUser(input: { name: string; role: UserRole; passwordHash: string }): Promise<User> {
    return this.queue.run(async () => {
      const now = this.deps.now().toISOString();
      const user = parseInput(userSchema, {
        ...input,
        id: this.deps.newId(),
        version: 1,
        createdAt: now,
        updatedAt: now,
        sessionVersion: 0,
      });
      await this.saveUsers([...this.users, user]);
      return user;
    });
  }

  updateUser(id: string, patch: Partial<Pick<User, "name" | "passwordHash" | "sessionVersion">>): Promise<User> {
    return this.queue.run(async () => {
      const current = this.getUser(id);
      if (!current) throw new KhError("not_found", `用户 ${id} 不存在`);
      const user = parseInput(userSchema, {
        ...current,
        ...patch,
        version: current.version + 1,
        updatedAt: this.deps.now().toISOString(),
      });
      await this.saveUsers(this.users.map((u) => (u.id === id ? user : u)));
      return user;
    });
  }

  createMachine(input: { name: string; userId: string; os: MachineOs; tokenHash: string }): Promise<Machine> {
    return this.queue.run(async () => {
      const now = this.deps.now().toISOString();
      const machine = parseInput(machineSchema, {
        ...input,
        id: this.deps.newId(),
        version: 1,
        createdAt: now,
        updatedAt: now,
        lastSeenAt: null,
        revokedAt: null,
      });
      await this.saveMachines([...this.machines, machine]);
      return machine;
    });
  }

  updateMachine(id: string, patch: Partial<Pick<Machine, "name" | "lastSeenAt" | "revokedAt">>): Promise<Machine> {
    return this.queue.run(async () => {
      const current = this.getMachine(id);
      if (!current) throw new KhError("not_found", `机器 ${id} 不存在`);
      const machine = parseInput(machineSchema, {
        ...current,
        ...patch,
        version: current.version + 1,
        updatedAt: this.deps.now().toISOString(),
      });
      await this.saveMachines(this.machines.map((m) => (m.id === id ? machine : m)));
      return machine;
    });
  }

  // 先写文件，写成功后再替换内存
  private async saveUsers(users: User[]): Promise<void> {
    await writeYamlFile(this.abs(AUTH_FILES.users), { users }, { mode: SECRET_FILE_MODE });
    this.users = users;
  }

  private async saveMachines(machines: Machine[]): Promise<void> {
    await writeYamlFile(this.abs(AUTH_FILES.machines), { machines }, { mode: SECRET_FILE_MODE });
    this.machines = machines;
  }

  private async loadOrCreateSecret(): Promise<string> {
    const file = this.abs(AUTH_FILES.sessionSecret);
    try {
      const existing = (await fs.readFile(file, "utf8")).trim();
      if (existing.length >= SECRET_MIN_LENGTH) return existing;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    }
    const secret = randomBytes(32).toString("base64url");
    await writeFileAtomic(file, `${secret}\n`, { mode: SECRET_FILE_MODE });
    return secret;
  }

  private abs(rel: string): string {
    return path.join(this.dataDir, ...rel.split("/"));
  }
}
