// @effect-diagnostics nodeBuiltinImport:off - Streams a profile archive through an ssh child process.
/** `save` fetches the profile after the browser has exited, and the host deletes its copy. */
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeStreamPromises from "node:stream/promises";

export interface LeaseTarget {
  readonly host: string;
  readonly user: string;
  readonly identityFile: string;
  readonly knownHostsFile: string;
}

export interface ProfileLease {
  readonly restore: (profile: string) => Promise<void>;
  /** Stores the profile from the host, then the host deletes it. The old copy stays on failure. */
  readonly save: (profile: string) => Promise<void>;
  readonly discard: (profile: string) => Promise<void>;
}

const sshArgs = (target: LeaseTarget, command: string) => [
  "-T",
  "-o",
  "BatchMode=yes",
  "-o",
  "StrictHostKeyChecking=yes",
  "-o",
  `UserKnownHostsFile=${target.knownHostsFile}`,
  "-o",
  "ConnectTimeout=10",
  "-i",
  target.identityFile,
  `${target.user}@${target.host}`,
  command,
];

const call = (
  target: LeaseTarget,
  command: string,
  io: { readonly stdin?: string; readonly stdout?: string } = {},
) =>
  new Promise<void>((resolve, reject) => {
    const proc = NodeChildProcess.spawn("ssh", sshArgs(target, command), {
      stdio: [io.stdin ? "pipe" : "ignore", io.stdout ? "pipe" : "ignore", "ignore"],
    });
    const copies = Promise.all([
      io.stdin
        ? NodeStreamPromises.pipeline(NodeFS.createReadStream(io.stdin), proc.stdin!)
        : undefined,
      io.stdout
        ? NodeStreamPromises.pipeline(
            proc.stdout!,
            NodeFS.createWriteStream(io.stdout, { mode: 0o600 }),
          )
        : undefined,
    ]);
    proc.on("error", reject);
    proc.on("exit", (code) =>
      copies.then(
        () => (code === 0 ? resolve() : reject(new Error(`${command.split(" ")[0]} failed`))),
        reject,
      ),
    );
  });

export const makeSshLease = (target: LeaseTarget, dir: string): ProfileLease => {
  const file = (profile: string) => NodePath.join(dir, `${profile}.tar`);
  const ensureDir = () => NodeFSP.mkdir(dir, { recursive: true, mode: 0o700 });
  return {
    restore: async (profile) => {
      await ensureDir();
      const stored = await NodeFSP.access(file(profile)).then(
        () => true,
        () => false,
      );
      await (stored
        ? call(target, `put ${profile}`, { stdin: file(profile) })
        : call(target, `wipe ${profile}`));
    },
    save: async (profile) => {
      await ensureDir();
      const temp = `${file(profile)}.${process.pid}.tmp`;
      try {
        await call(target, `get ${profile}`, { stdout: temp });
        // One older copy stays, in case the browser left a half-written profile.
        await NodeFSP.rename(file(profile), `${file(profile)}.prev`).catch(() => undefined);
        await NodeFSP.rename(temp, file(profile));
      } catch (error) {
        await NodeFSP.rm(temp, { force: true });
        throw error;
      }
    },
    discard: async (profile) => {
      await NodeFSP.rm(file(profile), { force: true });
      await NodeFSP.rm(`${file(profile)}.prev`, { force: true });
    },
  };
};
